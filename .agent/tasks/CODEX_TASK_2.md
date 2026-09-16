# Codex Task 2

- task_id: important-news-cost-hardening-production-deploy-20260916
- owner: codex
- slot: codex-2
- status: done
- next_owner: chatgpt
- priority: high
- recommended_model: Luna first
- purpose: C2 PASS済みの重要ニュース生成コスト削減実装を、`important-news-monitor` のみに安全に本番反映し、deploy sourceとproduction read-backの一致を確認する。

## Approved implementation

C2で承認済み:
- implementation commit: `44ffe59d29e666ce158efc3445efbf7b4b2985c5`
- follow-up audit commit: `58d6ec08270c0b93f6bfaac4336ba95a3cb885b5`（監査fixture/Report/TASK。production runtime変更ではない）
- production source changeは `supabase/functions/important-news-monitor/post_generation_logic.ts` のstage-specific packet化と、unsupported forecast抑制prompt。
- Fact/Voice fail-closed、bounded retry、dedupe、coverage、app-copy、Push、collection policyは維持。
- full important-news tests: 405/405 PASS。
- realistic mixed fixture: X生成入力約24.16%削減、重要ニュース経路全体推定約13.38%削減。30%全体削減とは表現しない。

## User authorization

2026-09-16 JST、ユーザーはC2 PASS後に「じゃあそれ」と指示し、今回の承認済み変更を本番deployする工程を明示承認した。

## Mandatory fresh checks

開始前に:
1. `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, `.agent/CODEX_REPORT_2.md` を読む。
2. `origin/main` をfresh-checkする。
3. H1/G1/G2の現行TASKを確認し、`important-news-monitor`を同時変更/deployするworkstreamがあればSTOP。
4. `origin/main` のruntime sourceに承認済み実装 `44ffe59d...` が含まれることを確認する。
5. production `important-news-monitor` の現在version/updated_atを記録する。

期待状態が違う場合は勝手に補正せずSTOPしてC2へ戻す。

## Authorized production action

許可するのは以下のみ:
- clean checkout/worktreeの最新 `origin/main` をdeploy sourceに使用
- `important-news-monitor` Edge Functionだけをdeploy
- 現行functionのJWT設定を事前確認し、既存設定を維持する
- deploy後にfunction version/status/updated_atをread-back
- production function sourceを可能な方法でdownload/read-backし、deploy sourceのruntime filesと一致確認
- 他Edge Functionのversion/updated_atが意図せず変化していないことを確認

## Prohibited

- 新しいproduction source実装（deploy blockerが見つかったら修正せずSTOP）
- `x-test-post`変更/deploy
- AI Lab/OAuth/Vault/social_accounts変更
- morning-greeting workflow/script変更
- `personalized-reports`変更/deploy
- DB/schema/migration/RPC/RLS変更
- Cron/settings/user notification設定変更
- `supabase db push`
- migration history repair
- manual/synthetic candidate生成
- manual OpenAI/X/Push invocation
- manual X投稿
- secret/tokenの表示

自然Cronによる通常処理は止めない。

## Verification

最低限:
- deploy前 `origin/main` fresh-check
- deploy sourceに `44ffe59d...` のruntime差分が存在
- `important-news-monitor` deploy success
- deploy後 ACTIVE/status確認
- runtime source read-back一致
- 他Function無変更確認
- production DB/Cron/settings変更0
- manual OpenAI/X/Push/X投稿0

可能ならdeploy直後の自然実行で致命的エラーが増えていないかread-onlyで短時間確認してよい。ただし人工実行はしない。

## Completion

完了時:
- `.agent/CODEX_REPORT_2.md` 先頭に今回taskのReportを追加
- Reportに deploy前後version、deploy source commit、read-back一致、他Function無変更、安全確認を記録
- source codeの追加commitは原則0
- `.agent/tasks/CODEX_TASK_2.md` を `status: review_required`, `next_owner: chatgpt` に更新
- push前に再度 `origin/main` fresh-check
- `.agent/`制御ファイルのみ安全にpush
- origin/main read-back後にSTOPしてC2待ち

## C2 review result — 2026-09-16

PASS.

Confirmed from `origin/main` report:
- deploy source was fresh `origin/main` `bfabcee0c70ec1915513e297af77f06d88e6ed7b` and contained the approved implementation commit `44ffe59d29e666ce158efc3445efbf7b4b2985c5`
- only `important-news-monitor` was deployed
- production advanced from v53 ACTIVE to v54 ACTIVE with `verify_jwt=false` preserved
- runtime source read-back matched deploy source across all downloaded function files
- listed other Edge Functions retained their pre-deploy versions/updated_at
- production DB/schema/RPC/migration/RLS/Cron/settings/user-setting changes were 0
- manual/synthetic candidate, OpenAI/X/Push/API invocation and manual X post were 0

This deploy task is complete. Any further optimization (for example judgement-stage cost reduction) must be a separate task.