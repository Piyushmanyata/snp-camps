# Manual exception at two attempts, available to volunteers

---
Status: accepted
---

Manual registration was locked to Team Leads and admins after three failed
Aadhaar scans. The patients who need the fallback most — worn or damaged cards
— are the ones who then wait while a volunteer finds a lead. Three attempts is
one more stand at the desk than the card usually rewards. Counting attempts on
the server would invent a session the desk does not have: the counter is
per-patient on the open form, and it must reset when the next patient starts.

**After two failed scans, any Registration Staff role may complete a manual
exception on their own account, with a recorded reason.** Clinical Desk
Operators remain excluded. The failed-attempt counter resets for each new
registration. Admins get a per-camp, read-only list of every exception —
actor, reason, attempt count, timestamp — so overuse is visible.

This does not change decode semantics. One scan still yields exactly one
outcome: card, garbage, or not-Aadhaar ([ADR 0014](0014-aadhaar-one-attempt.md)).
ADR 0014 is not a retry-count rule.

Rejected: keep Team-Lead-only at three attempts. It is the path that fails the
patients who cannot scan. Rejected: server-tracked attempt counting. There is
no patient session to hang a counter on, and a server count would survive
across patients or force a token the desk does not issue.
