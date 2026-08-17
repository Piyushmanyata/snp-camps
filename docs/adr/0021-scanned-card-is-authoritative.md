# The scanned card is authoritative; address locks on every scan

---
Status: accepted
---

A typed walk-in or a manual-exception registration is self-declared. The card
QR is the only provenance the app treats as authentic
([ADR 0004](0004-aadhaar-parsed-not-verified.md),
[ADR 0014](0014-aadhaar-one-attempt.md)). Identity fields already lock on a
successful scan because they compute the Person key. Address was left editable,
so a volunteer could keep a typed or guessed address after a good scan, and
One-Person-per-Aadhaar could not see that the human in front of them already
existed under a different spelling.

**The scanned card wins.** On every successful scan — desk registration,
self-registration, and camp-day Aadhaar confirmation — legal name, date of
birth, gender, Aadhaar last-4, and address are overwritten from the card and
join the Aadhaar lock. Phone and camp day stay editable. A non-Latin card name
still requires a Latin display name for the sheet and for name-search; the
duplicate key always uses the verbatim scanned name.

Confirmation of a `manual_exception` patient whose Person key is still null is
mandatory before Print prescription, unless a Team Lead or admin records a
reason and overrides. Volunteers cannot take that override.

Rejected: card wins on identity only, address stays editable. The address on
the card is the same provenance as the name. Leaving it editable after a scan
keeps a self-declared value the desk has just proven it does not need.
