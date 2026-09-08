# Claude Task 1

- task_id: morning-greeting-production-deploy-verify-20260908
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
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

## Report

- task_id: morning-greeting-production-deploy-verify-20260908
- result: **停止・未deploy**。Safety stop condition「mainに未承認・無関係なx-test-post変更が混在し、承認済み範囲だけ安全にdeployできない」に該当したため、deployを実行せず報告する。

### 発見した問題

`x-test-post`はSupabase Edge Functionとして関数ディレクトリ全体を1単位でdeployする仕組みであり、特定commitのファイルだけを選んでdeployすることはできない。

現在の`origin/main` HEAD（`155ba99`）で、直近deploy済み版（v89、commit `1088081`）以降に`supabase/functions/x-test-post/**`へ加わった変更をコミット単位で確認したところ、以下5件が含まれていた:

```
21d128c Replace independent location/activity/prop axes with coherent scene templates   [今回承認対象]
ff9dcc5 Redesign morning_greeting text tone and add deterministic image scene rotation   [今回承認対象]
1088081 Add safe X API error diagnostics for morning_greeting media upload failures      [v89として既にdeploy済み]
ce15350 Fix close_report dry-run/live Fact Check parity and failure diagnostics          [Claude slot2担当、K2承認済みだがdeploy未承認]
c24fdb4 Gate close_report on final Voice pass, add rewrite, move hashtags post-Voice     [Claude slot1(自分)担当、close-report-final-hardening-20260907。K1承認記録が見当たらず、少なくともdeploy未承認]
```

今回このTASKの「Approved implementation」セクションで明示的に承認されているのは`ff9dcc5`と`21d128c`の2commitのみ。`ce15350`・`c24fdb4`はいずれもclose_report関連で、今回のmorning_greeting deployタスクの承認範囲に含まれていない。

`ce15350`はK2レビューで承認済み（commit `492cc90 Approve K2 close report Fact Check parity fix`）だが、これは**コードレビューの承認**であり、**deploy許可**とは別（このセッション全体を通じて、承認とdeployは常に別タスク・別ステップとして扱われてきた）。`c24fdb4`（close-report-final-hardening、自分が実装）に至っては、K1承認コミット自体が見当たらない（`git log --all`で確認済み）。

**現時点で`x-test-post`をdeployすると、承認済みのmorning_greeting変更2件に加えて、close_report関連の未承認・未deploy変更2件（`ce15350`・`c24fdb4`）も意図せず本番へ同時反映されてしまう。**

### production確認結果（deploy前の事実確認）

- `x-test-post`: **v89 / ACTIVE**（変更なし、今回何もdeployしていない）。commit `1088081`相当のまま。
- `posting_windows.close_report.is_active`は別タスクで`false`と確認済み（今回は未確認・未変更）。close_report自体は現状投稿窓が無効なため、仮に上記の未承認変更が混入deployされても**close_reportの実投稿が即座に発生するわけではない**が、「未承認変更を意図せずdeployしない」というTASKの明示的な安全条件には抵触する。

### 未実施の理由

TASKの「Safety stop conditions」に明記されている「mainに未承認・無関係なx-test-post変更が混在し、承認済み範囲だけ安全にdeployできない」に該当するため、deploy・dry-run（dry-runはdeploy後の確認ステップのため）とも実行していない。X API呼び出し・X投稿も0件。

### production changes

- **なし**。deploy: 未実施。DB migration/schema/GRANT: なし。Cron変更: なし。secrets変更: なし。`posting_windows`変更: なし。X実投稿: 0件。
- Codex担当領域・Claude slot 2担当領域のファイル自体には触れていない（close_report関連ファイルの内容を変更・調査目的で読んだのみで、編集は一切していない）。

### next_recommendation（判断をお願いしたい点）

以下のいずれかの対応をご判断ください:

1. **close_report関連2commit（`ce15350`・`c24fdb4`）も今回まとめてdeployしてよいと明示的に承認する** — その場合、close_reportのproduction動作（Voice gate必須化、rewrite機構、fixed hashtag配線変更、Fact Check parity修正）も同時に有効化されることになるが、`posting_windows.close_report.is_active=false`のため実際の投稿には影響しない。承認いただければ、本タスクの範囲を明示的に拡張したうえでdeployを実行する。
2. **close_report関連commitを別途K1承認・別deployタスクとして先に処理し、その後改めてmorning_greetingのみ（実質的には現時点のmain HEAD全体）をdeployする** — 現実には2の方法でも「close_reportを含めてdeployする」という結果は1と変わらないため、実質的な選択は「今回1のように明示承認して進めるか」「一旦保留して別途整理してから進めるか」。
3. Supabase側でファイル単位の部分deployを行う手段は存在しないため、「morning_greetingだけを厳密に分離してdeploy」という選択肢は技術的に取れない。

いずれの場合も、明日2026-09-09 05:30 JSTの画像生成workflow（`scripts/morning-greeting-image.ts`経由）は、**deployとは独立してmain上のコードを直接使う**ため、x-test-post自体をdeployしなくても新しいscene logicは明日の画像生成に反映される（GitHub Actionsが`main`をcheckoutして実行するため）。本文生成（`x-test-post`のtext instructions）側の反映のみ、今回のdeploy判断待ちとなる。
