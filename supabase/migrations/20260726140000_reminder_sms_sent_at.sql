-- #52 — Day-before camp reminder SMS: mark each patient at most once per camp.
-- Patient rows are already camp-scoped, so one timestamp is enough.
-- Service-role cron only; no authenticated GRANT (desk UI does not show this).

ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS reminder_sms_sent_at timestamp with time zone;

COMMENT ON COLUMN public.patients.reminder_sms_sent_at IS
  'When the day-before reminder SMS was successfully sent (#52). NULL = not yet reminded.';

CREATE INDEX IF NOT EXISTS patients_reminder_pending_idx
  ON public.patients (camp_day_id)
  WHERE reminder_sms_sent_at IS NULL
    AND queue_status = 'registered';
