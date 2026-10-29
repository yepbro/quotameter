/**
 * Hermetic `process.env` control for the default-environment seams
 * (decision D-028).
 *
 * The testing convention is that environments are injected object literals;
 * `process.env` is never mutated. The two production seams whose *default*
 * is `process.env` (`createConfigReloader`'s snapshot, and any future
 * no-argument call through `loadConfigWithEnv`) can only be exercised
 * through `process.env` itself, so this helper narrows the sanctioned
 * exception to one shape: run `body` with every `QUOTAMETER_*` variable
 * replaced by exactly the given `vars`, and restore the complete prior
 * state afterwards — including keys that were absent before — even when
 * the body throws. Nothing leaks across tests.
 */

/** Every variable this helper may touch carries this prefix (decision D-023). */
const PREFIX = 'QUOTAMETER_';

/**
 * Runs `body` with `process.env` carrying exactly `vars` among the
 * `QUOTAMETER_*` variables; all other environment entries are untouched.
 * The prior `QUOTAMETER_*` state is restored in `finally`. Refuses
 * non-`QUOTAMETER_*` names — a key the restore pass would not remove is
 * exactly the cross-test leak this helper exists to prevent.
 */
export async function withQuotameterEnv(
  vars: Readonly<Record<string, string>>,
  body: () => Promise<void> | void,
): Promise<void> {
  for (const name of Object.keys(vars)) {
    if (!name.startsWith(PREFIX)) {
      throw new Error(`withQuotameterEnv accepts only ${PREFIX}* variables, got '${name}'`);
    }
  }
  const saved = new Map<string, string>();
  for (const name of Object.keys(process.env)) {
    if (!name.startsWith(PREFIX)) continue;
    const value = process.env[name];
    if (typeof value === 'string') saved.set(name, value);
  }
  const restore = (): void => {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith(PREFIX)) delete process.env[name];
    }
    for (const [name, value] of saved) {
      process.env[name] = value;
    }
  };
  try {
    for (const name of saved.keys()) delete process.env[name];
    for (const [name, value] of Object.entries(vars)) process.env[name] = value;
    await body();
  } finally {
    restore();
  }
}
