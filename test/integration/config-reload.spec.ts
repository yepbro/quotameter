import { chmod, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { loadConfigWithEnv } from '../../src/config/env';
import { configFilePath } from '../../src/config/load';
import { createConfigReloader, type ConfigReloader } from '../../src/config/reload';
import { createLogger, type Logger } from '../../src/util/logger';
import type { AccountConfig, AuthMode, Config, ProviderConfig } from '../../src/schemas/config';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';
import { withTempDir } from '../helpers/isolation';

/**
 * Locks the reload operation against the real filesystem (spec §5.2, §6.2,
 * §6.4; decision D-026): the §6.4 split — allowed settings apply live,
 * restart-requiring settings are reported — the §6.2 rule that an invalid
 * file rejects the reload and keeps the last valid configuration active,
 * D-023's environment re-application, and serialization of overlapping
 * reloads. Every configuration value is synthetic, never a secret; the pure
 * classification table is covered by `test/unit/config-reload.spec.ts`.
 */

/**
 * The concrete fixture type — every section present and mutable with widened
 * literal unions, assignable to `Config`; serialized to the file text.
 */
type Fixture = Required<Pick<Config, 'server' | 'app' | 'logging'>> & {
  auth: { mode: AuthMode; passwordHash?: string };
  providers: { zai: ProviderConfig };
  accounts: [AccountConfig, ...AccountConfig[]];
};

/** A valid file configuration; every value is synthetic, never a secret. */
function baseConfig(): Fixture {
  return {
    server: { host: '127.0.0.1', port: 8787 },
    app: { timezone: 'Europe/Berlin', pollingIntervalSeconds: 300, historyRetentionDays: 180 },
    auth: { mode: 'auto', passwordHash: 'synthetic-scrypt-hash' },
    logging: { level: 'warn' },
    providers: {
      zai: {
        peakHours: {
          timezone: 'Asia/Singapore',
          offPeakMultiplier: 0.5,
          windows: [
            {
              id: 'zai-weekday-peak',
              name: 'Z.ai Coding Plan peak hours',
              days: ['mon', 'tue', 'wed', 'thu', 'fri'],
              start: '14:00',
              end: '18:00',
              multiplier: 1,
            },
          ],
        },
        requestTimeoutSeconds: 15,
      },
    },
    accounts: [
      {
        id: 'zai-main',
        providerId: 'zai',
        label: 'Main subscription',
        enabled: true,
        apiKey: 'synthetic-test-key-not-a-real-secret',
      },
    ],
  };
}

/** Serialized file text of a mutated base configuration. */
function variant(mutate: (config: Fixture) => void): string {
  const config = baseConfig();
  mutate(config);
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** The isolated environment every test passes explicitly (never `process.env`). */
const NO_ENV = {};

/**
 * Starts a reloader over a fresh file: writes the initial configuration,
 * loads it through the real pipeline, and hands both to the reloader.
 */
async function startReloader(
  dir: { path: string },
  initialText: string,
  env: NodeJS.ProcessEnv = NO_ENV,
  logger?: Logger,
): Promise<ConfigReloader> {
  const target = configFilePath(dir.path);
  await writeFile(target, initialText, 'utf8');
  const loaded = await loadConfigWithEnv(target, env);
  if (!loaded.ok) throw new Error(`initial load failed: ${loaded.problems.join('; ')}`);
  return createConfigReloader({ initial: loaded, targetPath: target, env, logger });
}

describe('reload — §6.4-allowed settings apply live', () => {
  it('applies changed live settings and reports them (outcome "applied")', async () => {
    await withTempDir(async (dir) => {
      const reloader = await startReloader(
        dir,
        variant(() => {}),
      );
      await writeFile(
        configFilePath(dir.path),
        variant((c) => {
          c.app.timezone = 'Asia/Singapore';
          c.app.pollingIntervalSeconds = 120;
          c.app.historyRetentionDays = 90;
          c.accounts[0]!.label = 'Relabeled subscription';
          c.accounts[0]!.enabled = false;
          c.providers.zai!.peakHours.windows[0]!.start = '15:00';
          c.logging.level = 'debug';
        }),
        'utf8',
      );

      const result = await reloader.reload();
      expect(result).toMatchObject({
        ok: true,
        outcome: 'applied',
        applied: [
          'app.timezone',
          'app.pollingIntervalSeconds',
          'app.historyRetentionDays',
          'accounts',
          'providers',
          'logging.level',
        ],
        restartRequired: [],
      });
      const current = reloader.current();
      expect(current.config.app).toEqual({
        timezone: 'Asia/Singapore',
        pollingIntervalSeconds: 120,
        historyRetentionDays: 90,
      });
      expect(current.config.accounts?.[0]).toMatchObject({
        label: 'Relabeled subscription',
        enabled: false,
      });
      expect(current.config.logging?.level).toBe('debug');
      // The startup baseline stays what the process began with.
      expect(reloader.startup.config.app.pollingIntervalSeconds).toBe(300);
    });
  });

  it('freezes the effective configuration it adopts', async () => {
    await withTempDir(async (dir) => {
      const reloader = await startReloader(
        dir,
        variant(() => {}),
      );
      await writeFile(
        configFilePath(dir.path),
        variant((c) => (c.server.port = 9400)),
        'utf8',
      );
      const result = await reloader.reload();
      if (!result.ok) throw new Error(result.problems.join('; '));
      expect(Object.isFrozen(result.effective.config)).toBe(true);
      expect(Object.isFrozen(result.effective.config.accounts!)).toBe(true);
      expect(() => {
        result.effective.config.app.timezone = 'UTC';
      }).toThrow(TypeError);
    });
  });
});

describe('reload — restart-requiring settings are reported, not applied live', () => {
  it('reports them against the startup baseline (outcome "pending-restart")', async () => {
    await withTempDir(async (dir) => {
      const reloader = await startReloader(
        dir,
        variant(() => {}),
      );
      await writeFile(
        configFilePath(dir.path),
        variant((c) => {
          c.server.port = 9400;
          c.auth.mode = 'required';
          c.auth.passwordHash = 'rotated-synthetic-hash';
          c.app.pollingIntervalSeconds = 120;
        }),
        'utf8',
      );

      const result = await reloader.reload();
      expect(result).toMatchObject({
        ok: true,
        outcome: 'pending-restart',
        restartRequired: ['server.port', 'auth.mode'],
        applied: ['app.pollingIntervalSeconds', 'auth.passwordHash'],
      });
      // The swap is wholesale: the effective configuration mirrors the file
      // (consumers label the reported fields "restart required", §6.4) —
      // but the startup baseline still names what the process runs.
      expect(reloader.current().config.server?.port).toBe(9400);
      expect(reloader.startup.config.server?.port).toBe(8787);
    });
  });

  it('keeps reporting pending-restart until a restart happens', async () => {
    await withTempDir(async (dir) => {
      const reloader = await startReloader(
        dir,
        variant(() => {}),
      );
      await writeFile(
        configFilePath(dir.path),
        variant((c) => (c.server.port = 9400)),
        'utf8',
      );
      await expect(reloader.reload()).resolves.toMatchObject({ outcome: 'pending-restart' });

      // Same file, second reload: nothing changed since the previous
      // effective config, yet the process still runs the startup port —
      // the restart half diffs against startup, not the previous reload.
      const again = await reloader.reload();
      expect(again).toMatchObject({
        outcome: 'pending-restart',
        restartRequired: ['server.port'],
        applied: [],
      });
    });
  });

  it('settles back to "applied" when the file returns to the startup values', async () => {
    await withTempDir(async (dir) => {
      const reloader = await startReloader(
        dir,
        variant(() => {}),
      );
      await writeFile(
        configFilePath(dir.path),
        variant((c) => (c.server.port = 9400)),
        'utf8',
      );
      await expect(reloader.reload()).resolves.toMatchObject({ outcome: 'pending-restart' });
      await writeFile(
        configFilePath(dir.path),
        variant(() => {}),
        'utf8',
      );
      await expect(reloader.reload()).resolves.toMatchObject({
        outcome: 'applied',
        restartRequired: [],
        applied: [],
      });
    });
  });
});

describe('reload — invalid configuration keeps the last valid config (spec §6.2)', () => {
  it('rejects the very first reload on a missing file and keeps the incumbent', async () => {
    await withTempDir(async (dir) => {
      const reloader = await startReloader(
        dir,
        variant(() => {}),
      );
      const target = configFilePath(dir.path);
      await rm(target);

      const result = await reloader.reload();
      expect(result).toEqual({
        ok: false,
        outcome: 'rejected',
        problems: [`configuration file not found: ${target}`],
      });
      expect(reloader.current().config.app.timezone).toBe('Europe/Berlin');
    });
  });

  it('rejects malformed JSON and keeps the previous effective configuration', async () => {
    await withTempDir(async (dir) => {
      const reloader = await startReloader(
        dir,
        variant(() => {}),
      );
      await writeFile(
        configFilePath(dir.path),
        variant((c) => (c.app.pollingIntervalSeconds = 120)),
        'utf8',
      );
      await reloader.reload();
      await writeFile(configFilePath(dir.path), '{"server": {"host": ', 'utf8');

      const result = await reloader.reload();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problems).toHaveLength(1);
        expect(result.problems[0]).toMatch(/^invalid JSON: /);
      }
      // The last valid configuration remains active.
      expect(reloader.current().config.app.pollingIntervalSeconds).toBe(120);
    });
  });

  it('rejects a schema violation with field-specific problems', async () => {
    await withTempDir(async (dir) => {
      const reloader = await startReloader(
        dir,
        variant(() => {}),
      );
      await writeFile(
        configFilePath(dir.path),
        '{"app":{"timezone":"UTC"},"server":{"port":"eighty"}}',
        'utf8',
      );

      const result = await reloader.reload();
      expect(result).toEqual({
        ok: false,
        outcome: 'rejected',
        problems: ['server.port: expected an integer, got a string'],
      });
      expect(reloader.current().config.server?.port).toBe(8787);
    });
  });

  it('rejects a cross-field violation with its §15.1 problem', async () => {
    await withTempDir(async (dir) => {
      const reloader = await startReloader(
        dir,
        variant(() => {}),
      );
      await writeFile(
        configFilePath(dir.path),
        variant((c) => {
          c.auth.mode = 'required';
          delete c.auth.passwordHash;
        }),
        'utf8',
      );

      const result = await reloader.reload();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problems).toEqual([
          'auth: a password is required when auth.mode is "required" or server.host is not loopback (spec §15.1)',
        ]);
      }
      expect(reloader.current().config.auth).toEqual({
        mode: 'auto',
        passwordHash: 'synthetic-scrypt-hash',
      });
    });
  });

  it('rejects an unreadable file by its errno and keeps the incumbent', async () => {
    await withTempDir(async (dir) => {
      const reloader = await startReloader(
        dir,
        variant(() => {}),
      );
      const target = configFilePath(dir.path);
      // Runs as non-root (container `node` user, CI runner), so mode 000
      // denies the read the same way a foreign-owned 0600 file would.
      await chmod(target, 0o000);

      const result = await reloader.reload();
      expect(result).toEqual({
        ok: false,
        outcome: 'rejected',
        problems: [`cannot read configuration file ${target}: EACCES`],
      });
      expect(reloader.current().config.app.timezone).toBe('Europe/Berlin');
    });
  });

  it('recovers on the next valid reload after a rejection', async () => {
    await withTempDir(async (dir) => {
      const reloader = await startReloader(
        dir,
        variant(() => {}),
      );
      await writeFile(configFilePath(dir.path), '{"app":', 'utf8');
      await expect(reloader.reload()).resolves.toMatchObject({ ok: false });
      await writeFile(
        configFilePath(dir.path),
        variant((c) => (c.app.pollingIntervalSeconds = 120)),
        'utf8',
      );
      await expect(reloader.reload()).resolves.toMatchObject({
        ok: true,
        outcome: 'applied',
        applied: ['app.pollingIntervalSeconds'],
      });
    });
  });
});

describe('reload — environment overrides re-apply every time (decision D-023)', () => {
  it('keeps environment-pinned fields stable across reloads', async () => {
    await withTempDir(async (dir) => {
      const env = { QUOTAMETER_SERVER_PORT: '9100' };
      const reloader = await startReloader(
        dir,
        variant(() => {}),
        env,
      );
      expect(reloader.current().config.server?.port).toBe(9100);

      // The file now requests another port and another host; the pinned port
      // must not flip, and it never counts as a restart-requiring change.
      await writeFile(
        configFilePath(dir.path),
        variant((c) => {
          c.server.port = 9400;
          c.server.host = 'localhost';
          c.app.pollingIntervalSeconds = 120;
        }),
        'utf8',
      );
      const result = await reloader.reload();
      expect(result).toMatchObject({
        ok: true,
        outcome: 'pending-restart',
        restartRequired: ['server.host'],
        applied: ['app.pollingIntervalSeconds'],
      });
      expect(reloader.current().config.server?.port).toBe(9100);
      expect(reloader.current().sources.fields).toEqual(['server.port']);
    });
  });

  it('rebuilds the configuration environment-only when the file disappears', async () => {
    await withTempDir(async (dir) => {
      const env = { QUOTAMETER_APP_TIMEZONE: 'Europe/Berlin' };
      const reloader = await startReloader(
        dir,
        variant(() => {}),
        env,
      );
      await rm(configFilePath(dir.path));

      const result = await reloader.reload();
      expect(result).toMatchObject({ ok: true, outcome: 'applied' });
      const current = reloader.current();
      expect(current.fileAbsent).toBe(true);
      // Structured sections have no environment channel (D-023): the
      // environment-only configuration carries none of them.
      expect(current.config.accounts).toEqual([]);
      expect(current.config.providers).toEqual({});
      expect(current.config.app.timezone).toBe('Europe/Berlin');
    });
  });
});

describe('reload — overlapping and repeated calls serialize', () => {
  it('runs queued reloads one at a time, in invocation order', async () => {
    await withTempDir(async (dir) => {
      const target = configFilePath(dir.path);
      const texts = [
        variant(() => {}),
        variant((c) => (c.app.pollingIntervalSeconds = 120)),
        variant((c) => {
          c.app.pollingIntervalSeconds = 300;
          c.app.timezone = 'Asia/Singapore';
        }),
      ];
      // A gated read primitive makes the overlap deterministic: the first
      // reload's read parks until released, proving the second waits.
      const calls: number[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const filesystem = {
        async readFile(path: string): Promise<string> {
          calls.push(calls.length);
          const text = texts.shift();
          if (text === undefined) throw new Error(`unexpected read of ${path}`);
          if (calls.length === 2) await gate;
          return text;
        },
      };

      const initial = await loadConfigWithEnv(target, NO_ENV, filesystem);
      if (!initial.ok) throw new Error(initial.problems.join('; '));
      const reloader = createConfigReloader({
        initial,
        targetPath: target,
        env: NO_ENV,
        filesystem,
      });

      const first = reloader.reload();
      await new Promise((resolve) => setImmediate(resolve));
      expect(calls.length).toBe(2); // initial load + first reload only
      const second = reloader.reload();
      await new Promise((resolve) => setImmediate(resolve));
      expect(calls.length).toBe(2); // the second waits behind the gated first

      release();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).toMatchObject({
        ok: true,
        applied: ['app.pollingIntervalSeconds'],
      });
      expect(secondResult).toMatchObject({
        ok: true,
        applied: ['app.timezone', 'app.pollingIntervalSeconds'],
      });
      expect(calls.length).toBe(3);
      expect(reloader.current().config.app.timezone).toBe('Asia/Singapore');
    });
  });

  it('delivers every caller its own result for a burst on an unchanged file', async () => {
    await withTempDir(async (dir) => {
      const reloader = await startReloader(
        dir,
        variant(() => {}),
      );
      await writeFile(
        configFilePath(dir.path),
        variant((c) => (c.app.pollingIntervalSeconds = 120)),
        'utf8',
      );
      const [first, second, third] = await Promise.all([
        reloader.reload(),
        reloader.reload(),
        reloader.reload(),
      ]);
      expect(first).toMatchObject({ ok: true, applied: ['app.pollingIntervalSeconds'] });
      expect(second).toMatchObject({ ok: true, applied: [] });
      expect(third).toMatchObject({ ok: true, applied: [] });
    });
  });
});

describe('reload — events flow through the redacting logger (spec §16, §15.4)', () => {
  /** A logger over a memory sink at `info`, so lifecycle events are captured. */
  function sinkLogger(): { logger: Logger; sink: MemoryLogSink } {
    const sink = createMemoryLogSink();
    return { logger: createLogger({ level: 'info', destination: sink }), sink };
  }

  it('logs the applied reload as an info lifecycle event', async () => {
    await withTempDir(async (dir) => {
      const { logger, sink } = sinkLogger();
      const reloader = await startReloader(
        dir,
        variant(() => {}),
        NO_ENV,
        logger,
      );
      await writeFile(
        configFilePath(dir.path),
        variant((c) => {
          c.app.pollingIntervalSeconds = 120;
          // §16: lifecycle events appear at `info` — keep the effective
          // level at info so the record is not filtered by the reload's own
          // level application.
          c.logging.level = 'info';
        }),
        'utf8',
      );
      await reloader.reload();

      const record = sink.singleRecord();
      expect(record.level).toBe(30); // pino "info"
      expect(record.msg).toBe('configuration reloaded');
      expect(record).toMatchObject({
        outcome: 'applied',
        applied: ['app.pollingIntervalSeconds', 'logging.level'],
        restartRequired: [],
      });
      // Value-free by construction: no configuration content travels.
      expect(sink.lines().join('\n')).not.toContain('synthetic-test-key-not-a-real-secret');
    });
  });

  it('logs a rejected reload as a warning carrying the problems', async () => {
    await withTempDir(async (dir) => {
      const { logger, sink } = sinkLogger();
      const reloader = await startReloader(
        dir,
        variant(() => {}),
        NO_ENV,
        logger,
      );
      await writeFile(configFilePath(dir.path), '{"app":', 'utf8');
      await reloader.reload();

      const rejectedMessage = 'configuration reload rejected; keeping the last valid configuration';
      const record = sink.singleRecord();
      expect(record.level).toBe(40); // pino "warn"
      expect(record.msg).toBe(rejectedMessage);
      expect(record.problems).toHaveLength(1);
    });
  });

  it('applies logging.level live through setLevel (decision D-025)', async () => {
    await withTempDir(async (dir) => {
      const { logger, sink } = sinkLogger();
      expect(logger.level).toBe('info');
      const reloader = await startReloader(
        dir,
        variant(() => {}),
        NO_ENV,
        logger,
      );
      await writeFile(
        configFilePath(dir.path),
        variant((c) => (c.logging.level = 'debug')),
        'utf8',
      );
      await reloader.reload();
      expect(logger.level).toBe('debug');
      expect(sink.singleRecord().msg).toBe('configuration reloaded');
    });
  });

  it('keeps the incumbent when an injected dependency rejects, then recovers', async () => {
    await withTempDir(async (dir) => {
      const target = configFilePath(dir.path);
      await writeFile(
        target,
        variant(() => {}),
        'utf8',
      );
      const initial = await loadConfigWithEnv(target, NO_ENV);
      if (!initial.ok) throw new Error(initial.problems.join('; '));
      const real = createLogger({ destination: createMemoryLogSink() });
      let broken = false;
      const flaky: Logger = {
        ...real,
        setLevel(level) {
          if (broken) throw new Error('setLevel wiring is broken');
          real.setLevel(level);
        },
      };
      const reloader = createConfigReloader({
        initial,
        targetPath: target,
        env: NO_ENV,
        logger: flaky,
      });

      // The only realistically faultable dependency: a throwing `setLevel`
      // must reject the caller's promise (a wiring bug, not a config
      // problem) while the incumbent stays active.
      broken = true;
      await writeFile(
        configFilePath(dir.path),
        variant((c) => (c.app.pollingIntervalSeconds = 120)),
        'utf8',
      );
      await expect(reloader.reload()).rejects.toThrow('setLevel wiring is broken');
      expect(reloader.current().config.app.pollingIntervalSeconds).toBe(300);

      // The serialization queue survives the rejection: the next reload
      // (dependency healed) applies normally.
      broken = false;
      await expect(reloader.reload()).resolves.toMatchObject({
        ok: true,
        outcome: 'applied',
        applied: ['app.pollingIntervalSeconds'],
      });
      expect(reloader.current().config.app.pollingIntervalSeconds).toBe(120);
    });
  });
});
