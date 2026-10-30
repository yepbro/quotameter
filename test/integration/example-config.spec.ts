import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfigFile } from '../../src/config/load';

/**
 * Locks the published example configuration to the verified Z.ai peak-hours
 * schedule (task 112, spec §9.1–§9.2). The example under `docs/` is data, not
 * code: its contract is that it loads cleanly through the real configuration
 * boundary (the D-018 pipeline — JSON, schema, defaults, cross-field
 * invariants) and encodes exactly the schedule the official Z.ai documentation
 * states: Monday–Friday 14:00–18:00 Asia/Singapore, peak multiplier 1.0 (the
 * standard credit rate), off-peak multiplier 0.5 ("charged at 50% of the
 * standard credit rate").
 *
 * Provenance — source URLs and retrieval dates — is documentation, not JSON:
 * the contract closes every object (`additionalProperties: false`, decision
 * D-014), so a provenance key inside the example would make it unloadable by
 * the very parser this spec exercises. The task-112 dossier section carries it
 * instead and is checked below.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXAMPLE_CONFIG = path.join(REPO_ROOT, 'docs', 'config.example.json');
const PROVIDER_DOSSIER = path.join(REPO_ROOT, 'docs', 'providers', 'zai-coding-plan.md');

/**
 * The schedule exactly as the official sources state it (spec §9.1; dossier
 * sources 1 and 14, retrieved 2026-10-30): the window verbatim from the spec's
 * own §9.2 sample, in the canonical form the parser returns — `multiplier`
 * completed to its default 1 (the peak rate).
 */
const VERIFIED_PEAK_HOURS = {
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
};

/** One dossier section or subsection, from its heading to the next heading. */
function dossierSection(heading: string): string {
  const text = readFileSync(PROVIDER_DOSSIER, 'utf8');
  const start = text.indexOf(heading);
  expect(start, `dossier must contain the heading '${heading}'`).toBeGreaterThanOrEqual(0);
  const next = text.indexOf('\n## ', start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

describe('example configuration encodes the verified Z.ai schedule', () => {
  it('loads cleanly through the configuration boundary parser', async () => {
    const result = await loadConfigFile(EXAMPLE_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.providers?.['zai-coding-plan']?.peakHours).toEqual(VERIFIED_PEAK_HOURS);
      expect(result.config.providers?.['zai-coding-plan']?.requestTimeoutSeconds).toBe(15);
    }
  });

  it('encodes the schedule in exactly one provider and no secret values', async () => {
    const result = await loadConfigFile(EXAMPLE_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.config.providers ?? {})).toEqual(['zai-coding-plan']);
      // The example demonstrates the environment-variable secret source
      // (spec §6.3): no key-shaped placeholder belongs in a committed file.
      expect(result.config.accounts).toEqual([
        {
          id: 'zai-main',
          providerId: 'zai-coding-plan',
          label: 'Personal GLM Coding Plan',
          enabled: true,
          apiKeyEnv: 'ZAI_CODING_PLAN_API_KEY',
        },
      ]);
    }
  });

  it('documents provenance: official source, retrieval dates, artifact path', () => {
    // URLs and dates are pinned to the Provenance subsection, whose heading
    // carries no date itself — the section heading does (found in review), so
    // slicing from it would let these assertions survive a deleted table.
    const provenance = dossierSection('### Provenance');
    // The official source and its verbatim corroborator (dossier sources 1 and 14).
    expect(provenance).toContain('https://docs.z.ai/devpack/overview');
    expect(provenance).toContain('https://docs.z.ai/devpack/teamplan');
    // Spec §9.1's check and task 094's re-verification.
    expect(provenance).toContain('2026-10-28');
    expect(provenance).toContain('2026-10-30');
    // The task-112 section must point at the artifact it documents.
    expect(dossierSection('## Peak-schedule encoding')).toContain('docs/config.example.json');
  });
});
