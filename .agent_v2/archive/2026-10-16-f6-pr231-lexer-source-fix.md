# F6 — PR222 import境界パーサ修正（R1b P2・R1c P3）
- task_id: common-ai-f6-pr222-import-lexer-r1b-r1c-fix-20261016
- slot: F6
- owner: claude
- status: done
- next_owner: none
- start_code: F6
- completion_code: L6
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- recommended_model: **Opus5.5（高）**
- production_mutation_window: CLOSED
- previous_archive: .agent_v2/archive/2026-10-16-f6-pr222-source-fix.md
- review_source: .agent_v2/reports/J1.md (PR222 J1 V1 CHANGES_REQUIRED P2 R1b + P3 R1c)
- dependencies: protected Draft PR #187→#198→#205→#219→#222; PR216 separate documentation.

## 目的
PR222のJ1独立レビューで指摘されたimport検査の二件のみ修正。R1b P2: 文字列内 `"import/*"` と `"*/('./types.ts')"` を本物のコメントと誤認し、その間の危険な動的importを見落とす。R1c P3: 複数の合法なコメントが付いた名前付きimportを副作用importとして誤判定する。**追加の正規表現で一時しのぎせず、正しい字句/構文トークン境界を使用する。** A1のAPI費用計上は前回J1でPASS、変更禁止。

## 開始前ゲート
fresh origin/main、PROJECT_RULESと新旧ORCHESTRATION、ACTIVE_TASK/CURRENT_STATE関連メタデータ、F6/J1および旧G6/H5と新F3/F4/F5等のowner/PR/changed-path、PR222の正確なHEAD `11835df1b99f4f3f23006af7f1a27ea6ae51f0e4` とbase/祖先、clean独立worktree、重複task_id・変更競合をチェック。変化・競合・未コミット変更があれば停止報告。他slot checkout/reset/rebase禁止。

## R1b P2修正
J1 ReportのR1bフルガード再現（文字列片に囲まれた実 `import("../ai_provider/mod.ts")`）を修正前で再現し、修正後は必ず拒否。文字列リテラル、テンプレートリテラル、正規表現、行/ブロックコメントを字句解析で分け、import/export、side-effect、named、type-only、dynamic、re-exportの実モジュールedgeのみ確実に抽出。解析が曖昧ならfail-closed、未知edge/alias/symlink等の既存制限を弱めない。CIの静的テストであり実行時sandboxではないことは明記。

## R1c P3修正
`import/**/{ findModelSpec as same }/* ordinary */from/**/"../ai_provider/mod.ts";` を含む正当なnamed/type-only importsが誤検出されないこと。block commentは最初の終端で閉じる。危険な動的namespace importは拒否、合法な読み込みは受け入れる。許可listを拡大しない。

## 検証
修正前FAIL→修正後PASSの実コードguard反例、R1b文字列片、コメント付きnamed、テンプレート/正規表現にimport風文字、computed、escaped、transitive、symlink/unreadable、import-mapの変異テスト。provider/H5 bridge/market-reportのoffline typed regression; 504/timeout/connection lossの一度だけ送信、A1 unknown/upper_boundと予算上限、既存OpenAI経路を守る。full sharedの既知5型エラーと権限停止1件はBASELINE/NOT_VERIFIEDを維持し、無断再実行しない。deny-net、fake keys、no paid API。

## 変更範囲・禁止
F6所有 `supabase/functions/_shared/ai_provider/**` のimport検査と関連テスト、`docs/ai-provider/F6_*` のみ＋自身TASK/ACTIVE metadata。H5・F3/F4/F5・旧G6・G1・J1のファイル、費用分類/adapter/台帳/DB/RPC/migration、別slot worktreeは変更不可。無断merge/deploy、production接続、secret、SNS投稿禁止。

## 完了
独立再現テスト、changed_files、テスト結果、合否、PR差分・head/base・実push/readback・作業競合・NOT_VERIFIED・残リスク、production NO_GOをReportへ記録。status review_required / next_owner chatgptに更新、L6で返却。必要時のみJ1限定再レビューに出す。

## Report
- task_id: common-ai-f6-pr222-import-lexer-r1b-r1c-fix-20261016
- result: **FIXED_SOURCE_ONLY（R1b と R1c を直した。Draft PR #231、#222 の上に積む）**
  - import の検査を、正規表現で生の文字列を読む方法から、ECMAScript / TypeScript の字句解析でトークンに分けて文法どおりに読む方法に変えた
  - R1b: 文字列 `"import/*"` と `"*/('./types.ts')"` のあいだの本物の `import("../ai_provider/mod.ts")` を見つけて止める
  - R1c: `import/**/{ findModelSpec as same }/* ordinary */from/**/"../ai_provider/mod.ts";` などの正しい読み込みを通す
  - 許可リストは広げていない。A1（費用）、adapter、台帳、DB / RPC / migration には触れていない
  - 本番・Secret・Edge・Cron・設定の変更は 0。有料の呼び出しも 0
- branch / commit / PR
  - `claude/f6-pr222-import-lexer-20261016`（新しい独立した worktree `/Users/yuya/Developer/kabumori-f6-import-lexer`、#222 の head `11835df1` から作成）
  - commit `2a696aff24be01538bd0d9c5a1eb0afa07421483`（push 済み、`git ls-remote` で同じ値を確認）
  - Draft PR [#231](https://github.com/anohi-memories/kabumori/pull/231)。読み返し: OPEN / Draft、base `claude/f6-j1-r1a-a1-fix-20261016`（#222、head `11835df1b99f4f3f23006af7f1a27ea6ae51f0e4` のまま）、head `2a696aff24be01538bd0d9c5a1eb0afa07421483`、3 ファイル、MERGEABLE
  - #222 は J1 がレビューした状態のまま変えていない。順番は #187 → #198 → #205 → #219 → #222 → #231
- changed_files（3）
  - `supabase/functions/_shared/ai_provider/isolation_test.ts`（字句解析 `lexModule`、構文 `moduleEdges` / `parseClause`、念のための文字の読み取り `textEdges`、テスト）
  - `docs/ai-provider/F6_J1_R1B_R1C_LEXER.md`（新規）、`docs/ai-provider/F6_J1_R1A_A1_FIX.md`（生の文字列を読む方針の行に、今回の変更を書き足した）
- 直し方
  - 字句解析: 空白・改行・コメントは区切り（ブロックコメントは最初の `*/` で終わる）。文字列・テンプレート（`${}` の中はコード）・正規表現・数は 1 つのトークンで、中身をコードとして読まない
  - 構文: トークンから `import ... from`、`import "x"`、`import()`、`export * / { } from`（`type` つき、文字列の名前も）を文法どおりに読む。`import.meta`、`x.import`、`{ import: 1 }`、from の無い `export { a }` は読み込みにしない
  - 止めるもの（fail closed）: 閉じない文字列・テンプレート・正規表現・コメント、括弧の崩れ、知らない文字、エスケープした `import` / `export`、文法に合わない句、`import x = require(...)` で provider を読む形、計算した `import()`
  - 推測は `/` が正規表現か割り算かだけ（TypeScript の `x!` も考慮）。推測を外した場合に備えて、コメントとリテラルの中身を前の正規表現の方法で別に読む（足すだけで減らさない）
- R1b / R1c 直す前 / 直した後（本物のファイルに同じ細工。直す前 = #222 `11835df1`。F6 の検査と H5 の検査を両方流す。#222 では計 15 件、直した後は 16 件）
  - 直す前は 15 件すべて通る（見逃す）→ 直した後は止める（3 種類）
    - B1: J1 の R1b の再現そのもの（bridge に `"import/*"`、本物の `import("../ai_provider/mod.ts")`、`"*/('./types.ts')"`）
    - B2: テンプレートの断片で同じこと
    - B4: 新しい Edge のファイルで、断片のあいだに計算した `import()`
  - B3（`'...'` の断片と静的な読み込み）は、直す前も後も止める
  - 直す前は誤って止める → 直した後は通る（2 種類）
    - C1: J1 の R1c の再現そのもの
    - C2: コメントだらけの型だけの読み込み（許可された名前）
  - 以前の細工（R1a の再現、素の `import()`、別名の `executeAiRequest`、新しい Edge が bridge を使う、private な台帳ファイル）は、直す前も後も止める。コメントつきの普通の読み込みは前後とも通る
  - 最初の比較（直す前の状態どうし）でも B1 / B2 / B4 は 15 件すべて通り、C1 / C2 は止まることを確かめた。最終の commit でもう一度比べて同じ結果
- テストの中の合成の木（`J1 R1b / R1c:` のテスト）
  - R1b の再現そのもの（直接の参照と届く先は変わらず、名前の決まりで止める）。テンプレート、`'...'`、`${}` つきテンプレート、正規表現、行のコメントの断片
  - R1c の再現そのもの。ほかに、コメントだらけの型だけ、`/* ** / */`、行のコメントつき複数行、`export type { } from` を通す
  - ブロックコメントは最初の `*/` で終わり、その後ろの `{ executeAiRequest }` は止める
  - 文法の確認（`import type from`、`{ type }`、`{ type as kind }`、`def, * as all`、`export * as`、from の無い export、`import` / `export` という名前のプロパティ、`import.meta`）
  - 読めない形（エスケープした `import`、`import defer`、`{ a b }`、bridge の `import x = require(provider)`）と、壊れた入力 6 種類を止める
  - `x! / b`、ブロックの後の正規表現、推測を外す形（`function () {} / 2`）のどれでも、本物の import を止める
  - テンプレート・正規表現・文字列の中の import 風の文字は止める側に倒れる。存在するファイルを指す説明は通る
  - 計算した読み込み、エスケープ、中継、シンボリックリンク、読めないファイル、import map の既存テストは、字句解析でもそのまま通る
- tests（Deno 2.9.6、`--deny-net`、偽の鍵、本物の鍵の環境変数を外した子プロセス）
  - 共通AI基盤 `_shared/ai_provider/`: **145 PASS / 0 FAIL**（型の確認つき。#222 は 144。504 / 時間切れ / 切断の 1 回だけの送信、A1 の `unknown` / `upper_bound` と上限、OpenAI の経路、切り替え無しのテストを含む）
  - H5 bridge `offline_run.sh`: **27 PASS / 0 FAIL**
  - 市況レポート `market-report-analysis/`: **324 PASS / 0 FAIL**（型の確認つき）
  - main（`33403802`）と合わせた木（merge-tree 衝突なし）: 共通AI基盤＋市況レポート **506 PASS / 0 FAIL**
  - 関数フォルダの全 509 ファイル（テストを含む）を字句解析で読めた（エラー 0）。途中で TypeScript の `price.close! / averagePrice`（`personalized-reports/report_logic.ts`）を正規表現と取り違えたので、`x!` の後は割り算として直した
  - わざと壊す確認 11 種類（コメントを最後の `*/` で閉じる、リテラルとコメントの中身を読まない、読めないファイルを止めない、`import()` を飛ばす、`import()` を名前つき扱い、`type` を理解しない、読めない句を飛ばす、エスケープした keyword を黙って通す、`x!` の後を正規表現にする、文字列を解読しない、括弧の崩れを許す）: **すべて検知**。1 回目は「エスケープした keyword」の改変が残った。テストのエスケープ `\u0069mport` が作業の途中で普通の `import` に変わっていたためで、本当にエスケープを含む形に直して検知を確かめた
  - lint（`--no-config`）0 件、`git diff --check` OK、秘密情報の文字列 0
  - `_shared` 全体の既知の型エラー 5 件と、権限で止まる 1 件（`brand/ai_lab_event_dedupe_test.ts`）は、TASK の指示どおり**再実行していない（BASELINE / NOT_VERIFIED のまま。PASS 扱いしない）**。どちらのファイルも今回変えていない
- collision checks
  - #187 `a7e1d3f3`、#198 `4223d5c0`、#205 `4cd2cbdd`、#216 `1dc7b72e`、#219 `be35cc93`、#222 `11835df1` は変わっていない（Draft のまま）
  - main（`33403802`）と merge-tree で衝突なし
  - `_shared/ai_provider/` に触れる開いた PR は F6 自身の stack と古い G6 の #148 / #150 / #157 / #162 だけ（他の slot とは重ならない）
  - J1 の archive・Report・TASK、H5 / F2 / F3 / F4 / F5 / G1 / 旧 G6 の TASK・PR・worktree・コードには触れていない
- remaining_risk / NOT_VERIFIED
  - CI で動く静的な検査で、実行時の囲い（sandbox）ではない。`eval` / `new Function` / `Worker` の文字列、functions の外の設定、本番の deploy の設定は見ない
  - 字句解析は完全な TypeScript の構文解析ではない。`/` の推測を外す書き方はありうるが、その場合も文字の部分の読み取りで見つける（止める側に倒れる）か、ファイル全体が読めずに止まる
  - 説明の文字列やコメントに import 風の文字があると止まる（運用上の制限。今は該当なし）
  - `_shared` 全体の型エラー 5 件・権限で止まる 1 件、本物の provider、本番の台帳と動きは NOT_VERIFIED
- source_only: yes。merge 0、deploy 0、paid_calls 0、production の変更 0、Secret の値・`.env` は読んでいない
- production: **NO_GO のまま**
- next_recommendation
  - L6 で評価し、必要なら #231 の差分だけを J1 に限定再レビューしてもらう
  - マージの判断は #187 → #198 → #205 → #219 → #222 → #231 の順で別に

## L6 判定（2026-10-16）
- verdict: PASS_SOURCE_FIX / TARGETED_SECURITY_RECHECK_REQUIRED / MERGE_HOLD / PRODUCTION_NO_GO
- target: Draft PR #231 HEAD 2a696aff24be01538bd0d9c5a1eb0afa07421483, base PR #222, 3 files.
- reported: provider145/bridge27/market324/merged506 PASS; 509 source files lexed; 11 mutation tests detected changes. Independent tests NOT_RUN by ChatGPT; 5 pre-existing type errors and 1 permission-blocked test NOT_VERIFIED.
- next: J1 focused independent verification of former P2 R1b and P3 R1c; A1 accounting already accepted, no repeat review. No merge/deploy/live calls/production authorization.
