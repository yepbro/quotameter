import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LINGER_FLAG_DIR,
  probeUserLinger,
  renderLingerGuidance,
  statLingerFlagPresence,
  type LingerFlagPresence,
} from '../../src/cli/service-linger';
import { createTempDir } from '../helpers/isolation';

/**
 * The user-service linger detection and guidance layer (task 138, spec
 * §5.3 step 7's user-unit bullet, decision D-107): the flag-file tri-state
 * probe and the per-state guidance the service-setup step renders.
 *
 * The production classifier is additionally driven against the real
 * filesystem (temp directories): the container and CI images ship no
 * systemd, which is exactly the `ENOENT` world the default probe sees —
 * and their unprivileged uid makes a 000-mode directory a real `EACCES`,
 * so the `unknown` arm is exercised by the kernel, not by a mock.
 */

describe('probeUserLinger — the flag-file tri-state (D-107)', () => {
  it('present flag file is enabled, absent is disabled, other stat errors are unknown', () => {
    const probe = (presence: LingerFlagPresence) =>
      probeUserLinger('alice', { presence: () => presence });
    expect(probe('present')).toBe('enabled');
    expect(probe('absent')).toBe('disabled');
    expect(probe('stat-error')).toBe('unknown');
  });

  it('probes the flag file under the linger directory, by owner name', () => {
    const seen: string[] = [];
    probeUserLinger('alice', {
      presence: (path) => {
        seen.push(path);
        return 'absent';
      },
    });
    expect(seen).toEqual([join(LINGER_FLAG_DIR, 'alice')]);
  });

  it('the production default sees ENOENT on the systemd-less container', () => {
    // No /var/lib/systemd/linger exists there — the deterministic
    // `disabled` every default-probed step run observes in CI.
    expect(probeUserLinger('alice')).toBe('disabled');
  });
});

describe('statLingerFlagPresence — the production classifier against the real fs', () => {
  it('classifies an existing file, a missing path, and a missing parent directory', async () => {
    const dir = await createTempDir('qm-linger-flag-');
    try {
      const flag = join(dir.path, 'alice');
      await writeFile(flag, '');
      expect(statLingerFlagPresence(flag)).toBe('present');
      expect(statLingerFlagPresence(join(dir.path, 'bob'))).toBe('absent');
      // A missing flag directory means no user has a flag — still the
      // definite disabled answer, not an error.
      expect(statLingerFlagPresence(join(dir.path, 'no-such-dir', 'alice'))).toBe('absent');
    } finally {
      await dir.remove();
    }
  });

  it('an unsearchable directory is a stat error, never a silent absent', async () => {
    const dir = await createTempDir('qm-linger-eacces-');
    const locked = join(dir.path, 'locked');
    await mkdir(locked);
    try {
      await chmod(locked, 0o000);
      // The test process is unprivileged (container uid 1000), so mode
      // bits apply: statting inside yields EACCES → unknown downstream.
      expect(statLingerFlagPresence(join(locked, 'alice'))).toBe('stat-error');
    } finally {
      await chmod(locked, 0o755);
      await dir.remove();
    }
  });
});

describe('renderLingerGuidance — the §5.3 step 7 guidance per state', () => {
  it('disabled: the exact command on its own line with the logout/reboot consequence', () => {
    const text = renderLingerGuidance('alice', 'disabled');
    // Task 137's sentence verbatim, made conditional by detection.
    expect(text).toContain(
      'User services stop when their owner logs out. ' +
        'To keep the service running after logout or reboot, run:',
    );
    expect(text).toContain('\n  sudo loginctl enable-linger alice');
    expect(text.endsWith('\n  sudo loginctl enable-linger alice')).toBe(true);
  });

  it('unknown: states it could not be determined and prints the same command — never silently on', () => {
    const text = renderLingerGuidance('alice', 'unknown');
    expect(text).toContain('The linger status for alice could not be determined');
    expect(text).toContain('treated as disabled');
    // The consequence sentence and the exact command still print in full.
    expect(text).toContain('User services stop when their owner logs out.');
    expect(text).toContain('after logout or reboot');
    expect(text).toContain('\n  sudo loginctl enable-linger alice');
  });

  it('enabled: a plain confirmation with the consequence and no command', () => {
    const text = renderLingerGuidance('alice', 'enabled');
    expect(text).toContain('Linger is already enabled for alice');
    expect(text).toContain('keeps running after logout and reboot');
    expect(text).not.toContain('loginctl');
  });

  it('every state names the resolved owner', () => {
    for (const state of ['enabled', 'disabled', 'unknown'] as const) {
      expect(renderLingerGuidance('a-b_c1', state)).toContain('a-b_c1');
    }
  });
});
