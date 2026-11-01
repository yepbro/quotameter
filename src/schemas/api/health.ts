/**
 * The public health response contract (task 147, spec §13; decision D-111).
 *
 * §13's endpoint table pins `GET /api/health` down to one row: "Unauthenticated
 * response contains only `{ "status": "ok" }`". This module is that response's
 * TypeBox definition — the schema the route serializes through and the one
 * task 163 generates OpenAPI from (§13: "Define every request and response
 * through TypeBox/JSON Schema").
 *
 * The object is closed (`additionalProperties: false`) on purpose: the
 * serializer compiled from this schema emits exactly the declared key and
 * structurally drops any other, so the done-condition — no extra system
 * diagnostics leak before authentication — holds at the serialization layer,
 * not by handler discipline. What the response must never contain: versions,
 * uptime, memory/pid, storage or database state, account data, errors,
 * timestamps.
 *
 * The authenticated half of §13's row ("may include process/database
 * diagnostics") is deliberately absent: the spec's "may" makes it optional,
 * and a diagnostics extension is a future task's own decision (D-111).
 */

import { type Static, Type } from '@sinclair/typebox';

/**
 * The literal `GET /api/health` response (spec §13): one key, one value,
 * nothing else — closed so no additional property can ever serialize.
 */
export const HealthResponseSchema = Type.Object(
  { status: Type.Literal('ok') },
  { additionalProperties: false },
);

/** The shape `GET /api/health` answers with. */
export type HealthResponse = Static<typeof HealthResponseSchema>;
