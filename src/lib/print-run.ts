export type PrintRunResult = { ok: boolean; error?: string | null };

type PrintRunOutcome = {
  print: boolean;
  tone: "success" | "error";
  text: string;
};

const RECORDED = "Parchi record ho gayi. Print dialog khul gaya hai.";
const FAILED = "Parchi print nahi ho payi. Dobara try karein.";

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
