/**
 * The public health response contract (task 147, spec §13; decision D-111;
 * the authenticated diagnostics extension FSM-4/D-192).
 *
 * §13's endpoint table pins `GET /api/health` down to one row: "Unauthenticated
 * response contains only `{ "status": "ok" }`; authenticated response may
 * include process and database diagnostics, including whether the polling
 * engine is running". This module is that response's TypeBox definition —
 * the schema the route serializes through and the one task 163 generates
 * OpenAPI from (§13: "Define every request and response through
 * TypeBox/JSON Schema").
 *
 * The object is closed (`additionalProperties: false`) on purpose: the
 * serializer compiled from this schema emits exactly the declared keys and
 * structurally drops every other, so the unauthenticated half of the
 * contract — no extra system diagnostics before authentication — holds at
 * the serialization layer, not by handler discipline. What the response
 * must never contain beyond the declared pair: versions, uptime,
 * memory/pid, storage or database state, account data, errors, timestamps.
 *
 * The authenticated half of §13's row (D-111's recorded deferral, named by
 * D-180 as FSM-4's spec basis) is the optional `polling` block: present
 * only on the branch the route grants diagnostics to, absent — and
 * byte-exactly omitted by the compiled serializer — everywhere else. The
 * property is optional rather than `nullable` so the unauthenticated
 * payload `{ status: "ok" }` serializes to the literal with no trailing
 * serialization artifacts.
 */

import { type Static, Type } from '@sinclair/typebox';

/**
 * The authenticated diagnostics block (FSM-4, D-192): one fact — whether
 * the polling engine's dispatch loop is alive — closed like its parent so
 * no future diagnostic rides it without a contract change.
 */
export const HealthPollingDiagnosticsSchema = Type.Object(
  { running: Type.Boolean() },
  { additionalProperties: false },
);

/** The `polling` diagnostics `GET /api/health` may carry when granted. */
export type HealthPollingDiagnostics = Static<typeof HealthPollingDiagnosticsSchema>;

/**
 * The `GET /api/health` response (spec §13): the literal public body plus
 * the optional authenticated `polling` diagnostics — closed so no
 * additional property can ever serialize. The unauthenticated wire form is
 * exactly `{"status":"ok"}`: an absent optional property emits nothing.
 */
export const HealthResponseSchema = Type.Object(
  {
    status: Type.Literal('ok'),
    polling: Type.Optional(HealthPollingDiagnosticsSchema),
  },
  { additionalProperties: false },
);

/** The shape `GET /api/health` answers with. */
export type HealthResponse = Static<typeof HealthResponseSchema>;
