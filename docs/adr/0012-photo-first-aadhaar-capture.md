# ADR 0012: Photo-first Aadhaar capture, native detector first

## Status

Accepted

## Context

Aadhaar Secure QR codes are dense (multi-kilobyte payloads). On the ₹6–10k
fixed-focus Android phones that staff and patients actually hold, a live
`getUserMedia` video stream rarely delivers a frame sharp enough to resolve the
modules, however well-tuned the decode pipeline is. The live pipeline (worker
decode, probe-geometry sweep, WASM engines) has been tuned repeatedly and still
reads as "slow and unreliable" in the field — self-registration is effectively
unavailable to patients because the scan step defeats them.

Two capture paths are dramatically more reliable on the same hardware:

1. A **still photo** taken with the phone's native camera app
   (`<input type="file" accept="image/*" capture="environment">`): the OS camera
   provides tap-to-focus, exposure control, flash, and full sensor resolution.
2. The platform **BarcodeDetector** (Play-Services ML Kit on Android Chrome),
   which out-decodes our bundled WASM engines on dense codes — but only where
   the capability probe passes (see docs/barcodedetector-device-floor.md).

## Decision

Aadhaar capture is **photo-first**: the primary action on phones is "take a
photo of the card", decoded through the existing worker pipeline plus a
first-chance attempt with the native BarcodeDetector where
`getSupportedFormats()` includes `qr_code`. Live video scanning remains as a
secondary option, unchanged. The USB wedge scanner path at the desk is
unaffected.

The deep re-tune of the live pipeline (probe geometry, escalation schedule,
camera constraints) is explicitly out of scope and stays governed by the
empirical fake-camera harness — unit tests alone have twice reported a broken
live scanner as green.

## Consequences

- Bad-camera phones get a reliable path: the OS camera's autofocus does the
  work the live stream cannot.
- Where Play Services is present, native detection removes most WASM decode
  cost; elsewhere the existing worker cascade still runs, so no device is left
  behind.
- UI copy and button order change on both desk registration and
  self-registration; training material should show "photo kheenchein" as the
  normal path.
- Live-scan quality complaints are not fixed by this ADR and belong to the
  follow-up pipeline re-tune.
