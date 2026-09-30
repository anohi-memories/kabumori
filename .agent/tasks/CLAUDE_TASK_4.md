# Claude Task 4

- task_id: x-ai-salaryman-dev-diary-content-shift-20260930
- owner: claude
- slot: claude-4
- status: ready
- next_owner: claude
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
