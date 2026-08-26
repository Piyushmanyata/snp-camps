import assert from "node:assert/strict";
import test from "node:test";
import {
  PRINT_WINDOW_CLOSED,
  deskPrintWindowOpen,
  isPrintWindowOpen,
  printConfirmationGate,
} from "../src/lib/print-window.ts";
import { classifyOperationError } from "../src/lib/public-error.ts";

test("print window is closed when the flag is off on today's date", () => {
  const now = new Date("2026-08-15T18:30:00.000Z");
  assert.equal(
    isPrintWindowOpen({
      dayDate: "2026-08-16",
      printingOpen: false,
      now,
    }),
    false,
  );
});

test("print window is open when the flag is on and the day is today in Asia/Kolkata", () => {
  const now = new Date("2026-08-15T18:30:00.000Z");
  assert.equal(
    isPrintWindowOpen({
      dayDate: "2026-08-16",
      printingOpen: true,
      now,
    }),
    true,
  );
});

test("print window is closed when the flag is on for yesterday in Asia/Kolkata", () => {
  const now = new Date("2026-08-15T18:30:00.000Z");
  assert.equal(
    isPrintWindowOpen({
      dayDate: "2026-08-15",
      printingOpen: true,
      now,
    }),
    false,
  );
});

test("print window is closed when the flag is on for tomorrow in Asia/Kolkata", () => {
  const now = new Date("2026-08-15T18:30:00.000Z");
  assert.equal(
    isPrintWindowOpen({
      dayDate: "2026-08-17",
      printingOpen: true,
      now,
    }),
    false,
  );
});

test("Asia/Kolkata midnight: the previous IST calendar day closes at 18:30Z", () => {
  const justBefore = new Date("2026-08-15T18:29:59.999Z");
  const justAfter = new Date("2026-08-15T18:30:00.000Z");
  assert.equal(
    isPrintWindowOpen({
      dayDate: "2026-08-15",
      printingOpen: true,
      now: justBefore,
    }),
    true,
  );
  assert.equal(
    isPrintWindowOpen({
      dayDate: "2026-08-15",
      printingOpen: true,
      now: justAfter,
    }),
    false,
  );
  assert.equal(
    isPrintWindowOpen({
      dayDate: "2026-08-16",
      printingOpen: true,
      now: justAfter,
    }),
    true,
  );
});

test("desk print window follows today's flagged day only", () => {
  const now = new Date("2026-08-15T18:30:00.000Z");
  assert.equal(
    deskPrintWindowOpen(
      [
        { day_date: "2026-08-15", printing_open: true },
        { day_date: "2026-08-16", printing_open: false },
      ],
      now,
    ),
    false,
  );
  assert.equal(
    deskPrintWindowOpen(
      [
        { day_date: "2026-08-15", printing_open: true },
        { day_date: "2026-08-16", printing_open: true },
      ],
      now,
    ),
    true,
  );
  assert.equal(deskPrintWindowOpen([], now), false);
});

test("PRINT_WINDOW_CLOSED is a new greppable identifier mapped to Hinglish", () => {
  assert.equal(PRINT_WINDOW_CLOSED, "PRINT_WINDOW_CLOSED");
  const classified = classifyOperationError(
    { message: "PRINT_WINDOW_CLOSED" },
    { log: false },
  );
  assert.match(classified.publicMessage, /Admin se print window khulwaein/i);
  assert.equal(classified.retryable, false);
});

test("print confirmation gate is unavailable when the client or query cannot be read", () => {
  assert.equal(
    printConfirmationGate({ clientMissing: true, queryError: false, gate: null }),
    "unavailable",
  );
  assert.equal(
    printConfirmationGate({
      clientMissing: false,
      queryError: true,
      gate: { provenance: "card_scanned" },
    }),
    "unavailable",
  );
  assert.equal(
    printConfirmationGate({ clientMissing: false, queryError: false, gate: null }),
    "unavailable",
  );
  assert.equal(
    printConfirmationGate({
      clientMissing: false,
      queryError: false,
      gate: {
        provenance: "manual_exception",
        confirmation_override_at: null,
        duplicateKey: null,
      },
    }),
    "required",
  );
  assert.equal(
    printConfirmationGate({
      clientMissing: false,
      queryError: false,
      gate: { provenance: "card_scanned", duplicateKey: "abc" },
    }),
    "ok",
  );
  assert.equal(
    printConfirmationGate({
      clientMissing: false,
      queryError: false,
      gate: {
        provenance: "manual_exception",
        confirmation_override_at: "2026-08-26T00:00:00.000Z",
        duplicateKey: null,
      },
    }),
    "ok",
  );
  assert.equal(
    printConfirmationGate({
      clientMissing: false,
      queryError: false,
      gate: {
        provenance: "manual_exception",
        confirmation_override_at: null,
        duplicateKey: "confirmed-key",
      },
    }),
    "ok",
  );
});

test("print confirmation gate is unavailable for a malformed result", () => {
  assert.equal(
    printConfirmationGate({
      clientMissing: false,
      queryError: false,
      gate: {},
    }),
    "unavailable",
  );
});

test("PRINT_WINDOW_NOT_TODAY is mapped to English admin copy", () => {
  const classified = classifyOperationError(
    { message: "PRINT_WINDOW_NOT_TODAY" },
    { log: false },
  );
  assert.match(classified.publicMessage, /today's camp day/i);
  assert.equal(classified.retryable, false);
});
