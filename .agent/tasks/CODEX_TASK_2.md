# Codex Task 2

- task_id: x-close-report-freshness-production-deploy-20260916
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Luna first
- purpose: C2 PASS済みのX大引けfreshness境界修正を、`x-test-post` のみに安全に本番反映し、runtime sourceとdeploy sourceの一致を確認する。

## Approved implementation

C2で承認済み:
- implementation commit: `04bfe490a53fea95892ea6e225251b5e129aa87e`
- change: `jpx_close`について、同一JST日・15:30以降の観測値を16:45〜17:05 JSTのlive close-report実行窓ではfreshとして扱うsemantic same-session rule
- existing 90-minute rule is retained as fallback outside that window
- previous-day / future / invalid timestamp / pre-15:30 / missing or nonnumeric / source identity failures remain rejected
- Fact/Voice fail-closed, no-fallback policy, posting schedule 17:00 are unchanged
- targeted tests: 64/64 PASS
- full `x-test-post` regression: 388/388 PASS
- changed source `deno check`: PASS
- `git diff --check`: PASS

## User authorization

2026-09-16 JST、ユーザーはC2 PASS後に「指示」と明示し、この承認済みfreshness修正を本番反映する工程の開始を承認した。

## Mandatory fresh checks

開始前に:
1. `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, `.agent/CODEX_REPORT_2.md` を読む。
2. `origin/main` をfresh-checkする。
3. H1/G1/G2の現行TASKを確認し、`x-test-post`を同時変更/deployするworkstreamがあればSTOP。
4. latest `origin/main` のruntime sourceに `04bfe490a53fea95892ea6e225251b5e129aa87e` のfreshness修正が含まれることを確認する。
5. production `x-test-post` の現在version/status/verify_jwt/updated_atを記録する。

期待状態が違う場合は勝手に補正せずSTOPしてC2へ戻す。

## Authorized production action

許可するのは以下のみ:
- clean checkout/worktreeの最新 `origin/main` をdeploy sourceに使用
- `x-test-post` Edge Functionだけをdeploy
- 現行functionのJWT設定を事前確認し、その設定を維持
- deploy後に `x-test-post` version/status/verify_jwt/updated_atをread-back
- production function sourceを可能な方法でdownload/read-backし、deploy sourceのruntime filesと一致確認
- 他Edge Functionのversion/updated_atが意図せず変化していないことを確認

## Prohibited

- 新しいsource修正（deploy blockerが見つかった場合は修正せずSTOP）
- `important-news-monitor`や他Edge Functionのdeploy
- app personalized report変更/deploy
- morning report変更
- AI Lab/OAuth/Vault/social_accounts変更
- DB/schema/migration/RPC/RLS変更
- Cron/settings/posting schedule変更
- `supabase db push`
- migration history repair
- manual/synthetic close-report実行
- manual OpenAI/X/Push invocation
- manual X投稿
- secret/tokenの表示

自然Cronによる通常処理は止めない。

## Verification

最低限:
- deploy前 `origin/main` fresh-check
- deploy sourceに `04bfe490...` のruntime差分が存在
- `x-test-post` deploy success
- deploy後 ACTIVE/status/JWT設定確認
- runtime source read-back一致
- 他Function無変更確認
- production DB/Cron/settings/posting schedule変更0
- manual OpenAI/X/Push/close-report/X投稿0

次の自然17:00 close-reportで実運用確認する。人工的にclose-reportを起動しない。

## Completion

完了時:
- `.agent/CODEX_REPORT_2.md` 先頭に今回taskのReportを追加
- Reportに deploy前後version、deploy source commit、runtime read-back一致、他Function無変更、安全確認、次の自然17:00確認待ちを記録
- source codeの追加commitは原則0
- `.agent/tasks/CODEX_TASK_2.md` を `status: review_required`, `next_owner: chatgpt` に更新
- push前に再度 `origin/main` fresh-check
- `.agent/`制御ファイルのみ安全にpush
- origin/main read-back後にSTOPしてC2待ち
