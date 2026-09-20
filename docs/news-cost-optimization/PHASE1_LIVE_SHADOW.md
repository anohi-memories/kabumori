# Important-news Phase 1 live shadow

`important-news-shadow` is a measurement-only path. It polls independent free
and official sources, records source health and first-seen observations in
`important_news_shadow_*`, and conservatively matches them to recent live
candidates. It never feeds the live judgement/generation/publication selectors
and has no X, Push, notification, or app-copy write surface.

The first rollout uses a 30-minute Cron canary. At least two natural runs must
be observed before the job may move to the 10-minute target cadence. The old
fetch, judgement, generation, and publish-ready jobs remain unchanged throughout
the shadow period.

Conditional paid search is limited to one search per run, only for a new
high-signal sparse event or a high-signal event during multi-source degradation.
A two-hour topic cooldown prevents duplicate paid searches. Quiet cycles cost
zero. Tokens, actual web-search calls, and estimated cost are stored on the run
and in `ai_usage_events` under `news_shadow_search`.

The source set is BOJ, Fed, JMA earthquake/volcano, USTR, UN peace/security,
EIA, BBC World, Al Jazeera, ECB, SEC, and GDELT. GDELT is polled hourly with a
deterministic cooldown because its preflight was materially slower. The White
House candidate feed was excluded after returning HTTP 404 during production
preflight; it is not reported as a healthy source.

Authentication is fail-closed: the Function compares `X-Cron-Secret` to the
dedicated `IMPORTANT_NEWS_SHADOW_CRON_SECRET` environment value. The same new
random value is stored in Vault for the Cron request header. The service-role
key remains internal to normal Function database access and is never accepted as
the request credential. Neither secret value is committed or returned.

Rollback is to disable the single `important-news-shadow` Cron. Shadow data
remains for audit. No live pipeline rollback is required because the live
pipeline is never changed.
