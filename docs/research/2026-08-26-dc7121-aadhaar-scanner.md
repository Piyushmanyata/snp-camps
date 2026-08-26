# DC7121 Aadhaar USB scanner commissioning

## Finding

The supplied `DC7121.php` is Dcode's product page, not scanner firmware or a
driver. Dcode describes the DC7121 as a plug-and-play wired 2D scanner that
reads QR codes without additional software. Its linked one-page specification
lists `USB` as the interface and includes QR Code, Data Matrix, PDF417, and
Aztec among the supported formats. It does not state the USB device class,
keyboard layout, output suffix, or any programming barcodes.

Sources: [Dcode DC7121 product page](https://www.dcodeinternational.in/DC7121.php)
and [official DC7121 specification sheet, page 1](https://www.dcodeinternational.in/images/DC7121.pdf#page=1).

The current app needs keyboard-wedge behavior: the scanner types the complete
payload into a focused password input, and `Enter` submits and clears it
([`aadhaar-usb-input.tsx`](../../src/components/aadhaar-usb-input.tsx#L15-L49)).
Leading and trailing whitespace is removed before decoding
([`aadhaar-attempt.ts`](../../src/lib/aadhaar-attempt.ts#L20-L29)). USB payloads
outside 20-16,384 characters are rejected, and numeric Aadhaar Secure QR
payloads are recognized from 50 digits upward
([`aadhaar-decode.worker.ts`](../../src/lib/aadhaar-decode.worker.ts#L64-L72),
[`aadhaar-qr.ts`](../../src/lib/aadhaar-qr.ts#L714-L727)).

## Required configuration

| Setting | Value |
|---|---|
| USB mode | USB HID keyboard / keyboard wedge |
| Keyboard country | English (US) |
| Symbology | QR Code enabled; Data Matrix may remain enabled but is not required |
| Output | Original, complete payload; no prefix, code ID, formatting, or truncation |
| Terminator | One carriage return / `Enter`; no `Tab` |
| Scan mode | Triggered single scan |

These are integration requirements inferred from the app, not settings proven
by the vendor sheet. Do not scan configuration barcodes from another model.
If the factory defaults do not satisfy them, obtain the **DC7121 programming
manual** or these exact configuration barcodes from Dcode support.

## Physical acceptance gate

1. Confirm the connected unit enumerates as a keyboard-class USB device and
   record its VID/PID. The supplied artifacts do not identify the live unit.
2. With English (US) selected, scan a current Aadhaar Secure QR into a local
   scratch editor. It must type one uninterrupted payload and submit exactly
   once with `Enter`; do not retain the payload.
3. In the registration UI, record consent, focus **USB Aadhaar scanner**, and
   scan the same card. Acceptance requires a successful decode of the physical
   card, not merely a scanner beep or generic QR success.
4. Verify the decoded legal name, date of birth, gender, Aadhaar last four, and
   address against the card, then discard the scratch capture. On every
   successful scan these card fields are authoritative and replace typed values
   ([ADR 0021](../adr/0021-scanned-card-is-authoritative.md#L16-L21)).

The device is not commissioned until this gate passes with a real current
Aadhaar Secure QR. Generic QR/Data Matrix support alone is insufficient, as
already required by the repository's hardware decision
([D20](../plans/2026-07-29-desk-registration-fulfilment-and-template-controls.md#L131)).
