export type PatientStatusGuidance = {
  label: string;
  instruction: string;
  tone: "neutral" | "waiting" | "complete";
};

/** Patient-facing meaning of the queue state and remaining treatment work. */
export function getPatientStatusGuidance(
  queueStatus: string,
  pendingOrderCount: number,
): PatientStatusGuidance {
  if (queueStatus === "registered") {
    return {
      label: "Registered",
      instruction: "Check in at the registration desk when you arrive.",
      tone: "neutral",
    };
  }

  if (queueStatus === "waiting") {
    return {
      label: "Waiting for doctor",
      instruction:
        "Stay near the consultation area. Your queue position refreshes every 30 seconds.",
      tone: "waiting",
    };
  }

  if (queueStatus === "seen" && pendingOrderCount > 0) {
    return {
      label: "Consultation complete",
      instruction: "Please collect the pending treatments shown below.",
      tone: "waiting",
    };
  }

  if (queueStatus === "seen") {
    return {
      label: "Camp visit complete",
      instruction: "Your consultation and prescribed treatments are complete.",
      tone: "complete",
    };
  }

  return {
    label: "Status unavailable",
    instruction: "Please ask the registration desk for help.",
    tone: "neutral",
  };
}
