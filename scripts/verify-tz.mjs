#!/usr/bin/env node
/**
 * Time-zone facts guard for the §17.1 regression matrix (task 126, decision
 * D-097).
 *
 * Runs at process start — the CI `timezone` job (and `make test-time
 * ZONE=…`) invoke it in a fresh process with `TZ` fixed in the environment,
 * because `Intl` resolves the process zone at startup: mutating
 * `process.env.TZ` inside an already-running process proves nothing (the
 * task-116 discipline, `test/helpers/rollingRangeRunner.ts`).
 *
 * The guard makes the matrix non-vacuous: before the time/peak-hours suite
 * runs under a matrix `TZ`, it verifies that
 *  1. `TZ` took effect — the default zone `Intl` resolves is the expected
 *     canonical name (ICU canonicalizes some identifiers: `Asia/Kolkata` →
 *     `Asia/Calcutta`, `Asia/Kathmandu` → `Asia/Katmandu`), so a spawn or CI
 *     wiring bug that left every cell in one zone fails loudly; and
 *  2. the runtime's tzdata carries the zone's DST and fractional-offset
 *     facts — the UTC offset of the default zone at two fixed probes
 *     (15 January and 15 July 2026), parsed from `longOffset` and compared
 *     numerically (ICU spells a zero offset `GMT` on Node 22.13.0 but
 *     `GMT+00:00` on Node 24, and this guard runs on both), must equal the
 *     recorded minute-exact values, so a tzdata that lost a zone or its
 *     transitions cannot pass vacuously.
 *
 * The expected values were generated from the declared-minimum runtime
 * (Node.js 22.13.0, full ICU); the CI job pins that version so the table is
 * a genuine oracle rather than a tautology. Exits non-zero with an
 * actionable English message when any check fails.
 */

/**
 * The nine matrix zones: the seven §17.1-required identifiers as process
 * `TZ` values, plus `Asia/Kathmandu` (a never-DST quarter-hour offset — the
 * required list covers quarter hours only through DST `Pacific/Chatham`)
 * and `Pacific/Kiritimati` (+14:00, the dateline extreme; the task-116
 * precedent). Together they cover DST and non-DST offsets at whole-, half-,
 * and quarter-hour granularity.
 *
 * `probes` holds the expected UTC offsets **in minutes** at the two fixed
 * instants below, in order — facts, not display spellings: ICU renders a
 * zero offset as `GMT` on Node 22.13.0 but `GMT+00:00` on Node 24, and the
 * guard must hold on every runtime that runs it (the main test matrix
 * spawns it on Node 22.13.0/22/24 through the integration spec). e.g.
 * `Lord_Howe` is a half-hour-offset zone whose DST shift is itself 30
 * minutes, and `Chatham` sits at +12:45/+13:45.
 */
const MATRIX = [
  { tz: 'UTC', resolved: 'UTC', probes: [0, 0] },
  // DST, whole-hour offsets, northern hemisphere.
  { tz: 'America/New_York', resolved: 'America/New_York', probes: [-300, -240] },
  { tz: 'Europe/London', resolved: 'Europe/London', probes: [0, 60] },
  // No DST, whole-hour offsets.
  { tz: 'Asia/Shanghai', resolved: 'Asia/Shanghai', probes: [480, 480] },
  // No DST, half-hour offset.
  { tz: 'Asia/Kolkata', resolved: 'Asia/Calcutta', probes: [330, 330] },
  // No DST, quarter-hour offset.
  { tz: 'Asia/Kathmandu', resolved: 'Asia/Katmandu', probes: [345, 345] },
  // DST, half-hour offset and a 30-minute DST shift (southern hemisphere).
  { tz: 'Australia/Lord_Howe', resolved: 'Australia/Lord_Howe', probes: [660, 630] },
  // DST, quarter-hour offsets (southern hemisphere).
  { tz: 'Pacific/Chatham', resolved: 'Pacific/Chatham', probes: [825, 765] },
  // No DST, +14:00 — the dateline extreme.
  { tz: 'Pacific/Kiritimati', resolved: 'Pacific/Kiritimati', probes: [840, 840] },
];

/** Fixed instants far from every zone's 2026 transitions: one per DST half. */
const PROBES = [
  { label: '2026-01-15T00:00:00Z', epochMs: Date.parse('2026-01-15T00:00:00Z') },
  { label: '2026-07-15T00:00:00Z', epochMs: Date.parse('2026-07-15T00:00:00Z') },
];

/**
 * Parses a `longOffset` string (`GMT`, `GMT+05:30`, `GMT-04:00`, …) into
 * seconds from UTC. Returns null for anything the matrix's minute-granular
 * zone set cannot produce (a seconds component, a malformed value) — the
 * caller fails loudly on it instead of comparing noise.
 */
function parseOffsetSeconds(display) {
  if (display === 'GMT') return 0;
  const match = /^GMT([+-])(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(display);
  if (!match) return null;
  const [, sign, hours, minutes, seconds] = match;
  const total =
    Number(hours) * 3600 + Number(minutes) * 60 + (seconds === undefined ? 0 : Number(seconds));
  return sign === '-' ? -total : total;
}

/** The `longOffset` display of the process default zone at one instant (no explicit timeZone). */
function defaultZoneOffsetDisplay(epochMs) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'longOffset' }).formatToParts(
    epochMs,
  );
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? '(no offset part)';
}

const tz = process.env.TZ;
if (!tz) {
  console.error(
    'TZ is not set (or empty) — the time-zone matrix runs each zone in a fresh ' +
      'process with TZ fixed in the environment (the CI timezone job, or ' +
      "'make test-time ZONE=<zone>'); mutating process.env.TZ later proves nothing",
  );
  process.exit(1);
}

const entry = MATRIX.find((candidate) => candidate.tz === tz);
if (!entry) {
  console.error(
    `TZ='${tz}' is not one of the nine §17.1 matrix zones: ${MATRIX.map((item) => item.tz).join(', ')}. ` +
      'A zone outside the matrix would run the suite off the recorded coverage grid — ' +
      'extend this table, the CI timezone matrix, and test/integration/tz-verify-script.spec.ts together',
  );
  process.exit(1);
}

const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (resolved !== entry.resolved) {
  console.error(
    `TZ=${tz} resolved as '${resolved}', expected '${entry.resolved}' — the environment ` +
      "did not take effect, or this runtime's ICU canonicalization differs from " +
      "Node.js 22.13.0's (update this table's 'resolved' column deliberately)",
  );
  process.exit(1);
}

for (const [index, probe] of PROBES.entries()) {
  const display = defaultZoneOffsetDisplay(probe.epochMs);
  const actualSeconds = parseOffsetSeconds(display);
  const expectedSeconds = entry.probes[index] * 60;
  if (actualSeconds === null || actualSeconds !== expectedSeconds) {
    console.error(
      `TZ=${tz}: offset at ${probe.label} is '${display}', expected UTC${formatOffset(expectedSeconds)} ` +
        `— the runtime's tzdata disagrees with the recorded zone facts (a lost zone, a changed ` +
        'transition, or an offset rendering this parser does not know); investigate before ' +
        'trusting this matrix cell',
    );
    process.exit(1);
  }
}

console.log(
  `tz ok: TZ=${tz} resolved ${resolved}; ` +
    PROBES.map((probe, index) => {
      const display = defaultZoneOffsetDisplay(probe.epochMs);
      return `${probe.label} ${display} (${formatOffset(entry.probes[index] * 60)})`;
    }).join('; '),
);

/** Renders a signed offset in seconds as ±HH:MM (the table's own notation). */
function formatOffset(totalSeconds) {
  const sign = totalSeconds < 0 ? '-' : '+';
  const abs = Math.abs(totalSeconds);
  const hours = String(Math.floor(abs / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((abs % 3600) / 60)).padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}
