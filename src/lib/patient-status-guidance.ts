export type PatientStatusGuidance = {
  label: string;
  instruction: string;
  tone: "neutral" | "complete";
};

export function getPatientStatusGuidance(
  queueStatus: string,
): PatientStatusGuidance {
  if (queueStatus === "registered") {
    return {
      label: "Registration ho gaya",
      instruction:
        "Camp ke din apne venue par jaayein. Desk par aapki parchi print hogi.",
      tone: "neutral",
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
