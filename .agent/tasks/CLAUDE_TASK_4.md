# Claude Task 4

- task_id: x-ai-salaryman-dev-diary-content-shift-20260930
- owner: claude
- slot: claude-4
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（高）
- purpose: 会社員AIラボの自動投稿を「AIの使い方解説中心」から「非エンジニア会社員のAI個人開発日記中心」へ変更し、投稿AIとChatGPTが共有できる安全な開発進捗コンテキストを作る。

## Mandatory startup
1. Read ORCHESTRATION / CURRENT_STATE / this TASK.
2. Use an independent G4 worktree/check-out.
3. Fresh origin/main.
4. Locate the actual company-AI-lab generation path, account/brand config, scheduler, prompt/template, and tests before editing.
5. Confirm file separation from G3. Do not touch social-mobile Auth/account-deletion work.
6. Preserve other brands, especially みお and かぶモリ. This task changes only 会社員AIラボ.

## Product direction

Current problem:
- posts are too often framed as "how to use AI"
- they read like repeated AI tips/tutorials
- user wants the account to feel like an ongoing development diary

New identity:
**本業をしながら、コードを書けない非エンジニア会社員が、複数AIをチームのように使って個人開発を進めている記録。**

The account may still mention AI, but AI is part of the development process, not the topic of every post.

## User-approved tone/examples

Use these as style references, not fixed text to repeat:

1.
AIで個人開発してると、
「作る」より「直す」の時間のほうが長い日が普通にある。
今日はここを直したら別の場所が崩れて、
そこを直したらまた確認。
でも自分でコードを書けなくても、
AIに状況を整理して渡せば少しずつ前には進む。
地味だけど、こういう日が一番リアル。
#個人開発

2.
非エンジニアがAIで開発してて最近思うこと。
「AIに任せれば全部一発で完成する」
は全然そんなことない。
むしろ大事なのは、
・何を作りたいか決める
・やる範囲を絞る
・結果を確認する
・違ったら修正を伝える
この繰り返し。
コードより先に、指示の出し方で詰まる。
#個人開発

3.
本業しながらの個人開発、
毎日何時間もやるのは正直無理。
だから最近は
「今日は1個だけ終わらせる」
くらいで考えるようにしてる。
画面を1つ直す。
バグを1つ潰す。
仕様を1つ決める。
小さくても昨日より進んでたらOK。
これが一番続く。
#個人開発

4.
AIを3つ使って開発してるけど、
「一番賢いAIに全部やらせる」
みたいな使い方にはしてない。
企画や整理が得意なAI、
実装が得意なAI、
レビューや調査が得意なAI。
人間のチームみたいに役割を分けたほうが進めやすい。
自分はコードを書くより、
このAIチームを動かす係。
#個人開発

5.
個人開発を始める前は、
アプリ作り＝コードを書くこと
だと思ってた。
実際やってみると、
仕様を決める
↓
作ってもらう
↓
触って確認
↓
おかしい所を探す
↓
直してもらう
この時間がかなり長い。
コードが書けなくても、
「何が違うか」を言葉にできる力はかなり重要。
#個人開発

## Content pillars

Prioritize:
- 今日やった開発・修正・検証
- バグや手戻りのリアル
- 仕様を決めた/変えた理由
- 本業と個人開発の両立
- 小さく進める習慣
- 非エンジニア視点で感じたこと
- 複数AIの役割分担
- 失敗/詰まり/やり直し
- リリースまでの過程
- 「作るより確認・修正が長い」など実体験ベースの気づき

Avoid:
- 毎回「AIで○○できます」
- 毎回ツールの使い方
- generic prompt tips
- 同じ構成/同じ結論の連投
- 成功者っぽい誇張
- エンジニアを装う表現
- 実際にしていない作業を今日やったように書く

Target balance:
- development diary / current progress: about 70%
- evergreen development reflection: about 30%

## Shared development-progress context

Create one canonical, safe-to-share development-diary context that both:
- the production/API post generator can consume
- ChatGPT can read from the repository

Preferred shape:
- one human-readable canonical Markdown file
- optionally one generated machine-readable JSON only if the existing runtime needs it

The source must contain only public-safe diary context, such as:
- date
- project/category
- what changed today
- what was difficult
- what was decided
- what remains
- one or more possible diary angles

Do NOT expose:
- secrets/tokens
- production identifiers
- private emails
- customer/user data
- raw security findings
- internal credentials/config values
- destructive-operation details
- raw .agent task/report bodies

Implement a safe updater/collector using the architecture that fits the existing scheduler/runtime. It may derive candidate facts from repository task reports/git history, but must sanitize/whitelist before the content becomes eligible for automatic posting.

If the production generator cannot dynamically read a repository file without redeployment, do not fake it. Implement the smallest truthful bridge compatible with the current runtime and document the data flow.

## Generation rules

When fresh progress exists:
- prefer a concrete recent development diary angle
- convert technical detail into normal non-engineer language
- do not invent results
- do not leak project-sensitive information
- avoid mentioning internal branch names, task IDs, DB object names, secrets, production identifiers

When no trustworthy fresh progress exists:
- fall back to an evergreen reflection in the approved style
- never pretend something happened "today"

Variation:
- vary opening, sentence rhythm, length, structure
- bullets are optional, not mandatory
- #個人開発 is the default hashtag; avoid hashtag stuffing
- retain natural first-person voice
- no "AI先生" tone or tutorial CTA unless context genuinely calls for it

## Tests / verification

Add or update tests for:
- 会社員AIラボ uses new diary-oriented prompt/context
- other brands remain unchanged
- no-progress fallback does not fabricate today's activity
- sensitive/raw orchestration data cannot flow directly into prompt output
- current scheduler/generation still works
- deterministic fixtures for at least several diary/context variants

Run relevant tests, typecheck/lint, and existing generation smoke tests.

## Production

Do not activate/deploy until the implementation and generated sample set are reviewed at K4.
No unrelated production changes.

## Completion / K4

Report:
- actual current generation path found
- changed_files
- canonical progress-context location and update flow
- how API AI consumes it
- how ChatGPT can read it
- prompt/content-policy changes
- 10 representative generated sample posts using fixtures
- tests
- commit/push/PR
- deploy status
- remaining issues
- safety checks

status -> review_required
next_owner -> chatgpt
STOP for K4.


## Report

- task_id: x-ai-salaryman-dev-diary-content-shift-20260930
- result: **PASS（source-only、未デプロイ）**。「AIの使い方解説」ばかりになっていた原因を特定し、開発日記ベースの投稿へ切り替える実装を行った。PR #61（未merge、未デプロイ）。
- model_used: Sonnet 5（高）
- worktree: G4専用 `/Users/yuya/Developer/kabumori/.claude/worktrees/g4-x-admin-pr15`（コードは新規branch `g4/ai-lab-dev-diary-content-shift-20260930`、TASK更新はworktree本来のbranchから）
- PR: https://github.com/anohi-memories/kabumori/pull/61 （head `385e561`、OPEN、MERGEABLE）

### 実際の生成経路（見つけたこと）

- 会社員AIラボ（`ai_salaryman_lab`）の投稿は、`supabase/functions/x-test-post/index.ts`のcron dispatchが`scheduled_posts`から`post_type: "brand_post"`の行を拾い、`dispatchAiLabScheduledBrandPost`（`_shared/brand/ai_lab_scheduled_brand_post.ts`）→`generateBrandPost`（`_shared/brand/brand_post_generator.ts`、OpenAI Responses API）で本文を生成し、`postToX`でXへ投稿している。
- **「AIの使い方解説」ばかりになっていた直接の原因**: `dispatchAiLabScheduledBrandPost`の`generate`呼び出しに`topicSeed`が一度も渡されていなかった。そのため`generateBrandPost`内のfallback `topicSeed?.trim() || context.codeProfile.defaultTopicSeed || DEFAULT_TOPIC_SEED`が毎回`DEFAULT_TOPIC_SEED`（"AIツールを使った日々のちょっとした工夫"）になっていた。`voiceInstructions`（人格・トーン）自体は妥当だったが、**話題（topic）が固定されていた**。
- 投稿の実行権限・文字数上限（280文字）・重複検知（cross-brand dedupe）・X投稿のfingerprint記録などの既存の安全機構は今回変更していない。

### changed_files

新規:
- `supabase/functions/_shared/brand/ai_lab_dev_diary_context.md`（正本、git管理、人/ChatGPTが手で書き足す）
- `supabase/functions/_shared/brand/ai_lab_dev_diary_context.ts`（純粋関数: パース・sanitize・選択、テスト20件）
- `supabase/functions/_shared/brand/ai_lab_dev_diary_context_test.ts`

変更:
- `supabase/functions/_shared/brand/brand_profiles.ts`（`AI_SALARYMAN_LAB_CODE_PROFILE.voiceInstructions`を新方針に全面更新。禁止事項・かぶモリ分離は維持）
- `supabase/functions/_shared/brand/brand_profiles_test.ts`（新方針に合わせて更新）
- `supabase/functions/_shared/brand/brand_post_generator.ts`（付随して見つけたバグを1件修正、下記）
- `supabase/functions/_shared/brand/brand_post_generator_test.ts`（上記の回帰テストを追加）
- `supabase/functions/x-test-post/index.ts`（AI Labのdispatch呼び出し箇所のみ、`topicSeed`を計算して渡すよう追加。`dispatchAiLabScheduledBrandPost`自体のAPIは無変更）

DB/RLS/RPC/migrationの変更なし。G3所有のAuth/account/provider-readinessファイルへの変更なし（重なりなし）。

### canonical progress-context location and update flow

- 正本: `supabase/functions/_shared/brand/ai_lab_dev_diary_context.md`。1エントリ=1日、`project:` `changed:`（必須） `difficulty:` `decided:` `remaining:` `angle:`（複数可）のラベル行のみで構成する簡易フォーマット。ファイル先頭にコメントで書き方のルールを明記した。
- 更新方法: 人（またはChatGPT）がこのファイルへ直接エントリを追記する。gitで管理されるので、そのままレビュー・履歴確認ができる。

### how the API generator consumes it（重要な制約）

- Supabase Edge Functionはデプロイ時に**自分のディレクトリ以下をまるごとバンドル**する。`.md`ファイルを`.ts`と同じディレクトリに置き、`node:fs/promises`（DenoのNode互換層、実行時に動作確認済み）で隣接ファイルとして読み込む方式にした。DB/Storageへの別読み出しは実装していない。
- **結果として、`.md`の更新を実際の投稿へ反映するには、`x-test-post`の再デプロイが必要**（TASKの「動的に読めないなら、それを偽装しない」指示どおり、正直な制約として残した）。デプロイなしで自動反映される仕組みではない。

### how ChatGPT can read it

このリポジトリの`supabase/functions/_shared/brand/ai_lab_dev_diary_context.md`を直接読み書きできる（他のMarkdownファイルと同様）。

### prompt/content-policy changes

`AI_SALARYMAN_LAB_CODE_PROFILE.voiceInstructions`を全面更新。要点:
- アイデンティティ: 「本業をしながら、コードを書けない非エンジニア会社員が、複数AIをチームのように使って個人開発を進めている記録」。
- コンテンツの柱（約7割・直近の開発日記）: 今日やった開発・修正・検証／バグや手戻りのリアル／仕様を決めた・変えた理由／本業と個人開発の両立／小さく進める習慣。
- コンテンツの柱（約3割・エバーグリーン）: 非エンジニア視点で感じたこと／複数AIの役割分担／失敗・詰まり・やり直し／リリースまでの過程。
- AIは手段であり主役ではない、というルールを明記。毎回のツール紹介・使い方解説・定型構成・成功者演出・エンジニア偽装・やっていない作業の捏造を明示的に禁止。
- 書き出し・リズム・長さ・構成のバリエーション、ハッシュタグは基本「#個人開発」のみで連投しない、というルールを追加。
- **既存の安全項目は維持**: 未確認の人物像・実績・勤務先・投資経験・収益額の捏造禁止、事実として提供されていない一人称体験談の禁止、株式投資・かぶモリの話題/人格/文体/固定ハッシュタグとの完全分離。
- 今日の進捗が無い場合に「今日〜した」と断定しないルールを明記（エバーグリーンな気づきとして書く）。

### 付随して見つけて直したバグ

`brand_post_generator.ts`の共通ハッシュタグ指示: `fixed_hashtags`が未設定（会社員AIラボの現状）のとき、これまでは「ハッシュタグは付けないでください」と機械的に指示していた。今回`voiceInstructions`に「#個人開発をデフォルトにする」ルールを追加したことで、**同じプロンプト内で2つの指示が真っ向から矛盾する**状態になっていた。これはブランド非依存の共有モジュールの既存の作りであり、今回追加した`voiceInstructions`との組み合わせで顕在化した。修正: 固定ハッシュタグが無い場合は「固定のハッシュタグ指定はありません。使うかどうかは上記の指示に従ってください」という中立文に変更し、ブランドごとの声の指示を尊重するようにした。固定ハッシュタグが設定されているブランド（かぶモリ等）の挙動は無変更（既存テストで確認済み、新規の回帰テストも追加）。

### 10 representative generated sample posts using fixtures

実際の生成パイプライン（`generateBrandPost`、topicSeed注入・プロンプト構築・280文字ポリシー判定）を、OpenAIへの実通信の代わりに**手書きの代表サンプル文をfixtureとして返すfetch**で通し、配線が正しく動くことを確認した（実際のモデル出力ではなく、審査前に実APIを使わないための決定論的な確認）。日記由来4件・エバーグリーン6件、全件280字以内、ハッシュタグの有無も意図的にばらつかせた。全文はPR本文に掲載（`gh pr view 61`または上記リンクで確認可能）。

あわせて、実際の正本ファイルに対して`selectAiLabTopicSeed({ now: 2026-09-30 })`を実行し、2026-09-29のエントリ（3日以内）から日記由来の角度が正しく選ばれることを確認した（選択ロジック自体もfixtureではなく実ファイルで動作確認済み）。

### tests

- `ai_lab_dev_diary_context_test.ts`: **20/20 pass**（パース、フィールド単位／エントリ全体のsanitize、禁止カテゴリ全種、未来日付エントリの除外、複数エントリからの最新選択、決定論的な乱数選択、実際の正本ファイルの全エントリがsanitizeを通ること）。
- `brand_profiles_test.ts`: **7/7 pass**（新方針の柱・7:3比率・トーン・ハッシュタグ規律・note送客ルール・捏造禁止＋today断定禁止・かぶモリ分離、いずれも更新済み）。
- `brand_post_generator_test.ts`: **12/12 pass**（既存11件＋ハッシュタグ指示修正の回帰テスト1件）。
- `ai_lab_scheduled_brand_post_test.ts`: **8/8 pass**（`index.ts`配線変更の影響なし）。
- `supabase/functions/_shared/brand/`配下すべて: **109/109 pass**（`deno test`、実行時ランタイムで確認。一部は`node --experimental-strip-types --test`ではDeno専用APIのため実行不可だが、これは今回の変更と無関係な既存の環境差）。
- `deno check`: 新規・変更したファイル単体ではエラー0。`x-test-post/index.ts`全体では、今回のPRが触れていない既存4ファイル（`x_oauth2_post.ts`、`morning_greeting_image_logic.ts`、`morning_greeting_logic.ts`、`morning_lane_response_logic.ts`、`morning_candidate_logic.ts`）由来の型エラー6件が出るが、`origin/main`時点で既に存在することを確認済み（今回の変更起因ではない）。
- `git diff --check`: PASS。差分に対する簡易secret scan: 該当なし。

### commit/push/PR

`g4/ai-lab-dev-diary-content-shift-20260930`ブランチへcommit・push済み。PR #61作成済み（OPEN、MERGEABLE、head `385e561`）。mainへは未merge。

### deploy status

**未デプロイ**。TASKの「実装とサンプルがK4でレビューされるまでdeploy/activateしない」指示どおり、Supabase Functionsへのdeployは行っていない。したがって現時点で実際の投稿内容はまだ変わっていない（次回の自動投稿は、mergeかつdeployされるまで従来どおり）。

### remaining issues

1. **デプロイが必要**: PRがmergeされても、`x-test-post`を再デプロイしない限り本番の投稿には反映されない。
2. **正本ファイルの継続更新**: 今回4件（2026-09-26〜09-29）の実エントリを書いたが、これは開発の進捗に応じて随時追記していく前提。追記のたびに`x-test-post`の再デプロイが必要（上記の制約どおり）。エントリが3日を超えて古くなると自動的にエバーグリーンへフォールバックするので、放置しても安全（嘘の「今日」表示は起きない）。
3. **手動更新の運用**: 現状は人/ChatGPTが手でMarkdownを書く運用。将来、taskレポートやgit historyから自動で候補を抽出する仕組みが欲しくなった場合は、今回のwhitelist/sanitize関数（`isSanitizedDiaryField`等）をそのまま使える設計にしてある。

### safety checks

- 生成された文面が「今日〜した」と断定できるのは、実際に3日以内の安全なエントリがある場合のみ。無い場合は明確にエバーグリーン（断定なし）にフォールバックする（テストで確認済み）。
- 正本Markdownの各フィールドは、ブランチ名・タスクID・テーブル名・RPC名・コミットハッシュ・PR番号・URL・メールアドレス・鍵/トークンらしき文字列を検知したら**そのフィールドを除外**し、`changed`が該当した場合は**エントリ全体を除外**する（黙って通さない）。
- かぶモリとの分離、株式投資関連の話題禁止、捏造禁止（人物像・実績・勤務先・投資経験・収益額）は既存のまま維持。
- 秘密情報・トークン・鍵の値はコード・テスト・正本ファイルのいずれにも含まれていない（secret scan実施済み）。
- production mutation = 0件。X実投稿・deploy・DB/RLS/RPC/migration・Auth設定変更のいずれも無し。

## Completion

- status -> review_required
- next_owner -> chatgpt
