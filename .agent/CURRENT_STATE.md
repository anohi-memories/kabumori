# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-24 JST
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## User routing preference

- H2 / G2 は **X自動投稿アプリ専用**。
- H1 / G1 は **かぶモリ本体側**を優先。
- かぶモリ本体内のX投稿基盤・queue・dispatcher改善は、ユーザーの明示指定どおりH1/G1側で扱う。
- ユーザーが明示的に別スロットを指定した場合はその指示を優先する。
- 同一ファイル / migration / RPC / Edge Function / workflow / production設定の競合禁止ルールは常に優先する。

## Active workstreams

- Codex slot 1: `ready` — `x-autopost-phase1d-claim-domain-partition-and-planner-authority-20260924`
  - かぶモリ本体側のX投稿基盤 prerequisite。
  - legacy claimはunbound rowsのみ、v2 claimはbound rowsのみを扱うhard partition candidateを作る。
  - plannerのsocial_account_id authorityを分類し、trusted contextがある経路だけ明示bindingする。
  - retry/stale/reconcileでもclaim domainが混ざらないことをdisposable PostgreSQLで証明する。
  - production mutation 0。migration/deploy/Cron/OAuth/Vault/X API callは禁止。
  - Recommended model: GPT-5.6 Sol Medium。

- Codex slot 2: `idle`
  - **X自動投稿アプリ専用**として空けている。
  - かぶモリ本体のタスクは、ユーザー明示指定なしにここへ入れない。

- Claude slot 1: `review_required` — `kabumori-mobile-auth-real-e2e-disposable-account-20260924`
  - Real iPhone dev client against production. Gate A PASS (signup + confirmation) and Gate B PASS (first login, exactly one profile via RPC, session restore, logout/re-login).
  - Gate C FAIL: the recovery link reaches the app (the redirect allowlist works), but expo-router shows Unmatched Route for `kabumori://reset-password`. Source fix candidate: `+native-intent` redirectSystemPath. No production patch.
  - Gate D/E not run. The disposable test account is kept for re-running C→D after the fix. auth.users 3 / profiles 2 (+1 test each); no existing user changed.
  - Also found: the confirmation redirect lands on an unreachable Site URL (Auth config, needs approval).

- Claude slot 2: `ready` — `x-admin-multibrand-selector-phase2-merge-only-20260924`
  - X複数ブランド管理側。
  - K2 PASS済みPR #15を最新mainへfreshen/rebaseし、レビュー済みcandidateとの意味的同一性確認後にmergeする。
  - Netlify deploy/DB policy変更は禁止。production mutation 0。

## Parallel safety

- H1/G1はかぶモリ本体側、H2/G2はX自動投稿アプリ専用。
- 同じファイル、DB migration、RPC、Edge Function、workflow、production設定を複数slotで同時変更しない。
- push前にfresh `origin/main`確認。
- 既存未コミット変更は他workstream所有として触らない。
- 競合可能性を安全に否定できない場合は開始せず、具体的な競合箇所を報告する。

## Known issues / observations

- Phase1B account-bound queue foundationはC2 PASS済み。
- Phase1B migration単独適用禁止。
- old dispatcherのまま claim_due_post_v2 有効化禁止。
- legacy pending rowsの暗黙account backfill禁止。
- multibrand migration history不整合の可能性があるためblind `supabase db push`禁止。

## 更新ルール

- 各専用TASKが正本。正本と索引が矛盾する場合はTASKを優先する。
- 作業完了時に確認できた現在値だけを反映する。
- 推測は事実として書かず、秘密情報・認証情報・個人情報は書かない。
