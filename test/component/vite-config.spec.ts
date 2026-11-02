import { describe, expect, it } from 'vitest';
import viteConfig from '../../ui/vite.config';

/**
 * The build contract's configuration pin (decisions D-127, D-129): the
 * two `build` settings that shape the output for the served CSP have no
 * observable effect while the UI references no sub-4 KiB asset — a
 * deleted line would change nothing else in the tree — so their presence
 * is pinned executably against the resolved config object, immune to
 * formatting. Lives in the component project because `ui/tsconfig.json`
 * is the single type-checking project for `ui/**` and its specs.
 */
describe('ui vite build contract', () => {
  it('never inlines assets as data: URIs (img-src/font-src admit none)', () => {
    expect(viteConfig.build?.assetsInlineLimit).toBe(0);
  });

  it('empties the output directory, including the out-of-root DIST_DIR', () => {
    expect(viteConfig.build?.emptyOutDir).toBe(true);
  });
});
