/**
 * Behaviour tests for the shared DB → camp-worker error mapper (#31)
 * and structured retry classifier (#60).
 * Known codes map to safe copy; unknown codes never leak raw Postgres text.
 * Retry uses an allow-list of transient classes only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyOperationError,
  isRetryableDbError,
  mapDbError,
  publicRegistrationError,
} from "../src/lib/public-error.ts";

test("known Postgres unique violation maps to camp-worker copy", () => {
  const msg = mapDbError(
    { code: "23505", message: 'duplicate key value violates unique constraint "camps_one_active"' },
    { log: false },
  );
  assert.equal(msg, "That record already exists.");
  assert.doesNotMatch(msg, /duplicate key|camps_one_active/i);
});

test("RLS / permission denial maps to permission copy", () => {
  const msg = mapDbError(
    {
      code: "42501",
      message: 'permission denied for table patients',
    },
    { log: false },
  );
  assert.equal(msg, "You do not have permission for this action.");
  assert.doesNotMatch(msg, /permission denied for table/i);
});

test("foreign key violation maps without leaking table names", () => {
  const msg = mapDbError(
    {
      code: "23503",
      message:
        'insert or update on table "camp_days" violates foreign key constraint "camp_days_camp_id_fkey"',
    },
    { log: false },
  );
  assert.equal(msg, "Related data is missing or still in use.");
  assert.doesNotMatch(msg, /camp_days_camp_id_fkey|foreign key constraint/i);
});

test("AADHAAR_DUPLICATE keeps structured desk copy", () => {
  const msg = mapDbError("AADHAAR_DUPLICATE:reg=1042", { log: false });
  assert.match(msg, /reg no 1042/);
  assert.doesNotMatch(msg, /AADHAAR_DUPLICATE/);
});

test("registration day-full phrase maps", () => {
  const msg = publicRegistrationError(
    { message: "day is full — select a camp day with seats" },
    "test",
  );
  // publicRegistrationError logs by default; still maps cleanly
  assert.equal(msg, "That camp day is full. Choose another day.");
});

test("SEAT_LIMIT_BELOW_ASSIGNED maps to capacity copy with count (#66)", () => {
  const msg = mapDbError(
    { message: "SEAT_LIMIT_BELOW_ASSIGNED:taken=5" },
    { log: false },
  );
  assert.equal(msg, "Seat limit cannot be below 5 existing bookings");
  assert.doesNotMatch(msg, /SEAT_LIMIT_BELOW_ASSIGNED|connection|internet/i);
});

test("legacy seats-below-taken phrase still maps (#66)", () => {
  const msg = mapDbError(
    { message: "Cannot set seats below taken (3)" },
    { log: false },
  );
  assert.equal(msg, "Seat limit cannot be below 3 existing bookings");
});

test("unknown code maps to safe generic and never returns raw text", () => {
  const raw =
    "ERROR: relation \"secret_internal_table\" does not exist (SQLSTATE 42P01)";
  const msg = mapDbError({ code: "42P01", message: raw }, { log: false });
  assert.equal(msg, "Something went wrong. Try again or ask the desk.");
  assert.doesNotMatch(msg, /secret_internal_table|42P01|SQLSTATE|relation/i);
});

test("unknown error logs raw text when log is enabled", () => {
  const raw = "super_secret_postgres_detail_xyz";
  /** @type {unknown[]} */
  const calls = [];
  const original = console.error;
  console.error = (...args) => {
    calls.push(args);
  };
  try {
    const msg = mapDbError(
      { code: "XX000", message: raw },
      { context: "unit-test", log: true },
    );
    assert.equal(msg, "Something went wrong. Try again or ask the desk.");
    assert.ok(calls.length >= 1, "console.error should be called");
    const flat = JSON.stringify(calls);
    assert.match(flat, /super_secret_postgres_detail_xyz/);
    assert.match(flat, /unit-test/);
    assert.doesNotMatch(msg, /super_secret/);
  } finally {
    console.error = original;
  }
});

test("custom fallback is used when nothing matches", () => {
  const msg = mapDbError(
    { code: "XX000", message: "weird internal boom" },
    { log: false, fallback: "Queue could not be loaded — retry." },
  );
  assert.equal(msg, "Queue could not be loaded — retry.");
  assert.doesNotMatch(msg, /weird internal boom/);
});

test("publicRegistrationError uses registration fallback", () => {
  const msg = mapDbError(
    { message: "completely unknown xyz" },
    {
      log: false,
      fallback: "Registration failed. Try again or ask the desk.",
    },
  );
  assert.equal(msg, "Registration failed. Try again or ask the desk.");
});

// ---------------------------------------------------------------------------
// #60 — classifyOperationError matrix (structured codes, not English regex)
// ---------------------------------------------------------------------------

/** @type {Array<{ name: string, error: object|string, flags?: object, retryable: boolean, category?: string, copyMatch?: RegExp }>} */
const MATRIX = [
  {
    name: "transport failure flag",
    error: { message: "anything" },
    flags: { transportFailure: true },
    retryable: true,
    category: "transient",
  },
  {
    name: "timedOut flag",
    error: { message: "aborted" },
    flags: { timedOut: true },
    retryable: true,
  },
  {
    name: "HTTP 503",
    error: { message: "Service Unavailable", status: 503 },
    retryable: true,
    category: "transient",
  },
  {
    name: "browser API transport sentinel",
    error: { code: "NETWORK_ERROR", message: "Registration service unavailable" },
    retryable: true,
    category: "transient",
  },
  {
    name: "connection failure 08006",
    error: { code: "08006", message: "connection_failure" },
    retryable: true,
    category: "transient",
  },
  {
    name: "serialization_failure 40001",
    error: { code: "40001", message: "could not serialize access" },
    retryable: true,
    category: "transient",
  },
  {
    name: "deadlock 40P01",
    error: { code: "40P01", message: "deadlock detected" },
    retryable: true,
    category: "transient",
  },
  {
    name: "statement timeout 57014",
    error: {
      code: "57014",
      message: "canceling statement due to statement timeout",
    },
    retryable: true,
    category: "timeout",
  },
  {
    name: "browser Failed to fetch (legacy message fallback)",
    error: { message: "TypeError: Failed to fetch" },
    retryable: true,
    category: "transient",
  },
  {
    name: "insufficient privilege 42501",
    error: { code: "42501", message: "permission denied for table patients" },
    retryable: false,
    category: "permission",
    copyMatch: /permission/i,
  },
  {
    name: "unique violation 23505",
    error: { code: "23505", message: "duplicate key value" },
    retryable: false,
    category: "conflict",
  },
  {
    name: "not found PGRST116",
    error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
    retryable: false,
    category: "not_found",
  },
  {
    name: "invalid input 22P02",
    error: { code: "22P02", message: "invalid input syntax for type uuid" },
    retryable: false,
    category: "validation",
  },
  {
    name: "schema cache / missing function PGRST202",
    error: {
      code: "PGRST202",
      message: "Could not find the function public.missing in the schema cache",
    },
    retryable: false,
  },
  {
    name: "undefined table 42P01",
    error: { code: "42P01", message: 'relation "secret" does not exist' },
    retryable: false,
  },
  {
    name: "RPC raise day full (P0001) is terminal",
    error: {
      code: "P0001",
      message: "This day is full (40 seats). Choose another day.",
    },
    retryable: false,
    category: "capacity",
    copyMatch: /full|another day/i,
  },
  {
    name: "SEAT_LIMIT_BELOW_ASSIGNED is terminal capacity",
    error: { message: "SEAT_LIMIT_BELOW_ASSIGNED:taken=5" },
    retryable: false,
    category: "capacity",
    copyMatch: /below 5/,
  },
  {
    name: "inactive camp phrase is terminal",
    error: { code: "P0001", message: "No active camp" },
    retryable: false,
    copyMatch: /no longer available|camp/i,
  },
  {
    name: "unknown XX000 is terminal (not retried)",
    error: { code: "XX000", message: "internal boom detail" },
    retryable: false,
    category: "unknown",
  },
  {
    name: "AADHAAR_DUPLICATE is terminal",
    error: { message: "AADHAAR_DUPLICATE:reg=9" },
    retryable: false,
    category: "duplicate",
  },
];

for (const row of MATRIX) {
  test(`classify: ${row.name}`, () => {
    const classified = classifyOperationError(row.error, {
      log: false,
      ...(row.flags || {}),
    });
    assert.equal(
      classified.retryable,
      row.retryable,
      `retryable for ${row.name}`,
    );
    if (row.category) {
      assert.equal(
        classified.publicCategory,
        row.category,
        `category for ${row.name}`,
      );
    }
    if (row.copyMatch) {
      assert.match(classified.publicMessage, row.copyMatch);
    }
    assert.doesNotMatch(
      classified.publicMessage,
      /SQLSTATE|relation "|permission denied for table|duplicate key value|secret/i,
    );
    assert.equal(
      isRetryableDbError(row.error, row.flags || {}),
      row.retryable,
    );
  });
}

test("classify logs category and retryable without putting raw text in publicMessage", () => {
  /** @type {unknown[]} */
  const calls = [];
  const original = console.error;
  console.error = (...args) => {
    calls.push(args);
  };
  try {
    const c = classifyOperationError(
      { code: "42501", message: "permission denied for table patients" },
      { context: "desk-ops.assign", log: true },
    );
    assert.equal(c.retryable, false);
    assert.equal(c.publicCategory, "permission");
    const flat = JSON.stringify(calls);
    assert.match(flat, /42501/);
    assert.match(flat, /permission/);
    assert.match(flat, /desk-ops\.assign/);
    assert.doesNotMatch(c.publicMessage, /patients/);
  } finally {
    console.error = original;
  }
});
