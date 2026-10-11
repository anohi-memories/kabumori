# Claude Task G9 — API最適化B / Phase5成果から評価基盤の権利・費用整理へ

- task_id: api-optimization-b-phase5-followup-fixture-rights-and-cost-eval-g9-20261011
- owner: claude
- slot: claude-9
- status: ready
- next_owner: claude
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
- result: not_started
- changed_files: none
- tests: not_run
- commit_hash: none
- push: not_performed
- merge: not_performed
- deploy: not_performed
- remaining_issues: 第三者本文18件の評価fixture権利、安全な費用対効果・取りこぼし評価、PR115所有確認
- safety_checks: not_started
- next_recommendation: G9で開始し、B限定の独立worktreeでPhase5から継続。完了時K9。
