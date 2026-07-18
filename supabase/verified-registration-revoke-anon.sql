-- Final cutover: apply only after /api/patient-register is deployed and
-- successfully smoke-tested against register_verified_patient.
-- Authenticated non-staff callers are rejected inside register_patient; the
-- authenticated grant remains only for staff registration screens.
revoke execute on function public.register_patient(
  uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
) from anon;
