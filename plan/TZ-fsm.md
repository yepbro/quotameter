# TZ-fsm — Technical Specification: Formalizing Implicit Finite State Machines (FSM Track)

**Document version:** 1.0
**Date:** 2026-11-06
**Basis:** the codebase audit «Implicit finite state machines» (review session, November 2026). Code references `file:line` reflect `master` at the audit date; when lines drift, navigate by the named entities.
**Related documents:** [`SPECIFICATION.md`](SPECIFICATION.md) (§6.4, §7.1–7.3, §8.2, §11.2, §13, §14.5), [`../DECISIONS.md`](../DECISIONS.md) (D-026, D-061, D-064, D-066, D-067, D-070, D-109, D-125, D-176, D-178).

---

## 0. General provisions

### 0.1. Track scope

The audit confirmed 16 implicit state machines and 6 suspected ones. Only five require rework; the rest (the derived §7.3 status, the `QuotameterApp` lifecycle, sessions, the login rate budget, the retry wrapper, the UI session, `useApiCall`, startup migrations, the retention schedule and graceful drain, reset detection) are reference-grade — for those, reference documentation is sufficient (see §2).

| ID    | Machine                                             | Priority | Disposition                                           |
| ----- | --------------------------------------------------- | -------- | ----------------------------------------------------- |
| FSM-1 | Polling dispatcher composite state (`AccountEntry`) | P1       | rework — this spec, §3                                |
| FSM-2 | Account lifecycle (config × storage × secret)       | P1       | rework — §4                                           |
| FSM-3 | D-064 suspension machine (duplicated holders)       | P2       | rework — §5                                           |
| FSM-4 | Polling loop liveness (the dead state)              | P2       | rework — §6                                           |
| FSM-5 | Live `pending-restart` in settings                  | P3       | rework — §7                                           |
| —     | Remaining audit machines                            | —        | no rework; optionally diagram in `docs/architecture/` |

### 0.2. Process requirements (binding for every task)

1. **Design before code:** before implementing each task, run the design phase through the `plan` skill (architecture, affected files, scope of changes). No code is written until the design is complete.
2. **Skills:** before writing or reviewing TypeScript, load the `antfu` and `ts-library` skills (main session and subagents alike); on conflict, the specification, `DECISIONS.md`, and the existing code win.
3. **English only** for every repository artifact: commits (Conventional Commits, subject ≤72 chars), code, tests, logs, user-facing strings.
4. **One machine — one task — one commit.** Statuses in [`tasks.md`](tasks.md) follow the AGENTS.md rules (`[new]` / `[in progress]` / `[done]`).
5. **Tests are mandatory:** happy path + errors + edge cases in the same commit; green `make check` before committing, green `make check-all` before landing in `master`.
6. **Public-contract changes** (API, formats, events) require a `DECISIONS.md` entry and updates to the affected documentation (`docs/api.md`, `docs/openapi.json`, README when behavior changes). Tasks FSM-2, FSM-4, and FSM-5 change contracts — the plan is fixed in their sections.
7. **Push to the remote only on an explicit owner request.**
8. **Linear history:** rebase or fast-forward, no merge commits.

### 0.3. Numbering and order

Tasks are numbered FSM-1…FSM-5 (the number equals this spec's section). Priorities: FSM-1 and FSM-2 — P1; FSM-3 and FSM-4 — P2; FSM-5 — P3.

**Recommended execution order:** FSM-3 → FSM-1 → FSM-2 → FSM-4 → FSM-5. Rationale: FSM-3 removes the suspension-machine duplication _before_ the dispatcher refactor (FSM-1), which becomes simpler on clean ground; FSM-2 is independent of the first two but closes the status-interface seam that FSM-4 also touches, so it comes first; FSM-5 has no dependencies and closes the track.

---

## 1. Terms

- **Implicit state machine** — a mechanism with a finite set of states and transitions implemented through a combination of boolean flags, timestamp fields, conditional constructs, and handlers, without an explicit "state" type.
- **Behavior parity** — the requirement that a refactor preserves observable behavior: every existing semantic (spec + tests) works identically before and after.
- **Holder** — the object that stores a machine's state between transitions.

---

## 2. Machines outside the rework scope (reference)

The following audit machines need no rework; if desired they can be captured as state diagrams in `docs/architecture/fsm-reference.md` (a separate optional task, not part of this track):

- the derived §7.3 account status (`src/services/polling-status.ts` — already a pure function with a precedence table);
- the application lifecycle (`src/server/app.ts`, `AppState`);
- the session lifecycle (`src/services/sessions.ts`, valid/expired/unknown verdict);
- the login failure budget (`src/services/login-rate-limit.ts`) and the busy exclusion (`src/server/api/auth-routes.ts`);
- the cycle retry wrapper (`src/services/polling-retry.ts`);
- outcome classification (`src/services/polling-outcomes.ts` + `src/providers/transport.ts`);
- the UI session (`ui/src/session.ts`), `useApiCall` (`ui/src/api/index.ts`);
- startup migrations (`src/storage/startup-migrations.ts`), the retention schedule (`src/server/retention.ts`), graceful drain (`src/server/shutdown.ts`);
- reset detection (`src/services/events-detection.ts`).

---

<a id="fsm-1"></a>

## 3. FSM-1 — An explicit phase model for the polling dispatcher (P1)

### 3.1. Problem

The decision "when and whether an account may be polled" is encoded in **six independent variables** of one entry (`src/services/polling-scheduler.ts:313–344`):

- `nextPollMonotonicMs` — the scheduled due time (monotonic);
- `notBeforeEpochMs` — the 429 `Retry-After` gate (`-Infinity` = open), :319–323;
- `suspension` — the D-064 state (an orthogonal gate);
- `pendingManualTest` — the owed manual attempt, :334;
- membership of `accountId` in `flights` — "a cycle is in flight";
- `Flight.hung` — the sticky hung-flight flag, :343.

The effective state (waiting / due / in-flight / hung / suspended-waiting-for-probe / probe-due / manual-owed / retry-after-gated / removed) is never expressed explicitly. The check order inside `nextAction` (:732–805) is critical and not type-protected: the history already records a missed-gate bug (U-028: the verification probe bypassed `Retry-After`) and an owed-attempt overwrite (review P2-3). Any new dispatcher branch risks forgetting one of the gates.

### 3.2. Goal

Introduce an **explicit discriminated union of polling phases** per account and make the dispatcher exhaustive (a `switch` over phases) with compile-time totality checking. The refactor is **behavior-preserving**: every §7.1/§7.2 semantic stays observable-identical.

### 3.3. Inviolable invariants (the parity contract)

The implementation must preserve and cover with tests:

1. §7.1: the first poll runs immediately after startup and after an account is added (`freshEntry`, :528–538).
2. §7.1: no overlapping requests per account — structurally, via the single dispatch loop (:741).
3. §7.1: interval + jitter ≤10%, monotonic time (`pollingDelayMs`, :98–112).
4. §7.2: the `Retry-After` gate is unconditional — it binds the normal poll, the manual attempt, and the verification probe (the U-028 order, :747, :772–781).
5. §7.2: suspension (D-064) stops the normal schedule; the probe is admitted only through `admitVerification` (:756–786).
6. D-066: the 255.5 s hang threshold is sticky; a hung flight is not dispatchable but does not starve the others (:716–723).
7. The owed manual attempt survives an in-flight cycle and an interval change; it is consumed only by the dispatcher (:744–754, :885–897).
8. Containment: a throwing settle/wrapper reschedules on the plain interval (:696–707).
9. A mid-flight key change or removal discards the outcome as stale (:648–653).
10. An interval change re-anchors every not-suspended account (:872–883).

### 3.4. Requirements

- **R1.** Introduce an exported `PollPhase` type — a discriminated union of dispatcher phases (working set: waiting for the normal poll; `Retry-After`-gated; waiting for the suspension probe; probe due; manual attempt owed; in flight; hung; absent). The final phase set and their fields are decided in the design phase (the `plan` skill); a "phase × suspension-gate" model is acceptable, where D-064 stays an orthogonal source and is not copied into the phase.
- **R2.** `AccountEntry` holds exactly one phase; deriving "is dispatchable?" from a scatter of fields is eliminated. Timestamps remain data inside the union's variants.
- **R3.** `nextAction` is an exhaustive `switch` over the phases; adding a phase without handling it is a compile error (the pattern of `classifyTransportError`, `polling-outcomes.ts:286–318`).
- **R4.** Phase transitions are pure functions in a separate module (e.g. `src/services/polling-phase.ts`), with explicit "event × phase → phase" tables; the dispatcher only invokes them.
- **R5.** The D-064 machine is **not duplicated**: `AuthSuspensionState` remains the single suspension authority; the phase references it and never copies `nextVerificationAtEpochMs` (see also FSM-3).
- **R6.** Diagnostics: phase transitions log at `debug` (accountId + phases, never secrets) through the existing injectable `Logger`.
- **R7.** No public contracts change: wire formats and the API are untouched. Internal types and seam signatures (`schedulerFactory` etc.) may change with calling tests updated.

### 3.5. Tests and acceptance criteria

**Done when:**

- the existing suites `test/unit/polling-scheduler.spec.ts`, `polling-outcomes*.spec.ts`, `polling-suspension*.spec.ts`, `server-polling.spec.ts` are green without weakened assertions (only type-level adjustments are allowed);
- property tests for the invariants are added: (a) overlap is impossible under any event sequence; (b) the owed manual attempt survives settle and interval changes; (c) the `Retry-After` gate binds all three attempt kinds; (d) a hung flight is never dispatchable yet never starves the others;
- a parity proof: golden tests over scripted clock readings (event sequences → dispatcher decision sequences) run before and after the refactor produce identical outputs;
- `make check` is green; coverage and mutation thresholds do not degrade (`make check-all`);
- a `DECISIONS.md` entry (D-066's successor) records the chosen phase model.

### 3.6. Affected files

`src/services/polling-scheduler.ts` (primary), the new `src/services/polling-phase.ts`, `src/server/polling.ts` (seams, no behavior change), `test/unit/polling-scheduler.spec.ts` + new property/golden specs, `DECISIONS.md`.

### 3.7. Risks

Medium: subtle timing semantics; the gates' order. Mitigated by the parity harness (golden tests before/after) and migrating one dispatcher branch at a time inside the task (the task still lands as its single commit).

Size estimate: **L**.

---

<a id="fsm-2"></a>

## 4. FSM-2 — A unified account lifecycle model (P1)

### 4.1. Problem

The account state is smeared across **three axes and three stores**:

- config: `accounts[].enabled` (`src/schemas/config.ts:304–305`), entry presence, secret source (`apiKey` / `apiKeyEnv`);
- SQLite: `accounts.status` ∈ {active, archived} (`src/storage/repository.ts:690,741,792`); archiving is terminal (D-061; `src/storage/account-lifecycle.ts:89–99`), purging is cascading (:133–174);
- process memory: secret resolution against the startup env snapshot, the D-064 suspension, the latest outcome.

Display goes through **three independent projections** that can contradict each other: `deriveAccountStatus` (`src/services/polling-status.ts:294–321`), the accounts view (`src/server/api/accounts.ts:153,176,402,438–472`), and `accountAttentionOf` (`ui/src/account-attention.ts:52–65`).

**A reproducible contradiction:** an account archived in the database and then re-added to the config file by hand gets `enabled=true`; `syncAccountsFromConfig` skips archived rows (`src/server/composition.ts:228`), the status route derives `collecting/fresh` (`src/server/api/status.ts:244–257,300–304`), while the accounts view and the attention module show `archived`. Two screens disagree. There is no "unarchive" transition (deliberate), but display consistency is not guaranteed.

### 4.2. Goal

One formally defined account lifecycle model and **one canonical projection function** consumed by all three surfaces (the status API, the accounts API/view, the UI attention, the CLI `status`). Guarantee: for any combination of source facts, all projections agree.

### 4.3. Requirements

- **R1.** A canonical lifecycle precedence (formalizing the de-facto order of `account-attention.ts`): `archived` (the storage fact) → `disabled` (`enabled=false`) → `not-configured` (the secret does not resolve) → the working §7.3 statuses. The fixed order is recorded in `DECISIONS.md`.
- **R2.** Consistency invariant: an account with `status='archived'` in storage is **never** displayed with `collecting/fresh/stale/unreachable/format-changed/auth-rejected`; `/api/status` and the accounts view never disagree about "is archived". The concrete wire decision (a rank-0 `archived` input into `deriveAccountStatus`, or merging the facts in the status route) is chosen in the design phase; if the `/api/status` response shape changes, a `DECISIONS.md` entry + `docs/api.md` + a regenerated `docs/openapi.json` are mandatory.
- **R3.** One projection: `accountAttentionOf` (UI) and the status route read one shared top-level classifier (a shared module; the UI receives the result over the wire — display only, no client-side logic duplication).
- **R4.** A matrix invariant test: an `enabled × archived × configured` table → the expected status in every projection; the §4.1 contradiction is reproduced as a red test before the fix and green after.
- **R5.** Terminality semantics: archiving stays terminal (D-061); re-adding an id to the config does not resurrect the row — the existing `syncAccountsFromConfig` behavior is preserved and covered by a test. Deciding an unarchive policy (forbid forever vs a separate operation) is **out of scope**; if needed it is recorded as a residual in `DECISIONS.md`.
- **R6.** The CLI `status` uses the same canonical projection (`src/cli/service-status.ts`).

### 4.4. Tests and acceptance criteria

**Done when:**

- the red test of the §4.1 contradiction is added and green;
- the R4 matrix test is green; the existing `api-status-schema`, `api-accounts-view`, and `account-attention` suites are updated and green;
- for wire changes: `src/schemas/api/status.ts`, `docs/api.md`, `docs/openapi.json`, the `en` i18n catalog (for new UI strings), and the badge/notice component tests are updated;
- `make check` / `make check-all` are green; a `DECISIONS.md` entry exists.

### 4.5. Affected files

`src/services/polling-status.ts`, `src/server/api/status.ts`, `src/server/api/accounts.ts`, `src/server/composition.ts` (test/invariant only; the sync behavior is preserved), `ui/src/account-attention.ts`, `src/schemas/api/status.ts`, `ui/src/components/AccountStatusBadge.vue` / `AccountAttentionNotice.vue` (on wire changes), `src/cli/service-status.ts`, `docs/api.md`, `docs/openapi.json`, `DECISIONS.md`.

### 4.6. Risks

Medium: extending `/api/status` — consumer compatibility (the UI and CLI ship in the same package; there are no external consumers — the risk is controlled). A backwards-compatible field addition is preferred.

Size estimate: **M–L**.

---

<a id="fsm-3"></a>

## 5. FSM-3 — A single holder for the D-064 suspension machine (P2)

### 5.1. Problem

The pure suspension machine (`src/services/polling-suspension.ts`) is instantiated **twice per process**:

1. the scheduler: `AccountEntry.suspension` (`src/services/polling-scheduler.ts:554,656,777–779,889,907`);
2. the composition holder `AccountSuspensions` (`src/services/account-suspensions.ts:130–171`) — the source for `/api/status` and manual tests.

The holders' synchronization is a convention, not a type: "the same events → the same transitions" is maintained by hand through the `settleWithHolderFeed` wrapper (`src/server/polling.ts:228–254`), the `wiringEpochs` staleness rule (:218, :249), and duplicated `auth_error` outcome constants (`polling-scheduler.ts:123` and `account-suspensions.ts:50`). Any new event source wired into one holder but not the other silently diverges the machines: `/api/status` shows `Auth rejected` while the scheduler keeps probing (or vice versa). The existing property spec (`polling-suspension.property.spec.ts`) covers the machine, not the holders' lockstep.

### 5.2. Goal

Exactly **one `AuthSuspensionState` instance per account in the process**; the dispatcher and the status surfaces read the same holder. The pure machine and its transitions do not change.

### 5.3. Requirements

- **R1.** A single suspension-state holder. Acceptable designs (chosen in the design phase): (a) the scheduler reads/writes through `AccountSuspensions` (the holder becomes the only store); (b) an event tape: one object aggregates all sources (polled cycles, manual tests, key changes, leaving the polled set) and distributes to subscribers. Record the choice in `DECISIONS.md` (the D-064/D-176 successor).
- **R2.** All five event sources keep their semantics: polled-cycle outcomes (with the epoch/keyIdentity staleness rule), manual test requested/rejected (`src/server/providers.ts:89–119`), the reload key-identity report (`src/server/composition.ts:374–382`), `dropAccount` when an account leaves the polled set (`src/server/polling.ts:318–320`).
- **R3.** The duplicated `auth_error` outcome constants are eliminated (one shared factory/value).
- **R4.** No public contracts change (internal refactor); the wire behavior of `/api/status` is identical.
- **R5.** A **lockstep test**: a scripted sequence (polled 401 → inconclusive probe → manual test → success; polled 401 → reload with a key change → …) is fed through the composition, then verified: `suspensionOf`'s answer equals the dispatcher's probe-admission decision at every clock reading. Divergence is red.

### 5.4. Tests and acceptance criteria

**Done when:**

- exactly one holder exists in the process (verified structurally: the scheduler carries no suspension-state field of its own, or the holder is single by construction);
- the R5 lockstep test is green; the existing `polling-suspension*.spec.ts`, `account-suspensions.spec.ts`, `server-polling.spec.ts` are green;
- `make check` is green; a `DECISIONS.md` entry exists.

### 5.5. Affected files

`src/services/account-suspensions.ts`, `src/services/polling-scheduler.ts`, `src/server/polling.ts`, `src/server/providers.ts`, `src/server/composition.ts`, the tests above, `DECISIONS.md`.

### 5.6. Risks

Medium: transition-order races (`manualTestRejected` during an in-flight attempt) are legal today and must stay legal; fix the order in the design. The task runs **before** FSM-1 (see §0.3).

Size estimate: **M**.

---

<a id="fsm-4"></a>

## 6. FSM-4 — Observability of polling-loop death (P2)

### 6.1. Problem

The dispatcher can die silently from a broken seam (`loopError`, `src/services/polling-scheduler.ts:840–842,852–864`): the `running` getter turns false (:930–934), **but nothing consumes it** — no log, no API signal. `/api/health` today answers the literal `{"status":"ok"}` in every case (`src/server/api/health.ts:27,41–46`; the authenticated diagnostics branch that spec §13 permits is not implemented). The process stays alive, so systemd's `Restart=on-failure` never fires; collection stops, and the owner learns only indirectly from `Stale`.

### 6.2. Goal

Loop death becomes observable: an `error` log record, authenticated diagnostics, and the CLI reflect "the polling engine is dead". Auto-restart decisions are **out of scope** (recorded as a residual).

### 6.3. Requirements

- **R1.** One `error` log record at the moment of loop death (through a composition seam; the scheduler keeps no logger of its own — an `onLoopDied` callback or a `running` poll in the composition; the design belongs to the `plan` phase). Repeated firings do not spam (at most one per event).
- **R2.** The authenticated `GET /api/health` gains a diagnostics block `polling: { running: boolean }` (the unauthenticated response stays exactly `{"status":"ok"}` — §13). Contract change: `src/schemas/api/health.ts`, `docs/api.md`, `docs/openapi.json`, a `DECISIONS.md` entry.
- **R3.** `quotameter status` warns when the engine is dead or unreachable (a separate process cannot probe it; minimally a pointer to `quotameter logs` when the latest cycle is older than N intervals — reuse the evidence). The minimum viable R3 is a textual recommendation; details in the design phase.
- **R4.** `stop()`'s behavior on a dead loop (the `loopError` rethrow, :920–928) is preserved.
- **R5.** The "exit the process on loop death" option is considered and **rejected/deferred** by a `DECISIONS.md` entry (residual: restart semantics is a separate decision, see §6.6).

### 6.4. Tests and acceptance criteria

**Done when:**

- unit: a broken seam (e.g. a non-finite clock reading) kills the loop → `running=false`, exactly one `error` record, `stop()` rethrows;
- API: the authenticated health contains `polling.running` (true/false), the unauthenticated one stays byte-exact `{"status":"ok"}` (the existing pin holds);
- the OpenAPI/schema contract tests are updated; `make check` is green; a `DECISIONS.md` entry exists.

### 6.5. Affected files

`src/services/polling-scheduler.ts` (the observation seam), `src/server/composition.ts`, `src/server/api/health.ts`, `src/schemas/api/health.ts`, `src/cli/service-status.ts` (R3), `docs/api.md`, `docs/openapi.json`, `DECISIONS.md`.

### 6.6. Risks and explicit non-decisions

Low. Self-restart (`process.exit` with a non-zero code under `Restart=on-failure`) is a separate future decision; this task records the residual. Keeping diagnostics away from unauthenticated clients is mandatory (§15).

Size estimate: **S–M**.

---

<a id="fsm-5"></a>

## 7. FSM-5 — Live `pending-restart` in settings (P3)

### 7.1. Problem

The `restartRequired` flags in GET `/api/settings` are **static class markings** of the §6.4 trio (`src/server/api/settings.ts:191,196,220` — always `true` for host/port/auth.mode), not process state. The live diff (effective configuration vs the startup one, `src/config/reload.ts:337–339`) surfaces only in the response of the PUT that made the change (`src/schemas/api/settings.ts:330`) and in the reload log. After a hand-edited file plus `quotameter reload`/SIGHUP, the UI cannot show the actual "awaiting restart". Additionally, the follow-up inconsistency window ("the config is adopted while config-sync/polling lag", `src/server/composition.ts:404–423`) is invisible anywhere but the `error` log.

### 7.2. Goal

The UI and the API reflect the actual state: which restart-requiring fields are pending a process restart right now.

### 7.3. Requirements

- **R1.** GET `/api/settings` gains a live `pendingRestart: string[]` field (the effective-vs-startup diff over `RESTART_REQUIRED_FIELDS`; the source is the existing reloader's seam via `findReloadChanges` — no logic duplication). The addition is backwards-compatible; the existing class markings stay.
- **R2.** `SettingsView` distinguishes the class marking "requires a restart" from the live "currently pending": a live marker plus the `quotameter restart` hint whenever `pendingRestart` is non-empty (strings only through the `en` i18n catalog; component tests).
- **R3. (optional, by design decision)** A follow-up inconsistency indicator (config adopted, storage/polling lagging) — minimum: a `DECISIONS.md` entry stating that observation stays at the log level; maximum: a `followUpsConsistent` flag in health. Does not block acceptance.
- **R4.** Contract: `src/schemas/api/settings.ts`, `docs/api.md`, `docs/openapi.json`, a `DECISIONS.md` entry (an additive GET response extension).

### 7.4. Tests and acceptance criteria

**Done when:**

- unit/api: (a) a fresh process → `pendingRestart: []`; (b) a host change via the file + reload → `pendingRestart: ["server.host"]`, persisting across repeated GETs until a restart; (c) a PUT of a live field adds nothing to `pendingRestart`;
- a SettingsView component test: the marker appears/disappears with the field's value;
- the contracts are updated (`docs/api.md`, `docs/openapi.json`); `make check` is green; a `DECISIONS.md` entry exists.

### 7.5. Affected files

`src/server/api/settings.ts`, `src/schemas/api/settings.ts`, `src/server/composition.ts` (the seam), `ui/src/views/SettingsView.vue`, `ui/src/settings-fields.ts`, `ui/src/i18n/en.ts`, `docs/api.md`, `docs/openapi.json`, `DECISIONS.md`.

### 7.6. Risks

Low: an additive response extension. Size estimate: **S–M**.

---

## 8. Acceptance summary

| ID    | Priority | Order | Contract changed?        | DECISIONS.md                | Key proof                                    |
| ----- | -------- | ----- | ------------------------ | --------------------------- | -------------------------------------------- |
| FSM-1 | P1       | 2nd   | no                       | yes (D-066 successor)       | parity golden tests + property invariants    |
| FSM-2 | P1       | 3rd   | possibly `/api/status`   | yes                         | red→green contradiction test + the matrix    |
| FSM-3 | P2       | 1st   | no                       | yes (D-064/D-176 successor) | the holders' lockstep test                   |
| FSM-4 | P2       | 4th   | yes, `/api/health`       | yes                         | error log + authenticated health diagnostics |
| FSM-5 | P3       | 5th   | yes, GET `/api/settings` | yes                         | the live diff in GET + the UI marker         |

Each task lands as one commit (`refactor:`/`feat:` by meaning) with the verification described in the commit body and a `CHANGELOG.md` (Unreleased) update for tasks that change behavior or contracts (FSM-2/4/5 — `feat`; FSM-1/3 — `refactor`).
