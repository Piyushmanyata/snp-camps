-- Migration: Remove check_duplicate_patients RPC
-- Date: 2026-07-22

DROP FUNCTION IF EXISTS public.check_duplicate_patients(uuid, text, text, integer, text, text);
