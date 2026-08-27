import assert from "node:assert/strict";
import test from "node:test";
import {
  PRINT_WINDOW_CLOSED,
  deskPrintWindowOpen,
  isPrintWindowOpen,
  printConfirmationGate,
} from "../src/lib/print-window.ts";
import { classifyOperationError } from "../src/lib/public-error.ts";

test("print window is closed when the flag is off", () => {
  assert.equal(
    isPrintWindowOpen({
      printingOpen: false,
    }),
    false,
  );
});

test("print window is open when the flag is on", () => {
  assert.equal(
    isPrintWindowOpen({
      printingOpen: true,
    }),
    true,
  );
});

test("desk print window is open when any day has printing enabled", () => {
  assert.equal(
    deskPrintWindowOpen([
      { day_date: "2026-08-15", printing_open: false },
      { day_date: "2026-08-16", printing_open: false },
    ]),
    false,
  );
  assert.equal(
    deskPrintWindowOpen([
      { day_date: "2026-08-15", printing_open: true },
      { day_date: "2026-08-16", printing_open: false },
    ]),
    true,
  );
  assert.equal(
    deskPrintWindowOpen([
      { day_date: "2026-08-15", printing_open: false },
      { day_date: "2026-08-16", printing_open: true },
    ]),
    true,
  );
  assert.equal(deskPrintWindowOpen([]), false);
});

test("PRINT_WINDOW_CLOSED is a new greppable identifier mapped to English", () => {
  assert.equal(PRINT_WINDOW_CLOSED, "PRINT_WINDOW_CLOSED");
  const classified = classifyOperationError(
    { message: "PRINT_WINDOW_CLOSED" },
    { log: false },
  );
  assert.match(classified.publicMessage, /Ask an admin to open the print window/i);
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
