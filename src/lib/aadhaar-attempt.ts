
import type { DecodeOutcome } from "@/lib/aadhaar-decode.worker";

export type { DecodeOutcome };

export type AadhaarDecodeClient = {
  decodePayload: (payload: string) => Promise<DecodeOutcome>;
  decodeFrame: (image: ImageData, thorough?: boolean) => Promise<DecodeOutcome>;
};

export type AadhaarAttempt = {
  image?: ImageData;
  nativeText?: string | null;
  client: AadhaarDecodeClient;
  thorough?: boolean;
};

const NOTHING: DecodeOutcome = { status: "none" };

export async function attemptAadhaarDecode(
  attempt: AadhaarAttempt,
): Promise<DecodeOutcome> {
  const hintText = attempt.nativeText?.trim();

  let hint: DecodeOutcome = NOTHING;
  if (hintText) {
    hint = await attempt.client.decodePayload(hintText);
    if (hint.status === "parsed") return hint;
  }

  if (!attempt.image) return hint;

  const binary = await attempt.client.decodeFrame(
    attempt.image,
    attempt.thorough,
  );
  return binary.status === "none" ? hint : binary;
}
