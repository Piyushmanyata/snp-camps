# One Aadhaar attempt; two QR readers

---
Status: accepted
---

Aadhaar Secure QR is binary. The phone’s built-in reader returns text and can
look like a hit while the real payload is unread. Treating that hit as final
skipped the backup reader (ADR 0012’s native-first path).

**One attempt produces one outcome.** The decoder is given the picture and
whatever the built-in reader said. It tries that as a hint, then the binary
reader, and returns card / garbage / not-Aadhaar. The capture screen only
starts the camera and applies the outcome. Completeness is the registration
form’s decision (desk may fill a partial; self-registration is all-or-nothing).

Aadhaar capture and Patient QR capture share one camera opener (focus, start,
stop). They do **not** share a reader: Aadhaar stays on the heavy decoder;
Patient QR stays on the cheap id reader.

Supplements ADR 0012; does not change “parsed, not verified” (ADR 0004).
