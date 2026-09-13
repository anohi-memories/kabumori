-- multibrand-phase3d-ai-lab-dry-run-routing-safety: minimum viable cross-brand duplicate guard.
--
-- NOT applied to production by this task. This is an additive-only table (no existing table is
-- touched, no existing row is modified) so it can be applied independently once a follow-up task wires
-- checkCrossBrandDuplicate() (supabase/functions/_shared/brand/cross_brand_dedupe.ts) into the live
-- publish-completion path. Applying only this migration on its own is safe and changes no existing
-- behavior -- Kabumori's live posting path does not read or write this table today.
create table if not exists public.published_content_fingerprints (
  id bigint generated always as identity primary key,
  brand_id text not null references public.brands(id),
  social_account_id text not null references public.social_accounts(id),
  post_type text not null,
  normalized_text_sha256 text not null check (normalized_text_sha256 ~ '^[0-9a-f]{64}$'),
  x_post_id text,
  published_at timestamptz not null default now()
);

-- The guard only ever queries "recent rows for other brands", so this is the one index it needs.
create index if not exists published_content_fingerprints_recent_idx
  on public.published_content_fingerprints (normalized_text_sha256, published_at desc);

alter table public.published_content_fingerprints enable row level security;
revoke all on public.published_content_fingerprints from anon, authenticated;
grant select, insert on public.published_content_fingerprints to service_role;

comment on table public.published_content_fingerprints is
  'Cross-brand duplicate guard only. Populated by the live publish-completion path once wired up (not yet); read via checkCrossBrandDuplicate() in _shared/brand/cross_brand_dedupe.ts. Never used for same-brand dedup, which existing mechanisms (publish_claims, tip/interaction cooldowns, important_news_candidates uniqueness) already cover.';
