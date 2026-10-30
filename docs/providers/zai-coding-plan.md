# Z.ai Coding Plan — provider contract dossier

This file is the evidence base for the `ZaiCodingPlanProvider` adapter, mandated by
[spec §8.3](../../plan/SPECIFICATION.md). It is a **dated contract dossier**: each research or
verification round appends its own dated section and never rewrites older ones. Later tasks extend
this file — 095 (sanitized live response), 096 (full request/response contract),
112 (peak-schedule encoding), 127 (schedule-source verification).

Current contents: the task 094 research snapshot (official documentation only), the task 093
verified-data-source section (the original prototype plus a sanitized live probe — the actual
endpoints, authentication, and response shapes), the task 095 contract-confirmation section
(the sanitized samples approved for fixtures, the §8.3 availability statement, and committed
fixtures under a re-invention policy per spec §15.4/§17.1), the task 096 adapter contract (the
implementation-facing requests, envelope rules, §8.4 metric mapping, and assumption ledger
consumed by tasks 098–100), and the task 112 peak-schedule encoding (the example configuration
and its provenance). The 094 snapshot records **only** what
official Z.ai documentation says, with exact URLs and access dates; nothing there is inferred,
and undocumented endpoints, fields, or samples are deliberately absent there (spec §8.3 forbids
inventing them). The 093 section records what the prototype reads and what a live probe returned,
with `<redacted>` markers in place of every account-linked value (spec §15.4/§17.1 forbid
committing secrets or personal data).

## Research snapshot — 2026-10-30 (task 094: official documentation)

### Method

All pages were accessed on **2026-10-30** from the development environment using the built-in
`webfetch` tool. Both `docs.z.ai` and `zcode.z.ai` were reachable; no fallback tool was needed
except for one page that no tool could render (recorded in the table and in
[Rate limits](#rate-limits-not-retrievable)). Quotations are verbatim from the pages as served on
that date.

### Sources checked

| #   | URL                                                   | What it is                                                                    | Retrieved  | Result                                         |
| --- | ----------------------------------------------------- | ----------------------------------------------------------------------------- | ---------- | ---------------------------------------------- |
| 1   | <https://docs.z.ai/devpack/overview>                  | Official GLM Coding Plan overview                                             | 2026-10-30 | Read; credits, reset rules, models, peak hours |
| 2   | <https://docs.z.ai/>                                  | Z.ai developer documentation root (resolves to the platform Quick Start page) | 2026-10-30 | Read; general API auth and endpoints           |
| 3   | <https://zcode.z.ai/en/docs/configuration>            | ZCode "Connect Models & Plans" (spec §8.3 reference)                          | 2026-10-30 | Read; Coding Plan API-key mode base URLs       |
| 4   | <https://docs.z.ai/llms.txt>                          | Complete documentation index of `docs.z.ai`                                   | 2026-10-30 | Read; full page list, used for discovery       |
| 5   | <https://docs.z.ai/openapi.json>                      | Official OpenAPI 3.0.1 specification ("Z.AI API available endpoints")         | 2026-10-30 | Read; machine-readable endpoint list           |
| 6   | <https://docs.z.ai/devpack/quick-start>               | GLM Coding Plan quick start                                                   | 2026-10-30 | Read; endpoint guide, API-key acquisition      |
| 7   | <https://docs.z.ai/devpack/faq>                       | GLM Coding Plan FAQ                                                           | 2026-10-30 | Read; where quota consumption is viewable      |
| 8   | <https://docs.z.ai/devpack/usage-policy>              | Usage policy                                                                  | 2026-10-30 | Read; rate/concurrency behavior                |
| 9   | <https://docs.z.ai/devpack/notice/usage-revision>     | "Plan Update Announcement" (published 2026-07-30)                             | 2026-10-30 | Read; credits transition, legacy plans         |
| 10  | <https://docs.z.ai/devpack/notice/api-key-management> | "API Key Management Guide" (published 2026-10-16)                             | 2026-10-30 | Read; key types and billing classification     |
| 11  | <https://zcode.z.ai/en/docs/usage-stats>              | ZCode "Usage Stats" feature page                                              | 2026-10-30 | Read; proves remote plan statistics exist      |
| 12  | <https://docs.z.ai/api-reference/introduction>        | API reference introduction                                                    | 2026-10-30 | Read; auth scheme, general endpoint            |
| 13  | <https://docs.z.ai/api-reference/rate-limit>          | API reference "Rate Limits"                                                   | 2026-10-30 | **Not retrievable** (see below)                |
| 14  | <https://docs.z.ai/devpack/teamplan>                  | "Team Plan Benefits" (team quotas, benefits, usage rules)                     | 2026-10-30 | Read; team-seat credits, third console page    |

Discovery trail: sources 1–3 are the official references named in spec §8.3/§20. Sources 4–14
were discovered from them — 4 is linked at the top of every `docs.z.ai` page, 5–10 and 14 are
linked from 1 and 4, 11 is linked from 3, 12 is linked from 2. The index's API Reference group is
enumerated under
[sources 4 and 5](#documentation-index-and-openapi-specification-sources-4-and-5) and contains no
quota/usage/statistics endpoint; the rest of the index (source 4) consists of guides, devpack
policy pages (source 14 among them), legal agreements, and release notes — no further API
documentation exists to check.

#### Rate limits (not retrievable)

<https://docs.z.ai/api-reference/rate-limit> is listed in the documentation index (source 4) but
could not be read on 2026-10-30: `webfetch` and the `web-reader` MCP tool both returned only the
client-side application shell (the page redirects to a JavaScript-rendered view with no
server-rendered content). Its content therefore could not be verified and is **not** used as
evidence anywhere in this dossier. The concurrency statements in
[Usage policy](#usage-policy-source-8) come from source 8, which was readable.

### Per-source findings

#### Coding Plan overview (source 1)

Plan allowance and reset rules (section "Usage Instruction"):

> Each plan is subject to both a 5-hour usage limit and a weekly usage limit.

| Plan Type | 5-Hour Credits | Weekly Credits |
| --------- | -------------- | -------------- |
| Lite      | 2,000          | 10,000         |
| Pro       | 12,000         | 60,000         |
| Max       | 28,000         | 140,000        |

> **5-hour credits**: Dynamically refreshed; credit quota resets 5 hours after consumption.
>
> **Weekly credits**: Activated upon subscription; resets every 7 days.

Credit calculation (verbatim formulas):

> Model credit usage = (Input tokens × Input multiplier + Cached Input tokens × Cached Input
> multiplier + Output tokens × Output multiplier) / 10,000
>
> MCP tool credit usage = Number of calls × Output multiplier

Multiplier table (section "Credit Calculation"): GLM-5.3 — input 6.9, cached input 1.7, output 24;
GLM-5.3-Flash (including its vision MCP) — 2.3 / 0.56 / 8; MCP servers Web Search, Web Reader,
Zread — output multiplier 1.2 per call. The overview links token/call inspection to the
authenticated console page
("[Charge Type](https://z.ai/manage-apikey/billing)"):

> You can view the number of tokens consumed under each pricing type and the number of tool calls
> on the [Charge Type](https://z.ai/manage-apikey/billing) page.

Models:

> All plans support **GLM-5.3**, GLM-5.3-Flash.
>
> Requests for GLM-5.2/GLM-5.1 will be automatically routed to GLM-5.3, requests for GLM-4.7 will
> automatically be routed to GLM-5.3-Flash.

Peak hours (cross-check against spec §9.1 — see
[Peak-hours schedule](#peak-hours-schedule-unchanged-since-the-2026-10-28-spec-check)):

> **During off-peak hours, model usage is charged at 50% of the standard credit rate**.
>
> **Peak hours**: Monday to Friday, 14:00–18:00 Singapore Standard Time (UTC+8).

#### Documentation index and OpenAPI specification (sources 4 and 5)

The documentation index at <https://docs.z.ai/llms.txt> lists every `docs.z.ai` page. Its "API
Reference" group contains only: Introduction, Errors, Rate Limits, Chat Completion, Generate Image
(+ async), Retrieve Result, Generate Video (+ retrieve), Audio Transcriptions, Tokenizer, Layout
Parsing, Web Search, Web Reader, Agent Chat, File Upload, Retrieve Result, Conversation History.
No usage, quota, billing, balance, or statistics page exists in any group of the index.

The official OpenAPI 3.0.1 specification at <https://docs.z.ai/openapi.json> (title "Z.AI API",
description "Z.AI API available endpoints", production server `https://api.z.ai/api`) enumerates
**exactly 14 paths**, all model/tool content endpoints:

- `POST /paas/v4/chat/completions`
- `POST /paas/v4/videos/generations`
- `GET /paas/v4/async-result/{id}`
- `POST /paas/v4/images/generations`
- `POST /paas/v4/async/images/generations`
- `POST /paas/v4/audio/transcriptions`
- `POST /paas/v4/tokenizer`
- `POST /paas/v4/layout_parsing`
- `POST /paas/v4/web_search`
- `POST /paas/v4/reader`
- `POST /paas/v4/files`
- `POST /v1/agents`
- `POST /v1/agents/async-result`
- `POST /v1/agents/conversation`

No path mentions usage, quota, billing, balance, subscription, or statistics. The only "usage"
content in the spec is the per-response token `usage` object inside chat-completion/agent response
schemas (schema description: "Token usage statistics returned when the model call ends."). The
spec's single security scheme is HTTP Bearer:

> `"bearerAuth": { "type": "http", "scheme": "bearer", "description": "Use the following format
for authentication: Bearer [<your api key>](https://z.ai/manage-apikey/apikey-list)" }`

#### Documentation root and API reference introduction (sources 2 and 12)

The documentation root states the general (non-Coding-Plan) endpoint and the auth scheme:

> Z.ai Platform's general API endpoint is as follows: `https://api.z.ai/api/paas/v4`

> When using GLM Coding Plan, please follow the
> [tutorial](https://docs.z.ai/devpack/quick-start.md) to configure your dedicated endpoint.

> The Z.AI API uses the standard **HTTP Bearer** for authentication.

```text
Authorization: Bearer ZAI_API_KEY
```

API keys are created/managed on the authenticated console page
<https://z.ai/manage-apikey/apikey-list>.

#### Coding Plan quick start (source 6)

Endpoint guide (verbatim table):

| Protocol                | Base URL                              |
| ----------------------- | ------------------------------------- |
| Anthropic Messages      | `https://api.z.ai/api/anthropic`      |
| OpenAI Chat Completions | `https://api.z.ai/api/coding/paas/v4` |
| OpenAI Responses        | `https://api.z.ai/api/v1`             |

Key acquisition and separation:

> Individual Plan users (including trial card recipients) can create an API Key under
> [Personal Coding Plan > Plan Overview](https://z.ai/manage-apikey/apikey-list).
>
> Team Plan members can create an API Key under
> [Team Coding Plan > My Plan](https://z.ai/manage-apikey/coding-plan/team/my-plan).

> API Keys for Individual Plans, Team Plans, and the standard model API are now managed
> separately. Newly created API Keys for these three product types are not interchangeable—use
> the one that matches your needs.

#### FAQ (source 7)

Where quota consumption is viewable — the official answer is a **console page, not an API**:

> You can view the progress of your quota consumption in the
> [subscription](https://z.ai/manage-apikey/subscription).

Quota-exhaustion semantics:

> GLM calls made in supported tools will **only** use your Coding Plan quota.
>
> Once the quota is used up, you'll need to wait until the next **5-hour cycle** for it to
> refresh. The system will not deduct from your account balance.

Endpoints per tool class and the models callable on the plan:

> API endpoint for Claude Code and Goose is：`https://api.z.ai/api/anthropic`
> API endpoint for other tools is: `https://api.z.ai/api/coding/paas/v4`

> Only the following two models can be called: GLM-5.3, GLM-5.3-Flash.

The FAQ also names the error seen when a Coding Plan key/endpoint is misconfigured:
"1113 Insufficient Balance".

#### API Key Management Guide (source 10, published 2026-10-16)

Three key types; the key type, not the endpoint, decides billing for keys created from
2026-10-16 onward:

> Starting October 16, 2026, API keys for the standard model API (pay-as-you-go or usage bundles)
> and GLM Coding Plan are managed separately.

> **For Standard and Coding Plan keys created from October 16 onward, the key type determines how
> calls are billed.** Across supported endpoints, Standard keys use standard API billing, while
> Coding Plan keys use the corresponding plan. Changing the endpoint does not change the key's
> billing type.

Key kinds: **Standard API Key** (created under "Standard API Key" on the API Keys page), **API
Key** for Individual Plan usage (created under "API Keys → Personal Coding Plan"), **Team Plan
Key** (from "Team Coding Plan → My Plan"). Keys created before 2026-10-16 are auto-classified as
Team Plan Key, Compatible, or Standard; "Your key values remain unchanged".

#### Plan Update Announcement (source 9, published 2026-07-30)

The credits system and its date:

> The new credits-based plan is now available. Previous plans are no longer sold to new users.

> Existing active subscriptions are not affected. In addition, usage on weekends will be deducted
> at off-peak rates all day.

Legacy-plan checking, again a console page:

> You can check your quota consumption progress in
> [Usage Statistics](https://z.ai/manage-apikey/subscription).

Legacy plan V2 (pre-credits) rates — quoted to prevent confusion with current-plan rates (see
[Peak-hours schedule](#peak-hours-schedule-unchanged-since-the-2026-10-28-spec-check)):

> **GLM-5.3**: As the flagship model, API calls consume quota at a rate of "1× during off-peak
> hours and 3× during peak hours".
>
> **GLM-5.3-Flash**: API calls consume quota at a rate of 0.4× during off-peak hours and 1.2×
> during peak hours.

#### Team Plan benefits (source 14)

The team edition publishes the same credit model per seat, and its own quota-inspection console
page:

> Each plan is subject to both a 5-hour usage limit and a weekly usage limit. You can check your
> quota consumption progress in
> [Usage Statistics](https://z.ai/manage-apikey/coding-plan/team/usage-stats).

| Plan Type     | 5-Hour Credits | Weekly Credits |
| ------------- | -------------- | -------------- |
| Standard Seat | 15,000         | 66,000         |
| Premium Seat  | 35,000         | 155,000        |

The reset rules, credit-calculation formulas, and multiplier table are identical to source 1, and
the page states both the peak window ("**Peak hours**: Monday to Friday, 14:00–18:00 Singapore
Standard Time (UTC+8).") and the off-peak rate ("**During off-peak hours, model usage is charged
at 50% of the standard credit rate.**") verbatim. On keys: "the **Team Plan Key is independent
from other platform API Keys**". Seat overage semantics: "If a seat exceeds its quota, the model
cannot be used during the limit period until the next reset cycle begins" — unless an
administrator enables on-demand usage overage, which continues service on paid overage.

#### ZCode configuration (source 3)

Coding Plan API-key mode base URLs for Z.ai:

> OpenAI Base URL `https://api.z.ai/api/coding/paas/v4`
> Anthropic Base URL `https://api.z.ai/api/anthropic`

> For a Coding Plan, the OpenAI URL must be the **Coding-only endpoint**
> (`/api/coding/paas/v4`), **not** the general endpoint `/api/paas/v4`.

> The Coding endpoint is for coding scenarios only; it and the general endpoint are not
> interchangeable.

Account-bound (non-API-key) mode needs no manual URLs: "If you bind your account through **Coding
Plan** authorization (not API Key mode), ZCode routes requests automatically — no manual setup
needed."

#### ZCode usage stats (source 11)

The ZCode client demonstrably reads quota data from a remote source — evidence that plan
statistics exist server-side, with no published contract:

> **Coding Plan** reads remote Z.ai / BigModel Coding Plan statistics. Use it to check quota,
> model usage, and tool usage.

What that view shows (field vocabulary only — **not** a documented response schema):

> Quota status such as the 5-hour prompt pool, weekly quota, and monthly MCP quota.
>
> Token consumption for models such as GLM-5.3 and GLM-5.3-Flash.
>
> Tool calls such as Network Search MCP and Web Reader MCP.

> ZCode also shows the current context-window breakdown, message and tool usage share, and the
> remaining quota for 5-hour, weekly, and tool-call pools.

Note: "monthly MCP quota" appears in this ZCode page; the current docs.z.ai allowance table
(source 1) lists only 5-hour and weekly credits. The "monthly" window is not further specified
anywhere in official docs as of 2026-10-30.

#### Usage policy (source 8)

Concurrency/rate behavior (relevant to polling politeness; dynamic, not a fixed number):

> Rate (concurrency) limits are tied to your plan tier. The platform dynamically adjusts these
> limits based on resource availability, with the general principle being **Max > Pro > Lite**.

> Plan users will enjoy higher concurrency limits during off-peak hours (dynamically increased),
> enabling support for a greater number of concurrent projects.

### Quota/usage endpoint status

**Verdict: as of 2026-10-30, an authenticated quota/usage/statistics endpoint is not documented
anywhere in official Z.ai documentation.**

Evidence:

1. The official OpenAPI specification (source 5) enumerates exactly 14 paths — all model/tool
   content endpoints ([list above](#documentation-index-and-openapi-specification-sources-4-and-5)).
   No usage/quota/billing path exists.
2. The complete documentation index (source 4) contains no usage/quota/statistics API page in any
   section.
3. The devpack pages (sources 1, 6, 7, 9, 14) direct every form of quota inspection to
   **authenticated web console pages** — <https://z.ai/manage-apikey/subscription> ("view the
   progress of your quota consumption"), <https://z.ai/manage-apikey/coding-plan/team/usage-stats>
   (team "Usage Statistics", source 14), and <https://z.ai/manage-apikey/billing> ("Charge Type"
   page for per-pricing-type token and tool-call counts). These are browser pages; the docs
   publish no HTTP contract for them.
4. The only "usage" in the public API is the per-request token `usage` object returned inside
   chat-completion responses (source 5 schema descriptions) — request-scoped token accounting,
   not plan quota.
5. ZCode (sources 3 and 11) proves a remote Coding Plan statistics source exists and is consumed
   by an official first-party client, but neither page names its URL, method, authentication, or
   response shape.

Because no endpoint and no response are documented, **no example response is quoted in this
snapshot** — none exists to quote (spec §8.3 forbids fabricating one). The request contract and a
sanitized real response must come from task 093 (original prototype) and/or task 095 (live
capture), per [Implications for 095/096](#implications-for-tasks-095-and-096).

### What is NOT specified (as of 2026-10-30)

- No authenticated quota/usage/statistics HTTP endpoint: no URL, no HTTP method, no request
  parameters are documented on `docs.z.ai` or `zcode.z.ai`.
- No stable response schema and no example response for quota statistics is documented.
- No authentication scheme specific to quota statistics is documented (HTTP Bearer is documented
  only for the general/model API, sources 5 and 12).
- No API-key format is documented (no prefix, length, or charset is stated anywhere; only the
  key-type taxonomy of source 10).
- No numeric mapping between credits and prompts is documented for the current credits plans
  (source 9 gives prompt estimates only for legacy plan V2).
- No fixed rate/concurrency numbers are documented (source 8 states limits are dynamic; the
  "Rate Limits" API-reference page could not be retrieved — see
  [Rate limits](#rate-limits-not-retrievable)).
- No HTTP status codes or error schema for quota exhaustion on the Coding Plan endpoints are
  documented; the FAQ (source 7) only names error "1113 Insufficient Balance" for misconfigured
  plan usage.
- No official statement explains how ZCode's "Coding Plan" statistics view (source 11) obtains
  its data.

### Related facts pinned

#### Peak-hours schedule (unchanged since the 2026-10-28 spec check)

Spec §9.1's finding (checked 2026-10-28) is **confirmed unchanged** on 2026-10-30. The peak
window appears verbatim on three official pages — the overview (source 1), the Team Plan page
(source 14), and the Plan Update Announcement (source 9):

> **Peak hours**: Monday to Friday, 14:00–18:00 Singapore Standard Time (UTC+8).

The off-peak rate is stated verbatim on the overview and the Team Plan page (sources 1 and 14):

> **During off-peak hours, model usage is charged at 50% of the standard credit rate.**

This matches §9.1's schedule exactly (Mon–Fri 14:00–18:00 `Asia/Singapore`; peak multiplier 1.0,
off-peak 0.5). Source 9 does not restate the 50% figure: for legacy plan V2 it expresses rates as
request multipliers, and it adds that weekend usage is deducted at off-peak rates all day for
existing subscriptions, consistent with the Mon–Fri window. **Caution for task 112:** source 9's
"1× off-peak / 3× peak" (GLM-5.3) and "0.4× / 1.2×" (GLM-5.3-Flash) rates apply to **legacy plan
V2** request metering, not to the current credits plans; the current-plan rule is the flat 50%
off-peak credit rate above and must be the one encoded.

#### Plan credits and reset rules

From source 1: Lite/Pro/Max carry 2,000/12,000/28,000 five-hour credits and 10,000/60,000/140,000
weekly credits; five-hour credits reset **5 hours after consumption** (rolling per-consumption,
not on fixed wall-clock windows); weekly credits "Activated upon subscription; resets every 7
days". The FAQ (source 7) adds that the weekly quota "starts counting from the time you place
your order". Quota Reset Cards (sources 7 and 11) can restore a quota to full before its natural
reset, restart that quota's reset cycle, and expire unused; using a weekly card also restores the
5-hour quota.

#### Authentication and key handling

HTTP Bearer (`Authorization: Bearer <key>`) is the documented scheme for the platform API
(sources 5, 12). Since 2026-10-16 keys are typed (Standard / Personal Coding Plan / Team Plan;
source 10) and for newly created keys the type — not the endpoint — decides billing. Quotameter
accounts (spec §8.2) will hold a Coding Plan key; the docs give no key format beyond "API Key".

#### Endpoints named in official documentation

All documented endpoints are **model-request** endpoints (spec §8.3's warning that the coding
base URL "must not be assumed to be a quota-statistics endpoint" stands confirmed):

| Purpose                                         | URL                                                       | Source       |
| ----------------------------------------------- | --------------------------------------------------------- | ------------ |
| Coding Plan — OpenAI Chat Completions           | `https://api.z.ai/api/coding/paas/v4`                     | 3, 6, 7, 10  |
| Coding Plan — Anthropic Messages                | `https://api.z.ai/api/anthropic`                          | 3, 6, 7, 10  |
| Coding Plan — OpenAI Responses                  | `https://api.z.ai/api/v1`                                 | 6, 10        |
| General model API                               | `https://api.z.ai/api/paas/v4`                            | 2, 3, 12     |
| Quota consumption console page (not an API)     | `https://z.ai/manage-apikey/subscription`                 | 7, 9         |
| Team usage-statistics console page (not an API) | `https://z.ai/manage-apikey/coding-plan/team/usage-stats` | 14           |
| Charge-type console page (not an API)           | `https://z.ai/manage-apikey/billing`                      | 1, 14        |
| API key management console page (not an API)    | `https://z.ai/manage-apikey/apikey-list`                  | 2, 6, 10, 12 |

### Implications for tasks 095 and 096

- **Cannot be confirmed from documentation alone:** the statistics endpoint URL, HTTP method,
  request parameters, response schema, field names, units of returned values, reset-timestamp
  fields, and plan-name fields. Task 096 therefore **cannot** be written from official docs; its
  contract must come from task 093 (original prototype inspection — not yet complete) and/or task
  095 (sanitized live response capture, e.g. observing what an official client such as ZCode
  calls, or the endpoint the prototype used). If neither yields a verifiable contract, spec §8.3
  requires documenting that limitation explicitly before the adapter is claimed complete.
- **Confirmed from documentation and usable in 096 regardless of endpoint:** authentication
  family (HTTP Bearer with a Coding Plan key); host `api.z.ai`; the metric **semantics** any
  response should be mapped onto — 5-hour credits and weekly credits (unit: credits), reset
  rules (5 h after consumption; 7-day cycle), plan names Lite/Pro/Max for `planName`, and the
  ZCode-observed vocabulary ("5-hour prompt pool", "weekly quota", "monthly MCP quota",
  tool-call pools) as **candidate** metric keys only.
- **For task 097 (fixtures):** no official sample response exists, so sanitized fixtures must
  come from 095's live capture; partial/unknown/error fixtures will be synthetic by necessity.
- **For task 112 (peak schedule):** cite source 1 (accessed 2026-10-30) with the Mon–Fri
  14:00–18:00 `Asia/Singapore` window and the flat 50% off-peak credit rate; encode 1.0/0.5
  multipliers per §9.1 and do **not** encode the legacy-V2 request multipliers from source 9.

## Verified data source (prototype + live probe, 2026-10-30) — task 093

### Method and provenance

Spec §8.3 makes prototype inspection the first implementation step ("first inspect the original
prototype and confirm the actual usage-statistics endpoint"). This section does that from three
inputs; this task itself made **no live API call and read no secret value** — the probe belongs to
the main session's round.

1. **The original prototype**: a local Python 3 CLI at `~/.local/bin/glm-quota` (standard library
   only — `urllib.request`, `json`, no dependencies). Inspected as source code in this task; not
   executed. Its UI strings are Russian; every label quoted below is translated.
2. **A sanitized live-verification bundle** produced by the main session on 2026-10-30 (UTC+7) by
   probing the prototype's three endpoints over HTTPS with the user's own Coding Plan key. The
   bundle lives outside the repository and is **not committed**. Its markers replaced account
   identifiers and account-linked values **partially, not completely** — two `agreementNo` values
   and the account-specific dates and prices remain clear in it. In every shape below, `<redacted>`
   stands for one of those markers; field names, types, structure, and non-personal plan-level
   values are verbatim from the bundle (`productSmallTitle`/`description` are elided for brevity —
   public marketing copy, not redacted), no marked value is reconstructed anywhere in this
   repository, and **no bundle value, marked or clear, may be copied verbatim into any repository
   artifact** — fixtures (097) re-invent their values (spec §15, §17.1).
3. **Local corroboration, re-verified in this task** — read-only and secret-free: a byte search
   (`grep`) of the first-party ZCode client bundle `/opt/ZCode/resources/app.asar` for the three
   path strings, and a boolean-only check that the key stored for provider `zai-coding-plan` in
   `~/.local/share/opencode/auth.json` does not begin with `Bearer ` (the check printed only
   `false`, never any part of the key).

### The prototype (traceability)

What it is, where it lives, and what it reads:

- **Purpose**: render the 5-hour/weekly/monthly quotas with reset times, a subscription line
  (plan, validity, autorenewal), and the reset-card inventory; a `json` argument dumps the raw
  endpoint payloads instead.
- **Key source**: reads `~/.local/share/opencode/auth.json` — OpenCode's own credential store —
  under provider `zai-coding-plan` (fallback `zai`), accepting either a plain string entry or an
  object with one of `key`, `api_key`, `apiKey`, `access`, `token`, `access_token`. The stored
  entry is an object (verified in this task); the key value is not `Bearer `-prefixed.
- **Transport**: `urllib.request` GET to `https://api.z.ai` + path, 20-second timeout, headers
  `Authorization` (the stored key value, verbatim — see
  [Authentication](#authentication-observed-forms)), `Accept-Language: en-US,en`,
  `Content-Type: application/json`.
- **Envelope handling**: treats top-level `code` of `0`/`200` (numeric or string) as success and
  unwraps `data`; any other `code` raises the envelope's `msg`.
- **Window vocabulary** (from its source, consistent with the observed shapes): `unit` **3 = hours,
  5 = months, 6 = weeks**; `number` is the window length in those units. Labels: `TIME_LIMIT` or
  `unit` 5 → monthly MCP-tool quota; `unit` 3 → "{number}-hour token quota" (defaults to 5);
  `unit` 6 → weekly quota.
- **Timestamps**: renders `nextResetTime` via `fromtimestamp(value / 1000)` — the field is epoch
  **milliseconds**.

Done-condition note: the prototype never calls a model-completion endpoint. All three URLs it
reads are dedicated monitor/biz paths, so the source identified here does not rely on
`/api/coding/paas/v4`, `/api/anthropic`, or any chat-completions URL.

### Verified endpoints

Three plain GETs on host `https://api.z.ai`, all returning HTTP 200 on 2026-10-30 with one shared
envelope:

```jsonc
// envelope common to all three endpoints (observed)
{
  "code": 200, // number; the prototype accepts 0/200, numeric or string, as success
  "msg": "Operation successful",
  "data": {/* endpoint-specific */},
  "success": true,
}
```

#### Endpoint 1 — quota limits: `GET /api/monitor/usage/quota/limit`

Full URL: `https://api.z.ai/api/monitor/usage/quota/limit`. **Primary metric source.**

```jsonc
// data (observed)
{
  "limits": [
    {
      "type": "TIME_LIMIT", // string; observed values: TIME_LIMIT, TOKENS_LIMIT
      "unit": 5, // number; window time-unit enum — see semantics below
      "number": 1, // number; window length in `unit`s
      "usage": 1000,
      "currentValue": 1,
      "remaining": 999,
      "percentage": 1, // number; percent of the window's allowance (scale question below)
      "nextResetTime": "<redacted>", // number, epoch milliseconds
      "usageDetails": [
        // per-tool breakdown of the consumed amount
        { "modelCode": "search-prime", "usage": 0 },
        { "modelCode": "web-reader", "usage": 1 },
        { "modelCode": "zread", "usage": 0 },
      ],
    },
    {
      "type": "TOKENS_LIMIT",
      "unit": 3,
      "number": 5,
      "percentage": 19,
      "nextResetTime": "<redacted>", // number, epoch milliseconds
    },
  ],
  "level": "pro", // string; plan tier
}
```

Semantics:

- **Window units** (prototype labels, consistent with these shapes): `(TIME_LIMIT, unit 5,
number 1)` is the **monthly MCP-tool quota** — `usageDetails` names exactly the
  [094 dossier](#research-snapshot--2026-10-30-task-094-official-documentation)'s MCP servers
  (Web Search = `search-prime`, Web Reader = `web-reader`, Zread = `zread`), which source 1 meters
  per call. `(TOKENS_LIMIT, unit 3, number 5)` is the **rolling 5-hour token quota**. A weekly
  entry (`unit 6`) is defined by the prototype but **absent from this capture** — the response
  carried only the two entries above.
- `nextResetTime` is epoch **milliseconds** (the prototype divides by 1000 before rendering); the
  bundle sanitized both observed values.
- **Open interpretation question (recorded, not decided):** in the TIME_LIMIT entry the arithmetic
  is self-consistent if `usage` (1000) is the window **allowance**, `currentValue` (1) the consumed
  amount, and `remaining` (999) the remainder: `currentValue + remaining = usage`, the
  `usageDetails` values sum to `currentValue`, and `percentage = 1` fits — though only on a
  per-mille scale or as a rounded-up percent (1/1000 is 0.1%), so the `percentage` scale itself is
  part of the open question: settle it before mapping to §8.4 `percentUsed`. The prototype's own
  display instead prints `usage / usage + remaining` ("used / total"), i.e. it treats `usage` as
  consumed — which contradicts `percentage = 1` for these values. Which reading the adapter must
  encode is decision material for 095/096; a second capture after tool consumption settles it.
- The TOKENS_LIMIT entry carried **only** `percentage` in this capture — no `usage`, `remaining`,
  `currentValue`, or `usageDetails`.
- `data.level` (`"pro"`) is the plan tier — the natural §8.4 `planName` source, cross-checkable
  against subscription `productName` below.
- This entry is the observed carrier of the "monthly MCP quota" vocabulary that
  [ZCode's usage-stats page](#zcode-usage-stats-source-11) names but official docs never specify.

#### Endpoint 2 — subscription records: `GET /api/biz/subscription/list`

Full URL: `https://api.z.ai/api/biz/subscription/list`. Plan-name and expiry context; no quota
numbers. `data` is an array of subscription records (three observed):

```jsonc
// one record (observed); monetary values, account ids, and account-specific dates are redacted
{
  "id": "<redacted>",
  "customerId": "<redacted>",
  "agreementNo": "<redacted>",
  "orderNo": "<redacted>",
  "productId": "product-372bf4", // plan-level product SKU (annual tier in this capture)
  "productName": "GLM Coding Pro",
  "productBigTitle": "GLM Coding Plan",
  "productSmallTitle": "<marketing tagline string>",
  "description": "<multi-line benefits string>",
  "status": "VALID", // string; observed: VALID
  "purchaseTime": "<redacted>", // string, "YYYY-MM-DD HH:MM:SS"
  "valid": "<redacted>", // string, "YYYY-MM-DD HH:MM:SS-YYYY-MM-DD HH:MM:SS" (start-end range)
  "autoRenew": 0, // number 0/1 (the prototype also tolerates a boolean)
  "initialPrice": "<redacted>", // number; all five price fields share this shape
  "standardPrice": "<redacted>",
  "useInitialPrice": true, // boolean
  "actualPrice": "<redacted>",
  "renewPrice": "<redacted>",
  "currentPeriod": 2, // number; billing-period counter
  "currentRenewTime": "<redacted>", // string, "YYYY-MM-DD"
  "nextRenewTime": "<redacted>", // string, "YYYY-MM-DD"
  "paymentType": "WAIT_PAY", // string; observed: WAIT_PAY, SUCCESS
  "billingCycle": "annually", // string; observed: annually, monthly
  "inCurrentPeriod": true, // boolean
  "paymentChannel": "STRIPE", // string; observed: STRIPE, GIVE
  "refundable": false, // boolean
  "refundableReason": "<redacted>",
  "banStatus": 0, // number
  "banExpireTime": null,
  "version": "V1", // string; observed: V1, V2 (plan generation)
}
```

The three observed records were one annual Stripe-billed record (`inCurrentPeriod: true`) and two
monthly records with `paymentChannel: "GIVE"` and `inCurrentPeriod: false` — a plan can carry
several records, so 096 must define which record wins: the prototype takes the first with
`status === "VALID"`; `inCurrentPeriod === true` is the other candidate. Account-specific values
(ids, agreement/order numbers, dates, and the paid prices of this particular account) are redacted
above and must not enter fixtures.

#### Endpoint 3 — reset cards: `GET /api/biz/customer-package-reset/list?targetType=PERSONAL`

Full URL: `https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL` (the
prototype sends `targetType` as a query parameter).

```jsonc
// data (observed)
{
  "customerId": "<redacted>",
  "targetType": "PERSONAL",
  "organizationId": null,
  "projectId": null,
  "lastFiveHourResetTime": "<redacted>", // string "YYYY-MM-DD HH:MM:SS" or null
  "lastWeekResetTime": null,
  "fiveHourResets": [], // Card[] — empty in this capture
  "weekResets": [], // Card[] — empty in this capture
}
```

Card-object fields (`available`, `expireTime`) are known **only from the prototype source** — both
arrays were empty in the live capture, so the card shape is unverified until 095 captures a
non-empty array. Semantics per 094's sources 7 and 11: reset cards restore a quota to full before
its natural reset, restart that quota's reset cycle, and expire unused; using a weekly card also
restores the 5-hour quota. `targetType=PERSONAL` scopes the query to a personal plan
(`organizationId`/`projectId` null in the response).

### Undocumented endpoints — verification status and limitations

All three paths appear **nowhere in official documentation** — the
[094 verdict](#quotausage-endpoint-status) stands (the official OpenAPI specification lists 14
model/tool paths only, and the docs route quota inspection to console pages). What makes them the
§8.3 "verified source and limitations" situation anyway:

| Endpoint                               | Live probe 2026-10-30 | In ZCode `app.asar` (grep, this task) |
| -------------------------------------- | --------------------- | ------------------------------------- |
| `/api/monitor/usage/quota/limit`       | 200                   | yes — 2 occurrences                   |
| `/api/biz/subscription/list`           | 200                   | yes — 3 occurrences                   |
| `/api/biz/customer-package-reset/list` | 200                   | **no** — 0 occurrences                |

The quota and subscription endpoints are live-probed **and** corroborated by the first-party
client; the reset-cards endpoint is corroborated by the prototype alone. Limitations recorded per
§8.3:

1. **Undocumented** — Z.ai may change or remove these paths without notice; the adapter must map
   unexpected shapes to `Format changed` (§7.2) with §7.4 sanitized retention, never guess fields.
2. **Observed once, from one Pro-tier personal account** — other plan tiers, team scope
   (`targetType` other than `PERSONAL`), and non-empty reset-card arrays are unobserved.
3. **No failure sample exists** — envelope `code`/`msg` on errors and HTTP behavior on auth
   rejection are unobserved; error fixtures for task 097 are synthetic by necessity.

### Authentication (observed forms)

- **Verified by live probe (2026-10-30):** `Authorization: Bearer <key>` returns 200 on all three
  endpoints, where `<key>` is the same key OpenCode's `zai-coding-plan` provider uses — and that
  key is also valid on `https://api.z.ai/api/coding/paas/v4/models` (HTTP 200). One Coding Plan
  key therefore authorizes both the coding endpoints and the monitor/biz quota surface; the quota
  endpoints live under `/api/monitor` and `/api/biz`, **not** under `coding/paas`.
- **Prototype nuance:** the prototype sends the header as the stored key value, verbatim
  (`'Authorization': key` in its source — it prepends nothing), and the key in OpenCode's
  `auth.json` does not itself begin with `Bearer ` (boolean check, this task). The prototype being
  a working utility implies the server has accepted the unprefixed form in past use, but this
  round did not re-verify that — only the `Bearer` form is probe-observed. The adapter should send
  the documented `Bearer <key>` form — the platform's documented scheme (094 sources 5 and 12);
  any prefix-acceptance would be server leniency, not contract.

### Implications for tasks 095, 096, and 097

- **095 (confirm the request contract with a sanitized response):** the sanitized bundle is the
  candidate "one safe sample"; before approval it should be reconciled with the open questions
  above — the `usage` vs `currentValue` semantics (one more capture after tool consumption settles
  it), the absent weekly (`unit 6`) entry, a non-empty reset-card array for the card shape, and
  whether a TOKENS_LIMIT entry ever carries absolute values.
- **096 (provider contract document):** URL, method, and auth material is complete (this section);
  what remains is the metric-mapping decision and the error schema. Candidate §8.4 mappings
  observed so far (observations only — decisions belong to 096):

| Observed                                                                                 | Candidate §8.4 mapping                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TIME_LIMIT`, `unit 5`, `number 1`, with `usage`/`currentValue`/`remaining`/`percentage` | `limitType: MONTHLY`, `unit: REQUESTS` (MCP tool calls; matches 094's per-call credit formula); used/remaining/limit from `currentValue`/`remaining`/`usage` **if** the arithmetic reading is confirmed |
| `TOKENS_LIMIT`, `unit 3`, `number 5`, `percentage` only                                  | `limitType: ROLLING_WINDOW`, `windowSeconds: 18000`, `unit: PERCENT` (§8.4 percentage-only rule; never derive token counts from percentages)                                                            |
| `unit 6` entry (unobserved)                                                              | `limitType: WEEKLY` — candidate only                                                                                                                                                                    |
| `data.level` (`"pro"`)                                                                   | `planName` (§8.4), cross-checked with subscription `productName`                                                                                                                                        |
| `nextResetTime` (epoch ms)                                                               | `resetsAt` (§8.4 UTC epoch ms)                                                                                                                                                                          |
| subscription `valid` end, `autoRenew`, `billingCycle`                                    | plan-expiry context, not quota metrics                                                                                                                                                                  |

- **097 (fixtures):** sanitized real fixtures come from the bundle (all three endpoints, happy
  path); synthetic fixtures are required for a weekly (`unit 6`) entry, non-empty reset cards,
  changed/unknown schema, error-envelope and HTTP-error cases, and a TOKENS_LIMIT entry without
  `percentage`. Fixture values must be re-invented, not copied: neither the bundle's markers nor
  its clear values (ids, dates, prices, or quota-state numbers) may be copied into fixtures or
  further artifacts. This dossier quotes the observed quota-state numbers (`usage`,
  `currentValue`, `percentage`, …) deliberately, as shape exemplars — fixtures must still
  re-invent them.
- **098 (credential validation):** `GET /api/coding/paas/v4/models` (200 with the same key) is the
  observed candidate for `validateCredentials` — a cheap, quota-state-independent check.

This section closes 094's open item ("its contract must come from task 093 … not yet complete")
for the request/response material. Task 093's own done-condition — a traceable source that does
not rely on an assumed model-completion endpoint — is met: every URL above is a dedicated
monitor/biz path, and none of the three is `/api/coding/paas/v4`, `/api/anthropic`, or any
chat-completions URL.

## Contract confirmation — sanitized samples approved for fixtures (2026-10-30, task 095)

### Method

This task made **no live API call and read no secret** — the live verification already happened
in the main session's 2026-10-30 probe (see
[the 093 section](#verified-data-source-prototype--live-probe-2026-10-30--task-093)). Its input
was the sanitized evidence bundle produced by that probe: one response per endpoint of
[the verified trio](#verified-endpoints), with `<ID@…>`/`<TOKEN@…>`/`<NUM-ID@…>` markers at
account-linked positions, held outside the repository permanently. The task reconciled the
bundle against the 093 shapes and open questions, approved one safe sample per endpoint for
fixtures, produced them, and records the §8.3 availability statement below. The policy is
decision D-040; the fixtures' consumer-facing notes live in
[`test/fixtures/README.md`](../../test/fixtures/README.md).

### §8.3 availability statement

Spec §8.3: _"If no officially documented statistics endpoint exists, clearly document the
integration's verified source and limitations before claiming the adapter complete."_

- **An officially documented sample does not exist.** The
  [094 verdict](#quotausage-endpoint-status) stands: no quota/usage/statistics endpoint, request
  contract, or example response is documented anywhere in official Z.ai documentation
  (fourteen sources checked 2026-10-30; the official OpenAPI specification enumerates fourteen
  model/tool paths only).
- **What is available instead: one sanitized live response per endpoint**, captured 2026-10-30
  by the probe of the 093 endpoint trio with the Coding Plan Bearer key. These samples are
  approved for fixtures below. They are **observations of an undocumented surface, not an
  official contract** — the integration's verified source is exactly the 093 trio (live-probed;
  two of three paths corroborated inside the first-party ZCode client).
- **Limitations of the approved samples:**
  1. **One snapshot in time** — a single capture per endpoint on 2026-10-30. No second
     observation exists, so the open semantic questions below remain open.
  2. **One Pro-tier personal account** (`targetType=PERSONAL`). Other plan tiers (Lite/Max/team
     seats), team scope, and non-empty reset-card arrays are unobserved.
  3. **No error samples** — no non-200 HTTP status, no failure envelope (`code`/`msg` on error),
     and no auth-rejection behavior was captured. Every error/edge fixture is synthetic by
     necessity.
  4. **The bundle's own redaction was partial** — two `agreementNo` values, the account-specific
     dates, and the paid prices remained clear in it. This is the reason the fixtures re-invent
     values instead of copying the bundle (D-038's rule; reinforced as D-040's policy).

### Approved samples

One fixture per endpoint, each holding the full observed response envelope:

| Endpoint                                                       | Fixture                                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------- |
| `GET /api/monitor/usage/quota/limit`                           | `test/fixtures/sanitized/zai-quota-limit.json`                 |
| `GET /api/biz/subscription/list`                               | `test/fixtures/sanitized/zai-subscription-list.json`           |
| `GET /api/biz/customer-package-reset/list?targetType=PERSONAL` | `test/fixtures/sanitized/zai-customer-package-reset-list.json` |

Complementing them, three **synthetic** fixtures under `test/fixtures/synthetic/` cover the
error/edge states the single capture lacks, so the parsing tests (tasks 099/100) have failure
shapes to consume: `zai-quota-limit-empty-limits.json` (envelope-valid, `limits: []`),
`zai-quota-limit-unknown-type.json` (a limit entry with an unrecognized `type`), and
`zai-envelope-malformed.json` (envelope missing `code`/`data`). The remaining synthetic matrix
(weekly `unit 6` entry, non-empty reset cards, error envelopes, HTTP errors, a
percentage-less `TOKENS_LIMIT` entry) stays with task 097, per 093's hand-off.

### Sanitization policy (bundle → fixture)

**Kept verbatim** — contract material that carries no account linkage: the response structure
and field names, JSON types, the envelope (`code: 200`, `msg`, `success`), closed vocabularies
(`TIME_LIMIT`/`TOKENS_LIMIT`, window-unit enums, `VALID`, `WAIT_PAY`/`SUCCESS`,
`annually`/`monthly`, `STRIPE`/`GIVE`, `V1`/`V2`, `PERSONAL`), the MCP `modelCode` names
(`search-prime`, `web-reader`, `zread` — the 094-dossier MCP servers), and the public plan-level
names (`level: "pro"`, `GLM Coding Pro`/`GLM Coding Plan`).

**Re-invented** — every account-linked or account-specific value: identifiers (`id`,
`customerId`, `agreementNo`, `orderNo`), all dates and times, all prices, the quota-state
numbers (`usage`, `currentValue`, `remaining`, `percentage`, `usageDetails[].usage`), the
`nextResetTime` epochs, and — as a bright-line extension beyond strict account linkage, for a
cheap-to-audit rule — the `productId` SKUs and the marketing copy (`productSmallTitle`,
`description`). Structural relations are preserved deliberately
(`currentValue + remaining = usage`; `usageDetails` sum to `currentValue`; the subscription
records' chained periods and shared identifiers, including the annual record's observed offset
where `valid.start == nextRenewTime` and `currentRenewTime` sits one period earlier), and the
monthly quota's consumed fraction
sits at one per-mille of its allowance — the capture's exact ratio — so the fixtures exercise
the percentage-scale question without resolving it. Full consumer notes (including the
marker-position typing caveat) are in `test/fixtures/README.md`.

### Open-questions status (carried to 096)

093 listed what a second capture should settle; no second capture exists, so **all of 093's open
questions remain open** and are decision material for 096 (D-038's candidate mappings):

- `usage` vs `currentValue` arithmetic — unsettled; the bundle is the same single snapshot 093
  already analyzed.
- A weekly (`unit 6`) limits entry — still unobserved (absent from the capture).
- The reset-card object shape — still unobserved (both card arrays empty); the prototype source
  remains the only evidence for `available`/`expireTime`.
- Whether a `TOKENS_LIMIT` entry ever carries absolute values — still unobserved
  (percentage-only in the capture).

### Leak audit

The committed diff was audited by exact-string search for every clear value the bundle contains:
both `agreementNo` hex strings, every observed date and time-of-day, every observed price, the
observed product SKUs, the marketing tagline and description strings, the observed quota-state
numbers, the redaction markers' payload paths, key material patterns (a `Bearer` header with a
value, the `Authorization` header name, api-key shapes), and e-mail-shaped strings. All are
absent from the diff; the audit's scope and result are described in the task commit body. The
only `…@…` occurrences in this section are the marker-format descriptions (`<ID@…>` and
alike), which name the redaction convention and carry no marker payload.

## Peak-schedule encoding — 2026-10-30 (task 112)

### What this section is

The seed data D-014 anticipated ("provider-specific values … are configuration _data_ seeded by
`init` and the example config"): the verified Z.ai peak-hours schedule encoded as
[`docs/config.example.json`](../config.example.json), a complete example `config.json` whose
`providers["zai-coding-plan"].peakHours` carries the schedule verbatim from spec §9.2's sample —
window `zai-weekday-peak`, Monday–Friday `14:00`–`18:00`, `multiplier: 1.0`, explicit
`offPeakMultiplier: 0.5`, `timezone: "Asia/Singapore"`. The example is data only: no schema or
`src/` change, and `test/integration/example-config.spec.ts` proves it loads cleanly through the
real configuration boundary parser (`loadConfigFile`, decision D-018's pipeline). Placement and
companion decisions are recorded as decision D-043.

### Provenance

| Source                                                   | Retrieved  | States                                                                                                                                                                           |
| -------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <https://docs.z.ai/devpack/overview> (dossier source 1)  | 2026-10-30 | "**Peak hours**: Monday to Friday, 14:00–18:00 Singapore Standard Time (UTC+8)." and "**During off-peak hours, model usage is charged at 50% of the standard credit rate**."     |
| <https://docs.z.ai/devpack/teamplan> (dossier source 14) | 2026-10-30 | Both statements verbatim (see [094's per-source findings](#team-plan-benefits-source-14)).                                                                                       |
| Spec [§9.1](../../plan/SPECIFICATION.md)                 | 2026-10-28 | The first recorded check of the overview page; task 094 confirmed it unchanged on 2026-10-30 ([peak-hours pin](#peak-hours-schedule-unchanged-since-the-2026-10-28-spec-check)). |

### Rate semantics encoded

- **Peak `1.0`** — the standard credit rate itself: §9.1 defines the configured `multiplier` as
  the quota-credit rate _relative to the standard rate_, and the sources describe no peak surcharge
  for the current credits plans (the 50% statement is the only rate modifier either page states).
- **Off-peak `0.5`** — "During off-peak hours, model usage is charged at 50% of the standard
  credit rate" (sources 1 and 14, quoted verbatim above). Saturday and Sunday are off-peak under
  the published Mon–Fri window (§9.1).
- **Not encoded**: source 9's "1× off-peak / 3× peak" (GLM-5.3) and "0.4× / 1.2×"
  (GLM-5.3-Flash) rates — they apply to **legacy plan V2** request metering, not to the current
  credits plans ([094's caution](#peak-hours-schedule-unchanged-since-the-2026-10-28-spec-check)).

Per §9.1 these multipliers are descriptive schedule metadata only: the application must never
rewrite collected provider values or infer quota values from them.

### Why provenance is not inside the JSON

The configuration contract closes every object (`additionalProperties: false`, decision D-014),
so a provenance key, `$schema` pointer, or comment inside `docs/config.example.json` would make
the example fail the very validation it exists to demonstrate. The dates and links therefore live
here — the dossier section the task brief's done-condition names — and the example test pins the
linkage by asserting this section contains the source URLs, both retrieval dates, and the example
path.

## Adapter contract — implementation-facing rules for tasks 098-100 (2026-10-30, task 096)

### Scope, method, and decision record

This section turns the record above into the implementation-facing contract for the adapter
tasks: 098 (`validateCredentials`), 099 (`fetchSnapshot` through the task-104 transport), and
100 (mapping into the [§8.4 normalized model](../../src/schemas/metrics.ts)). It is the single
place those tasks look for "which request, which field goes where, and what to do at every
gap". Method: no live API call and no secret was read. Every **verified** statement cites the
dossier section and fixture it rests on; every statement beyond the evidence is marked
**assumption** (A1–A10 in [the ledger](#assumption-ledger)) and names the adapter behavior
chosen for the gap plus the observation that would reopen it. The decision cluster is
decision **D-047** in `DECISIONS.md`; this section is its narrative.

### Requests

Host `https://api.z.ai`, plain GETs, one verified authentication form
([093](#verified-endpoints)):

- **Auth header:** `Authorization: Bearer <key>` — the documented platform scheme
  (094 sources 5 and 12), probe-observed returning 200 on all three trio endpoints
  ([authentication](#authentication-observed-forms)). The prototype's unprefixed header form is
  implied server leniency, not contract (D-038): the adapter sends exactly `Bearer <key>`, and
  the transport's error scrubbing already treats the whole header value plus the
  after-scheme credential as secret material (D-042).
- **No other header is contract material** (assumption A7): the prototype also sends
  `Accept-Language` and `Content-Type: application/json` on its GETs, but no observation ties
  any server behavior to either. The adapter sends only the `Authorization` header; a server
  that started requiring more would answer with a transport-visible failure (`http-status` or
  `content-type`), which is the reopen trigger.

| #   | Role in a collection cycle                                         | Method and full URL                                        | Query parameters      |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------- | --------------------- |
| 1   | **Primary** — quota metrics + `level`; its failure fails the cycle | `GET https://api.z.ai/api/monitor/usage/quota/limit`       | —                     |
| 2   | Secondary — plan-name context; failure degrades                    | `GET https://api.z.ai/api/biz/subscription/list`           | —                     |
| 3   | Secondary — reset-card context (unmapped in v1); failure degrades  | `GET https://api.z.ai/api/biz/customer-package-reset/list` | `targetType=PERSONAL` |
| 4   | Validation only (098); never part of a collection cycle            | `GET https://api.z.ai/api/coding/paas/v4/models`           | —                     |

- `targetType=PERSONAL` is the one known query parameter — prototype-sent and echoed by the
  response ([093 endpoint 3](#endpoint-3--reset-cards-get-apibizcustomer-package-resetlisttargettypepersonal)).
  v1 is personal-plan scope only; no other value is defined (assumption A8).
- Endpoint 4 is the credential check 093 observed (HTTP 200 with the same Coding Plan key —
  [authentication](#authentication-observed-forms)). Its body was never captured, so
  `validateCredentials` is **status-based**: 2xx → valid, 401/403 → rejected (assumption A3 —
  the same unobserved auth-failure shape as [below](#response-envelopes)), any other
  outcome (transport failure of any kind) → unavailable — the three distinct results task
  098 must produce, with no key material in the error.

**Transport requirements (all four endpoints):** every request goes through `providerFetch`
(D-042, `src/providers/transport.ts`); the adapter never calls `fetch` directly, never
retries (retry/backoff is task 106's layer), and issues the cycle's GETs sequentially. Every
`TransportError` kind can occur on the cycle's GETs — `timeout`, `aborted`, `dns`,
`connection`, `socket`, `network`, `http-status`, `response-too-large`, `content-type` — and
task 105 owns the mapping from kind to §7.2 outcome. One exception by construction: on the
signal-less credential check (endpoint 4), `aborted` cannot occur — it fires only on the
caller's §8.1 signal, which `validateCredentials` does not receive. Applicability specifics:

- **Timeout:** §7.2's configured value (default 15 s) is one total deadline per request; a
  cycle makes up to three sequential requests, each with its own deadline.
- **Response size:** the transport's 64 KiB cap applies per response. Observed bodies sit far
  below it (the committed sanitized fixtures are 0.3–3.8 KiB); a
  subscription list with many records is the only plausible growth direction, and the cap
  bounds it.
- **Content type:** the capture proves JSON bodies but did not record the declared
  `Content-Type` header. The transport's `application/json` gate is assumed satisfied (A6);
  a non-JSON declaration surfaces as a `content-type` transport failure, never a parse error.

**Per-endpoint failure policy (D-047):** endpoint 1 failing — transport or parse — fails the
cycle: no snapshot, no metric values written (§7.2). Endpoints 2 and 3 fail soft: the cycle
succeeds with endpoint 1's metrics, minus their context (the `planName` fallback; card
context), and the failure is logged. A soft failure is recorded in the application log only:
the cycle's run outcome stays `success` — whose error fields the `collection_runs` schema
keeps clean (D-034) — and no §7.4 response is retained, §7.4 retention being tied to parse
failures that produce no snapshot. Metric values originate only on endpoint 1, so this split
keeps §7.2's "do not write metric values" rule (the `Format changed` row) intact without
losing whole cycles to context loss.

### Response envelopes

Observed envelope, common to the trio ([093](#verified-endpoints); verbatim in every sanitized
fixture):

```jsonc
// envelope (observed)
{
  "code": 200, // number; the prototype also accepts 0, and either value as a string
  "msg": "Operation successful",
  "data": {/* endpoint-specific */},
  "success": true,
}
```

Adapter envelope rules (D-047):

- **Success:** top-level `code` of `0` or `200`, in number **or** string spelling
  (prototype-verified tolerance; the capture observed number `200`) → validate and unwrap
  `data`. `success` and `msg` were observed on success but are **not interpreted**: the
  prototype keys on `code` alone, and no observation assigns `success` independent meaning.
- **Failure — the honest gap (assumption A2):** no error sample exists (the
  [095 availability statement](#83-availability-statement), limitation 3). What is known:
  the prototype raises the envelope's `msg` on non-success codes, so a present `msg` is
  retained (sanitized, non-secret) as the diagnostic string. Everything else is unknown, and
  the implementation requirement is therefore conservative: any `code` outside the success
  set, a missing `code`, or a wrong-typed container — `data` not an object where endpoints 1
  and 3 expect one, not an array where endpoint 2 expects one, `limits` not an array — is a
  **parse error**, which task 105 surfaces as `Format changed` with §7.4 sanitized retention.
  Error codes are never interpreted and never enumerated; `synthetic/zai-envelope-malformed.json`
  drives this shape.
- **HTTP-level failures** arrive as `TransportStatusError` (kind `http-status`) before any
  parsing. §7.2's 401/403 → `Auth rejected` handling is an **assumption (A3)**, not an
  observation: Z.ai's actual auth-rejection shape was never captured, and an envelope-encoded
  rejection (HTTP 200 + error `code`) would currently read as `Format changed`. A retained
  §7.4 payload is the diagnostic that would settle it.

### Metric mapping (endpoint 1 → §8.4)

#### Entry recognition

Each `data.limits[]` entry is recognized by its `(type, unit)` pair. `type` is the quota
mechanism (observed: `TIME_LIMIT`, `TOKENS_LIMIT`); `unit` is the window time-unit per the
prototype labels (3 = hours, 5 = months, 6 = weeks —
[093 prototype](#the-prototype-traceability)); `number` is the window length in those units.
Recognized identities (D-047):

| `(type, unit)` pair                      | Status                                                                         | Metric `key`   | `label`                | `limitType`      | `unit`                                                                                                             | `windowSeconds`                        |
| ---------------------------------------- | ------------------------------------------------------------------------------ | -------------- | ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `(TIME_LIMIT, 5)`                        | verified (capture)                                                             | `mcp-monthly`  | Monthly MCP tool quota | `MONTHLY`        | `REQUESTS`                                                                                                         | —                                      |
| `(TOKENS_LIMIT, 3)`                      | verified (capture)                                                             | `tokens-5h`    | 5-hour token quota     | `ROLLING_WINDOW` | `PERCENT` while only `percentage` is supplied (§8.4 percentage-only rule); `CREDITS` if absolutes ever appear (A5) | `number × 3600` (observed `5` → 18000) |
| `(TIME_LIMIT, 6)` or `(TOKENS_LIMIT, 6)` | **assumed** (A1) — the weekly window is documented (094), the entry unobserved | `weekly-quota` | Weekly quota           | `WEEKLY`         | per present fields: `PERCENT` / `CREDITS` (A5)                                                                     | —                                      |

- `(TIME_LIMIT, 5, 1)` is the **monthly MCP-tool quota**: its `usageDetails` name exactly the
  094-documented MCP servers metered per call (`search-prime`, `web-reader`, `zread`), and 094
  source 1 meters MCP usage by call count — hence `unit: REQUESTS`.
- `(TOKENS_LIMIT, 3, 5)` is the **rolling 5-hour quota**: 094's "credit quota resets 5 hours
  after consumption" is a rolling window, hence `limitType: ROLLING_WINDOW` and
  `windowSeconds = number × 3600`. The 5-hour length is the documented plan rule (every tier);
  if `number` ever differs, `windowSeconds` still follows `number × 3600` — an observed
  deviation is diagnostics-worthy evidence, not a new window series, and the metric key stays
  `tokens-5h`.
- **Unknown `(type, unit)` pairs are skipped and logged** — not emitted and not parse errors
  (D-047; `synthetic/zai-quota-limit-unknown-type.json` drives this). An unrecognized entry is
  not a metric, and minting series keys for unknown shapes would fragment the `metric_values`
  history (every distinct unknown type would start a new series). A response whose entries are
  all unknown — or `limits: []` (`synthetic/zai-quota-limit-empty-limits.json`) — is a
  **valid snapshot with zero metrics**: envelope-valid emptiness is success, per §8.3's "not
  every plan necessarily exposes every field".
- **Key collisions are resolved first-wins:** entries are processed in array order, and a
  second entry mapping to an already-emitted key — both `unit 6` types, or the same
  `(type, unit)` twice — is skipped and logged (§8.4 requires keys to be unique within a
  snapshot).

#### Field-by-field mapping

| Endpoint-1 source                       | §8.4 target                                                                                                  | Status and evidence                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| envelope `code`/`data`                  | success discriminator + unwrap ([envelope rules](#response-envelopes))                                       | verified — 093 envelope, prototype tolerance                                                                                             |
| `data.level` (`"pro"` observed)         | `ProviderSnapshot.planName`, verbatim; a non-string value counts as absent (the endpoint-2 fallback applies) | verified — capture and `sanitized/zai-quota-limit.json`                                                                                  |
| recognized `limits[]` entry             | one `NormalizedMetric` per the recognition table above                                                       | verified shapes                                                                                                                          |
| `limits[].usage`                        | `limit`                                                                                                      | field verified; **assumed reading** (D-047 — [value semantics](#value-semantics-d-0471--the-question-093-posed-and-095-echoed-open))     |
| `limits[].currentValue`                 | `used`                                                                                                       | field verified; **assumed reading** (D-047)                                                                                              |
| `limits[].remaining`                    | `remaining`                                                                                                  | field verified; reading assumed with the triple (D-047)                                                                                  |
| `limits[].percentage`                   | `percentUsed`, verbatim                                                                                      | field verified; scale **pinned percent** (D-047 — [percentage scale](#percentage-scale-d-0472--the-question-095-deliberately-left-open)) |
| — (derived: `100 − percentUsed`)        | `percentRemaining`, listed in `derivedFields`                                                                | derived from a supplied/derived percentage — allowed; absolutes never derived from percentages (§8.4)                                    |
| `limits[].nextResetTime` (epoch ms)     | `resetsAt`, verbatim — already UTC epoch milliseconds; the prototype's ÷1000 is rendering only               | verified — 093 timestamps                                                                                                                |
| `limits[].usageDetails`                 | **unmapped** — §8.4 has no per-tool breakdown field                                                          | shape verified; deliberately dropped, documented here                                                                                    |
| `limits[].number` on month/week windows | **unmapped** — informational; the window is calendar-bound                                                   | prototype label                                                                                                                          |

#### Value semantics (D-047.1 — the question 093 posed and 095 echoed open)

Pinned: `usage` is the window **allowance**, `currentValue` the **consumed** amount,
`remaining` the remainder. It is the only self-consistent reading — the capture and the
fixtures preserve `currentValue + remaining = usage` and the per-tool `usageDetails` summing
to `currentValue` (a consumption breakdown sums to the consumed total). The prototype's
display ("used / total" from `usage`) contradicts `percentage` for the same values and is
rejected as a rendering artifact, not arithmetic evidence ([093 endpoint
1](#endpoint-1--quota-limits-get-apimonitorusagequotalimit),
[095 echo](#open-questions-status-carried-to-096)). Consequence for the adapter: an entry
whose supplied triple violates `used + remaining = limit` is emitted **invalid** — numeric
values dropped, `resetsAt` retained (D-010), `invalidReason: "currentValue + remaining does
not equal usage"` — not a parse error; the other entries of the response survive.

#### Percentage scale (D-047.2 — the question 095 deliberately left open)

Pinned: `percentage` is **integer percent** (0–100 scale), not per-mille. Discriminating
evidence: the capture's `TOKENS_LIMIT` entry carried `percentage: 19` while the account's
5-hour quota stood at roughly 18% consumption at capture time (main-session capture-time
context, recorded here as given evidence — this task made no new probe). 19 as percent is
consistent with an 18-point-something actual state under integer rounding; 19 as per-mille
would mean 1.9%. The monthly
entry (`percentage: 1` at exactly one per-mille consumed — the exact ratio 095 preserved in
the fixtures precisely so this question stayed open) cannot discriminate: 1 fits per-mille,
and integer percent only under upward rounding. Adapter decision points:

- `percentUsed` = `percentage` **verbatim** — no re-scaling, no rounding correction. Rounding
  direction is **not pinned** (both observations are consistent with ceiling; A10); pass-through
  keeps the provider's number authoritative.
- `percentRemaining` = `100 − percentUsed`, always, listed in `derivedFields` — it inherits
  the same integer coarseness by design, so `percentUsed + percentRemaining = 100` holds
  exactly for the UI.
- When `percentage` is absent but `used` and `limit` are both supplied, `percentUsed` is
  derived as `100 · used / limit` (marked derived) — the only permitted absolute→percentage
  direction. Token/credit counts are **never** derived from percentages (§8.4).
- **No cross-validation** against the absolute triple (D-047.2): integer rounding makes
  `percentage: 1` vs an actual 0.1% fraction expected noise, not malformation.
- Falsifier: a captured `percentage > 100` falsifies the percent scale and reopens D-047.

#### Recognized-entry validation (two-tier strictness, D-047.5)

Envelope and container types are strict (parse error on violation, per
[envelopes](#response-envelopes)); fields inside a recognized entry are tolerant:

- No usable values — neither `percentage` nor the absolute triple — → invalid metric,
  `invalidReason: "no quota values present on limits entry"` (the 093-open
  "percentage-less `TOKENS_LIMIT`" case; 097's planned synthetic fixture drives it).
- A wrong-typed value field (for example a string `percentage`) → invalid metric,
  `invalidReason: "<field> is not a number"` naming the field.
- Absent or wrong-typed `nextResetTime` → omit `resetsAt` (optional metadata); the rest of the
  entry survives. A recognized entry is never dropped for a metadata defect.
- A partially supplied absolute triple: the missing member is derived from the other two when
  both are supplied (for example `remaining = limit − used`), each derivation listed in
  `derivedFields` (§8.4); with fewer than two supplied, the present values map as far as they
  go and the metric stays valid.
- With the absolute triple present, the arithmetic identity is checked per
  [value semantics](#value-semantics-d-0471--the-question-093-posed-and-095-echoed-open);
  `usageDetails` is not validated (unmapped).

Concrete observed-state outputs (from `sanitized/zai-quota-limit.json`'s re-invented numbers;
the capture had the same shapes):

- `mcp-monthly`: `used: 2, remaining: 1998, limit: 2000` (`REQUESTS`),
  `percentUsed: 1, percentRemaining: 99` (derived), `resetsAt: 1795885500000`,
  `isValid: true`.
- `tokens-5h`: `unit: PERCENT`, absolute fields empty, `percentUsed: 23, percentRemaining: 77`
  (derived), `windowSeconds: 18000`, `resetsAt: 1793353200000`, `isValid: true` — §8.4's
  percentage-only rule; token counts are never invented from the percentage.

### Subscription and reset-card context (endpoints 2 and 3)

Endpoint 2 supplies plan context only — no quota numbers (verified,
[093 endpoint 2](#endpoint-2--subscription-records-get-apibizsubscriptionlist)):

| Endpoint-2 source                                                                                                                        | Target                                                                                                 | Status                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| selected record's `productName` (`"GLM Coding Pro"` observed)                                                                            | `planName` **fallback** — used only when endpoint 1's `data.level` is absent                           | field verified; rule A9                                                                                                                                                                                     |
| record selection among `data[]`                                                                                                          | the record with `inCurrentPeriod === true`; else the first with `status === "VALID"`; else no fallback | **assumed** (A9) — the capture's three records make both candidate rules coincide (the first `VALID` record is also the `inCurrentPeriod` one, the annual STRIPE record); the prototype takes first-`VALID` |
| `valid` range end (plan expiry), `autoRenew`, `billingCycle`, renewal times                                                              | **unmapped** — §8.4/§11.2 have no plan-expiry field; the `snapshots` table (083) stores plan name only | 093 called this "plan-expiry context, not quota metrics"                                                                                                                                                    |
| `id`, `customerId`, `agreementNo`, `orderNo`, `productId`, all prices, `paymentType`, `paymentChannel`, `version`, `refundable*`, `ban*` | **unmapped, deliberately** — no target field, and account-linked/monetary values stay out of snapshots | fixture policy D-040 exists precisely because these must not travel                                                                                                                                         |

Endpoint 3 is fetched but **maps nothing in v1** (D-047.6): `lastFiveHourResetTime` /
`lastWeekResetTime` and the card arrays have no §8.4 target, and the card object shape
(`available`, `expireTime`) is prototype-source only (A4) — both arrays were empty in the
capture
([093 endpoint 3](#endpoint-3--reset-cards-get-apibizcustomer-package-resetlisttargettypepersonal)).
The fetch is kept rather than dropped on two grounds: the `last*ResetTime` fields are the
provider's own declared-reset record — the same kind of evidence §12.1's reset detection acts
on, which for this provider arrives as metric `resetsAt` from endpoint 1 (nothing persists
the endpoint-3 fields in v1; mapping them into reset-event evidence later would be a contract
extension) — and re-adding a dropped request would itself be a contract change, while keeping
it costs one cheap GET per cycle. Card semantics (restore-to-full before natural reset, cycle
restart, expiry; a weekly card also restores the 5-hour quota) are documented in
[094's plan-credits section](#plan-credits-and-reset-rules).

### Assumption ledger

Each unverified gap, the adapter behavior chosen for it, where the gap surfaces, and the
observation that would reopen it:

| #   | Gap (unverified)                                                               | Adapter behavior                                                                                                        | Surfaces as / reopen trigger                                                      |
| --- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A1  | Weekly `unit 6` entry — documented quota, absent from the capture              | recognized as `weekly-quota` (WEEKLY); percentage-only → `PERCENT`; absolutes → arithmetic reading with `CREDITS` (A5)  | first capture containing a `unit 6` entry                                         |
| A2  | Error envelope (`code`/`msg` on failure) — no sample exists                    | any non-success/absent `code` or wrong-typed container → parse error; `msg` kept as diagnostic; codes never interpreted | first retained §7.4 payload of a real failure                                     |
| A3  | Auth-rejection shape — 401/403 vs 200 + error envelope                         | only HTTP 401/403 count as `Auth rejected` (§7.2); an envelope-encoded rejection reads `Format changed`                 | first observed bad-key response                                                   |
| A4  | Reset-card object shape — prototype-only (`available`, `expireTime`)           | not parsed in v1 (endpoint 3 maps nothing)                                                                              | a non-empty card array in a future capture                                        |
| A5  | Absolute values on `TOKENS_LIMIT`/weekly entries — percentage-only observed    | arithmetic reading applies; `unit: CREDITS` — 094's documented credit metering beats the `TOKENS` type name             | first such capture; a contradiction needs a D-047 successor                       |
| A6  | `Content-Type: application/json` declaration on 2xx responses — not recorded   | assumed; the transport gate is enforced as-is                                                                           | a `content-type` transport failure in diagnostics                                 |
| A7  | Additional required request headers — only `Authorization` verified            | adapter sends `Authorization` only                                                                                      | an `http-status`/`content-type` failure appearing on an otherwise healthy account |
| A8  | `targetType` values other than `PERSONAL` (team scope) — unobserved            | v1 always sends `targetType=PERSONAL`; no other value is defined                                                        | team-plan support, if ever requested                                              |
| A9  | Subscription record-selection rule — candidates coincide in the single capture | `inCurrentPeriod === true` preferred, then first `status === "VALID"`                                                   | a capture where the rules diverge                                                 |
| A10 | `percentage` rounding direction — consistent with ceiling, not observed        | pass-through verbatim; no rounding assumed or corrected                                                                 | a capture with sub-percent consumption states                                     |

### Evidence index

- **Endpoint URLs, methods, auth, envelope, field names/types, `nextResetTime` epoch-ms,
  `unit` 3/5/6 semantics, `number` semantics:** the
  [093 verified-data-source section](#verified-data-source-prototype--live-probe-2026-10-30--task-093)
  plus `test/fixtures/sanitized/zai-quota-limit.json`,
  `zai-subscription-list.json`, `zai-customer-package-reset-list.json` (structure verbatim,
  values re-invented per D-040; consumer notes in
  [`test/fixtures/README.md`](../../test/fixtures/README.md)).
- **Window/credit semantics (5-hour rolling, weekly cycle, per-call MCP metering, card
  behavior, plan tiers):** 094's [plan credits and reset rules](#plan-credits-and-reset-rules)
  and its overview findings.
- **No-official-contract verdict:** 094's [quota/usage endpoint status](#quotausage-endpoint-status);
  **availability statement and sample limitations:** the
  [095 §8.3 statement](#83-availability-statement); **the open questions this section closes
  or carries:** [095 open-questions status](#open-questions-status-carried-to-096).
- **Failure/edge shapes:** `test/fixtures/synthetic/zai-envelope-malformed.json` (envelope),
  `zai-quota-limit-unknown-type.json` (unknown entry), `zai-quota-limit-empty-limits.json`
  (empty-but-valid).
- **Decisions:** D-038 (verified source), D-040 (fixture policy), D-042 (transport seam),
  D-010 (invalid-metric metadata), D-047 (this section's decision cluster).
