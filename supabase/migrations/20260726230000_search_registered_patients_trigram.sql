-- #61 — Lost-slip name search: exact prefix first + bounded trigram fallback.
-- Append-only: REPLACE search_registered_patients only.
--
-- Ranking (deterministic):
--   1. Exact normalized prefix matches first
--   2. Then greatest(similarity, word_similarity) DESC
--   3. Then full_name_normalized ASC
--   4. Then reg_no ASC
--
-- Scope: queue_status = 'registered' AND camp_id = p_camp_id AND camp active.
-- Fuzzy branch only when length(query) >= 3; threshold similarity >= 0.35
-- or word_similarity >= 0.40 (conservative so common names do not flood).
-- Cap p_limit at 10 for desk disambiguation (was soft-capped 25).

CREATE OR REPLACE FUNCTION public.search_registered_patients(
  p_camp_id uuid,
  p_query text,
  p_limit integer DEFAULT 10
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  age integer,
  address text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $$
declare
  v_q text;
  v_lim integer;
  -- Conservative fuzzy floors (#61). Documented for EXPLAIN / seeded fixtures.
  v_sim_threshold real := 0.35;
  v_word_threshold real := 0.40;
begin
  if not public.is_staff() then
    raise exception 'staff only';
  end if;

  if p_camp_id is null then
    raise exception 'camp required';
  end if;

  if not exists (
    select 1
    from public.camps c
    where c.id = p_camp_id
      and c.is_active
  ) then
    raise exception 'No active camp';
  end if;

  v_q := lower(btrim(regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g')));
  if length(v_q) < 1 then
    return;
  end if;

  -- Desk UI expects at most 10 rows for disambiguation.
  v_lim := greatest(1, least(coalesce(p_limit, 10), 10));

  return query
  select
    p.id,
    p.reg_no,
    p.full_name,
    p.age,
    p.address
  from public.patients p
  where p.camp_id = p_camp_id
    and p.queue_status = 'registered'
    and (
      p.full_name_normalized like v_q || '%'
      or (
        length(v_q) >= 3
        and (
          similarity(p.full_name_normalized, v_q) >= v_sim_threshold
          or word_similarity(v_q, p.full_name_normalized) >= v_word_threshold
        )
      )
    )
  order by
    case
      when p.full_name_normalized like v_q || '%' then 0
      else 1
    end,
    greatest(
      similarity(p.full_name_normalized, v_q),
      word_similarity(v_q, p.full_name_normalized)
    ) desc,
    p.full_name_normalized,
    p.reg_no
  limit v_lim;
end;
$$;

ALTER FUNCTION public.search_registered_patients(uuid, text, integer) OWNER TO postgres;
COMMENT ON FUNCTION public.search_registered_patients(uuid, text, integer) IS
  'Lost-slip desk search (#61): registered-only in active camp. Exact normalized prefix first, then bounded trigram similarity/word_similarity for small typos. Max 10 rows: name, age, address only.';
REVOKE ALL ON FUNCTION public.search_registered_patients(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_registered_patients(uuid, text, integer) TO authenticated, service_role;
