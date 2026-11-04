import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The license-gate self-exclusion guard (task U-032, spec §4.3, §4.4;
 * decision D-155).
 *
 * `scripts/check-licenses.mjs` excludes the repository's own package from the
 * unapproved-license gate (license-checker reports it as UNLICENSED because
 * the package is private). The exclusion was once pinned as the exact
 * license-checker key `quotameter@0.0.0` — a version-qualified string that
 * went stale at the first release version bump and failed the gate on the
 * project's own package (verified live before the fix: a scratch bump to
 * 999.9.9 produced `UNAPPROVED quotameter@999.9.9: UNLICENSED`).
 *
 * D-155's policy: match by NAME, read from package.json at runtime. The
 * script has top-level side effects, so it cannot be imported; this spec
 * pins the policy by EXTRACTING AND EXECUTING the script's own code — the
 * release-workflow/coverage-thresholds structural pattern, hardened after
 * the task's review round (deepseek-v4.1-flash) demonstrated that text-only
 * pins are evadable: the real `packageNameOf` is cut out of the source and
 * run over the key table (no spec-local mirror to drift), and the real SELF
 * initializer is evaluated with the manifest read stubbed — against the
 * current manifest and a scratch-bumped one — asserting the entry set is
 * exactly the package name in both cases (the done-condition: a version
 * bump cannot change the exclusion). Text pins remain only where execution
 * cannot reach: the SELF construction's shape, the wiring of the skip, and
 * the whole-script ban on quoted `name@x.y` literals.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-licenses.mjs');

/** The same manifest the script reads at runtime — same-process truth. */
const MANIFEST = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};

/** A version no release will ever collide with; must differ from the current one. */
const SCRATCH_VERSION = '999.9.9-scratch-bump.0';

function scriptSource(): string {
  return readFileSync(SCRIPT, 'utf8');
}

/** The captured body of the script's `const SELF = new Set([...]);` literal. */
function selfSetBody(): string {
  const [, body] = /const SELF = new Set\(\[([\s\S]*?)\]\);/.exec(scriptSource()) ?? [];
  if (body === undefined) {
    throw new Error(
      'scripts/check-licenses.mjs lost its `const SELF = new Set([...])` exclusion — the ' +
        'private package reports UNLICENSED and would fail the gate; restore the ' +
        'self-exclusion or update this guard together with the new mechanism',
    );
  }
  return body;
}

/**
 * The script's own `packageNameOf`, cut out of the source and compiled — the
 * positive control runs the REAL function, never a spec-local mirror of it,
 * so a semantic edit to the helper fails here instead of passing silently.
 */
function extractedPackageNameOf(): (key: string) => string {
  const declaration = /function packageNameOf\(key\) \{[\s\S]*?\n\}/.exec(scriptSource());
  if (declaration === null) {
    throw new Error(
      'scripts/check-licenses.mjs lost its `function packageNameOf(key)` helper — the ' +
        'self-exclusion cannot reduce checker keys to their name part (D-155); restore ' +
        'it or update this guard together with the new mechanism',
    );
  }
  const factory = new Function(`return (${declaration[0]});`) as () => (key: string) => string;
  return factory();
}

/**
 * Evaluates the script's real SELF initializer with the manifest read
 * stubbed to `manifest` (nothing touches the disk) and returns the entry
 * array the script would build from it. `import.meta.url` is rewritten to
 * the script's own URL because `new Function` bodies are scripts, not
 * modules, and cannot parse `import.meta`; the construction pin holds that
 * exact substring in place, so the rewrite always hits.
 */
function evaluateSelfEntries(manifest: { name: string; version: string }): string[] {
  const body = selfSetBody();
  if (!body.includes('import.meta.url')) {
    throw new Error(
      'the SELF construction no longer anchors its manifest read at `import.meta.url` — ' +
        'this evaluator rewrites that exact expression to stub the read; update this ' +
        'guard together with the new mechanism',
    );
  }
  const factory = new Function(
    'readFileSync',
    'scriptModuleUrl',
    `return [${body.replaceAll('import.meta.url', 'scriptModuleUrl')}];`,
  ) as (readFileSync: (...args: unknown[]) => string, scriptModuleUrl: string) => string[];
  return factory(() => JSON.stringify(manifest), pathToFileURL(SCRIPT).href);
}

describe('license gate self-exclusion (task U-032, spec §4.3/§4.4; decision D-155)', () => {
  it('the self-exclusion name is read from package.json at runtime', () => {
    const body = selfSetBody();
    expect(
      body.includes('package.json') && /\.name\b/.test(body),
      'the SELF exclusion must derive its entry from package.json `.name` at ' +
        'runtime (D-155): a hardcoded entry rots on a package rename exactly the way ' +
        'the old version-qualified pin rotted on a version bump',
    ).toBe(true);
    expect(
      body,
      'the manifest read must stay anchored at the script location ' +
        '(`import.meta.url`) — cwd-independent, and the evaluator below rewrites ' +
        'this exact expression to stub the read',
    ).toContain('import.meta.url');
    expect(
      body,
      'no `@` may appear in the SELF construction — D-155 is name-only, and any `@` ' +
        'is how a version-qualified identity sneaks back in (the literal pin below and ' +
        'the evaluated entry-set pin above it catch it, this fails first and loudest)',
    ).not.toMatch(/@/);
    expect(
      body,
      'the construction must not read the manifest `.version` — the rejected D-155 ' +
        'alternative (interpolating the version back into the entry) is exactly the ' +
        'U-032 defect in runtime form',
    ).not.toMatch(/\.version\b/);
  });

  it('the gate script carries no quoted version-qualified package literal', () => {
    // The old pin was exactly the quoted literal 'quotameter@0.0.0'; backtick
    // prose in comments (the scoped-key example in packageNameOf's docblock)
    // stays legal.
    expect(
      scriptSource(),
      'a quoted `name@x.y` literal crept into scripts/check-licenses.mjs — ' +
        'version-qualified package identities are the U-032 defect class; match by ' +
        'name instead',
    ).not.toMatch(/'[^'\n]*@\d+\.\d+[^'\n]*'/);
  });

  it('checker keys are matched by their name part', () => {
    const source = scriptSource();
    expect(
      source,
      'the skip must compare the NAME part of each license-checker key, not the whole ' +
        '`name@version` key (D-155) — a whole-key comparison re-couples the exclusion to ' +
        'the version, the U-032 defect; keep `excludeNames.has(packageNameOf(name))` or ' +
        'update this guard together with the new mechanism',
    ).toContain('excludeNames.has(packageNameOf(name))');
    expect(
      source,
      'the name-part split must sit at the LAST `@` so scoped keys ' +
        "(`@scope/pkg@1.2.3`) keep their scope — keep `key.lastIndexOf('@')` or update " +
        'this guard together with the new mechanism',
    ).toContain("key.lastIndexOf('@')");
  });

  it('the real packageNameOf splits keys at the last @ (positive control)', () => {
    const packageNameOf = extractedPackageNameOf();
    expect(packageNameOf('quotameter@0.0.0')).toBe('quotameter');
    expect(packageNameOf(`quotameter@${SCRATCH_VERSION}`)).toBe('quotameter');
    expect(packageNameOf('@scope/pkg@1.2.3')).toBe('@scope/pkg');
    // Keys without a version part are returned unchanged — the name already.
    expect(packageNameOf('quotameter')).toBe('quotameter');
    expect(packageNameOf('@scope/pkg')).toBe('@scope/pkg');
  });

  it('the evaluated SELF entry set is exactly the package name, at the current and a scratch-bumped version', () => {
    expect(MANIFEST.name, 'package.json must carry a package name').not.toBe('');
    expect(
      SCRATCH_VERSION,
      'the scratch version must differ from the current one or this pin proves nothing',
    ).not.toBe(MANIFEST.version);
    expect(
      evaluateSelfEntries(MANIFEST),
      'the exclusion set the script builds today must hold exactly the package name ' +
        '— one entry, nothing hardcoded beside it',
    ).toEqual([MANIFEST.name]);
    expect(
      evaluateSelfEntries({ ...MANIFEST, version: SCRATCH_VERSION }),
      'the entry must not change after a hypothetical release bump — a ' +
        'version-dependent entry (however built: literal or interpolated) is the ' +
        'U-032 defect, and this evaluation of the real construction fails on it',
    ).toEqual([MANIFEST.name]);
  });

  it('a scratch version bump keeps the self-entry matching (the U-032 done-condition)', () => {
    const packageNameOf = extractedPackageNameOf();
    // The exclusion set the script would build from the scratch-bumped
    // manifest, applied with the script's own name-part reduction.
    const self = new Set(evaluateSelfEntries({ ...MANIFEST, version: SCRATCH_VERSION }));
    const excluded = (key: string): boolean => self.has(packageNameOf(key));
    // license-checker reports each package as `name@version`: the self entry
    // after the bump — the exact key the old pin failed on — stays excluded,
    // as does today's self entry.
    expect(excluded(`${MANIFEST.name}@${SCRATCH_VERSION}`)).toBe(true);
    expect(excluded(`${MANIFEST.name}@${MANIFEST.version}`)).toBe(true);
    // The exclusion matches nothing else at either version: a foreign
    // package's license verdict must never be swallowed silently.
    expect(excluded(`unrelated-pkg@${SCRATCH_VERSION}`)).toBe(false);
    expect(excluded(`unrelated-pkg@${MANIFEST.version}`)).toBe(false);
    expect(excluded(`@scope/unrelated@${SCRATCH_VERSION}`)).toBe(false);
  });
});
