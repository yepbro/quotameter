import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The dev-container uid-remap guard (decision D-181; no plan task — the
 * 2026-11-06 EACCES incident at commit `67b75c1`).
 *
 * The development container runs as the host user: the Makefile exports
 * `DEV_UID`/`DEV_GID`, `compose.yaml` passes them as build args, and the
 * Dockerfile remaps its `node` user onto them. Every piece of that wiring
 * is three plain-text files away from silent regression — a dropped `ARG`,
 * a removed compose build arg, or a Makefile edit that stops exporting the
 * ids rebuilds the image at the 1000:1000 defaults, and on a host whose
 * user is not uid 1000 the EACCES class returns (container rewrites of
 * host-owned tracked files fail again, and after migration the volumes are
 * host-owned, so a defaults rebuild breaks the volumes' writes too). This
 * spec pins the wiring the way `test/unit/release-workflow.spec.ts` pins
 * the release channel: a line scanner over the three files, every failure
 * mode a loud message telling the editor to keep the guard in step with
 * any mechanism change.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const dockerfile = readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
const compose = readFileSync(path.join(REPO_ROOT, 'compose.yaml'), 'utf8');
const makefile = readFileSync(path.join(REPO_ROOT, 'Makefile'), 'utf8');

describe('dev container uid remap (decision D-181)', () => {
  it('the Dockerfile declares DEV_UID/DEV_GID build args with 1000:1000 defaults', () => {
    for (const arg of ['ARG DEV_UID=1000', 'ARG DEV_GID=1000']) {
      expect(
        dockerfile.includes(arg),
        `the Dockerfile no longer declares "${arg}" — the remap has no input; ` +
          'restore the ARG (see docs/agents/environment.md, "Matching the host ' +
          'user") or update this guard with the new mechanism',
      ).toBe(true);
    }
  });

  it('the remap is guarded, collision-checked, and re-chowns the volume seed dirs', () => {
    // The remap must refuse an id another image account/group holds instead
    // of crashing in usermod/groupmod, and must skip both steps entirely at
    // the 1000:1000 defaults.
    for (const line of [
      'usermod -u "$DEV_UID" node',
      'groupmod -g "$DEV_GID" node',
      'getent passwd "$DEV_UID"',
      'getent group "$DEV_GID"',
      'chown -R node:node /app /home/node /var/lib/quotameter',
    ]) {
      expect(
        dockerfile.includes(line),
        `the Dockerfile remap step no longer contains "${line}" — the guard ` +
          'shape changed; restore it or update this guard with the new mechanism ' +
          '(decision D-181 pins the collision pre-check and the volume-seed chown)',
      ).toBe(true);
    }
  });

  it('the container user stays the named node user (a passwd entry must survive)', () => {
    expect(
      /^USER node$/m.test(dockerfile),
      'the Dockerfile no longer runs as the named "node" user — a numeric USER ' +
        'breaks HOME=/home/node resolution (npm/Playwright cache paths); see ' +
        'decision D-181 interpretation (1)',
    ).toBe(true);
  });

  it('compose passes the host ids as build args of the dev service', () => {
    for (const arg of ['DEV_UID: ${DEV_UID:-1000}', 'DEV_GID: ${DEV_GID:-1000}']) {
      expect(
        compose.includes(arg),
        `compose.yaml no longer passes "${arg}" as a build arg — builds fall ` +
          'back to the image defaults whatever the Makefile exports; restore the ' +
          'arg or update this guard with the new mechanism',
      ).toBe(true);
    }
  });

  it('the Makefile exports the host uid/gid so make-driven builds remap', () => {
    for (const line of ['export DEV_UID := $(shell id -u)', 'export DEV_GID := $(shell id -g)']) {
      expect(
        makefile.includes(line),
        `the Makefile no longer contains "${line}" — make-driven builds stop ` +
          'remapping the container user; restore the export or update this guard ' +
          'with the new mechanism',
      ).toBe(true);
    }
  });

  it('the image declares the passwd tools the remap runs', () => {
    expect(
      /apt-get install -y --no-install-recommends[^\n]*\bpasswd\b/.test(dockerfile),
      'the Dockerfile apt install no longer includes "passwd" (usermod/groupmod) ' +
        '— the remap relies on the base image shipping it implicitly; declare it ' +
        'explicitly (decision D-181) or update this guard with the new mechanism',
    ).toBe(true);
  });
});
