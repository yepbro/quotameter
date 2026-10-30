# Configuration JSON Schema

Quotameter's `config.json` format is defined by a published JSON Schema
(spec §6.2, §18): [`schema/config.schema.json`](../schema/config.schema.json)
in the repository, shipped in the npm package at the same relative path. In a
global installation it lives at `$(npm root -g)/quotameter/schema/config.schema.json`.

The schema is **generated, not hand-written**: it is the JSON serialization of
the canonical TypeScript contract (`CONFIG_SCHEMA_DOCUMENT` in
[`src/schemas/config.ts`](../src/schemas/config.ts)), produced by
`scripts/generate-schema.mjs`. A unit test
(`test/unit/config-schema-published.spec.ts`) fails when the committed file
drifts from the contract, so the artifact cannot go stale silently.

## Example configuration

A complete, commented-by-accompaniment example lives at
[`docs/config.example.json`](config.example.json): every section at its spec
defaults, one Z.ai Coding Plan provider, one account wired to an
environment-variable key. Its `peakHours` block encodes the verified Z.ai
schedule (Monday–Friday 14:00–18:00 `Asia/Singapore`, peak multiplier `1.0`,
off-peak `0.5`); the official sources, retrieval dates, and rate semantics are
documented in the [provider dossier](providers/zai-coding-plan.md) (task 112
section), and `test/integration/example-config.spec.ts` keeps the example
loading cleanly through the real configuration parser.

## Editor validation

Associating the schema gives completion, hovers, and validation while editing
`config.json`. In VS Code (`settings.json` or `.vscode/settings.json`):

```jsonc
{
  "json.schemas": [
    {
      // Matches ~/.config/quotameter/config.json and XDG overrides.
      "fileMatch": ["*/quotameter/config.json"],
      // Copy the schema out of the installed package (or repository) once:
      //   cp "$(npm root -g)/quotameter/schema/config.schema.json" ~/quotameter.schema.json
      "url": "file:///home/you/quotameter.schema.json",
    },
  ],
}
```

Other editors and CLI validators work the same way — point any JSON Schema
tooling at the file. The document declares
[$schema: draft 2020-12](https://json-schema.org/draft/2020-12/schema), which
current editors and Ajv v8 support out of the box.

## Structural and semantic validation

The published schema carries the **structural** rules of the contract: types,
ranges, patterns, closed enums, spec defaults, and unknown-key rejection
(`additionalProperties: false`) at every level.

Some rules are **cross-field** and live in the application instead (decision
D-014, spec §6.2): exactly one of `apiKey`/`apiKeyEnv` per account, unique
account and window ids, valid IANA time zone names, `start < end` and
non-overlapping peak windows on the same day, and the password requirements
for non-loopback binds or `auth.mode: required` (spec §15.1). A file that
passes this schema can therefore still be rejected — with an explanatory
message — at startup or `quotameter reload`. The same split is why the
document is marked "structural validation only" in its description.

## Regenerating

After changing `src/schemas/config.ts`:

```console
$ make schema
```

`make schema` regenerates the file inside the development container and
writes `schema/config.schema.json` back to the repository from the host side:
the container runs as uid 1000 and must not write into the bind-mounted source
tree, so the generator's output directory is env-configured (`SCHEMA_DIR`,
default `schema/` on the host, `/var/lib/quotameter/schema` in the container —
see [docs/agents/environment.md](agents/environment.md)). Without `make`, run
`npm run schema:generate` and copy the file from `$SCHEMA_DIR` if you set it.
