-- #97 — Admin Camp Settings for spectacles collection, post-camp surgery, and paper fallback mode.
-- Adds spectacles_collection_date, spectacles_collection_venue,
-- post_camp_surgery_date, post_camp_surgery_venue, and paper_fallback_mode to camps.
-- Enforces SMS venue length constraints (<= 35 chars) and admin-only update rules.

ALTER TABLE public.camps
  ADD COLUMN IF NOT EXISTS spectacles_collection_date date NULL,
  ADD COLUMN IF NOT EXISTS spectacles_collection_venue text NULL,
  ADD COLUMN IF NOT EXISTS post_camp_surgery_date date NULL,
  ADD COLUMN IF NOT EXISTS post_camp_surgery_venue text NULL,
  ADD COLUMN IF NOT EXISTS paper_fallback_mode boolean NOT NULL DEFAULT false;

-- Add CHECK constraints enforcing SMS venue max length (35 chars)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'camps_spectacles_collection_venue_check'
  ) THEN
    ALTER TABLE public.camps
      ADD CONSTRAINT camps_spectacles_collection_venue_check
      CHECK (spectacles_collection_venue IS NULL OR char_length(spectacles_collection_venue) <= 35);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'camps_post_camp_surgery_venue_check'
  ) THEN
    ALTER TABLE public.camps
      ADD CONSTRAINT camps_post_camp_surgery_venue_check
      CHECK (post_camp_surgery_venue IS NULL OR char_length(post_camp_surgery_venue) <= 35);
  END IF;
END $$;

-- RPC to update camp settings with explicit admin check and venue length validation
CREATE OR REPLACE FUNCTION public.update_camp_settings(
  p_camp_id uuid,
  p_spectacles_collection_date date DEFAULT NULL,
  p_spectacles_collection_venue text DEFAULT NULL,
  p_post_camp_surgery_date date DEFAULT NULL,
  p_post_camp_surgery_venue text DEFAULT NULL,
  p_paper_fallback_mode boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_updated_count integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin role required to update camp settings'
      USING ERRCODE = '42501';
  END IF;

  IF p_spectacles_collection_venue IS NOT NULL AND char_length(p_spectacles_collection_venue) > 35 THEN
    RAISE EXCEPTION 'Spectacles collection venue exceeds maximum length of 35 characters'
      USING ERRCODE = '22001';
  END IF;

  IF p_post_camp_surgery_venue IS NOT NULL AND char_length(p_post_camp_surgery_venue) > 35 THEN
    RAISE EXCEPTION 'Post-camp surgery venue exceeds maximum length of 35 characters'
      USING ERRCODE = '22001';
  END IF;

  UPDATE public.camps
  SET
    spectacles_collection_date = p_spectacles_collection_date,
    spectacles_collection_venue = p_spectacles_collection_venue,
    post_camp_surgery_date = p_post_camp_surgery_date,
    post_camp_surgery_venue = p_post_camp_surgery_venue,
    paper_fallback_mode = COALESCE(p_paper_fallback_mode, false)
  WHERE id = p_camp_id;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count = 0 THEN
    RAISE EXCEPTION 'Camp not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.update_camp_settings(uuid, date, text, date, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_camp_settings(uuid, date, text, date, text, boolean) TO service_role, authenticated;

COMMENT ON FUNCTION public.update_camp_settings IS 'Issue #97: Admin-only RPC to update camp settings (spectacles collection, post-camp surgery, paper fallback mode).';
