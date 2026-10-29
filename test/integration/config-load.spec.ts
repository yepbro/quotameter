import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configFilePath, loadConfigFile } from '../../src/config/load';
import { writeConfigFile } from '../../src/config/write';
import { withTempDir } from '../helpers/isolation';

/**
 * Locks configuration loading against the real filesystem (spec §6.2;
 * decision D-018): every failure mode a `config.json` on disk can have —
 * missing, unreadable, malformed, structurally invalid, semantically
 * invalid — must surface as readable problems, never as a throw, partial
 * data, or a silent default. The write round-trip proves compatibility with
 * the atomic writer (task 065). Pure formatting logic is covered by
 * `test/unit/config-load.spec.ts`; here every read is a real file read.
 */

/** Full valid configuration as file text; values are synthetic, not secrets. */
const FULL_CONFIG = `{
  "server": { "host": "127.0.0.1", "port": 8787 },
  "app": { "timezone": "Europe/Berlin", "pollingIntervalSeconds": 300, "historyRetentionDays": 180 },
  "auth": { "mode": "auto" },
  "logging": { "level": "warn" },
  "providers": {
    "zai-coding-plan": {
      "peakHours": {
        "timezone": "Asia/Singapore",
        "offPeakMultiplier": 0.5,
        "windows": [
          {
            "id": "zai-weekday-peak",
            "name": "Z.ai Coding Plan peak hours",
            "days": ["mon", "tue", "wed", "thu", "fri"],
            "start": "14:00",
            "end": "18:00",
            "multiplier": 1
          }
        ]
      },
      "requestTimeoutSeconds": 15
    }
  },
  "accounts": [
    {
      "id": "zai-main",
      "providerId": "zai-coding-plan",
      "label": "Main subscription",
      "enabled": true,
      "apiKey": "synthetic-test-key-not-a-real-secret"
    }
  ]
}
`;

describe('loadConfigFile against real files', () => {
  it('loads a complete valid configuration and returns it validated', async () => {
    await withTempDir(async (dir) => {
      const target = configFilePath(dir.path);
      await writeFile(target, FULL_CONFIG, 'utf8');
      const result = await loadConfigFile(target);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.server).toEqual({ host: '127.0.0.1', port: 8787 });
        expect(result.config.app.timezone).toBe('Europe/Berlin');
        expect(result.config.providers).toEqual({
          'zai-coding-plan': {
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
        });
        expect(result.config.accounts).toEqual([
          {
            id: 'zai-main',
            providerId: 'zai-coding-plan',
            label: 'Main subscription',
            enabled: true,
            apiKey: 'synthetic-test-key-not-a-real-secret',
          },
        ]);
      }
    });
  });

  it('completes a minimal file with the canonical defaults (spec §6.2)', async () => {
    await withTempDir(async (dir) => {
      const target = configFilePath(dir.path);
      await writeFile(target, '{"app":{"timezone":"UTC"}}\n', 'utf8');
      const result = await loadConfigFile(target);
      expect(result).toMatchObject({
        ok: true,
        config: {
          server: { host: '127.0.0.1', port: 8787 },
          app: { timezone: 'UTC', pollingIntervalSeconds: 300, historyRetentionDays: 180 },
          auth: { mode: 'auto' },
          logging: { level: 'warn' },
          providers: {},
          accounts: [],
        },
      });
    });
  });

  it('reports a missing file without throwing', async () => {
    await withTempDir(async (dir) => {
      const target = configFilePath(dir.path);
      await expect(loadConfigFile(target)).resolves.toEqual({
        ok: false,
        problems: [`configuration file not found: ${target}`],
      });
    });
  });

  it('reports malformed JSON without echoing file content (spec §15.4)', async () => {
    await withTempDir(async (dir) => {
      const target = configFilePath(dir.path);
      await writeFile(target, '{"apiKey": "sk-synthetic-secret-98765",}\n', 'utf8');
      const result = await loadConfigFile(target);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problems).toHaveLength(1);
        expect(result.problems[0]).toMatch(/^invalid JSON: /);
        expect(result.problems[0]).not.toContain('sk-synthetic-secret-98765');
      }
    });
  });

  it('reports an unreadable file by its errno (runs as non-root: container `node` user, CI runner)', async () => {
    await withTempDir(async (dir) => {
      const target = configFilePath(dir.path);
      await writeFile(target, '{"app":{"timezone":"UTC"}}', 'utf8');
      await chmod(target, 0o000);
      const result = await loadConfigFile(target);
      expect(result).toEqual({
        ok: false,
        problems: [`cannot read configuration file ${target}: EACCES`],
      });
    });
  });

  it('reports a path that is a directory instead of loading it', async () => {
    await withTempDir(async (dir) => {
      const notAFile = join(dir.path, 'config-dir');
      await mkdir(notAFile);
      const result = await loadConfigFile(notAFile);
      expect(result).toEqual({
        ok: false,
        problems: [`cannot read configuration file ${notAFile}: EISDIR`],
      });
    });
  });

  it('reports schema violations from a file with field-specific problems', async () => {
    await withTempDir(async (dir) => {
      const target = configFilePath(dir.path);
      await writeFile(
        target,
        '{"app":{"timezone":"UTC"},"server":{"port":"eighty","hosts":"x"}}',
        'utf8',
      );
      const result = await loadConfigFile(target);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problems).toEqual([
          "server: unknown property 'hosts'",
          'server.port: expected an integer, got a string',
        ]);
      }
    });
  });

  it('reports cross-field violations from a file (findConfigProblems stage)', async () => {
    await withTempDir(async (dir) => {
      const target = configFilePath(dir.path);
      await writeFile(
        target,
        JSON.stringify(
          {
            app: { timezone: 'UTC' },
            accounts: [
              { id: 'a1', providerId: 'zai', label: 'A', apiKey: 'k1', apiKeyEnv: 'QUOTAMETER_K' },
            ],
          },
          null,
          2,
        ),
        'utf8',
      );
      const result = await loadConfigFile(target);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problems).toEqual([
          "accounts[0] 'a1': apiKey and apiKeyEnv are mutually exclusive (spec §6.3)",
        ]);
      }
    });
  });

  it('round-trips through the atomic writer (task 065 compatibility)', async () => {
    await withTempDir(async (dir) => {
      const target = configFilePath(dir.path);
      const config = {
        app: { timezone: 'UTC' },
        accounts: [{ id: 'a1', providerId: 'zai', label: 'A', apiKey: 'synthetic-key' }],
      };
      await writeConfigFile(target, config);
      const result = await loadConfigFile(target);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.app).toEqual({
          timezone: 'UTC',
          pollingIntervalSeconds: 300,
          historyRetentionDays: 180,
        });
        expect(result.config.accounts).toEqual([
          { id: 'a1', providerId: 'zai', label: 'A', enabled: true, apiKey: 'synthetic-key' },
        ]);
      }
    });
  });
});
