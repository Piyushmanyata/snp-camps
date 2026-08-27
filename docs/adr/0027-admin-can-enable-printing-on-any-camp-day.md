# Admin can enable prescription printing for any camp day

---
Status: accepted
---

An audit guard in `set_camp_day_printing_open` refused opening printing for any camp day whose date was not today in `Asia/Kolkata` (`PRINT_WINDOW_NOT_TODAY`). This prevented admins from setting up camp days in advance or overriding print controls when preparing upcoming camps.

**Admins can toggle printing open or closed on any camp day at any time.** The `set_camp_day_printing_open` RPC enforces `is_admin()` but imposes no date barrier on setting `printing_open`.

Rejected: restricting `set_camp_day_printing_open` to today's date. Admins require administrative discretion to manage camp schedules ahead of camp days.
