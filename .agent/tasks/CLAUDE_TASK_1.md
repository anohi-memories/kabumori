# Claude Task 1

- task_id: morning-greeting-production-deploy-verify-20260908
- owner: claude
- slot: claude-1
- status: in_progress
- next_owner: claude
- priority: urgent
- purpose: K1承認済みのmorning_greeting本文トーン改善と画像scene多様化を、2026-09-09朝の自動実行に間に合うよう安全に本番反映し、非投稿dry-runで確認する。

## Approved implementation

K1で以下を承認済み:
- text-policy commit: `ff9dcc5b41595c31b7cd8d587ec1519f83e2791f`
- coherence fix commit: `21d128c79432b87eb3e44a38db272c29cb2ca057`

承認内容:
- morning_greeting本文は相場・株解説を原則入れず、記念日/季節/曜日/日常/自然な朝の挨拶を優先
- morning_reportとの役割分離
- 画像は固定visual_themeを廃止し、coherent scene templateで日次多様化
- location + activity + propは自然な組み合わせの不可分template
- camera/framing/expression/outfit/lightingは日付seedで変化
- special_day/seasonal anchorと無関係なactivityを混ぜない
- full regression: 344 passed / 0 failed
- production変更なしの状態でK1承認済み

## Current production facts

- `posting_windows.morning_greeting.is_active = true`
- 投稿窓: 06:30-07:00 JST
- X OAuthは`media.write`付きtokenへ更新済み
- 非投稿 `POST /2/media/upload` は新tokenで成功確認済み
- 2026-09-08 morning_greetingの403原因は旧tokenのscope不足と判断済み
- manual publishは管理者Supabase Auth session必須の安全ゲートがあり、迂回禁止

## Goal

明日2026-09-09の自然Cronで、今回承認済みの新しい本文生成ロジックと新しい画像sceneロジックが使われる状態にする。

## Required steps

1. `origin/main`を同期し、承認済み2commitがmainに含まれていることを確認する。
2. 他slotの変更と競合しないことを確認する。
3. morning_greeting本文ロジックを含む本番 `x-test-post` Edge Functionを、mainの承認済み状態からdeployする。
   - 未承認の別変更を意図せず同時deployしないこと。
   - mainに別の未deploy変更が混在している場合は、勝手にdeployせず停止して報告すること。
4. 画像側について、`.github/workflows/morning-greeting-image.yml` がmain上の `scripts/morning-greeting-image.ts` / `morning_greeting_logic.ts` を使い、次回05:30 JST実行で新scene logicが適用されることを確認する。
5. production `x-test-post` deploy後、**morning_greeting dry-runのみ**を1回行う。
6. dry-runで最低限確認:
   - HTTP success
   - payload generated
   - text validator pass
   - market-heavy contentではないこと
   - `wouldPublish` / equivalent safety stateが正常
   - X投稿API呼び出し 0
   - X実投稿 0
7. 明日分の画像について実画像APIを今夜余分に叩く必要はない。05:30 JST workflowの自然実行に任せる。
8. `posting_windows.morning_greeting` は変更しない。現在のtrueを維持する。

## Production changes allowed in this task

許可:
- 承認済みmorning_greeting変更を含む `x-test-post` Edge Functionのproduction deploy
- 非投稿dry-run

禁止:
- X manual/live publish
- 管理者認証ゲート迂回
- OAuth token/secrets変更
- DB migration/schema/GRANT
- Cron変更
- posting_windows変更
- 他Edge Function deploy
- Codex/Claude slot2担当領域の変更

## Safety stop conditions

以下ならdeploy/続行せず停止して報告:
- mainに未承認・無関係なx-test-post変更が混在し、承認済み範囲だけ安全にdeployできない
- dry-runがFact/Voice/validator/safety gate等でfail
- X APIを呼びそうなmodeしか使えない
- production version/sourceが期待commitと一致しない

## Completion report

完了時:
- `status: review_required`
- `next_owner: chatgpt`
- `## Report`追記
- deployしたproduction version
- deploy source commit / main HEAD
- dry-run結果
- X投稿0件確認
- posting_windows未変更確認
- 画像workflowが明日05:30 JSTに新logicを使う根拠
- 明日06:30-07:00 JST自然投稿待ちであること
