# Codex Report 4

Codex slot 4（H4）の完了報告専用ファイルです（2026-10-11追加）。H4 TASK `.agent/tasks/CODEX_TASK_4.md` の報告をここへ記録します。新しい報告は先頭へ追加し、過去の報告は削除・改変しません。未実施項目も省略せず記録します。

## H4 PR #129 独立レビュー — 2026-10-12 JST

- task_id: news-improvement-a-pr129-phase7-r2-final-focused-review-h4-20261012
- result: **CHANGES_REQUIRED**（P1×1 / P2×2、下記3件）
- status: review_required
- next_owner: chatgpt
- reviewed_head: `7bf9b8a0a014ebe9a613e9ebeb0082d0b7834c54`
- previous_review_head: `61dd33d72711b11eefd39f77ac2d2431b9b6a9a5`
- R1_head: `984eeb41f14257be56ecfc00e9a55fa01d1ee136`
- main_baseline: `35e4d623d5e50f5eeefe0553e40725190e185928`
- review_pr: https://github.com/anohi-memories/kabumori/pull/129
- return_to: ニュース改善API最適化のちゃ
- completion_code: C4
- recommended_model: Sol（高）
- changed_files: product/source **none**。H4自身の `.agent/CODEX_REPORT_4.md` と `.agent/tasks/CODEX_TASK_4.md` の完了記録のみ同期対象。
- commit_hash: source commit **none**（レビュー対象は上記既存head）。制御ファイルの同期commitはsource変更とは区別する。
- push: product branch not_performed。H4 TASK/ReportのみGitHub同期対象。
- merge: not_performed
- deploy: not_performed
- safety_checks: 本番DB/Edge/Cron/Secrets/Auth/Supabase実呼出/有料AI/X/公開投稿=0。PRコメント・編集=0。他slot TASK/Report/branch/worktree/server変更=0。

## 判定と検証範囲

一度限りのsource-only独立レビュー。fresh mainを確認し、指定headから専用detached worktree `/private/tmp/kabumori-h4-pr129-20261012` を作成。他slotの作業ディレクトリは使用していない。PRの14変更pathとR1/R2差分、本文追記→重複判定→判定保存→生成の境界を確認した。

以下の再現はすべて**独立に作成した合成テキスト／HTML／mock状態**。実際のPDF・Fed発表・本番DBでの発生を主張しない。競合の再現は実 `index.ts` のhandlerをロードし、Deno.serve・Deno.env.getをstubし、実判定SELECT/保存と実enrichment/body-fillを通した。AIのno_post応答のみ固定mock。外部通信はDenoの `--deny-net` で禁止、実環境変数は `--deny-env` で禁止した。

## H4-R1 [P1] 表の折返しを金額専用行と誤認し、増減率を利益額へ変換

- path/line: `supabase/functions/_shared/news_body_extraction/kessan_tanshin_facts.ts:195`（同ファイル249–258の継続行処理も関連）。Phase6/7新規path。
- release_blocker: **yes**。修正範囲は数値表の行長・layout判定と回帰テスト。
- 原因: `tokens.length === metrics.length` なら、headerが明確なamount/%ペアでも無条件で `pairs = "none"` とする。次の数字だけの行は読み捨てる。
- 再現入力（架空会社・数値、単位百万円）:

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

- 合成表が表す当期: 売上1000/+10%、営業100/+20%、経常80/+30%、純利益50/+40%。折返された数字を安全に復元できなければ読取不可とするべき。
- 実出力: `ok=true / issues=[]`。`composeTdnetPdfBody()` は `kind=kessan_facts` として「売上高1000百万円、営業利益10百万円、経常利益100百万円、純利益20百万円」を確定Fact風の先頭ブロックに生成する。営業利益の1/10化だけでなく他指標もずれる。単なる読取漏れではない。
- 最小修正案: m個のtokenを金額のみと認めるのは明確な `amounts_only` layoutに限る。interleaved/grouped headerで2m未満ならfail-closed。継続行の結合を行う場合もheader順序・行境界・token数が一意な場合だけ許容。正常amounts-only/負符号/grouped/IFRSの既存挙動を維持。
- 回帰テスト: 上記折返しと終端切れ、m/2m双方の正常表、forecast EPS列を独立入力で検証する。実PDFでの頻度・G8の60件への含有は未確認。

## H4-R2 [P2] 本文追記が先に成功すると、古い本文での判定保存を止められない

- path/line: 新規 `supabase/functions/important-news-monitor/candidate_body_fill.ts:54–59`。逆側の保存条件は既存 `index.ts:859`（id+pending_judgementだけ）。新規in-place変更が既存readerとの整合を崩す。
- release_blocker: **yes**。F9をDB更新経路として有効化する前に本文snapshotの一致を保存時に検査する。
- 再現順序:
  1. row=`pending_judgement / body_summary=null` を実 `judge_pending` handlerがSELECT。
  2. mock AI requestを保留。入力body=nullを確認。
  3. 同じrowを実 `storedStatementStates()`→`enrichFedStatementCandidates()`→`fillMissingCandidateBody()`が処理。公式bodyを追記し `filled`。
  4. 旧snapshot用のmock AI応答（no_post、reason=`Headline has no policy decision details`）を返す。
  5. 保存PATCHはstatusがpendingのままなので成功。handlerはHTTP200/databaseUpdated=true、DBは**公式本文があるのに rejected/no_post/本文情報不足という旧reason**となる。
- 実害: 新たに取得した政策決定が再判定されず取りこぼされる。逆方向（判定保存→追記）と同時fill×2は安全にskipしており、それだけのテストではこの順序を証明できない。
- 最小修正案: 判定保存を選択時body snapshotと原子的CASで一致させ、本文変更なら保存しない・即時生成もしない。pendingを維持し次の判定で新bodyを読む。直前SELECTだけでは再度TOCTOUが残る。F9が意図的にheadline-only `content_hash`を保持するので、そのhashだけをversionとして比較しても防げない。body null時の条件だけでも当該新規競合を塞げる。
- 検証限界: 原子的条件を解釈するmock PostgRESTと実handlerでの再現であり、実Postgres/RLS/managed APIの並行証明ではない。固定AI応答の発生率は主張しない。

## H4-R3 [P2] 同じ正規声明本文内の過去判断を現在の政策変更として出力

- path/line: `supabase/functions/_shared/news_body_extraction/fomc_statement_facts.ts:89–106`。
- release_blocker: **yes**、過去判断・複数判断の入力を安全に保留する限定修正。
- 原因: article全体にraiseがあればlower/maintainより優先する。range/changeも別々の最初のmatchを使用し、現在の意思決定文とのbindingがない。R1のURL/文書種別/日付検証は別文書へのredirectを防ぐが、同じ正規文書内の時制を防がない。
- 独立合成HTML: candidate URL=`monetary20261009a.htm`、本文日付=`October 9, 2026`、heading=`Federal Reserve issues FOMC statement`をすべて一致させたうえで、次の2文を入れる:

```text
At its July meeting, the Committee decided to raise the target range for the federal funds rate by 1/4 percentage point to 4-1/4 to 4-1/2 percent.
At this meeting, the Committee decided to maintain the target range for the federal funds rate at 4-1/4 to 4-1/2 percent.
```

- 実出力: enrich成功、現在日付の先頭Factブロックに `4.25〜4.5%（引き上げ、25bp引き上げ）`。正しい現在判断は据置。公式host/URL/day一致を満たしても誤った現在判断を出す。
- 最小修正案: 現在判断と特定できる文にaction/range/changeを束ねる。複数判断があり確定できなければwithheld。過去文を省いたraise/lower/maintain正常ケースを維持する。合成ケースであり、この形式のFed実文書が現在feedにあることは未確認。

## R2-F7とF9の受入可能部分／残余制約

- 毎時固定modulo starvationは除去されている。独立10/30/60分×3回で、保存済み1件+失敗2件+後続成功1件の順序を試し後続到達を確認。失敗はsuccess quotaを消費しない。seedを変えた独立cold-start30runでも6候補すべてに試行機会があった。
- **永続公平性の保証はない**。3/4候補でも成功2件に達するか20秒チェックで残りがdeferredになり得る。「maxAttempts以下なら毎回全件試行」というコードコメントは実装より強いが、style上の追加blockerにはしない。正常storage成功後は既取得がquota外となり次候補が進む。6件以上のcold startは確率的で、永続queueもないためRSS消失後の再試行はできない。
- 20秒はhard deadlineではない。独立時計mockで8秒失敗×3=**24秒**、4件目deferredを確認。時間が20秒ちょうどなら `>` 比較により追加試行も可能。単一fetch8秒・attempt4上限、複数sourceの処理との累積を考慮する必要がある。Edge全体timeout/現在のfeed量/実際の失敗頻度は本番にアクセスせず未確認。そのため運用timeoutを理由とするP1/P2は追加しない。
- `fillMissingCandidateBody`のid/status/source_name/空本文の条件付きPATCHと1行read-back、fail時throw、同時fill×2で1勝者、他status/他lane保護は確認済み。malformed responseの一部はskip扱いになるが、別の重大findingにはしていない。
- `content_hash`維持はstable headline dedupeの意図として許容。`source_url`と`content_hash`には既存unique indexがあり、同一正規URLの重複／二重公開を新たに作る経路は確認しなかった。ただしこれは改変後本文のevidence hashにはならず、H4-R2の保存CASに使えない。
- 実status `rejected`（importance=no_post）/generation_failed/published等は本文追記対象外。既存headline-only backlogの復旧は未実装で、勝手に再判断／再公開してよいとはしない。未公開だけの対象・freshness・再判定の承認を別途定める必要がある。既存publishedの更新・再公開は不可。
- F1符号/F2grouped/F3IFRS/F4basis/F5同一四半期/F6minutes redirect/F8イニシャルと反対票の既存回帰はPASS。ただし上記R1/R3の残存を含め全修正を完全PASSと扱わない。
- BOJ新取得は未接続、minutes/projectionsは従来pass-through。Fed host/redirect/capはmock回帰が通った。実サイトの利用条件・権利はこのオフラインレビューで新たに認定していない。
- TDnet読取不可fallbackは注記を付けてgeneric原文抜粋を残す設計。本文に残る曖昧な原文数字のすべてを確定Factと認めてよいとは証明していない。別の生成モデルを実呼出していない。読取不確かな表から確定Factを作らないことがH4-R1の最小必須条件。

## tests（H4自身の実行）

環境: Deno2.9.6 / TypeScript6.0.3。sourceは編集せず、診断用テスト／ログはリポジトリ外に作成。

| 対象 | 結果 |
| --- | --- |
| important-news-monitor全体 | **757 PASS / 0 FAIL** |
| news_body_extraction Phase6/R1 | **29 PASS / 0 FAIL** |
| news_discovery + news-discovery-observer | **162 PASS / 0 FAIL** |
| important-news-shadow | **20 PASS / 0 FAIL** |
| H4独立12 probe | **9 PASS / 3 FAIL**（上記R1/R2/R3、安全性assertionの失敗） |
| diff whitespace | PASS |
| deno lint monitor | PR100 problems、fresh-main100。rule/message/pathは同一で、位置移動のみ。新規diagnosticなし |
| deno check index | PR/main両方に `_shared/x_oauth2_post.ts:66` の同じTS2769。対象blob SHAも同一。今回新規型errorではない |

テストは `deno test --no-check --cached-only --deny-net --deny-env --allow-read`（後続は `--no-lock`も追加）。型検査は別途 `deno check --no-lock --cached-only --node-modules-dir=none`。初回のnode_modules設定エラーを上記設定で解消した後、上記共通TS2769を確認。G8報告のTS2322/lint97を自分の環境でも再現したとは書かない。

**全PASSではない**。既存968テストが通り、追加12probeのうち3つが重要な穴を検出した。H4のsource worktreeはgit status clean・HEAD不変。Denoが生成した未追跡deno.lockだけはH4自身の生成物として除去した。

実PDF60件の再照合、旧独立9再現scriptの完全同一実行、本番RLS/SQL/DB、上位timeout、実AI Fact→X公開は未実施。既存R1/F6/F9 fixtureと独立12probeで関連条件を確認したので、第三者の旧9script完全PASSとは主張しない。

## remaining_issues / next_recommendation

1. H4-R1/R2/R3をG8のニュース改善Aの一つの限定修正TASKにまとめる。実装推薦 **Sonnet5（高）**（body snapshot CAS・表layout fail-closed・矛盾する声明の保留と3失敗例の回帰）。SQL schema/RPC追加・別システム改修に広げる必要はない。
2. 修正後は上記3例のfail-before/pass-afterと既存968回帰をG8が実行してK8へ返す。機械的な追加の全面レビューを要求しない。最終判断は依頼元ChatGPT。
3. PR headは開始／完了前確認とも `7bf9b8a0`、OPEN/Draft/unmerged。最新metadataのmergeableは開始true→完了前falseに変化した。base/mainが進むためfresh conflict再確認は必要。H4が勝手に統合・競合解消しない。
4. H4自身TASKのみreview_required/next_owner chatgptへ返す。ACTIVE_TASK/CURRENT_STATE/G8/G9や他slotは変更しない。
5. 本番反映は本TASKで禁止されており、merge/deployも未実施。PR116本番用worktree未操作。

ニュース改善API最適化のちゃ へ C4 を送ってください。


---

## Report

- task_id: none
- result: not_started（未割当）
- status: idle
- next_owner: none
- return_to: none（未割当）
- completion_code: C4
- changed_files: none
- tests: not_run
- commit_hash: none
- push: not_performed
- deploy: not_performed
- remaining_issues: none（作業未割当）
- safety_checks: not_started
- next_recommendation: 明示割当までidleを維持する。
