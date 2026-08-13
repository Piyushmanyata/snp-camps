-- PostgreSQL requires a newly-added enum value to commit before later
-- migrations use it in functions, checks, or data.
alter type public.user_role add value if not exists 'clinical_operator';
