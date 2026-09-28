# Codex Task

- task_id: x-social-mobile-multi-provider-auth-focused-review-20260928
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: critical
- recommended_model: Sol（高）
- purpose: PR #47 multi-provider Auth Phase 2を1回だけ集中レビューする。X/Apple/Google/Email認証、identity linking、PKCE/deep link、password recovery、X app-authとposting-Xの分離を確認し、production provider activation前のAuth境界を固める。

## Review target

- PR #47 exact head: `7bda196147a749431774fba915a86d41bf43dc5d`
- Phase 1 main baseline includes merged PR #42 -> `f0cac15`, PR #44 -> `7870d10`

## Must verify

1. X app login and X posting-account authorization are strictly separate.
2. Supabase provider token is never reused/stored/logged as posting credential.
3. posting X still goes only through existing `x-oauth-connect-user` + Vault path.
4. OAuth callback only accepts intended scheme/route and rejects posting callback / foreign scheme / malformed input.
5. PKCE/state/code exchange cannot be replayed or double-exchanged in the implemented client flow.
6. Apple nonce handling matches current recommended Supabase/Apple flow.
7. Google/X browser OAuth cancel/error/success paths are safe.
8. Email signup does not enumerate existing accounts.
9. Password recovery requires the intended recovery context before password update.
10. Provider linking is explicit and authenticated.
11. Duplicate/ambiguous identities fail closed; no merge by name/handle/user_metadata.
12. `user_metadata` is not used for authorization.
13. no service_role/provider secret/refresh token in mobile client.
14. new-account notice occurs before workspace creation where required.
15. first workspace/onboarding continuation remains exact-user bound.
16. existing password login/session restore/logout regressions remain clean.
17. provider availability gating does not create false-ready UI.
18. no production Auth/config/DB/X mutation occurred.

## Docs / current behavior

- Read current Supabase skill first.
- Check current Supabase docs/changelog for social login, identity linking, Apple, Google, X/Twitter, PKCE/deep linking, password recovery before judging semantics.
- Do not rely on stale remembered Auth behavior.

## Verification

- inspect exact PR #47 diff
- run focused auth tests
- run full social-mobile tests
- typecheck
- lint
- Expo web + iOS export/build smoke
- git diff --check
- secret/token scan
- source-level negative checks for callback/linking ambiguity

## Fix policy

Small, unambiguous P1/P2 Auth/source bug may be fixed directly on PR #47 and retested.
Any design-level or provider-console uncertainty => report and STOP; do not mutate production configuration.

## Production constraints

- no Supabase provider enablement/disablement
- no redirect allowlist mutation
- no SMTP change
- no Apple/Google/X developer-console change
- no DB migration
- no Stage 3B activation
- no real X post
- production_mutation=0

## Completion / C1

Report:
- PASS / PASS-WITH-FIX / FAIL
- exact reviewed/fixed PR #47 head
- findings
- identity-linking assessment
- callback/PKCE/recovery assessment
- X-login-vs-posting-X assessment
- tests
- source fixes if any
- production_mutation=0
- whether PR #47 is ready for merge
- exact remaining console/config gates and recommended activation order

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.

## H1 result — 2026-09-28

- **FAIL** at unchanged PR #47 head `7bda196147a749431774fba915a86d41bf43dc5d`; not ready for merge/provider activation.
- Seven executable negative probes reproduced linking URL rejection, false-success duplicate callbacks, lost PKCE flow ID, signup enumeration, implicit provider-token persistence, unbound recovery context and malformed callback acceptance.
- Existing mobile tests 32/32 + data-view 14/14, typecheck, lint, web+iOS export and diff check PASS. These do not establish real-device/provider E2E readiness.
- Source fix / PR push / merge / deploy: none. Coordinated Auth-boundary design is required; stopped under the TASK fix policy. `production_mutation=0`.
- Full findings, source locations, reproduction contracts and activation gates: `.agent/CODEX_REPORT.md`, latest H1 multi-provider Auth section. Await C1; do not restart this finished review under H1 without a new assignment.


## Final C1 — multi-provider Auth focused review

Verdict: **FAIL**.

- reviewed PR #47 head `7bda196147a749431774fba915a86d41bf43dc5d`.
- seven Auth boundary findings were reproduced with executable synthetic probes.
- no source fix was made in H1 because the issues require one coordinated design correction.
- X app-login vs posting-X separation itself passed.
- Apple native nonce contract passed.
- identity linking, callback/PKCE, recovery, provider-session storage, onboarding exact-user continuation and provider-readiness require correction before merge/provider activation.
- production_mutation=0.
- returned to G3 as one bundled correction task; after K3, exactly one focused H1 acceptance pass should be used.
