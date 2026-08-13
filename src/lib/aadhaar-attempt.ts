/**
 * One Aadhaar attempt, one outcome (ADR 0014).
 *
 * Aadhaar Secure QR is binary. The phone's built-in reader returns text and can
 * look like a hit while the real payload is unread, so its answer is a **hint**:
 * only a genuinely parsed card ends the attempt. Anything else — garbage, our
 * own desk slip, nothing at all — still gives the binary reader its turn on the
 * same picture.
 *
 * The client is injected so the sequencing is testable without the decode
 * worker, which calls `Comlink.expose` at module top level and therefore cannot
 * be imported outside a Worker. Camera, photo (ADR 0012) and USB wedge all
 * route through here; the capture screen only starts the camera and applies the
 * outcome, and completeness stays the registration form's decision.
 */

import type { DecodeOutcome } from "@/lib/aadhaar-decode.worker";

export type { DecodeOutcome };

/** The decoder surface an attempt needs — satisfied by `aadhaar-decode-client`. */
export type AadhaarDecodeClient = {
  decodePayload: (payload: string) => Promise<DecodeOutcome>;
  decodeFrame: (image: ImageData, thorough?: boolean) => Promise<DecodeOutcome>;
};

export type AadhaarAttempt = {
  /** The picture to read. Absent for a USB wedge, which carries text only. */
  image?: ImageData;
  /** Whatever the phone's built-in reader said, if anything. */
  nativeText?: string | null;
  client: AadhaarDecodeClient;
  /** Passed through to the binary reader's preprocessing cascade. */
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
    // A real card is the whole attempt — do not pay for the binary reader too.
    if (hint.status === "parsed") return hint;
  }

  if (!attempt.image) return hint;

  const binary = await attempt.client.decodeFrame(
    attempt.image,
    attempt.thorough,
  );
  // The hint's reason outlives an empty binary read: "not an Aadhaar card" is
  // what stops the session, and collapsing it to `none` would keep the camera
  // open on our own desk slip.
  return binary.status === "none" ? hint : binary;
}
