# Claude Task 4

- task_id: x-ai-salaryman-dev-diary-pr61-runtime-fix-20260930
- owner: claude
- slot: claude-4
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（高）
- target: PR #61
- purpose: H2で見つかった2点だけを修正し、会社員AIラボの開発日記生成をproduction-readyなsource状態にする。

## Mandatory startup

1. Read ORCHESTRATION / CURRENT_STATE / this TASK / latest H2 report.
2. Independent G4 worktree; fresh origin/main.
3. Update/rebase the PR branch safely because PR #61 is behind main.
4. Read the current Supabase skill/changelog/docs before changing Edge Function packaging.
5. Do not touch G3/Auth/account-deletion work.

## Fix 1 — runtime diary asset

Current blocker:
- the implementation reads adjacent Markdown at runtime
- current deploy packaging does not prove that the Markdown is included
- read failure silently falls back to evergreen

Required:
- keep the human/ChatGPT-readable Markdown as the canonical diary source
- make the production Edge runtime consume a representation that is guaranteed to be bundled by the actual deploy path
- prefer the smallest reliable approach
- a generated/importable TypeScript snapshot derived from the canonical Markdown is acceptable and preferred if it avoids unsupported static-asset packaging
- if a Supabase static_files solution is used instead, prove it is supported by this repository's real deployment path and current official docs
- add a sync/parity check so canonical Markdown and bundled runtime representation cannot silently diverge
- do not silently treat a missing/unreadable required runtime asset as fresh diary context
- verify the actual Edge-runtime-compatible loader path, not only a local checkout file read

Current known limitation remains acceptable:
- changing diary content may still require commit + x-test-post redeploy
- periodic automatic progress aggregation is NOT part of this task

## Fix 2 — cross-brand hashtag scope

H2 found the shared no-fixed-hashtag prompt change also affects neutral profiles such as social_mobile_user_v1.

Required:
- preserve the prior no-hashtag behavior for other no-fixed-hashtag profiles
- allow the AI Lab-specific voice policy to control its own optional #個人開発 usage
- scope the exception explicitly to AI Lab or otherwise prove exact behavioral equivalence for every other profile
- add a regression test for the neutral social-mobile profile and fixed-hashtag brands

## Preserve

- AI Lab development-diary identity and 70/30 direction
- no-fabrication rule for fresh vs evergreen content
- sanitizer and public-safe diary curation model
- other brands' behavior
- existing scheduler/posting safety
- no DB/RLS/RPC/Auth changes

## Tests / evidence

Must include:
- canonical Markdown <-> runtime bundled representation parity
- fresh diary selection in Edge-compatible runtime path
- missing/stale/unsafe context fallback behavior
- AI Lab optional hashtag behavior
- neutral social-mobile no-hashtag behavior unchanged
- fixed-hashtag brand behavior unchanged
- existing AI Lab/scheduled generator suites
- full relevant shared-brand suite
- deno check for changed files
- git diff --check
- secret scan

No production deploy and no real X post.

## Completion / K4

Report:
- exact runtime packaging approach
- why it is valid for the actual Supabase deploy path
- changed_files
- hashtag scoping behavior
- tests
- PR/head
- production_mutation=0
- whether PR #61 is ready for focused H2 re-review

Then status -> review_required, next_owner -> chatgpt, STOP for K4.


## Report

- task_id: x-ai-salaryman-dev-diary-pr61-runtime-fix-20260930
- result: **PASS（source-only、未デプロイ）**。C2の2件のblockerを両方修正した。PR #61（未merge、未デプロイ）、head `be146f7`。
- model_used: Sonnet 5（高）
- worktree: G4専用 `/Users/yuya/Developer/kabumori/.claude/worktrees/g4-x-admin-pr15`（PR作業はブランチ`g4/ai-lab-dev-diary-content-shift-20260930`上で継続、originが先行していたため`git rebase origin/main`で安全に追従。`supabase/functions`配下に触れた他コミットは無く、実質コンフリクトなし。force-with-leaseでpush）

### exact runtime packaging approach（Fix 1）

- **確認した事実（Supabase公式ドキュメント・changelogで確認）**: Supabase Edge Functionのデプロイは、functionが実際に`import`しているmodule graphだけをESZipへバンドルする。同じディレクトリに置いてあるだけの、importされていないファイル（今回の`.md`）はバンドルされる保証がない。含めるには`supabase/config.toml`の`[functions.<name>].static_files`へ明示宣言する必要がある（Supabase CLI 2.7.0以降の機能）。本リポジトリは`x-test-post`にそのような宣言を持っておらず、新たに追加すること自体が別の本番デプロイ設定変更になる。
- **採用した方式**: Markdown（`ai_lab_dev_diary_context.md`）は引き続き正本（人/ChatGPTが手で書き足す）として維持。新規`generate_ai_lab_dev_diary_snapshot.ts`が、その内容をそのまま`JSON.stringify`した文字列定数として`ai_lab_dev_diary_context.snapshot.ts`（生成物、commit対象）へ書き出す。実行時の読み込み（`ai_lab_dev_diary_context.ts`の`loadAiLabDevDiaryMarkdown()`）は、この生成物を**通常の`import`**として読み込むだけに変更した。ファイル読み取りではないため、実行時に「読めない」という失敗モード自体が構造的に無くなった。
- **なぜ実際のSupabase deployで有効か**: `import`されたモジュールは、他の`_shared/brand/*.ts`のimportと全く同じ扱いでmodule graphに含まれる。新しいdeploy設定は一切不要（`static_files`宣言も、DB/Storageからの動的読み出しも実装していない）。

### 動作確認（実際に乖離を検知できることを手で確認）

1. `.md`へ1行追記 → `deno test`のparity testが**red**になることを確認。
2. `.md`を元に戻す（gitでrevert確認）→ 再度snapshotを生成し直し、テストが**green**に戻ることを確認。

これにより、Reportで主張するだけでなく、実際に「乖離を検知するガード」が機能することを確認済み。

### 正直に残る制約（変更していない、TASKの想定どおり）

- `.md`を編集したら、`generate_ai_lab_dev_diary_snapshot.ts`を実行してsnapshotを再生成し、両方をcommitしたうえで`x-test-post`を再デプロイしないと、実際の投稿には反映されない。
- 定期的な自動進捗集約は今回のスコープ外のまま。

### hashtag scoping behavior（Fix 2）

- `BrandCodeProfile`に`voiceControlsHashtags?: boolean`（既定`false`/未指定）を追加。`brand_post_generator.ts`の「固定ハッシュタグ未設定時」の指示は、この値が`true`のプロファイルのときだけ「上記の指示（voiceInstructions）に従ってください」に変わり、それ以外（既定）は元の「ハッシュタグは付けないでください」のまま。
- `AI_SALARYMAN_LAB_CODE_PROFILE`だけが`voiceControlsHashtags: true`を設定。`SOCIAL_MOBILE_USER_CODE_PROFILE`など他の全プロファイルは変更なし（`voiceControlsHashtags`を追加していない＝既定`false`）。
- ブランドIDのハードコード分岐は生成モジュール側に**一切持ち込んでいない**（プロファイル側のフラグで判定）。

### changed_files（今回の修正分のみ）

新規:
- `supabase/functions/_shared/brand/ai_lab_dev_diary_context.snapshot.ts`（生成物、`.md`から機械生成）
- `supabase/functions/_shared/brand/generate_ai_lab_dev_diary_snapshot.ts`（生成スクリプト）

変更:
- `supabase/functions/_shared/brand/ai_lab_dev_diary_context.ts`（`loadAiLabDevDiaryMarkdown()`をimportベースへ変更、ヘッダーコメントを実際のバンドル方式に訂正）
- `supabase/functions/_shared/brand/ai_lab_dev_diary_context_test.ts`（parity test、実ファイルでのend-to-end選択テストを追加）
- `supabase/functions/_shared/brand/brand_profiles.ts`（`voiceControlsHashtags`フィールド追加、AI Labのみ`true`）
- `supabase/functions/_shared/brand/brand_post_generator.ts`（ハッシュタグ指示の分岐をscopeし直し）
- `supabase/functions/_shared/brand/brand_post_generator_test.ts`（AI Labの回帰テストの説明を明確化、`social_mobile_user_v1`が旧挙動のままであることの新規回帰テストを追加）
- `supabase/functions/x-test-post/index.ts`（呼び出し箇所のコメント更新、`loadAiLabDevDiaryMarkdown()`がもう失敗しないため`.catch()`を削除）

DB/RLS/RPC/migration/Auth設定の変更なし。G3所有ファイルへの変更なし。

### tests

- `ai_lab_dev_diary_context_test.ts`: **22/22 pass**（既存20件＋新規2件: 正本とbundleされたsnapshotのbyte-identicalなparity test、実ファイルに対する日記由来トピック選択のend-to-endテスト）。上記のとおり、parityテストが実際に乖離を検知することを手動でも確認済み。
- `brand_profiles_test.ts`: **7/7 pass**（無変更のまま通過）。
- `brand_post_generator_test.ts`: **13/13 pass**（既存11件＋AI Labの回帰テスト1件（説明更新）＋`social_mobile_user_v1`の新規回帰テスト1件）。
- `ai_lab_scheduled_brand_post_test.ts`: **8/8 pass**（`index.ts`配線変更の影響なし）。
- `supabase/functions/_shared/brand/`配下すべて: **112/112 pass**（`deno test`、実行時ランタイムで確認）。
- `deno check`: 今回変更・新規追加したファイルすべて単体でエラー0。`x-test-post/index.ts`全体では引き続き既存6件のエラー（今回のPRが触れていない`x_oauth2_post.ts`・`morning_greeting_*.ts`・`morning_lane_response_logic.ts`・`morning_candidate_logic.ts`由来）が出るが、`origin/main`時点で既に存在することを確認済み（前回Reportと同じ、今回の修正でも件数は変化なし）。あわせて、`brand_post_generator_test.ts`で見つかった3件の`deno check`警告（`capturedBody?.X does not exist on type 'never'`）についても、PR #61以前の`main`のベースライン版ファイルで同一の警告が既に出ることを確認し、今回の変更に起因しないことを検証した。
- `git diff --check`: PASS。差分に対する簡易secret scan: 該当なし。

### PR/head

https://github.com/anohi-memories/kabumori/pull/61 （head `be146f7`、OPEN、MERGEABLE）。origin/mainへ追従するため一度rebaseし、force-with-leaseでpush済み。

### production_mutation

**0件**。デプロイ・DB/RLS/RPC/migration・Auth設定変更・X実投稿のいずれも無し。

### whether PR #61 is ready for focused H2 re-review

**Yes**。C2が指摘した2件（ランタイムでのバンドル保証・ブランド横断のハッシュタグ挙動変化）を、いずれも指摘どおりのスコープで修正した。他ブランド（かぶモリ・social_mobile_user_v1）の挙動は変更していないことをテストで確認済み。

## Completion

- status -> review_required
- next_owner -> chatgpt
