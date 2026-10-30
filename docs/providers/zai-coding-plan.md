# Z.ai Coding Plan — provider contract dossier

This file is the evidence base for the `ZaiCodingPlanProvider` adapter, mandated by
[spec §8.3](../../plan/SPECIFICATION.md). It is a **dated contract dossier**: each research or
verification round appends its own dated section and never rewrites older ones. Later tasks extend
this file — 095 (sanitized live response), 096 (full request/response contract),
112 (peak-schedule encoding), 127 (schedule-source verification).

Current contents: the task 094 research snapshot (official documentation only) and the task 093
verified-data-source section (the original prototype plus a sanitized live probe — the actual
endpoints, authentication, and response shapes). The 094 snapshot records **only** what official
Z.ai documentation says, with exact URLs and access dates; nothing there is inferred, and
undocumented endpoints, fields, or samples are deliberately absent there (spec §8.3 forbids
inventing them). The 093 section records what the prototype reads and what a live probe returned,
with `<redacted>` markers in place of every account-linked value (spec §15/§17.1 forbid committing
secrets or personal data).

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
