# Claude Task G8 — PR #129 R2：K8追加指摘F7の公平性・F9境界確認

- task_id: news-improvement-a-pr129-k8-f7-rotation-and-f9-boundary-g8-20261011
- owner: claude
- slot: claude-8
- status: ready
- next_owner: claude
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

## Report

- task_id: news-improvement-a-pr129-k8-f7-rotation-and-f9-boundary-g8-20261011
- result: not_started
- changed_files: none
- tests: not_run
- commit_hash: none
- push: not_performed
- merge: not_performed
- deploy: not_performed
- remaining_issues: F7時刻剰余エイリアシング、F9 guarded PATCHの正当性と既存非pending行の方針
- safety_checks: not_started
- next_recommendation: G8で開始し、追加限定修正・テスト完了後K8を返す。

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
