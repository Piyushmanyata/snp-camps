-- Ticket #93 — Counter desk order resolution RPC function.
-- Allows active camp crew to fulfill, defer, or cancel treatment orders.

CREATE OR REPLACE FUNCTION public.resolve_treatment_order(
  p_order_id uuid,
  p_action text,
  p_deferred_date date DEFAULT NULL,
  p_deferred_venue text DEFAULT NULL
)
RETURNS SETOF public.treatment_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
#variable_conflict use_column
declare
  v_order public.treatment_orders%rowtype;
  v_action text;
begin
  if not public.is_camp_crew() then
    raise exception 'active camp crew required';
  end if;

  if p_order_id is null then
    raise exception 'order_id is required';
  end if;

  v_action := lower(trim(p_action));
  if v_action not in ('fulfilled', 'deferred', 'cancelled') then
    raise exception 'Action must be fulfilled, deferred, or cancelled';
  end if;

  select * into v_order
  from public.treatment_orders
  where id = p_order_id
  for update;

  if v_order.id is null then
    raise exception 'Treatment order not found';
  end if;

  if v_order.status != 'pending' then
    raise exception 'Treatment order is already closed';
  end if;

  if v_action = 'deferred' and p_deferred_date is null then
    raise exception 'Deferred date is required when deferring an order';
  end if;

  update public.treatment_orders
  set status = v_action,
      closed_at = now(),
      closed_by = (select auth.uid()),
      deferred_date = case when v_action = 'deferred' then p_deferred_date else null end,
      deferred_venue = case when v_action = 'deferred' then nullif(trim(p_deferred_venue), '') else null end,
      updated_at = now()
  where id = p_order_id
  returning * into v_order;

  return next v_order;
end;
$$;

ALTER FUNCTION public.resolve_treatment_order(uuid, text, date, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resolve_treatment_order(uuid, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_treatment_order(uuid, text, date, text) TO authenticated, service_role, postgres;
