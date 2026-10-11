# Codex Task H4 — PR #129 Phase7/R1/R2 一度限りの独立安全レビュー

- task_id: news-improvement-a-pr129-phase7-r2-final-focused-review-h4-20261012
- owner: codex
- slot: codex-4
- status: done
- next_owner: none
- start_code: H4
- finish_code: C4
- completion_code: C4
- return_to: ニュース改善API最適化のちゃ
- recommended_model: Sol（高）
- type: independent high-risk source review (READ-ONLY; no PR/source edits)
- review_pr: https://github.com/anohi-memories/kabumori/pull/129
- exact_review_head: 7bf9b8a0a014ebe9a613e9ebeb0082d0b7834c54
- previous_review_head: 61dd33d72711b11eefd39f77ac2d2431b9b6a9a5
- review_1st_correction_head: 984eeb41f14257be56ecfc00e9a55fa01d1ee136
- return_chat_only: ニュース改善API最適化のちゃ
- forbidden: real production DB/Edge/Cron/Secrets/Auth/provider calls, paid AI, publish/X posts, merge/deploy, PR comments/edits, other task/source/worktree changes

## 対象と背景

A=ニュース改善の専任はG8。API最適化B=G9。G8はPR129 Phase7の独立レビューの指摘 F1〜F9（P1五件/P2四件）の修正を行い、head `984eeb41` にR1をpush。その後K8で見つかった毎時固定スケジュールのF7ローテーション starvation を直し、F9 conditional PATCH を検査可能なモジュールに分離してhead `7bf9b8a0` へR2をpush。G8報告 important-news-monitor 757 PASS、抽出29 PASS、news_discovery/observer 162 PASS、shadow20 PASS、既存TS2322（main同条件）/lint97 baseline継続、実PDF60件の再照合はR2では未実行。これらは**G8自己報告**であり第三者再実行済みではない。

PR129は現在OPEN/Draft/unmerged。Netlify/Vercel commit checks success（画面/Edge本番検証とは別）。このH4は**最終的に一度だけ**重要な誤Fact・取りこぼし・DB並行実行・公開二重化の実害を狙ってレビューする。軽微なstyle/微小なregexへの反復レビューや別システムへレビューを拡張しない。**G8/G9のTASK内容を書き換えない**。

## H4開始前の厳密なガード

- `PROJECT_RULES.md` / `.agent/ORCHESTRATION.md` / `.agent/ACTIVE_TASK.md` / `.agent/CURRENT_STATE.md` / 本TASK / `.agent/CODEX_REPORT_4.md` を読み、H4がreadyかつtask_id/return_to/completion_code一致を確認する。
- 独立worktree/checkoutをfresh `origin/main` とPR129指定headから用意。GitHub headが上記から動いていれば新差分を調べ、未評価の変更があれば勝手にレビュー完了しない。
- 他slot H1〜H3/H5、G1〜G10、既存G8 worktree/PR116 production専用worktree `/Users/yuya/Developer/kabumori-pf`、他のローカルserver/branch/dev server/未commitを絶対に操作しない。独立環境が作れなければBLOCKED。
- Source only / offline mocked test。実ネットワーク・本番DB・実Supabase外部呼出・有料API・本番デプロイ・X投稿は禁止。H4はレビュー専用、fixやcommit/pushしない。

## 重点検証（R2新規に最優先）

### R2-F7: ステートレス公平性・取得予算・正確性

- old `Math.floor(now/(10min)) % n` は毎時3件で同じ2件に固定された。R2は`maxPerFetch=2 successful`, `maxAttempts=4`, `budgetMs=20_000`、乱数tie break、Edgeインスタンス内失敗記憶に変更。
- **再現**: 毎時/30分/10分間隔で新規3件以上・保存済み含む・失敗先頭2件の条件でも次のstatementに必ず試行機会が届くか（3,4候補）。6件以上・連続cold startsはprobabilisticであることを明記し、永続保証を勝手に主張しない。
- 1 URL 8秒 * 最大4回=32秒となり得る。`budgetMs=20秒`が**真のhard deadlineではなくループ間チェック**であることの運用影響、上位Edge Function timeout、RSSから消えたリリースの取りこぼし、失敗記憶偏り・ランダムに偏った順序とクォータを検証。条件によりP1/P2として指摘し、観測情報がなければ推定と明記。
- 既存FOMCが候補URL / document date / release kind / feed day一致の時だけ事実を生成するか。未取得重要ニュースの落とし過ぎ、不要な失敗の繰返し、遅延を区別。

### R2-F9: 既存DB候補への条件付き本文追記

- `candidate_body_fill.ts` / `index.ts` のSELECT/PATCH/重複判定/生成判定までの流れをレビュー。
- PATCHの対象 `id + pending_judgement + source_name=market_macro + body_summary=null/empty`、atomic条件、`Prefer:return=representation` read-back、返却行0/異常/通信エラー/権限の扱いをmock PostgREST等で検証。
- **重大な競合候補**: judgementが先にSELECTしたheadline-only内容と、その後PATCHされる本文の不整合、保存時`content_hash`をheadline-onlyのままにする仕様がduplicate/candidate evidence/Factのintegrityに与える影響、同時複数run、取得済みのstatus衝突、URL重複/既に公開済みの二重投稿を点検。安全な明確な修正条件があれば根拠と最小範囲を指摘。
- F9の未処理 `no_post`/`generation_failed`/`published` を**修正済みと扱わない**。未公開でもstatus進行済み候補を再判断するには承認・設計が必要か、それまでの許容可能な「取りこぼし」なのか重大度と改修方向を述べる。schema/RPC新規変更は実装しない。
- マニュアルによるREAD-BACKテストではなく独立mock、統合全体を通した真の状態遷移確認（テストがmodule内部だけに限られた場合は残余リスク記載）。ステートレス・冪等・権限境界にP1/P2がないか。

### 旧F1〜F6/F8および他ルートの回帰確認（必要な範囲だけ）

- 数値誤解釈: 独立した△符号、amount/% grouped vs interleaved、IFRS税引前利益vs経常利益、連結/個別、同一四半期比較。同じ項目について元レビューのP1は5件・P2は4件。R1の修正結果を確認し、明白な誤Factの残存があれば重く扱う。
- FOMC: 旧minutesへのredirect/過去の判断/反対者のJ. W.イニシャル/反対票数の客観的正しさ。Fed minutes/projectedの既存パススルー/BOJ新取得未接続、著作権・公式host検証、TDnet fallbackにあいまいな原文数字が明確なFactとして入らないか。
- 全重要ニュース回帰（G8報告時757）、Phase6/7・R1/R2関連、ニュース discovery/observer の可能な限りの**オフラインテスト**。original独立再現9件の修正後挙動も再評価。ただし過剰な本番級ネットワークテストや無関係なスイートは不要。既知型エラーTS2322と今回新規問題を区別。

## 完了基準 / 判定

- 固定 reviewed_head を確認、レビューしたコード・テスト条件・再現した失敗と対象文書の実例か合成例かを分ける。
- Review verdict **PASS / PASS_WITH_RESTRICTIONS / CHANGES_REQUIRED / BLOCKED**（1回の絞ったレビュー）。P0/P1/P2の根拠ある実害があれば `CHANGES_REQUIRED`。
- 著しい実害が無ければ小さな残余リスクは明記してPASS_WITH_RESTRICTIONSとし、スタイル問題で無限reviewを起こさない。
- 重要度、path/line、具体的再現手順、修正最小案、release-blocker、その他の承認依存、未確認範囲、commit/PRが不変、本番アクセス0等を記録。
- `.agent/CODEX_REPORT_4.md` に `task_id/result/reviewed_head/changed_files(レビュー作業の編集なし)/tests/remaining_issues/safety_checks/next_recommendation/return_to/completion_code` を記載し、H4自身のTASK status`review_required`・next_owner`chatgpt`で返す。自分で最終merge/deployを決めない。
- 末尾に正確に `ニュース改善API最適化のちゃ へ C4 を送ってください。` と書く。返却先を推測しない。


## C4 evaluation — ChatGPT 2026-10-12 JST

- verdict: CHANGES_REQUIRED / PR129_MERGE_HOLD, completion_report_accepted
- report: `.agent/CODEX_REPORT_4.md` reviewed at `7bf9b8a0a014ebe9a613e9ebeb0082d0b7834c54`, independent 968 existing PASS and 12 probes=9 PASS/3 FAIL, P1×1/P2×2.
- findings: H4-R1 wrapping interleaved amount/% table emits false profit facts (P1); H4-R2 pending judgement saves stale headline verdict after official body fill (P2); H4-R3 correct Fed statement with historical raise preceding current maintain is rendered as current raise (P2).
- separate tasks: Only G8=ニュース改善A is assigned targeted remediation `news-improvement-a-pr129-h4-r1-r2-r3-correction-g8-20261012` (Opus5.5高). G9 remains API最適化B, other H/G slots unaffected.
- accepted: old F7 modulo starvation removed (probabilistic fairness limits remain), conditional PATCH safe status/lane guards, prior F1–F6/F8 checks largely green. Old no_post/failed backlog and Fed TTL limits remain explicit restrictions.
- release_state: PR129 OPEN/Draft/unmerged; no production deploy. H4 report itself has no product edits; H4 is now done/none, review-slot released. Do not auto-run another full H4 review.

## H4 Completion — 2026-10-12 JST

- result: CHANGES_REQUIRED（P1×1 / P2×2）
- reviewed_head: 7bf9b8a0a014ebe9a613e9ebeb0082d0b7834c54
- tests: existing 968 PASS; independent 12 probes = 9 PASS / 3 FAIL; failures recorded as H4-R1/R2/R3.
- findings: wrapped amount/% row misread; concurrent enrichment permits stale judgement; historical FOMC decision emitted as current action.
- report: .agent/CODEX_REPORT_4.md
- source_changes: none
- production_calls: 0
- merge/deploy: not_performed
- next_recommendation: 依頼元ChatGPTでC4確認、G8の限定修正TASKを判断。H4から他TASKを再割当しない。
- return_to: ニュース改善API最適化のちゃ
- completion_code: C4

ニュース改善API最適化のちゃ へ C4 を送ってください。
