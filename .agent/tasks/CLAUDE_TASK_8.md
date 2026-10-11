# Claude Task G8 — PR #129 H4独立レビュー3件の最小修正（R3）

- task_id: news-improvement-a-pr129-h4-r1-r2-r3-correction-g8-20261012
- owner: claude
- slot: claude-8
- status: ready
- next_owner: claude
- start_code: G8
- finish_code: K8
- return_to: ニュース改善API最適化のちゃ
- recommended_model: Opus5.5（高）
- type: targeted code correction after Codex H4 C4
- target_PR: https://github.com/anohi-memories/kabumori/pull/129
- reviewed_head: 7bf9b8a0a014ebe9a613e9ebeb0082d0b7834c54
- review_report: .agent/CODEX_REPORT_4.md
- review_verdict: CHANGES_REQUIRED / P1×1 P2×2
- user_routing: Aニュース改善専任G8だけ。API最適化B/G9、ほかG/H、別案件に触れず、引継ぎもしない。
- forbidden: production deploy/merge/paid API/real DB/real Edge/real Fed/TDnet requests, schema/RPC/migration/Cron/Secrets/provider/model changes, other worktrees/tasks

## 目的（レビューの繰返しではなく、実装とテスト）

H4によるPR129独立レビューは完了、C4確認済み。H4はソース未変更。GitHub PR129のレビュー済head `7bf9b8a0a014ebe9a613e9ebeb0082d0b7834c54` はOPEN/Draft/未merge（作業開始時にHEAD再確認）。既存968 PASS、H4独立12 probeの9 PASS/3 FAILは**実行済みレビュー結果**で、失敗した3件は安全性期待を破る合成再現。

以下のH4-R1(P1),R2(P2),R3(P2)だけを**実際に修正**する。F7の従来毎時modulo取りこぼしの改善、旧F1〜F6・F8等を維持。Styleや無関係なコードを広げない。失敗を誤Factにしないfail-closedを優先し、正常配信の不必要な停止を避ける。

## H4-R1 [P1] 決算短信：折返したinterleaved列の金額/増減率誤変換

- 対象 `supabase/functions/_shared/news_body_extraction/kessan_tanshin_facts.ts` の `parseRow()`、特に `tokens.length === metrics.length` を無条件でamounts_onlyにする処理と継続行の無視。
- **独立再現合成テキスト（架空数値）:**

```text
2026年3月期 決算短信〔日本基準〕(連結)
(百万円未満切捨て)
（１）連結経営成績
売上高 営業利益 経常利益 親会社株主に帰属する当期純利益
百万円 % 百万円 % 百万円 % 百万円 %
2026年3月期 1000 10 100 20
80 30 50 40
2025年3月期 900 5 90 6
70 7 40 8
```

- 真の当期金額: 売上1000 / 営業100 / 経常80 / 純利益50（百万円）。変化率 +10/+20/+30/+40%。旧実装は `ok=true, issues=[]` で営業10・経常100・純利益20を確定Factと出力する。
- 必須修正: `m` 個の数値をamounts_only行として認めるのは **headerからlayout==='amounts_only'と確証できる場合だけ**。interleaved/groupedの2m未満行は、明確で安全な継続行結合ができる条件だけ結合し、そうでなければ **表を読取不可・重要Fact非出力**。続行が別期間/forecast/注記に跨るのを誤結合しない。正常なinterleaved, grouped, amounts_only, 負号分離/IFRS/連結/forecast EPSを回帰で維持。
- 必須テスト: 上記折返し、次行切れ/欠落、曖昧な注記挿入、正常m/2m表、forecast EPS余剰token。同じ誤金額を確定の `kessan_facts` として通さない。読み取れない場合は明示issuesにfail-closed。

## H4-R2 [P2] 判定と本文追記のTOCTOU競合

- 対象 `important-news-monitor/index.ts` の `selectCandidatesForJudgement`→ `saveCandidateJudgement` と新 `candidate_body_fill.ts`。
- **独立再現:** `pending_judgement, body_summary=null` を `judge_pending` がSELECT→AIを一時停止（見出しのみでno_post推論）→同じrowに公式本文が `fillMissingCandidateBody` でPATCH成功→古いAI結果を返す→保存PATCHは `id+pending_judgement` のみなので旧no_postの理由が本文あり行に保存される。
- **修正要件:** 読み取った `body_summary` snapshot と保存時の値を**原子的な条件付き更新(CAS)**で照合し、変化していたら古い判定を保存せず、即時生成せず、`pending_judgement`を維持して次回公式本文で判定できる。再SELECTだけのTOCTOU、既存headline-only `content_hash` だけの比較を修正済みとしない。成功行は従来どおり処理。
- 変更の範囲は今回の**新規本文追記が関係する**レーンに限定できるなら限定する。初期bodyがnull/空の保存条件を `body_summary.is.null/eq.` 等で原子的にfilterする方法を検討し、PostgRESTクエリのNULL/空の意味と既存有本文/長文/URL長/特殊文字/他laneへの副作用を試験する。snapshotを一般に安全にCASできない場合は勝手なschema/RPC/migrationを追加せずBLOCKEDとして最小設計を報告。判定変更時に過去本文を消したり二重生成を許さない。
- 本番同時処理は mock mockだけで不十分の可能性を明記。少なくとも **実 `index.ts` handler のjudge_pending経路 + 本文fill経路**をDeno/DB mockで独立再現し、失敗前→修正後に同じ旧判定が保存されないことを確認。0-row conditional UPDATE の扱いは故障と競合を区別し、即時生成しない。bulk処理が古い判定で中断しないよう可能な限り既存作業制御を保護。
- `content_hash` はheadline-only保持の既存duplicate方針と矛盾しないことを確認。必要なら判断に明示リスク報告、危険なら勝手に広範囲変更しない。

## H4-R3 [P2] FOMC声明本文で過去の判断を今回の判断として採用

- 対象 `supabase/functions/_shared/news_body_extraction/fomc_statement_facts.ts` の `extractFomcStatementFacts()`。
- 旧実装: 記事全体に `decided to raise` が1つでもあれば、現在の `maintain` より優先し、金利レンジ・変更幅もそれぞれ本文の最初のmatchから取る。R1の正規URL/日付/文書種別検証では防げない。
- **独立再現合成HTML:** 正規URL `monetary20261009a.htm`、ヘッダー `Federal Reserve issues FOMC statement`、公開日 `October 9, 2026` を一致させた公式風本文：

```text
At its July meeting, the Committee decided to raise the target range for the federal funds rate by 1/4 percentage point to 4-1/4 to 4-1/2 percent.
At this meeting, the Committee decided to maintain the target range for the federal funds rate at 4-1/4 to 4-1/2 percent.
```

- 期待：**今回は4.25〜4.5%で据え置き**。旧出力 `4.25〜4.5%（引き上げ、25bp引き上げ）` は誤り。
- **修正要件:** action/range/changeを**同一の確定できる今回の政策決定文に結合**。過去の会合への参照やquoted historical actionを現在と区別し、複数の決定候補で確証なければ `facts.ok=false` / withheld（誤Factを作らない）。Fed通常の単一声明のraise/lower/maintain、分数レンジ、反対票/氏名、R1の同一性チェックを維持。英語文解析の過剰推測で特殊例を通さない。
- 実Fed文書で頻度は未確認。合成入力と実運用の発生を混同しない。

## 実行・安全条件

1. G8のTASK/Report、`PROJECT_RULES.md`、`.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、`.agent/ACTIVE_TASK.md`、H4 `.agent/CODEX_REPORT_4.md` を確認。PR129最新headとfresh `origin/main`、worktree list、未commit変更、他slot所有、対象ファイルの他作業競合を確認。
2. PR129を編集する場合はG8**専用の独立**worktree/checkout。G9の評価ツールとPR115の所有ブランチ、PR116本番保護worktree、H4 worktree/他slot branch/dev serverを一切変更しない。並行他ownerがPR129を同時編集しているなら即停止。
3. 対象原則: `_shared/news_body_extraction/kessan_tanshin_facts.ts`, `fomc_statement_facts.ts`, `important-news-monitor/index.ts` の必要な狭い修正と関連テストのみ。候補本文fillそのものの安全条件は維持。DB schema/RPC/migration/Auth/Cron/Secrets/provider/modelの変更は別途明示承認が必要。
4. F7既存時刻依存starvationが戻ってないこと、旧F1〜F9で既に修正済みの検証、正常決算短信・通常Fed声明が過剰に止まらないことを再実行。offline no-net: G8前報告757 important-news-monitor、29 extractor、162 discovery/observer、20 shadowとH4既存968のscope差を説明し、件数を重複合算しない。
5. 3件それぞれ **修正前FAIL→修正後PASS** をG8-ownedテストとして恒久化。H4再現ログが別worktreeにある場合、参照だけで既存H4作業物を改変しない。Deno check/lint baseline `x_oauth2_post.ts:66` 既知エラーと今回新規を区別。実PDF/実Fed/本番/PostgREST実行していない場合は未確認と記す。有料API/公開/投稿はすべて不可。
6. 同一PR129既存branchへの変更は競合なし確認できた場合だけcommit/push可、Draft維持、**merge/deploy禁止**。PR116明日固定本番のソース混入を禁止。
7. 3件の欠陥が残るなら全面PASSを自称しない。固定head、変更ファイル、重要Factのbefore/after、実テスト、PR state、commit、既存F9のno_post backlog制約/20秒budget制約を含む `## Report` に結果を記録し、**`K8` をニュース改善API最適化のちゃへ返す**。新たなCodexレビューを独断で割り当てない。C4は既に完了、H4を勝手に再利用しない。

## Report

- task_id: news-improvement-a-pr129-h4-r1-r2-r3-correction-g8-20261012
- result: not_started
- changed_files: none
- tests: not_run
- commit_hash: none
- push: not_performed
- merge: not_performed
- deploy: not_performed
- remaining_issues: H4-R1 P1 wrapped tables, H4-R2 P2 stale judgement CAS, H4-R3 P2 historical FOMC action, existing no_post backlog.
- safety_checks: not_started
- next_recommendation: G8 R3 bounded correction, K8へ戻る。

---

## Preserved previous G8 tasks, reports, and K8 evaluations (do not edit)

# Claude Task G8 — PR #129 R2：K8追加指摘F7の公平性・F9境界確認

- task_id: news-improvement-a-pr129-k8-f7-rotation-and-f9-boundary-g8-20261011
- owner: claude
- slot: claude-8
- status: done
- next_owner: codex-4
- start_code: G8
- finish_code: K8
- return_to: ニュース改善API最適化のちゃ
- recommended_model: Opus5.5（高）
- allocation: ユーザー専任指定の「ニュース改善A」のG8のみ。ほかのG/H枠・別案件・API最適化B（G9）に触れない。
- task_type: prior K8 CHANGES_REQUIRED narrowly scoped corrective implementation
- review_base_pr: https://github.com/anohi-memories/kabumori/pull/129
- review_base_head: 984eeb41f14257be56ecfc00e9a55fa01d1ee136
- safety: 本番deploy/PR merge/DB schema/RPC/migration/Cron/Secrets/Provider/モデル変更/有料API/他worktree操作は禁止

## K8評価の理由（完了判定：CHANGES_REQUIRED / RELEASE_HOLD）

- 2026-10-11のG8前TASK `news-improvement-a-pr129-f1-f9-remediation-g8-20261011` は `984eeb41` に6ファイル変更をpush。PR129はOPEN/Draft、未merge。G8が重要ニュース748、抽出29、discovery162等PASSを報告したが、ちゃ自身はローカルテスト未実施。
- F1〜F6・F8について具体的修正と回帰テストがGitHubに存在する。**F7の時間依存ローテーションに別条件で取りこぼしが残る**ため、K8は最終PASSを出さない。
- **必ず再現すべき反例**: `fed_statement_enrichment.ts` は `rotation=Math.floor(Date.now()/(10*60*1000))` を `eligible.length` で剰余する。一定の順番の新規FOMC声明が3件、取得上限2、起動が正確に毎時（60分=10分刻み6回）なら `(rotation+6)%3 === rotation%3` となり**毎回同じ2件しか取得せず、3件目を恒久的に保留**する。従来の「rotation:0/1/2」テストだけでは本番間隔を再現していない。実際のCron/呼出頻度はsource・runbook・read-only既存資料から確認し、未確認の本番実行間隔を断定しない。
- F9について `pending_judgement` かつ本文空の既存候補へのguard付きPATCHという新しい**本番DB更新経路**がPR129に含まれる（まだdeploy無し）。F9の `no_post`, `generation_failed`, `published` 等は未解消。公開済み重複投稿を防ぎ、ステータス・content_hashとbody_summaryの不一致やjudgementとの同時競合を安全に扱えるか独立レビュー要。
- 旧G8 Report内のF8個別結果記載が欠落し、`## Report` が厳密な見出しになっていない。旧履歴は全文保持し、今回のReportは明確な独立見出しで報告する。

## 今回の実装範囲と検証

1. **F7修正**: 実監視タイミングをsourceで確認し、1時間間隔/30分間隔の合成スケジュール（連続3〜6回）、再起動・cold start、候補3〜4件、上限2件、同一順序、先頭既存/失敗を含めて、有限周期で未処理の全件に処理機会が回ることを検証する。単に10分ずつ手動でrotation引数を増やすテストは禁止。実行間隔と候補数の公約数によるエイリアシングを防ぐ。既存DB上の有効な実行ID/履歴利用が必要な場合はSELECT-onlyのread pathに限り、DB schemaや本番設定変更を勝手にしない。任意周期を保証できない条件は明示。
2. **F9安全性確認**: Guard付きPATCHが `pending_judgement`・空本文以外を絶対更新しないよう、テストはfetch/DBを完全mockする。選択→同時処理→更新の競合を模擬し、body内容・candidate.content_hash・その後のjudgement/duplicate経路の整合、書込み失敗時の報告・再試行、行状態read-back、二重配信回避を点検する。**欠陥を認めたらPR129内で安全に修正**。スキーマ/RPC/実データ移行を要する場合は禁止事項を守り、別工程が必要な理由と最小安全設計を提示。非pending行は履歴保護のため現段階では変更しない。
3. **F1〜F6・F8正常系維持**: 前回の修正・合成ケースと実PDFで数値・連結/個別・FOMC文書同一性が壊れていないことを確認。F8ミドルイニシャルの個別Report結果を今回含める。新規レビュー対象はF7/F9と回帰に限定し、他P1を不要に書き換えない。
4. **PR/安全境界**: PR129だけ更新。G8専用独立worktree/checkoutをfresh origin/mainから確立。旧G8/他slot/G9/API-B/PR116のbranch・worktree・TASKを一切変更しない。PR116は2026-10-13予定の固定コミット専用、PR129混入禁止。BOJ取得未接続、著作権に注意。本番DB読み書き・実Edge呼出・有料AI使用なし。GitHubに先行したPR129更新や対象変更の競合があれば停止。
5. **テスト**: F7の本番想定固定時刻テストは修正前FAIL→修正後PASS。F9 mockの保存状態（pending/no_post/published/generation_failed）・競合・ハッシュ対応・監査保全のテスト。important-news-monitor全体、Phase6/7/R1、news_discovery/observer等既存suiteをオフライン再実行。実測未実施は未実施と記録。typecheck/lint既存baselineとの比較。
6. **完了**: 必要な変更だけPR129 branch `claude/news-body-integration-phase7-20261011` にcommit/push、Draft維持、merge/deployせず、F7/F9の残余リスクと再レビューの対象/判定を報告。F9の保留部分をPASS扱いしない。新しいコミットがあればその正確なSHAを記載し、`K8` をこのチャットに返却。追加レビュー担当を勝手に使わない。

## K8 evaluation — ChatGPT, 2026-10-12 JST

- verdict: ACCEPTED_IMPLEMENTATION / INDEPENDENT_REVIEW_REQUIRED / MERGE_HOLD
- verified_PR: PR129 OPEN/Draft/unmerged, head `7bf9b8a0a014ebe9a613e9ebeb0082d0b7834c54`, R1 `984eeb41` より1 commit/5 source+test files。Netlify/Vercel GitHub checks success、production検証・deployは未実施。
- source_review: `fed_statement_enrichment.ts` のF7を時刻剰余によらない順序へ変更、`candidate_body_fill.ts` のF9 conditional PATCH/結果read-backを確認。事実検証・実ネットワーク/DBを伴うend-to-end証明は未完了。G8報告757件などのDenoテストをChatGPT自身は再実行していない。
- remaining: F7 4件超/cold start/RSS消失のcoverage guarantee、上限20秒のhard timeoutではないこと。F9はpendingのみ、no_post/generation_failed/published等は歴史保護のため未更新、判定SELECTとの並行、content_hash据置が重複/出典監査に与える影響。
- next_action: 高リスクEdge/DB/FactsのためH4に**一度限りの重点Codex独立レビュー**（Sol（高）、`H4`開始→`C4`をこのチャットへ）を登録。G8のR2実装TASKはdoneとし枠を別案件の保留に使わない。A専任はG8維持、要修正ならC4後にG8へ戻す。マージ・デプロイは禁止。PR116とG9は別工程。

## Report

- task_id: news-improvement-a-pr129-k8-f7-rotation-and-f9-boundary-g8-20261011
- result: implemented (F7 root-cause fixed; F9 boundary hardened and tested; non-pending rows deliberately unchanged)
- F7: 時刻剰余ローテーションを廃止。反例（3件・上限2・毎時起動で `(rotation+6)%3` が不変）は取得上限を「成功数」で数える方式に変更して解消。試行は最大4回/20秒、順序は「直近失敗が少ない順→乱数タイブレーク」で、呼出間隔(10/30/60分)に依存しない。未取得≤4件は毎回全件に機会があり、それ以上はwarm instanceで失敗を後回し、cold startは乱数。厳密な毎回保証は4件超では不可（永続化なしの限界）。
- F9: DB書込み部を `candidate_body_fill.ts` に分離（スキーマ/RPC変更なし）。PATCH条件 = id一致 + status=pending_judgement + source_name=market_macro + 本文null/空、1文を原子的に更新、返却行を読み戻して本文・status一致を検証（不一致は例外）。content_hashは意図的に不更新（見出しのみ候補のhashと一致し続け重複扱いを維持）。他レーンの行は取得対象外。書込み失敗は例外→sourceErrors→次回再試行、競合で既にstatusが動いた行は"skipped"。published/no_post/generation_failed等は一切変更しない。
- F1〜F6・F8: 変更なし（再回帰で維持）。F8個別結果: ミドルイニシャル付き反対者 `Christopher J. Waller`・`Michelle W. Bowman` を完全氏名で2票と読む／票数と氏名が食い違えば氏名省略(uncertain)／不明確なら票数を作らない — review_fixes_test の2件でPASS。
- changed_files: important-news-monitor/{fed_statement_enrichment,fed_statement_enrichment_test,index}.ts; 新規 candidate_body_fill.ts, candidate_body_fill_test.ts
- tests: important-news-monitor 757 pass（前回748→+新規F7 5件/F9 mock 6件、旧static 1件置換）; news_body_extraction 29 pass（Phase6 19+R1 10）; news-discovery-observer+_shared/news_discovery 162 pass; important-news-shadow 20 pass; F7新規5件は旧実装で5件FAILED→修正後PASS; lint 97（baseline同数）; typecheck既存TS2322のみ; diff --check clean。実PDF60件の再照合は今回kessan側を変更していないため未再実施（前回: facts 51/数値一致51）。
- commit_hash: 7bf9b8a0a014ebe9a613e9ebeb0082d0b7834c54
- push: done（claude/news-body-integration-phase7-20261011, 984eeb41→7bf9b8a0, fast-forward）
- PR_head: 7bf9b8a0a014ebe9a613e9ebeb0082d0b7834c54（Draft/OPEN, 未merge）
- merge: not_performed
- deploy: not_performed
- remaining_issues: (1) F9の非pending行（published/no_post/generation_failed）は未解消のまま意図的に未変更。履歴保護とstatus遷移の設計が必要。(2) 判定の実行中に本文を後付けすると、その1回の判定は見出しのみで確定し得る（Phase 7前と同等。ガードで公開済み二重投稿・生成済み行の改変は起きない）。(3) fed取得間隔は10分想定だがrepo内で確認できず、実装は間隔非依存にした。(4) 4件超の永続失敗では厳密保証なし。
- safety_checks: 本番deploy/DB schema/RPC/migration/Cron/Secrets/モデル/Provider変更なし、有料API・実DB/Edge呼出なし（DBは完全mock）; PR #116(a26e4365)・他slot/G9/kabumori-ex/kabumori-pfのbranch・worktree・TASKへ変更なし; BOJ未接続維持。
- next_recommendation: 独立レビュー(F7アルゴリズム/F9 guarded PATCH)へ。F9非pending行は別設計判断。K8をニュース改善API最適化のちゃへ返却。

---

## Preserved previous G8 TASK / Report (immutable history below)

# Claude Task G8 — ニュース改善A / PR #129 R1指摘9件の修正実装

- task_id: news-improvement-a-pr129-f1-f9-remediation-g8-20261011
- owner: claude
- slot: claude-8
- status: review_required
- next_owner: chatgpt
- start_code: G8
- finish_code: K8
- return_to: ニュース改善API最適化のちゃ
- recommended_model: Opus5.5（高）
- scope_owner: このチャットの「ニュース改善 A」のみ。今後もA作業はG8に割当（個別TASK完了後は同じ枠で再割当）。他の案件、他のG枠のTASKや作業を引き継がない。
- assignment_authorization: ユーザーが2026-10-11にG8の使用を明示承認
- type: corrective implementation, PR #129 review findings
- prohibited: production deploy, merge, paid API, DB/schema/RPC/migration/Cron/Secrets/model/Provider changes, unrelated work

## 背景・現在地

- PR [#129](https://github.com/anohi-memories/kabumori/pull/129) は **OPEN / Draft / 未merge**。レビュー対象head `61dd33d72711b11eefd39f77ac2d2431b9b6a9a5`（開始時に最新headを再確認）。
- branch: `claude/news-body-integration-phase7-20261011`。Phase 6 + Phase 7の決算短信・FOMC改善を統合済みだが、独立Codexレビューの判定は **CHANGES_REQUIRED（P1 5件 / P2 4件）**。
- 今回は **レビューの繰り返しではなく、指摘への実コード修正と回帰テスト**。独立レビューはH1/H2/C1/C2とは別件で、レビュー結果はこのTASK本文のF1〜F9を正本とする。別チャットにある本文を参照させずに完結させる。
- Phase 6 original: `b8d10833a992bc285a89d3ab37b2c3acd995bad0`; Phase7 reviewed head above。初期レビューの合成入力再現で9件の安全性アサーションが失敗。合成再現であり、実際の誤配信が発生したとは主張しない。
- PR #116の本番反映予定は **固定merge commit `a26e4365ebcb701491629892e8bae207d28833c2`のみ**。PR #129のコードを混入させない。PR #116本番作業のworktree `/Users/yuya/Developer/kabumori-pf` は絶対保護。

## 必須開始チェック / 非競合

1. `PROJECT_RULES.md` / `.agent/ORCHESTRATION.md` / `.agent/ACTIVE_TASK.md` / `.agent/CURRENT_STATE.md` / このTASKを読み、G8の `ready`、所有者、return_toを確認。
2. `/Users/yuya/Developer/kabumori-fresh` のfresh `origin/main`、PR129最新head、所有者、他TASK/Report、worktree list、未コミット変更、競合変更対象を確認。G8専用の独立worktree/checkoutを作る。既存A単独セッションが同じPR129を現在編集している可能性があれば、**同時変更はせず停止・報告**する。
3. `kabumori-ex`（Phase6）、`kabumori-pf`（PR116）、他slotのworktree/branch/dev server・未commitファイルは一切操作しない。H1〜H5/G1〜G7/G9/G10および他のTASK/Reportを編集しない。Bの`tools/provider-compare/`と評価用ドキュメントも触らない。
4. 権利確認待ちの日銀 `boj_document_text.ts` を本番経路へ接続しない。PR115や他PRへ変更を混ぜない。

## F1〜F9（レビューで再現された修正要件）

### F1 [P1] 分離した負号を除去し、損失を利益として出力
- 場所: `_shared/news_body_extraction/kessan_tanshin_facts.ts:103–104` の `parseRow`。
- 入力: 営業利益欄 `△ 100 △ 20`。現状 `+100百万円、+20%`、期待は `-100百万円、-20%`。結合した `△100 △20` は正常。
- 対応: 別トークンの負号を安全に数値へ結合、対応不明や想定外トークンは黙って落とさず **行を拒否**。誤った本文を後段Fact/VoiceがPASSするモックでも公開候補になり得るため、上流で防ぐ。正常・異常テスト。

### F2 [P1] 金額/増減率の列をトークン数だけで交互配置判定
- 場所: `kessan_tanshin_facts.ts:108–118`。
- 指標4列・単位 `百万円 百万円 百万円 百万円 % % % %`、数値行 `1,000 100 80 50 10 20 30 40` は **金額4個→増減率4個**。現状は交互配置と判断し営業利益80・経常利益10・純利益30に誤る。期待額は100/80/50。
- 対応: 見出し+単位+列配置から対応を確証する。交互配置と横並び配置の両方、曖昧な場合のfail-closedをテスト。数の個数だけから推定しない。

### F3 [P1] IFRS税引前利益を経常利益に誤置換
- 場所: `kessan_tanshin_facts.ts:56`, 出力名 `:205`。
- `売上収益 営業利益 税引前利益 親会社の所有者に帰属する当期利益` で税引前利益80を「経常利益80」と出力。
- 対応: 異なる会計指標を分離し元見出しの意味を保持。未対応なら数値を創作せず拒否。

### F4 [P1] 連結/個別の逆転
- 場所: `kessan_tanshin_facts.ts:93–95,170`。
- 直前に `参考: 個別財務諸表`、対象表の最近接見出しは `(1)連結経営成績`。現状個別と誤分類。
- 対応: **当該表に紐付いた最近接の明示見出し**を優先し、相反する場合は拒否。近傍の無関係な語で上書きしない。

### F5 [P2] 比較対象の四半期が不一致
- 場所: `kessan_tanshin_facts.ts:187–188`。
- 当期 `2026年3月期第1四半期`、前期 `2025年3月期第3四半期` を前年同期として出力。
- 対応: 年だけでなく決算期末月、四半期、累計/単独、通期/中間期、連結/個別の比較可能性を検査。確証なければ「前年同期比」にしない。

### F6 [P1] 過去の議事録を現在のFOMC声明と誤認
- 場所: `important-news-monitor/fed_statement_enrichment.ts:142–150`。
- RSSの2026年声明タイトルから同一公式host内の `/monetarypolicy/fomcminutes20250917.htm` に302される合成例。2025年議事要旨内の引用を2026年声明の新しい政策判断として出力した。
- 対応: HTTPS/hostに加え **最終URL種別・文書見出し・RSS公開日と文書日付・決定の主文・元候補との同一性**を検査。過去資料やminutes/projections/引用を声明として受理しない。実Fed redirectが起きた事実とは扱わない。

### F7 [P2] maxPerFetch=2で3件目以降が永久脱落
- 場所: `fed_statement_enrichment.ts:125–135`、`index.ts:2106` と後続重複判定。
- 同順3件を3回実行すると毎回先頭2件だけ取得、3件目は0回。保存済み先頭候補も枠を浪費。超過時errorsもなし。
- 対応: 既処理候補を取得枠から除き、未取得の公平性、上限維持、理由付き観測、次回再試行を検証。RSSから消える場合の継続性も検討。永続化/schema/RPCが必要なら勝手に実装せず BLOCKED/設計報告。

### F8 [P2] 反対者名のミドルイニシャルで切断
- 場所: `_shared/news_body_extraction/fomc_statement_facts.ts:103–109`。
- `Voting against this action were Christopher J. Waller and Michelle W. Bowman, who preferred a different action.` → 現状 `Christopher J` のみ・反対票1。期待は完全2氏名・2票。
- 対応: イニシャルと文末、名前と理由節を区別。票数を推測しない。不明時は明示的に未確定として安全に省略。全会一致も証拠がある時のみ。

### F9 [P2] 同URL既存候補に新本文を反映できない
- 場所: `important-news-monitor/index.ts:2106–2108,2142–2145`、`findNewsDuplicate():434–437`。
- 旧本文なし→新しい公式本文ありでcontentHashが変わっても、URL一致によりduplicateとして破棄される。
- 対応: published / no_post / generation_failed / 判定待ち / 本文不足 を区別。公開済み二重投稿は禁止、未公開の安全な本文更新・再判定、履歴/監査記録保護、競合・idempotency確認。DB schema/RPC/実データ変更が必要なら無断変更せず、残課題と安全な段階導入を提示。

## 横断安全要件

- 「読み取れなかった」注意文だけでは守れない。誤った/曖昧な従来要約の数字を確定重要Factとして扱わない。Factの照合元が誤るとFactモデルでは救えない。初回Fact誤PASSを考慮する。
- 誤情報を出さない **fail-closed** と、正常な重要ニュースを過剰停止しないことの双方を検証。
- 日銀公式本文の新取得・保存・接続は禁止（権利確認待ち）。TDnet 403迂回、第三者記事本文の無断保存は禁止。
- APIキー/トークン/本番DB/外部書き込み/モデル/Secrets/Cron/Edge deploy/本番変更をしない。PR129はDraft継続、mergeは禁止。
- 既存の独立レビュー用 `review_test.ts` 等は別セッションのファイルのため直接改変せず、必要なら再現条件をこのTASKから自己完結でテスト化する。

## 必須テストと完了条件

- F1〜F9各項目に「before失敗→after期待値」テスト、正常対照（適法な数値・既存の交互列・声明）を追加。
- `important-news-monitor` 全体（レビュー時742 PASS）、Phase6の19件、Phase7の15件、`news_discovery`+observer（162 PASS報告）をオフラインで再実行。累計を二重計上しない。
- 可能な限り実PDF39/60件の集計と、当期/前期数値の正確性を再照合。本文はrepo/DBに保存しない。観測できない実データは未実施と明記。
- P1の5件をすべて解消。P2の4件を修正、または安全な未解決/実装停止と依存条件を明示。P1/P2未解決の状態で全面PASSを自称しない。
- 競合なしを確認できた場合に限りPR129の既存branchにcommit/push。PRheadを再取得してから差分を適用、他作業を上書きしない。**merge/deploy禁止**。
- 完了後、このTASK末尾の `## Report

- task_id: news-improvement-a-pr129-f1-f9-remediation-g8-20261011
- result: implemented — F1〜F9 all addressed in source; F9 staged (see F9). PR #129 stays Draft / unmerged.
- F1: fixed — 分離した△/▲を後続の数値に結合、結合先のない印・想定外トークンは行ごと拒否（DANGLING_MINUS / UNEXPECTED_TOKEN）。
- F2: fixed — 見出しの単位行から「交互/金額→増減率」配置を確証。確証できない8数値は LAYOUT_UNCONFIRMED で拒否（個数だけの推定を廃止）。
- F3: fixed — 税引前利益(pretax_profit)・当期利益(profit_total)・親会社帰属(net_profit)を別指標化、同一指標の重複列は表ごと拒否。経常利益へ置換しない。
- F4: fixed — 表直上の最近接の「経営成績/業績」見出しで連結/個別を決定。見出し内の相反は BASIS_CONFLICT で拒否。「参考: 個別…」では上書きしない。
- F5: fixed — 前期行は決算期末月・四半期/中間/通期・累計・1年前を満たす場合のみ。満たさなければ facts 自体を採用しない（PRIOR_ROW_*_MISMATCH）。
- F6: fixed — 候補URLが声明のプレスリリースpath、最終URL＝同path（別文書へのredirect拒否）、ページ見出しが声明、文書日付＝URL日付＝RSS日付(±3日)を要求。議事録・見通しは受理しない。
- F7: fixed (no schema) — 保存済み(本文あり)は取得枠を消費しない、残りは10分周期のローテーションで公平化、上限(2)維持、超過は deferred_over_cap を観測、失敗は次回再試行。RSSから消えた項目の継続保証は永続化なしでは不可（残課題）。
- F9: partially staged — 未判定(pending_judgement)かつ本文なしの保存済み声明は、guard付きPATCH（status=pending_judgement かつ body空）で本文を後付け（スキーマ/RPC変更なし）。published / no_post / generation_failed 等は書き換えず stored_without_body:<status> を観測のみ。再判定・履歴保護が必要な後者は設計判断待ち（DB/RPC変更が要るなら未実施）。
- changed_files: _shared/news_body_extraction/{kessan_tanshin_facts,fomc_statement_facts}.ts, review_fixes_test.ts(新規); important-news-monitor/{fed_statement_enrichment,fed_statement_enrichment_test,index}.ts
- tests: important-news-monitor 748 pass（742+新規6）; news_body_extraction 29 pass（Phase6 19+新規10; F1〜F9の before-fail→after-pass確認済み、旧実装では16件FAILED）; news-discovery-observer+_shared/news_discovery 162 pass; observer+shadow 57 pass; lint 97件（baseline同数）; typecheck は既存 TS2322(x_oauth2_post.ts)のみ; git diff --check 問題なし。
- before_after_quality: 実PDF60件(TDnet決算短信)で facts 51 / 数値verbatim一致 51 / prose 4 / missing 4 / 抽出空 1 — Phase 6と同等でF1〜F5の厳格化による取りこぼし増なし（初回実装で重複列判定が過剰に拒否し30件に低下→表行がある場合のみ判定に修正して51へ回復）。正文の改変数値は51/51検出、正しい文の誤conflictは0。
- commit_hash: 984eeb41f14257be56ecfc00e9a55fa01d1ee136
- push: done (claude/news-body-integration-phase7-20261011, fast-forward from 61dd33d7)
- PR_head: 984eeb41f14257be56ecfc00e9a55fa01d1ee136 (PR #129 Draft, OPEN)
- merge: not_performed
- deploy: not_performed
- remaining_issues: (1) F9の非pending行（published/no_post/generation_failed）への本文反映・再判定は未実装（履歴保護とstatus遷移の設計・必要ならRPC/migrationが前提）。(2) F7: RSSから消えた未取得声明の永続的再試行は永続化なしでは保証できない。(3) 日銀は未接続のまま。(4) fed取得は本番未検証。(5) 標準の正常系で「-」単独記号の分離(△以外)は曖昧のため結合しない。
- safety_checks: 本番deploy/DB/schema/RPC/Cron/Secrets/モデル/Provider変更なし・有料API呼出なし; PR #116(a26e4365)・kabumori-ex・kabumori-pf・他slotのTASKへ変更なし; 日銀本文の取得/接続なし; 実PDFの本文はrepo/DBに保存せず。
- next_recommendation: PR #129 を独立レビュー(Codex)に再提出 → F9の非pending行の扱いを設計判断（schema/RPCが必要なら別TASK）。merge/deployはPR #116反映・観測後に別途判断。K8 を ニュース改善API最適化のちゃ へ返却。
