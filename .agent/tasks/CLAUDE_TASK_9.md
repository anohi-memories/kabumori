# Claude Task G9 — API最適化B / Phase5成果から評価基盤の権利・費用整理へ

- task_id: api-optimization-b-phase5-followup-fixture-rights-and-cost-eval-g9-20261011
- owner: claude
- slot: claude-9
- status: review_required
- next_owner: chatgpt
- start_code: G9
- finish_code: K9
- return_to: ニュース改善API最適化のちゃ
- recommended_model: Sonnet5（高）
- scope_owner: このチャットの「API最適化 B」のみ。今後もB作業はG9に割当（個別TASK完了後は同じ枠で再割当）。ニュース取得/抽出・重要ニュース監視本体はA=G8が所有。他案件や他のG枠を引き継がない。
- assignment_authorization: ユーザーが2026-10-11にG9の使用を明示承認
- type: offline evaluation and cost/recall optimization preparation
- paid_api_budget: 0 / 有料API呼び出しなし
- prohibited: production deploy, DB writes, schema/RPC/migration, Cron/Secrets/model/Provider changes, other slots/tasks, PR129 edits

## 背景・根拠（B Phase5完了）

- BのPhase5報告は `claude/b-news-eval-prep-20261010` 上のcommit `96d2aebbaeffad749be5d267346f683074dd0202`、資料 `docs/model-optimization/NEWS_UNDELIVERED_ROOT_CAUSE_2026-10-10.md` と `phase5_report_2026-10-10.json`、`fixture_rights_audit_2026-10-10.json`。
- 最新確認でPR [#115](https://github.com/anohi-memories/kabumori/pull/115) はOPEN/Draft/未merged、既存head `8f4305574d1895a9f3b45c91470792bed7edb774`。開始時は最新を再取得。
- 調査: 重要以上405件のうち生成失敗196、直近7日169件中39（23.1%、作成日JST・定義F）。30日47〜48%と期間/分母を混同しない。Fact不足ゲート402/1,808 no_post、ゲート前の重要度は未記録。Xに出ないこととアプリ一覧に載らないことは別。
- PR116直接改善見込みは直近7日39件中6件+部分的7件という推定で、**本番実測ではない**。PR116 10月13日固定deployを実施する権限はこのG9にない。G8 PR129の数値抽出改善はまだレビュー指摘修正中、G9はそのコードを触らない。
- 22評価fixturesのうち本文保持20、権利監査で保存許容2（金融庁・財務省）、無許諾で本文を置くべきでない18件（TDnet11、Al Jazeera3、BBC2、AP2）。本文18件は評価時の原本取得とSHA256/字数照合を検討。JPX/TDnetの再利用条件未確認、403を迂回しない。
- Bの役割は評価基盤・モデル比較・APIコスト/取りこぼし削減の計測と設計。**ニュース本文抽出・配信Functionの実装はA/G8の範囲**。

## 今回の初回G9 TASK

1. **安全な引継ぎ照合**: Phase5のbranch/commit/報告とPR115の開発状態・TASK所有者・PR差分・mainとの関係をチェック。既存A/B直接Claudeセッションが対象branch/PRを編集中なら同時変更せず停止。B専用の新規独立worktree/checkoutから開始し、他slotのworktreeを使わない。
2. **fixture権利問題の最小修正**: 監査結果をもとに、PR115評価fixture `cases.json` に残る第三者本文18件をGit履歴の再利用・勝手な複製で増やさず、安全な参照/ハッシュ・本文非保存方式へ移す**コード案・テスト**を作成。評価時に適法に原文を取得できない/TDnet403/権利不明なら、取得を迂回せずそのケースは `unavailable` / `needs_rights_review` としてfail-closedに記録し、無断再配布しない。既存の適法なofficial 2件の扱いは維持。既存の`attachBodies`、`body_policy.ts`を活用し、再現性・ハッシュ照合をテストする。PR115を直接更新するのは明確な所有者合意・非競合・対象branch安全確認が取れた場合のみ。それ以外はG9独立branchの変更/設計として報告し、既存PRを触らない。
3. **比較とコストの測定基準**: APIコスト/重要ニュース取りこぼし/生成失敗/事象到達の評価指標をPhase5分母定義で固定し、`全判定`を重要以上失敗率の分母に混ぜない。生成失敗は段階（取込・判定ゲート・Fact/Voice・X・アプリ/通知）別に集計。既存ログとSELECT-onlyの既存集計（必要な本番読取権限が不明・競合する場合は新規本番アクセスはしない）から**オフライン再現可能**なベースラインと今後のA/B比較計画を提示。
4. **公開済み側の評価準備**: Phase4/5で人手未確認16件のうちAI暫定3件と未決13件の区別を維持。将来の配信済み側100件のサンプル評価計画を作るが、AI暫定を人手承認として扱わない。ゲート前重要度の欠落を観測可能な`JudgementTrace`設計として保全し、本番schema変更はしない。
5. **権利・費用・安全ゲート**: OpenAI/Claudeの有料比較は**ユーザーの別途予算承認まで実行しない**。既存の無料公的ソース優先＋限定WebSearch方針を維持。見逃し0を目標にしつつ、根拠のない誤配信を増やさない。利用規約不明なデータの保存・配布・403迂回は禁止。

## 変更可能な範囲

- G9専用branch上の `tools/provider-compare/` および `docs/model-optimization/` のBの評価コード・テスト・設計だけ。
- PR115のownership/競合が明らかになった場合は無断pushしない。PR129、PR116、`supabase/functions/important-news-monitor/`、`_shared/news_body_extraction/`、breaking/trigger/Provider本体、G1〜G8/G10、他TASK/Report、production DB/Cron/Secrets/設定・モデルには触れない。
- 本番接続や有料API、実Claude API比較、実X投稿、実アプリ配信、merge/deployは禁止。既存実PDF/記事本文を新たにrepoへ保存しない。純粋なテスト・評価のための読取であってもライセンスと利用範囲を遵守。
- Bの作業を「ニュース改善A/G8」のTASKへ自動移管したり、他のG枠に再割当しない。必要なA連携事項は**報告で明示**し、このチャットのちゃが判断する。

## 必須テストと完了条件

- `deno test --no-config -A tools/provider-compare/src` の既存259 PASS（Phase5報告）をベースラインとして再実行し、rights/fixtureの新規テスト・hash一致/不一致・unavailable/403・source無しを検証。既存テストの改変や本番変更無し。型検査/lint/diff/secret scan。
- fixture権利の課題18件について権利状態と安全な移行方針/実装を明示。権利未確認をPASSとしない。
- 生成失敗・API使用量の評価分母、Phase5/Phase4の差、PR116の効果の**未観測**を明確化。
- B所有範囲の差分だけ、独立branchにcommit/push。新規Draft PRは安全かつ既存PR115と重複しない場合のみ。PR115所有が未確定なら変更せずBLOCKEDと報告。
- 完了時このTASK末尾の `## Report` に task_id/result/changed_files/tests/commit_hash/push/PR/rights_checks/cost_estimates/remaining_issues/safety_checks/next_recommendation を残し、`K9` を **ニュース改善API最適化のちゃ** に返す。次のタスクはこの部屋以外から持ち込まない。

## Report

- task_id: api-optimization-b-phase5-followup-fixture-rights-and-cost-eval-g9-20261011
- result: **PASS_OFFLINE（review_required）** — 第三者本文18件を本文非保存・fail-closedで扱う仕組みと検証、評価指標の分母固定、オフラインのベースライン、配信済み側100件のSQL計画を独立branchに実装。`cases.json` とPR115は未変更（所有者判断待ち）。
- completion_code: K9（return_to: ニュース改善API最適化のちゃ）
- branch: `claude/g9-fixture-rights-cost-eval-20261011`（`claude/b-news-eval-prep-20261010` の `96d2aebb` から分岐。新規独立worktree `/Users/yuya/Developer/kabumori-g9-fixture-rights`）
- changed_files:
  - 新規 `tools/provider-compare/src/{fixture_access,fixture_loader,baseline_metrics}.ts` と `{fixture_access,baseline_metrics,pending_distinction}_test.ts`
  - 新規 `tools/provider-compare/scripts/{build_rights_safe_fixtures,baseline_report}.ts`、`export_eval_posted_sample.sql`（SELECTのみ・本番未実行）
  - 新規 `tools/provider-compare/fixtures/{cases.rights_safe,cases_body_manifest}.json`
  - 新規 `docs/model-optimization/{G9_FIXTURE_RIGHTS_AND_COST_BASELINE_2026-10-11.md,baseline_2026-10-11.json}`
  - 変更（B所有の評価ツールのみ）`src/cli.ts`（`--fixtures`、`--runtime-bodies`、liveはrights_safe必須）、`src/probe_cli.ts`（既定をrights_safe）、`scripts/phase5_report.ts` と `phase5_report_2026-10-10.json`（期間別のPR116見込みを追記のみ。他の値は不変）
- tests: `deno test --no-config -A tools/provider-compare/src` **284 passed / 0 failed**（既存259を未改変で維持 + 追加25）。`deno check` / `deno lint`（tools/provider-compare 全体 83ファイル）エラー・指摘なし。isolation（JSON文字列単位のsecret scan含む）PASS。SQLはローカルPostgreSQL 17で構文・抽出数を確認。
- commit_hash: `b6020dbb41d63cba88208cef20063c8d24632c0e`
- push: 実施（上記branchのみ）。PR作成なし（PR115との重複を避けるため。必要ならちゃが判断）。
- merge: not_performed
- deploy: not_performed
- PR: PR115 未変更（OPEN/Draft、head `8f430557`、更新なし。所有者合意が確認できないため直接更新せず）。PR116/117/129 未変更。
- rights_checks:
  - 評価fixture22件の内訳: 保存許容2（金融庁・財務省）、本文なし2、**許諾を確認できない18（TDnet 11、Al Jazeera 3、BBC 2、AP 2、16,252文字）**
  - 18件は既定で `needs_rights_review` として実行から除外。取得元（ローカルの読み取り専用エクスポート）を明示した場合のみ、サニタイズ後SHA-256が一致したものだけ付与。行なし=`body_source_missing`、不一致=`body_hash_mismatch`。ネットワーク/子プロセスのコードは無く、TDnet 403は構造上迂回できない
  - TDnet（JPX・発行体）の利用規約は公式ページから確認できず（サービス概要のみ）。BBC/AJ/APは許諾未確認。権利未確認はPASSにしていない
  - **未解決**: Git履歴にはPR115の初回コミットの本文が残る。`recorded.generation.text`（本番の公開投稿文）と見出しは各ケースに残る（本番自身の文章として扱ったが権利確認の対象）。Phase2のL0で、18件の本文を含むリクエストをAnthropicの無料count_tokensへ送っていた（課金・モデル呼び出しなし）。以後 `probe_cli` は既定でrights_safe
- cost_estimates（台帳の平均×件数。請求書ではない。有料比較は未実行）:
  - ニュースパイプライン全体 約 $13.3/30日（Sol判定 $8.7、Luna $1.4、検索 $1.7）
  - ゲートでno_postになったSol判定 約 $2.6（30日の件数）〜 $5.5（現在の量）/30日。生成失敗に使った費用 約 $0.17〜0.25/30日 → 失敗の損失は費用ではなく到達
  - 将来の比較（見積）: 一次判定×290件 Haiku(off) $0.09 / Sonnet(low) $2.60 / Opus(medium) $8.88。一次+詳細×290件 $0.20 / $5.72 / $19.03。生成の連鎖×100件 $0.12 / $3.27 / $10.04。Sonnet・Opusは一次判定でLunaの約30〜110倍。実行はユーザーの予算承認後
- metrics_baseline:
  - 配信失敗率の分母は「重要以上」に固定（no_postを入れると関数が失敗）。全判定を分母にした値は別名。30日 48.4%（196/405）と直近7日 **23.1%（39/169）** を窓つきで別保持
  - 段階別: 判定でno_post 1,406、ゲート402、重要以上405、生成停止（Fact168/Voice25/ローカル1/API2）、X配信208
  - PR116の効果は**未観測**（merge後の最初の完全な週で比較。15%への低下の検出に各群約369件=約3週間、10%なら約127件=約1週間）。直近7日の失敗39件のうち改善見込み6・部分的7・対象外26は読み取りの推定で実測ではない
- remaining_issues: (1) `cases.json` の置換とGit履歴の扱いはPR115所有者の判断（本文を前提とする既存テストの前処理追加が必要）。(2) A担当Preflightの定義（期間・分母・状態・重複・試行か最終か）は未照合。(3) ゲート前重要度の保存（`JudgementTrace`）は承認とC2レビューが必要な本番変更で、Bからは実施しない。(4) 配信済み側100件は製品方針の問い6項目の回答後に実施。(5) 人手確認済みラベルは0件。(6) TDnet原本は未確認（403は迂回しない）。
- safety_checks: 有料API呼び出し0。本番DBへの新規アクセス0（既存のコミット済み成果物のみ使用）。DB書込み/schema/Cron/Secrets/Provider/モデル変更なし。PR115/116/117/129・`supabase/functions/important-news-monitor/`・他slotのTASK/worktreeに触れていない。`cases.json` 不変。merge/deploy なし。AI暫定を人手承認として扱っていない（`verifier` は全件 `none`）。
- next_recommendation: ちゃが次を判断。(a) PR115所有者へ `cases.rights_safe.json` への切替と履歴の扱いを依頼、(b) A/G8へPhase5の取得段階の高優先3件（決算短信の当期行、日銀PDFの本文、FOMC声明）を引き継ぎ、(c) ゲート観測（`JudgementTrace`）の保存方式の承認、(d) 製品方針の問い6項目の回答後に配信済み側100件を実施、(e) 有料比較はユーザーの予算承認後のみ。K9 を **ニュース改善API最適化のちゃ** に返す。
