alter table public.useful_tip_verifications
  add column if not exists generation_diagnostics jsonb not null default '{}'::jsonb;

alter table public.useful_tip_verifications
  drop constraint if exists useful_tip_verifications_generation_diagnostics_object;

alter table public.useful_tip_verifications
  add constraint useful_tip_verifications_generation_diagnostics_object
  check (jsonb_typeof(generation_diagnostics) = 'object');
