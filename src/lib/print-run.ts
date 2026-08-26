export type PrintRunResult = { ok: boolean; error?: string | null };

type PrintRunOutcome = {
  print: boolean;
  tone: "success" | "error";
  text: string;
};

const RECORDED = "Prescription recorded. Print dialog opened.";
const FAILED = "Could not print prescription. Please try again.";

export function resolvePrintRun(
  results: readonly PrintRunResult[],
): PrintRunOutcome {
  const failed = results.find((result) => !result.ok);
  if (!failed && results.length > 0) {
    return { print: true, tone: "success", text: RECORDED };
  }
  return {
    print: results.some((result) => result.ok),
    tone: "error",
    text: failed?.error || FAILED,
  };
}
