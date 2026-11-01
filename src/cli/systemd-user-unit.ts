/**
 * systemd user unit generation and structural validation (task 135, spec
 * §5.3 step 7 / §5.4, decision D-104) — the user-unit twin of
 * `systemd-unit.ts` (task 134, D-103), composed from its shared blocks
 * (`renderUnitFile`, `assertUnitPathInput`, `assertUnitRestartSecSeconds`,
 * `checkUnitShape` with the exported check builders, and the pinned
 * Description/Documentation) rather than forked.
 *
 * §5.4's first sentence prescribes directives for **units** — absolute
 * Node/CLI paths, `Restart=on-failure` with a configurable `RestartSec`,
 * `After=`/`Wants=network-online.target`,
 * `Environment=NODE_ENV=production`, journald output — and only the
 * hardening sentence splits by manager kind ("for system units … use a
 * compatible minimal hardening set for user units"). The user unit therefore
 * keeps those directives verbatim and adapts exactly what the per-user
 * service manager cannot apply (decision D-104, verified against
 * systemd.exec(7)):
 *
 * - **No `User=`/`Group=` at all.** "These options are only available for
 *   system services and are not supported for services running in per-user
 *   instances of the service manager"; for a non-root user's services
 *   "switching user identity is not permitted, hence the only valid setting
 *   is the same user the user's service manager is running as". The user
 *   manager already runs the service as the owning regular account — §5.1's
 *   never-root holds by construction, and `UserUnitInput` has no user or
 *   group field to get wrong.
 * - **The compatible minimal hardening set is `NoNewPrivileges=true` only.**
 *   In user services "the various settings requiring file system namespacing
 *   support (such as ProtectSystem=) are not available, as the underlying
 *   kernel functionality is only accessible to privileged processes" (they
 *   need `PrivateUsers=true` and unprivileged-userns support), so
 *   `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome=read-only`, and the
 *   `ReadWritePaths` that re-opens holes in them are omitted;
 *   `NoNewPrivileges` is a prctl the unprivileged manager can always apply.
 *   Write protection in user mode is the application's own §6.3 permission
 *   discipline (config `0600`, directories `0700`).
 * - **`WantedBy=default.target`** — the user manager ships `default.target`
 *   and no `multi-user.target` (verified against systemd's `units/user/`
 *   tree), so the system unit's enable target would dangle there.
 * - **`After=`/`Wants=network-online.target` kept verbatim**: the user
 *   manager ships no such target, ordering against a missing unit is
 *   trivially satisfied and a `Wants=` on a missing unit has no effect —
 *   benign, and §5.4 prescribes the directives without a user-unit
 *   exception.
 *
 * Everything else carries over from D-103: `Type=exec` (a stale Node/CLI
 * path fails the start visibly), the pinned `Description`/`Documentation`,
 * `RestartSec` rendered `<n>s` from whole seconds ≥ 1, no `WorkingDirectory`
 * (stale-path economy), journald `StandardOutput`/`StandardError`, and
 * deterministic byte-identical output — the property `service install`'s
 * regeneration (§5.4) and `doctor`'s staleness check build on.
 * `UserUnitInput` has no secret-carrying field of any kind, and
 * {@link validateUserUnit} enforces the read-back half: any `Environment=`
 * line other than `NODE_ENV=production` is a problem whose message never
 * reproduces the divergent value.
 *
 * As with task 134, nothing here touches the filesystem or systemd:
 * installing under `~/.config/systemd/user/`, `systemctl --user enable`,
 * and linger guidance are tasks 137–139.
 */

import * as path from 'node:path';
import {
  UNIT_DESCRIPTION,
  UNIT_DOCUMENTATION,
  assertUnitPathInput,
  assertUnitRestartSecSeconds,
  checkUnitShape,
  expectUnitExecStartRun,
  expectUnitProductionEnvironment,
  expectUnitTimeSpan,
  expectUnitTruthyBoolean,
  expectUnitValue,
  renderUnitFile,
} from './systemd-unit';
import type { UnitShape } from './systemd-unit';

/**
 * The user unit's file name (spec §5.3 step 7: `~/.config/systemd/user/`).
 * Deliberately the same file name as the system unit's: the system and user
 * managers keep separate unit namespaces, so the two never collide — and a
 * machine with both installed gets two independently managed services.
 */
export const USER_UNIT_NAME = 'quotameter.service';

/**
 * Inputs of the generated user unit (spec §5.4). Every path is absolute and
 * injection-safe (validated by {@link assertUnitPathInput}); there is
 * deliberately no user, group, config-directory, or data-directory field —
 * the user manager runs the service as the owning account and applies no
 * mount-namespace hardening (see the module header) — and no
 * secret-carrying field of any kind: §5.4 forbids secrets in unit files,
 * and an input that cannot carry one cannot leak one.
 */
export interface UserUnitInput {
  /** Absolute path of the Node binary — at runtime `process.execPath`. */
  nodePath: string;
  /** Absolute path of the CLI entry point (`bin/quotameter.mjs`). */
  cliPath: string;
  /** Restart delay in seconds, rendered as `RestartSec=<n>s`. */
  restartSecSeconds: number;
}

/**
 * Where task 139 installs the generated user unit for a given home
 * directory (spec §5.3 step 7's literal `~/.config/systemd/user/` — the
 * default XDG layout; honoring a custom `XDG_CONFIG_HOME` is the installer's
 * decision, not the generator's). The home directory is validated by
 * {@link assertUnitPathInput}: absolute, whitespace-free, and free of the
 * systemd metacharacters this generator does not escape — the same
 * injection guard every interpolated unit value passes.
 */
export function userUnitInstallPath(homeDir: string): string {
  assertUnitPathInput('homeDir', homeDir);
  return path.join(homeDir, '.config', 'systemd', 'user', USER_UNIT_NAME);
}

/**
 * Builds the user unit content (spec §5.4) from validated inputs.
 *
 * The directive set is §5.4's first sentence plus the systemd minimum, with
 * the user-manager adaptations of decision D-104 (module header): no
 * `User=`/`Group=` (the manager owns the identity), no mount-namespace
 * hardening (unavailable unprivileged) — `NoNewPrivileges=true` is the
 * compatible minimal hardening set — and `WantedBy=default.target` (the
 * user manager's own default target).
 *
 * @returns the complete unit file content, `\n`-terminated.
 * @throws {@link Error} naming the offending field when an input violates
 *   the §5.4 rules above.
 */
export function buildUserUnit(input: UserUnitInput): string {
  assertUnitPathInput('nodePath', input.nodePath);
  assertUnitPathInput('cliPath', input.cliPath);
  assertUnitRestartSecSeconds(input.restartSecSeconds);

  return renderUnitFile([
    [
      'Unit',
      [
        `Description=${UNIT_DESCRIPTION}`,
        `Documentation=${UNIT_DOCUMENTATION}`,
        'After=network-online.target',
        'Wants=network-online.target',
      ],
    ],
    [
      'Service',
      [
        'Type=exec',
        // `quotameter run` is the foreground command systemd supervises (§5.2).
        `ExecStart=${input.nodePath} ${input.cliPath} run`,
        'Environment=NODE_ENV=production',
        'Restart=on-failure',
        `RestartSec=${input.restartSecSeconds}s`,
        // The §5.4 compatible minimal user hardening set: NoNewPrivileges
        // needs no privileges to apply; the namespacing directives the
        // system unit carries (PrivateTmp, ProtectSystem=strict,
        // ProtectHome=read-only, ReadWritePaths) are unavailable to the
        // unprivileged user manager (D-104).
        'NoNewPrivileges=true',
        'StandardOutput=journal',
        'StandardError=journal',
      ],
    ],
    ['Install', ['WantedBy=default.target']],
  ]);
}

/**
 * The strict shape of the generated user unit: the system unit's shape minus
 * the system-only directives (`User`, `Group`, `PrivateTmp`,
 * `ProtectSystem`, `ProtectHome`, `ReadWritePaths` — their presence in a
 * user unit is an unexpected-directive problem) and with
 * `WantedBy=default.target` instead of `multi-user.target`. `Description`/
 * `Documentation` stay allowed-but-unpinned, exactly as in the system shape.
 */
const USER_UNIT_SHAPE: UnitShape = {
  allowedKeys: {
    Unit: ['Description', 'Documentation', 'After', 'Wants'],
    Service: [
      'Type',
      'ExecStart',
      'Environment',
      'Restart',
      'RestartSec',
      'NoNewPrivileges',
      'StandardOutput',
      'StandardError',
    ],
    Install: ['WantedBy'],
  },
  contract: [
    {
      section: 'Unit',
      key: 'After',
      required: true,
      check: expectUnitValue('network-online.target'),
    },
    {
      section: 'Unit',
      key: 'Wants',
      required: true,
      check: expectUnitValue('network-online.target'),
    },
    { section: 'Service', key: 'Type', required: true, check: expectUnitValue('exec') },
    { section: 'Service', key: 'ExecStart', required: true, check: expectUnitExecStartRun },
    {
      section: 'Service',
      key: 'Environment',
      required: true,
      check: expectUnitProductionEnvironment,
    },
    { section: 'Service', key: 'Restart', required: true, check: expectUnitValue('on-failure') },
    { section: 'Service', key: 'RestartSec', required: true, check: expectUnitTimeSpan },
    { section: 'Service', key: 'NoNewPrivileges', required: true, check: expectUnitTruthyBoolean },
    {
      section: 'Service',
      key: 'StandardOutput',
      required: true,
      check: expectUnitValue('journal'),
    },
    { section: 'Service', key: 'StandardError', required: true, check: expectUnitValue('journal') },
    {
      section: 'Install',
      key: 'WantedBy',
      required: true,
      check: expectUnitValue('default.target'),
    },
  ],
};

/**
 * Structurally validates unit content against the §5.4 user-unit contract
 * (decision D-104). Returns problem strings (empty array = valid) via the
 * shared {@link checkUnitShape} engine: parse problems, missing or
 * wrong-valued contract directives, duplicate keys, unexpected sections and
 * directives — including every system-only directive, so a system unit
 * pasted into `~/.config/systemd/user/` is rejected, not silently
 * reinterpreted — and **any** `Environment=` line other than
 * `NODE_ENV=production` (the mechanical no-secrets rule, whose message
 * never reproduces the divergent value).
 *
 * As with the system unit, validation is structural by measured necessity:
 * the development container and CI images ship no systemd.
 */
export function validateUserUnit(content: string): string[] {
  return checkUnitShape(content, USER_UNIT_SHAPE);
}
