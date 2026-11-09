# Manual smoke test (spec §17.3)

The optional manual smoke test with a real Z.ai Coding Plan key (spec §17.3,
"optional and is not run in CI"; plan task 198). Performed 2026-11-09 against
the live Z.ai API with the account owner's key; decision D-208 records the
protocol. This page is the report: what was exercised, the evidence, the
discrepancies found, and the secret-hygiene audit. It is a point-in-time
observation document, not a repeatable suite — the repeatable halves of §17
live in CI and `make check-all`.

## Environment

- Source checkout in the pinned development container (Node 22.13.0, uid 1001),
  CLI through `bin/quotameter.mjs` (the launcher's dist-first resolution,
  D-195; `npm run build:cli` had run, so the compiled graph served the run).
- Loopback bind `127.0.0.1:8788`, `auth.mode: auto` (passwordless loopback is
  the designed §15.1 shape for a local smoke), time zone UTC.
- Polling interval 60 s for the first cycles, later changed at runtime (below).
- Config and data under `/var/lib/quotameter/{config,data}` inside the
  container — destroyed after the run (teardown below).
- The real key never entered the repository, the container filesystem, or any
  log: the account was created with `apiKeyEnv` (the config stores the
  variable _name_ only), and the value lived in the service process
  environment, sourced from a `0600` env file that was shredded and removed at
  teardown.
- "Displayed metrics" is evidenced through the HTTP API (`/api/status`,
  `/api/history`) — the same data the UI renders; the web interface itself was
  not driven in this run (its rendering is covered by the component/E2E
  suites).

## Scenarios and evidence

| #   | Scenario (spec)                                       | Result                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Account connection with the real key (§19.3)          | **PASS**                         | `init --yes … --api-key-env ZAI_SMOKE_KEY`: "Connection test passed — the provider accepted the credentials for 'smoke-zai'".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2   | Immediate first collection after startup (§7.1/§19.4) | **PASS**                         | `collection_runs` id 1 starts at boot +0 s, duration 2.4 s, outcome `success`; `/api/status` reports `fresh` with `lastSuccessAt`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 3   | Cadence at the configured interval (§19.4)            | **PASS**                         | Runs 1–3 at ~65–68 s start-to-start (60 s interval + ~2.5 s poll duration), every run `success`, ~2.5 s each.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 4   | Persistence and history (§19.5, §13)                  | **PASS**                         | Each cycle writes `metric_values`; `/api/history` serves points with real values (below), at 04:20:10Z 3 %, 04:21:17Z 4 %, 04:22:21Z 4 %, 04:34:53Z 7 % (`tokens-5h` percentUsed).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 5   | Runtime interval change (§6.4, §19.4)                 | **PASS**                         | Config `pollingIntervalSeconds` 60 → 120 + SIGHUP: reload record `outcome: applied, applied: ["app.pollingIntervalSeconds"]`; next observed start-to-start gaps 68 s (old cadence) then 160 s (new cadence).                                                                                                                                                                                                                                                                                                                                                                                                     |
| 6   | Runtime logging-level change (§6.4)                   | **PASS**                         | `logging.level` warn → info + SIGHUP: `applied: ["logging.level"]`; info-level records appear without restart.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 7   | Error arm: invalid key (§7.2, §19.8)                  | **OBSERVED, with a discrepancy** | See "Discrepancy 1": the collection endpoint's real rejection resolves the dossier's A2/A3 assumptions and exposes an auth misclassification on that path; a follow-up probe of the credential-check endpoint returned a genuine HTTP 401 and classified correctly.                                                                                                                                                                                                                                                                                                                                              |
| 8   | No secret leakage (§19.11)                            | **PASS**                         | Zero key occurrences in logs, API responses, errors, diagnostics, and the database (exact-value scan of the whole container after teardown: 0 matches); the bad-key experiment's own bogus value also absent from the service log.                                                                                                                                                                                                                                                                                                                                                                               |
| 9   | Reset observability (§9, §12.2)                       | **BOUNDED PASS**                 | Every point carries `resetsAt` (monthly 2026-11-29T19:36:54Z; 5 h window 2026-11-09T09:23:15Z, i.e. that window began 04:23:15Z). A live reset-boundary crossing was not awaited; the machinery stays covered by the automated suites. Scenario 4's first three readings precede 04:23:15Z (the previous window) and the 7 % reading follows it — the boundary fell inside the observation span and the percentage did not read lower after it, recorded as an observation without interpretation (the owner's account may simply have been in active use; provider semantics are not verifiable from the repo). |

## Observed values (owner cross-check)

Read at 2026-11-09T04:34:53Z. The "console" column records the account
owner's independent read through their own `glm-quota` console tool (taken
right after the smoke — the owner's paste, then a re-read by the main session
at 05:02:57Z with identical rows; the tool displays a UTC−8 local time, which
the reset rows below convert). The comparison is recorded; the discrepancy
list is empty.

| Metric                   | Quotameter observed            | Provider console (owner)                                                                                                        | Verdict                        |
| ------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `mcp-monthly` used/limit | 32 / 1000 (3 %), remaining 968 | 3 % (bar); `1 000 / 1 968` — the tool's rendering of limit / limit+remaining                                                    | matches                        |
| `tokens-5h` used         | 7 % of the window              | 17–18 % (at ~05:01–05:03Z) — the window was rising through the smoke (3→4→7 % in 14 min; the owner was actively using the plan) | consistent, different instants |
| Monthly reset            | 2026-11-29T19:36:54Z           | `29.11 11:36` local (UTC−8) = 19:36Z; "через 494 ч 34 мин" at 05:02:57Z — exact arithmetic                                      | **exact match**                |
| 5 h window reset         | 2026-11-09T09:23:15Z           | `09.11 01:23` local (UTC−8) = 09:23Z; "через 4 ч 20 мин" at 05:02:57Z — exact arithmetic                                        | **exact match**                |

## Discrepancies

### 1. The collection endpoint's envelope-encoded auth rejection is misclassified (resolves A2/A3 for that path; follow-up U-061)

The dossier documented the auth-rejection shape as **assumption A3** with the
resolution rule "first observed bad-key response", and the error envelope as
**assumption A2** with the trigger "first retained §7.4 payload of a real
failure". This smoke fired both, on the **collection endpoint** (endpoint 1):

```
HTTP 200
{"code":401,"msg":"token expired or incorrect","success":false}
```

The account's poll cycle classifies this as `parse_error` ("the response
envelope code was not a success value") and the status reads `format-changed`:
the A3 fallback the dossier itself anticipated. Consequences for a real
invalid/expired key: the §7.2 auth outcome never fires on the collection path,
the D-064 suspension machinery never engages, and the account status/`lastError`
carry the static parse reason rather than the provider's `msg` (the `msg` is
not lost — the §7.4 raw-payload retention keeps it and `quotameter doctor --raw`
renders it, and the adapter already extracts a sanitized `envelopeMessage` no
consumer reads; what is missing is the status/lastError surface). The envelope
body carries no account linkage and is retained here as contract material.

A follow-up probe of the **credential-check endpoint** (endpoint 4,
`validateCredentials`, a keyed `init` with the same bogus key) returned a
genuine **HTTP 401**, which the adapter already classifies correctly
(`credentials-rejected`; init reports "the provider refused the key" and stores
the account in an error state). The two endpoints' rejection shapes differ,
and the discrepancy is therefore scoped to the collection path.

The fix — mapping the envelope-encoded 401 on the collection path to the §7.2
auth outcome with the machinery engaging — is tracked as **U-061**; the
dossier's dated section and the A2/A3 ledger rows record the resolution.

### 2. `/api/events` reports a future-extended range as `stopped_service` (minor, recorded)

An events query whose `to` extends past `now` (this smoke used +1 h) reports
the not-yet-happened span as a `stopped_service` gap. The UI's own ranges end
at `now`, so users do not see this; recorded as an observation for the §12.2
semantics, no follow-up filed.

## Teardown and hygiene

Service stopped (SIGTERM), the env file shredded (`dd` overwrite + remove),
helper scripts and the run log removed, `/var/lib/quotameter/{config,data}`
destroyed (recreated once for the endpoint-4 probe, destroyed again after it),
and an exact-value scan of the container returned 0 key occurrences. The key
itself remains only in the owner's `0600` file outside the repository and is to
be revoked after this report is accepted.
