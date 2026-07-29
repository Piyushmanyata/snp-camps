export type PatientStatusGuidance = {
  label: string;
  instruction: string;
  tone: "neutral" | "waiting" | "complete";
};

/**
 * Patient-facing meaning of the queue state. Hinglish — patients read Hinglish,
 * staff read English, and a leak either way is a bug (CONTEXT.md §Language).
 *
 * There is no treatment-order arm any more: migration 20260728119000 retired the
 * station, so `patient_status_by_token` no longer returns `pending_orders` and
 * the old "pending treatments" branch was unreachable.
 */
export function getPatientStatusGuidance(
  queueStatus: string,
): PatientStatusGuidance {
  if (queueStatus === "registered") {
    return {
      label: "Registration ho gaya",
      instruction:
        "Camp ke din desk par jaayein. Wahan aapka parcha print hoga, tabhi aap line mein aayenge.",
      tone: "neutral",
    };
  }

  if (queueStatus === "waiting") {
    return {
      label: "Line mein hain",
      instruction:
        "Doctor ke kamre ke paas rukein. Aapka number har 30 second mein apne aap update hota hai.",
      tone: "waiting",
    };
  }

  if (queueStatus === "seen") {
    return {
      label: "Aapka number ho gaya",
      instruction:
        "Doctor ne aapko dekh liya hai. Apna parcha sambhaal kar rakhein.",
      tone: "complete",
    };
  }

  return {
    label: "Status nahi mil paaya",
    instruction: "Kripya registration desk par poochein.",
    tone: "neutral",
  };
}
