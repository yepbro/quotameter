import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createConfigFileAccountStore,
  createConfigFileOwner,
  createConfigFileSettingsStore,
} from '../../src/server/config-stores';
import type { EffectiveConfig, ReloadResult } from '../../src/config/reload';
import { parseConfig } from '../../src/config/load';
import type { EnvironmentSources } from '../../src/config/env';
import type { Validated } from '../../src/schemas/boundary';
import type { Config } from '../../src/schemas/config';
import type { QuotaRepository } from '../../src/storage/repository';
import { withTempDir } from '../helpers/isolation';

/**
 * The production configuration stores' own matrix (task U-040, D-140 — the
 * review round's P2): the serialized file owner over REAL temp files, with
 * only the reload and effective-configuration seams doubled (observing them
 * needs determinism the composition suite already provides elsewhere). The
 * happy paths through the full composition live in `composition.spec.ts`;
 * this file pins the owner's error and edge arms — the absent-file base,
 * malformed and non-object files, duplicate ids, unknown ids, the
 * refuse-before-write guarantee, reload-rejection propagation, `apiKeyEnv`
 * resolution, mutation serialization, the settings write's attempted-only
 * rule, and the settings password change's fail-secure revocation order —
 * revoke before the write, refuse with nothing written on a failed
 * revocation, honest reporting of the revoked-then-failed arm (D-184).
 */

/** A valid configuration as parsed — the effective() double's currency. */
function parsed(input: unknown): Validated<Config> {
  const result = parseConfig(input);
  if (!result.ok) throw new Error(`fixture invalid: ${result.problems.join('; ')}`);
  return result.value;
}

/** Builds an EffectiveConfig view of a parsed configuration. */
function effectiveOf(config: Validated<Config>): EffectiveConfig {
  return Object.freeze({
    config,
    sources: Object.freeze({ fields: Object.freeze([]), accountSecrets: Object.freeze([]) }),
    fileAbsent: false,
  });
}

/** The environment marking with the given overridden fields. */
function sourcesOf(fields: readonly string[] = []): EnvironmentSources {
  return { fields: fields as EnvironmentSources['fields'], accountSecrets: [] };
}

/** The doubled reload: canned results, call-counted, effective-updating. */
class ReloadDouble {
  private readonly results: ReloadResult[] = [];
  calls = 0;

  constructor(private readonly state: { effective: EffectiveConfig }) {}

  /** The next reload's result (default: success over the current state). */
  next(result: ReloadResult): void {
    this.results.push(result);
  }

  readonly reload = async (): Promise<ReloadResult> => {
    this.calls++;
    const result: ReloadResult = this.results.shift() ?? {
      ok: true,
      outcome: 'applied',
      effective: this.state.effective,
      applied: [],
      restartRequired: [],
    };
    if (result.ok) this.state.effective = result.effective;
    return result;
  };
}

/** The test harness over one temp config file. */
interface StoreHarness {
  readonly accountStore: ReturnType<typeof createConfigFileAccountStore>;
  readonly settingsStore: ReturnType<typeof createConfigFileSettingsStore>;
  readonly reload: ReloadDouble;
  readonly repository: {
    deleteAllSessionsCalls: number;
    /** What the next successful `deleteAllSessions` reports deleted. */
    deleteAllSessionsReturns: number;
    /** Raw file bytes observed at each revocation — the order proof. */
    revokeSnapshots: readonly string[];
    /** Makes the next `deleteAllSessions` throw the given detail. */
    failNextDeleteAllSessions(detail: string): void;
    /** Seeds the `retention:applied-days` marker the settings read serves. */
    setAppliedRetentionDays(raw: string | null): void;
  };
  readonly configPath: string;
  /** Re-points the effective() double at a new configuration. */
  setEffective(input: unknown): void;
  /** The pendingRestart thunk double (FSM-5, D-193): call count + value. */
  readonly restartPending: {
    calls: number;
    value: ReadonlyArray<'server.host' | 'server.port' | 'auth.mode'>;
  };
  readRaw(): Promise<string>;
}

async function withStores(
  options: { env?: Record<string, string>; initialFile?: string | null } = {},
  body: (h: StoreHarness) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const configDir = join(dir.path, 'config');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const configPath = join(configDir, 'config.json');
    // The default base is a minimal valid file; `null` means "absent file"
    // (the env-only mode's RMW base — the env must then supply what the
    // schema requires, exactly as production would).
    const initialFile =
      options.initialFile === undefined ? '{"app":{"timezone":"UTC"}}\n' : options.initialFile;
    if (initialFile !== null) {
      await writeFile(configPath, initialFile, 'utf8');
    }
    const state = { effective: effectiveOf(parsed({ app: { timezone: 'UTC' } })) };
    const reload = new ReloadDouble(state);
    // The repository double: the §15.2 revocation call the store makes
    // (order-observing through per-call file snapshots, injectably
    // failing, with a configurable deleted count), plus the §11.3
    // applied-retention marker its read serves.
    let appliedRetentionDays: string | null = null;
    let deleteAllSessionsFailure: Error | null = null;
    const repository = {
      deleteAllSessionsCalls: 0,
      deleteAllSessionsReturns: 0,
      revokeSnapshots: [] as string[],
      deleteAllSessions(): number {
        this.deleteAllSessionsCalls++;
        // The bytes as they lie AT the revocation: proving the fail-secure
        // order (D-184) means proving the write had not happened yet.
        this.revokeSnapshots.push(readFileSync(configPath, 'utf8'));
        if (deleteAllSessionsFailure !== null) {
          const failure = deleteAllSessionsFailure;
          deleteAllSessionsFailure = null;
          throw failure;
        }
        return this.deleteAllSessionsReturns;
      },
      failNextDeleteAllSessions(detail: string): void {
        deleteAllSessionsFailure = new Error(detail);
      },
      getMetaValue(key: string): string | null {
        return key === 'retention:applied-days' ? appliedRetentionDays : null;
      },
      setAppliedRetentionDays(raw: string | null): void {
        appliedRetentionDays = raw;
      },
    };
    const owner = createConfigFileOwner({
      targetPath: configPath,
      env: options.env ?? {},
      effective: () => state.effective,
      reload: reload.reload,
    });
    // The reloader's live diff as an observable double (FSM-5, D-193):
    // counts calls (the liveness proof — read() consults it every time)
    // and serves a flippable value.
    const restartPending = {
      calls: 0,
      value: [] as ReadonlyArray<'server.host' | 'server.port' | 'auth.mode'>,
    };
    await body({
      accountStore: createConfigFileAccountStore(owner),
      settingsStore: createConfigFileSettingsStore(owner, {
        repository: repository as unknown as QuotaRepository,
        dataDir: join(dir.path, 'data'),
        pendingRestart: () => {
          restartPending.calls++;
          return restartPending.value;
        },
      }),
      reload,
      repository,
      restartPending,
      configPath,
      setEffective: (input: unknown) => {
        state.effective = effectiveOf(parsed(input));
      },
      readRaw: () => readFile(configPath, 'utf8'),
    });
  });
}

describe('createConfigFileAccountStore', () => {
  it('creates the file from an absent base (the env-only mode writes through)', async () => {
    await withStores(
      { initialFile: null, env: { QUOTAMETER_APP_TIMEZONE: 'Europe/Berlin' } },
      async (h) => {
        await h.accountStore.add({
          id: 'first',
          providerId: 'zai-coding-plan',
          label: 'First',
          enabled: true,
          apiKey: 'synthetic-key',
        });
        // The environment supplied `app.timezone`, so the created file needs
        // nothing but the mutation's own section — the sub-minimal file is
        // the sanctioned env-only shape (D-023).
        expect(JSON.parse(await h.readRaw())).toEqual({
          accounts: [
            {
              id: 'first',
              providerId: 'zai-coding-plan',
              label: 'First',
              enabled: true,
              apiKey: 'synthetic-key',
            },
          ],
        });
        expect(h.reload.calls).toBe(1);
      },
    );
  });

  it('rejects a duplicate id and leaves the file untouched', async () => {
    await withStores({}, async (h) => {
      await h.accountStore.add({ id: 'a', providerId: 'p', label: 'A', enabled: true });
      const before = await h.readRaw();
      await expect(
        h.accountStore.add({ id: 'a', providerId: 'p', label: 'Again', enabled: true }),
      ).rejects.toThrow(/already exists/);
      expect(await h.readRaw()).toBe(before);
    });
  });

  it('resolves update/remove for unknown ids without writing', async () => {
    await withStores({}, async (h) => {
      await h.accountStore.add({ id: 'a', providerId: 'p', label: 'A', enabled: true });
      const before = await h.readRaw();
      expect(await h.accountStore.update('missing', { label: 'X' })).toBeNull();
      expect(await h.accountStore.remove('missing')).toBe(false);
      expect(await h.readRaw()).toBe(before);
    });
  });

  it('applies label, enable, and key changes to the file entry', async () => {
    await withStores({}, async (h) => {
      await h.accountStore.add({
        id: 'a',
        providerId: 'p',
        label: 'A',
        enabled: true,
        apiKey: 'synthetic-old',
      });
      await h.accountStore.update('a', {
        label: 'Renamed',
        enabled: false,
        apiKey: 'synthetic-new',
      });
      expect(JSON.parse(await h.readRaw())).toEqual({
        app: { timezone: 'UTC' },
        accounts: [
          { id: 'a', providerId: 'p', label: 'Renamed', enabled: false, apiKey: 'synthetic-new' },
        ],
      });
    });
  });

  it('removes the entry and reports existence', async () => {
    await withStores({}, async (h) => {
      await h.accountStore.add({ id: 'a', providerId: 'p', label: 'A', enabled: true });
      expect(await h.accountStore.remove('a')).toBe(true);
      expect(JSON.parse(await h.readRaw())).toEqual({ app: { timezone: 'UTC' }, accounts: [] });
    });
  });

  it('refuses a malformed file and a non-object root without repairing them', async () => {
    await withStores({ initialFile: '{"app": ' }, async (h) => {
      await expect(
        h.accountStore.add({ id: 'a', providerId: 'p', label: 'A', enabled: true }),
      ).rejects.toThrow(/cannot modify configuration file/);
    });
    await withStores({ initialFile: '[1,2]\n' }, async (h) => {
      await expect(
        h.accountStore.add({ id: 'a', providerId: 'p', label: 'A', enabled: true }),
      ).rejects.toThrow(/top level is not a JSON object/);
    });
  });

  it('refuses an invalid candidate BEFORE writing — the file keeps its bytes', async () => {
    // The file is valid JSON but invalid configuration (port type); the
    // store's own mutation (a well-formed account) cannot make the merged
    // candidate valid, so the refuse-before-write promise binds.
    const initial = `${JSON.stringify({ app: { timezone: 'UTC' }, server: { port: 'abc' } })}\n`;
    await withStores({ initialFile: initial }, async (h) => {
      await expect(
        h.accountStore.add({ id: 'a', providerId: 'p', label: 'A', enabled: true }),
      ).rejects.toThrow(/refusing to persist an invalid configuration change/);
      expect(await h.readRaw()).toBe(initial);
      expect(h.reload.calls).toBe(0);
    });
  });

  it('propagates a rejected reload after the write (the incumbent stays effective)', async () => {
    await withStores({}, async (h) => {
      h.reload.next({
        ok: false,
        outcome: 'rejected',
        problems: ['app.timezone: expected a string, got a number'],
      });
      await expect(
        h.accountStore.add({ id: 'a', providerId: 'p', label: 'A', enabled: true }),
      ).rejects.toThrow(/configuration reload rejected after the mutation/);
    });
  });

  it('serializes concurrent mutations — both land, in invocation order', async () => {
    await withStores({}, async (h) => {
      const first = h.accountStore.add({ id: 'a', providerId: 'p', label: 'A', enabled: true });
      const second = h.accountStore.add({ id: 'b', providerId: 'p', label: 'B', enabled: true });
      await Promise.all([first, second]);
      expect(JSON.parse(await h.readRaw())).toEqual({
        app: { timezone: 'UTC' },
        accounts: [
          { id: 'a', providerId: 'p', label: 'A', enabled: true },
          { id: 'b', providerId: 'p', label: 'B', enabled: true },
        ],
      });
      expect(h.reload.calls).toBe(2);
    });
  });

  it('resolves secrets: file values, environment names, and the unset residual', async () => {
    await withStores({ env: { QM_SET_KEY: 'env-value', QM_EMPTY_KEY: '' } }, async (h) => {
      h.setEffective({
        app: { timezone: 'UTC' },
        accounts: [
          { id: 'file', providerId: 'p', label: 'L', apiKey: 'file-value' },
          { id: 'env', providerId: 'p', label: 'L', apiKeyEnv: 'QM_SET_KEY' },
          { id: 'empty', providerId: 'p', label: 'L', apiKeyEnv: 'QM_EMPTY_KEY' },
          { id: 'unset', providerId: 'p', label: 'L', apiKeyEnv: 'QM_ABSENT_KEY' },
          { id: 'keyless', providerId: 'p', label: 'L' },
        ],
      });
      expect(await h.accountStore.secretOf('file')).toBe('file-value');
      expect(await h.accountStore.secretOf('env')).toBe('env-value');
      // D-011's empty-is-unset and the D-112 unresolved-name residual.
      expect(await h.accountStore.secretOf('empty')).toBeNull();
      expect(await h.accountStore.secretOf('unset')).toBeNull();
      expect(await h.accountStore.secretOf('keyless')).toBeNull();
      expect(await h.accountStore.secretOf('unknown')).toBeNull();
    });
  });
});

describe('createConfigFileSettingsStore', () => {
  it('serves the applied-retention marker from storage, fail-soft (§11.3, D-178)', async () => {
    await withStores({}, async (h) => {
      // No cleanup has completed: the marker is absent, the read is null.
      await expect(h.settingsStore.read()).resolves.toMatchObject({
        appliedRetentionDays: null,
      });
      // The last completed cleanup applied 180 — served verbatim.
      h.repository.setAppliedRetentionDays('180');
      await expect(h.settingsStore.read()).resolves.toMatchObject({
        appliedRetentionDays: 180,
      });
      // A corrupted marker reads null, not a 500: the settings page must
      // survive it, and the next cleanup's write is the repair.
      h.repository.setAppliedRetentionDays('corrupt-marker');
      await expect(h.settingsStore.read()).resolves.toMatchObject({
        appliedRetentionDays: null,
      });
      // An out-of-range integer (beyond the safe range) is corrupt too.
      h.repository.setAppliedRetentionDays('99999999999999999999');
      await expect(h.settingsStore.read()).resolves.toMatchObject({
        appliedRetentionDays: null,
      });
    });
  });

  it('serves the reloader pendingRestart thunk verbatim, read per read() (FSM-5, D-193)', async () => {
    await withStores({}, async (h) => {
      // The store is a pass-through, never a recomputation: every read
      // consults the thunk and serves exactly its answer of the moment.
      await expect(h.settingsStore.read()).resolves.toMatchObject({ pendingRestart: [] });
      h.restartPending.value = ['server.host'];
      await expect(h.settingsStore.read()).resolves.toMatchObject({
        pendingRestart: ['server.host'],
      });
      h.restartPending.value = ['server.host', 'auth.mode'];
      await expect(h.settingsStore.read()).resolves.toMatchObject({
        pendingRestart: ['server.host', 'auth.mode'],
      });
      expect(h.restartPending.calls).toBe(3);
    });
  });

  it('writes only the attempted field, skipping environment-owned ones', async () => {
    await withStores({}, async (h) => {
      const config = parsed({ app: { timezone: 'UTC', pollingIntervalSeconds: 600 } });
      await h.settingsStore.apply({
        config,
        pendingPassword: undefined,
        sources: sourcesOf(['app.timezone']),
        attempted: ['app.timezone', 'app.pollingIntervalSeconds'],
      });
      // timezone is environment-owned (never file-written); only the
      // interval the request attempted reaches the file, beside the base's
      // untouched app section.
      expect(JSON.parse(await h.readRaw())).toEqual({
        app: { timezone: 'UTC', pollingIntervalSeconds: 600 },
      });
    });
  });

  it('writes nothing for an empty attempt set', async () => {
    await withStores({}, async (h) => {
      const before = await h.readRaw();
      await h.settingsStore.apply({
        config: parsed({ app: { timezone: 'UTC' } }),
        pendingPassword: undefined,
        sources: sourcesOf(),
        attempted: [],
      });
      // Nothing was written (the base file keeps its bytes); the no-change
      // mutation still reports the reload outcome.
      expect(await h.readRaw()).toBe(before);
      expect(h.reload.calls).toBe(1);
    });
  });

  it('refuses to overwrite a non-object section', async () => {
    await withStores({ initialFile: '{"app":"oops"}\n' }, async (h) => {
      const config = parsed({ app: { timezone: 'UTC', pollingIntervalSeconds: 600 } });
      await expect(
        h.settingsStore.apply({
          config,
          pendingPassword: undefined,
          sources: sourcesOf(),
          attempted: ['app.pollingIntervalSeconds'],
        }),
      ).rejects.toThrow(/expected a JSON object/);
    });
  });

  it('hashes a supplied password, revokes sessions BEFORE the write, stores only the encoding', async () => {
    await withStores({}, async (h) => {
      await h.settingsStore.apply({
        config: parsed({ app: { timezone: 'UTC' } }),
        pendingPassword: 'correct-horse-battery',
        sources: sourcesOf(),
        attempted: [],
      });
      const file = JSON.parse(await h.readRaw()) as { auth?: { passwordHash?: string } };
      expect(file.auth?.passwordHash).toMatch(/^scrypt\$N=/);
      expect(await h.readRaw()).not.toContain('correct-horse-battery');
      expect(h.repository.deleteAllSessionsCalls).toBe(1);
      // The fail-secure order (§15.2, D-184): the revocation ran against
      // the PRE-write file — the snapshot it observed carries no hash yet.
      expect(h.repository.revokeSnapshots).toHaveLength(1);
      expect(h.repository.revokeSnapshots[0]).not.toMatch(/scrypt\$N=/);
      expect(h.reload.calls).toBe(1);
    });
  });

  it('a failed revocation refuses the change with nothing written — the old hash stays', async () => {
    const oldHash = 'scrypt$N=65536,r=8,p=1,keylen=64$b2xkLXNhbHQ=$b2xkLWhhc2g=';
    const initial = `${JSON.stringify({ app: { timezone: 'UTC' }, auth: { passwordHash: oldHash } })}\n`;
    await withStores({ initialFile: initial }, async (h) => {
      h.repository.failNextDeleteAllSessions('synthetic database failure');
      await expect(
        h.settingsStore.apply({
          config: parsed({ app: { timezone: 'UTC' } }),
          pendingPassword: 'correct-horse-battery',
          sources: sourcesOf(),
          attempted: [],
        }),
      ).rejects.toThrow(
        /revoking the sessions failed \(the password change was refused, nothing was written\): synthetic database failure/,
      );
      // Nothing was queued or written, nothing applied: the file keeps its
      // bytes — the OLD hash is what remains effective (§6.2) — and the
      // reload the write would have ridden never ran.
      expect(await h.readRaw()).toBe(initial);
      expect(h.reload.calls).toBe(0);
    });
  });

  it('reports already-revoked sessions arm-truly when the mutation fails after revocation', async () => {
    await withStores({}, async (h) => {
      h.repository.deleteAllSessionsReturns = 2;
      h.reload.next({
        ok: false,
        outcome: 'rejected',
        problems: ['app.timezone: expected a string, got a number'],
      });
      // The safe-direction residual (D-184), in its reload-rejected arm:
      // sessions gone, the change not applied — and the FILE ahead of
      // memory (the write ran before the rejected reload), which is why
      // the annotation states the file's state as uncertain instead of
      // claiming the current password is what a next sign-in needs.
      const failure = (await h.settingsStore
        .apply({
          config: parsed({ app: { timezone: 'UTC' } }),
          pendingPassword: 'correct-horse-battery',
          sources: sourcesOf(),
          attempted: [],
        })
        .catch((error) => error)) as Error;
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toMatch(
        /configuration reload rejected after the mutation.*2 stored sessions had already been revoked — the running service keeps the current password, and the configuration file may already hold the new hash, which a later reload would apply/,
      );
      // The file-ahead half of the arm, asserted: the new hash IS on disk.
      const file = JSON.parse(await h.readRaw()) as { auth?: { passwordHash?: string } };
      expect(file.auth?.passwordHash).toMatch(/^scrypt\$N=/);
      // The wrapper preserves the original failure as its cause.
      expect((failure.cause as Error).message).toMatch(
        /configuration reload rejected after the mutation/,
      );
    });
  });

  it('revokes before even the mutation file read — the placement pin (D-184)', async () => {
    // A malformed file would fail the mutation's own read ("cannot modify
    // configuration file") — if that error is what surfaces, the
    // revocation sat inside the mutation; the revocation error surfacing
    // here proves it runs BEFORE the serialized mutation is entered.
    await withStores({ initialFile: '{"app": ' }, async (h) => {
      h.repository.failNextDeleteAllSessions('synthetic database failure');
      await expect(
        h.settingsStore.apply({
          config: parsed({ app: { timezone: 'UTC' } }),
          pendingPassword: 'correct-horse-battery',
          sources: sourcesOf(),
          attempted: [],
        }),
      ).rejects.toThrow(/revoking the sessions failed/);
    });
  });

  it('rethrows the bare failure when the revocation deleted nothing', async () => {
    await withStores({}, async (h) => {
      h.reload.next({
        ok: false,
        outcome: 'rejected',
        problems: ['app.timezone: expected a string, got a number'],
      });
      const failure = (await h.settingsStore
        .apply({
          config: parsed({ app: { timezone: 'UTC' } }),
          pendingPassword: 'correct-horse-battery',
          sources: sourcesOf(),
          attempted: [],
        })
        .catch((error) => error)) as Error;
      // The catch makes the success type reachable; prove it is not.
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toMatch(/configuration reload rejected after the mutation/);
      // A zero-count revocation lost nothing: no annotation noise.
      expect(failure.message).not.toMatch(/revoked/);
    });
  });

  it('never rewrites the stored hash when no password is supplied', async () => {
    await withStores({}, async (h) => {
      await h.settingsStore.apply({
        config: parsed({ app: { timezone: 'UTC' } }),
        pendingPassword: 'correct-horse-battery',
        sources: sourcesOf(),
        attempted: [],
      });
      const stored = await h.readRaw();
      await h.settingsStore.apply({
        config: parsed({ app: { timezone: 'UTC', pollingIntervalSeconds: 120 } }),
        pendingPassword: undefined,
        sources: sourcesOf(),
        attempted: ['app.pollingIntervalSeconds'],
      });
      const after = JSON.parse(await h.readRaw()) as {
        app: Record<string, unknown>;
        auth: Record<string, unknown>;
      };
      expect(after.app.pollingIntervalSeconds).toBe(120);
      expect(after.auth.passwordHash).toBe(
        (JSON.parse(stored) as { auth: { passwordHash: string } }).auth.passwordHash,
      );
      expect(h.repository.deleteAllSessionsCalls).toBe(1);
    });
  });
});
