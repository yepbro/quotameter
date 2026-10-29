import { describe, expect, it } from 'vitest';
import type { BoundaryParser, Validated } from '../../src/schemas/boundary';

/**
 * Locks the boundary-parser contract shape described in
 * docs/architecture/trust-boundaries.md: exactly-once validation with
 * field-addressed problems and no partial data.
 */
const demoParser: BoundaryParser<{ port: number }> = {
  parse(input: unknown) {
    if (typeof input !== 'object' || input === null || !('port' in input)) {
      return { ok: false, problems: ['root: expected an object with a port field'] };
    }
    const port = (input as { port: unknown }).port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, problems: ['port: expected an integer between 1 and 65535'] };
    }
    return { ok: true, value: { port } as Validated<{ port: number }> };
  },
};

describe('boundary parser contract', () => {
  it('accepts valid input and returns the validated value', () => {
    const result = demoParser.parse({ port: 8080 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.port).toBe(8080);
    }
  });

  it('rejects invalid input with field-addressed problems', () => {
    expect(demoParser.parse('not an object')).toEqual({
      ok: false,
      problems: ['root: expected an object with a port field'],
    });
    expect(demoParser.parse({ port: 99999 })).toEqual({
      ok: false,
      problems: ['port: expected an integer between 1 and 65535'],
    });
  });
});
