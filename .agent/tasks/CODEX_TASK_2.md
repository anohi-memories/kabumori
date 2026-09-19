# Codex Task 2

- task_id: social-mobile-app-phase10-x-connect-ui-shell-20260919
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Luna
- purpose: 自動投稿アプリ側を前進させる。一般ユーザー向けX接続のAccounts UI / 状態表示 / deep-link受け口 / adapter境界を実装する。ただしClaude slot2のPhase9 OAuth server candidateはK2 NOT PASSで修正中のため、H2はserver migration/RPC/Edge Functionに触れず、UIとclient abstractionだけを安全に進める。

## Background

- social-mobileのtenant/Auth/RLS基盤はPhase8までK2 PASS。
- Claude slot2 Phase9は一般ユーザー向けX OAuth server candidateを実装済みだが、K2で以下2 blockerが見つかり修正待ち:
  1. OAuth state double-hash
  2. callback retry/idempotency lifecycle
- そのためH2はserver contractを固定値として埋め込まず、UI/client adapterを分離して実装する。
- production default data sourceは引き続き mock。

## Mandatory startup

開始前に必ず確認:
1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. this TASK
4. `.agent/tasks/CLAUDE_TASK.md` の最新K2 blocker
5. fresh `origin/main`

競合ルール:
- H2は `apps/social-mobile/**` のみ。
- G2が触る `supabase/functions/x-oauth-connect-user/**`、Phase9 migration/RPC、既存 `x-oauth-connect` には触れない。
- 同一ファイル競合が見つかったらSTOP。

## Goal

アプリ上で以下の導線をsource candidateとして完成させる:

1. Accounts画面に「Xアカウントを接続」CTA
2. 未接続 / 接続中 / 接続済み / エラー / 再接続 の状態表示
3. 接続済みならX handle表示
4. OAuth開始処理をUIから直接HTTP実装せず、専用client adapter/interface越しに呼ぶ
5. deep-link callbackの受け口を用意
6. callback payloadをadapterへ渡し、UI状態へ反映
7. cancel時に安全にAccountsへ戻る
8. signed-out時は接続開始不可
9. no-workspace / no-membership時もクラッシュせずonboarding導線を表示
10. mock modeで全状態をローカル確認可能

## Critical constraint

**Phase9 server contractはまだ確定していない。**

そのため:
- endpoint path / request body / state hashing / PKCE詳細 / final RPC signatureをUIへハードコードしない。
- `XConnectionClient` 等のadapter境界を作り、実server transportはstub/mockまたはfeature-gatedにする。
- G2 K2 PASS後にtransport実装だけ差し替えられる構造にする。
- UI側でraw state/hashなどOAuth securityロジックを独自判断しない。

## Suggested structure

必要に応じて既存構成に合わせるが、例:
- `apps/social-mobile/src/lib/x-connection.ts`
- `apps/social-mobile/src/lib/x-connection-client.ts`
- `apps/social-mobile/src/app/...accounts...`
- deep-link route / callback handler
- tests

既存命名・route構造を優先し、勝手な大規模refactorはしない。

## UX requirements

最低限:
- 未接続: 「Xアカウントを接続」
- 接続中: progress表示、二重タップ防止
- 接続済み: @handle / 接続済み表示
- エラー: 再試行可能、秘密値や生レスポンスを表示しない
- 再接続: UIのみ用意。実server reconnect contractはadapter越し
- callback成功: Accountsへ復帰し状態更新
- callback失敗/cancel: 安全にAccountsへ戻る
- accessibility label / testID等、既存テスト方針に合わせる

## Tests

最低限:
- signed-out connect blocked
- disconnected CTA
- connecting double-submit prevention
- connected handle display
- callback success -> connected
- callback error -> error state
- cancel -> safe return
- reconnect path
- no membership/workspace state
- mock mode deterministic
- no token/code_verifier/access_token/refresh_token rendered or logged
- production default `EXPO_PUBLIC_DATA_SOURCE=mock` unchanged
- typecheck
- lint
- Expo web export / route resolution
- git diff --check

## Production safety

禁止:
- production migration apply
- Edge Function deploy
- Phase9 RPC/Function変更
- X Developer Portal変更
- OAuth/Vault/token操作
- production social_accounts/brands/memberships write
- publish_enabled変更
- Cron/X/Push/AI
- service_roleをmobileへ入れる
- production defaultをsupabaseへ切替

## Completion / C2

完了時:
- `.agent/CODEX_REPORT_2.md` 先頭へ結果
- changed files
- UI flow
- adapter contract
- tests
- production mutation=0
- G2 Phase9 K2 PASS後に必要なtransport接続点
- TASK -> `review_required`
- next_owner -> `chatgpt`
- push前fresh origin/main
- push/read-back
- C2待ちでSTOP
