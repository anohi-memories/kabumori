# Claude Task 2

- task_id: kabumori-app-morning-close-report-detail-and-portfolio-impact-20260924
- owner: claude
- slot: claude-2
- status: done
- next_owner: none
- priority: high
- recommended_model: Opus5.5（高）
- purpose: かぶモリアプリの朝刊・大引けレポートを、X「かぶモリ」アカウントと基本テーマ・材料・論点を揃えつつ、アプリ版では市場全体の詳細分析とユーザー保有株への影響分析を追加した上位版へ改修する。

## User-approved product direction

### Common principle

- X版とアプリ版で、その日の主要材料・相場観・重要論点が矛盾しないこと。
- X版をそのまま長文化するだけにはしない。
- アプリ版は文字数制限に縛られず、X版より詳しい「上位版」とする。
- X版の投稿生成フロー/queueをこのTASKで変更しない。
- X側の事実・材料・市場テーマの取り方を参照するのは可。ただしG3/G4所有範囲は編集しない。

### Morning report / 朝刊

アプリ版朝刊は少なくとも次を含む:

1. 市場全体の朝刊
   - 前日の日本市場
   - 米国主要指数
   - Nasdaq / SOXなどテック・半導体関連
   - 日経先物
   - 為替
   - 金利・原油等、その日に重要なクロスアセット
   - 国内外の重要ニュース
   - 決算/経済指標/イベント
   - セクター別の追い風・逆風
   - 寄り付き前の主要シナリオと注目ポイント

2. ユーザー保有株への「今日の影響見通し」
   - 各保有銘柄ごとに、当日の市場材料がどう影響しそうか
   - 追い風 / 逆風 / 中立を、根拠付きで説明
   - 市場全体、業種、為替、金利、原油、米株、個別ニュースとの接続
   - 寄り付き/場中で見るべきポイント
   - 材料が弱い場合は無理に理由を作らず「明確な個別材料なし」とする
   - 断定的な株価予測は避け、観察ポイントとシナリオを示す

### Closing report / 大引け

アプリ版大引けは少なくとも次を含む:

1. 市場全体の大引け詳報
   - 日経平均 / TOPIX / 必要な主要指数
   - 前日比、場中の流れ
   - 上昇/下落を主導した材料
   - 業種・テーマ別の強弱
   - 為替、先物、米国要因、金利、原油等の影響
   - 当日の重要ニュース/決算/需給材料
   - 朝の想定と実際の差分
   - 翌営業日に持ち越す注目材料

2. ユーザー保有株への「実際の影響」
   - 各保有銘柄がどう動いたか
   - 市場全体に対して強かった/弱かった等の相対評価
   - その日の材料と値動きの整合性
   - 個別材料があれば明示
   - 個別材料がない場合、市場/業種要因と推測を明確に分離
   - 朝刊で挙げた影響見通しとの答え合わせ
   - 翌営業日の確認ポイント

## UX / content requirements

- 「市場全体」と「保有株への影響」を明確にセクション分離する。
- 長文でも読みやすい見出し・箇条書き/段落構造にする。
- 同じ内容の重複を減らす。
- 数値が取得できていない場合は捏造せず欠損を明示または自然に省略する。
- 古いデータと当日データを混同しない。
- 個別銘柄の影響理由は、事実 / 推定 / 観察点を区別する。
- 投資助言の断定表現ではなく、情報整理・シナリオ分析として出す。
- ユーザーが保有株を持っていない場合でも市場全体レポートは成立する。
- 保有銘柄が多い場合、全銘柄を機械的に同じ長さで書かず、影響度の高いものを詳しく、材料の薄いものは簡潔にする。

## Mandatory startup / source audit

1. 独立worktree/checkoutを使用。
2. Read:
   - PROJECT_RULES.md
   - .agent/ORCHESTRATION.md
   - .agent/CURRENT_STATE.md
   - this TASK
3. Fresh fetch origin/main.
4. G1/G3/G4/H1/H2のscopeを確認。
5. 既存の朝刊/大引け生成パスを特定:
   - prompt/template
   - Edge Function/server logic
   - scheduler/cron if any
   - DB tables/storage
   - personalized_reports/read path
   - mobile rendering screen/components
6. X「かぶモリ」側で同一市場材料を生成/保持しているsourceをread-onlyで調査し、再利用できるfact layerと、アプリ固有layerを分離する。
7. source audit結果をTASK Reportへ記載してから実装。
8. G3が所有するX queue/planner SQL/RPC/x-test-post Phase1Dと編集対象が重なる場合はSTOPし、具体的な競合ファイルを報告する。

## Architecture requirement

可能な限り以下の2層を分離する:

### Shared market fact/context layer
- 当日の市場データ
- 重要ニュース
- イベント
- 市場テーマ
- X版とアプリ版で共通にできる根拠情報

### App enrichment layer
- 詳細な市場解説
- 朝刊/大引け専用の長文構成
- authenticated userの保有銘柄取得
- 保有株影響分析
- 朝刊→大引けの答え合わせ

X投稿文そのものをアプリへコピペする設計ではなく、共通facts/contextから各surface向け出力を作る方向を優先する。
ただし大規模リファクタが必要なら、このTASKで無理に共通基盤化せず、既存設計に安全に合わせる。

## Portfolio boundary

- 保有株は必ずauthenticated user自身のデータだけを使用。
- 他ユーザーのportfolioを混ぜない。
- service-roleをmobileへ露出しない。
- 既存RLS/auth境界を弱めない。
- symbol/name/holding metadataに欠損があっても他人のデータで補完しない。
- account/user IDをLLM出力本文へ不要に露出しない。

## Morning-to-close comparison

既存データモデルで安全に可能なら:
- 朝刊で保存した主要シナリオ/保有株見通しを大引け生成時に参照
- 「朝の想定 → 実際」を比較

ただし、これに新規schema/migrationが必要な場合:
- 既存personalized_reports等で表現できるか先に確認
- migrationが必要なら実装前に影響範囲を整理
- 他slotと競合しないことを確認
- blind `supabase db push` 禁止
- production applyはこのTASKではしない

## Tests

最低限:
- morning market-wide report generation
- closing market-wide report generation
- portfolio holdings present
- no holdings
- one holding with strong relevant material
- holding with no direct material
- multiple holdings
- missing market datapoint
- morning→closing comparison if implemented
- no cross-user portfolio leakage
- generated output sections/order
- X-specific queue/planner path remains unchanged

Run:
- focused tests
- relevant existing report/mobile tests
- type/static checks
- `git diff --check`
- if Edge Function changed, appropriate Deno checks/tests

Report exact counts.

## Forbidden

- G1 recovery/Auth files
- G3 X queue/planner SQL/RPC/x-test-post Phase1D files
- G4 admin/Netlify files
- X API posting behavior changes
- Cron schedule changes unless strictly necessary and non-overlapping; if needed, STOP and report before change
- production migration apply
- blind supabase db push
- production DDL/DML
- Auth/RLS weakening
- service-role exposure
- Vercel configuration/deploy
- Netlify setup
- unrelated UI redesign
- MIC work

## Production mutation budget

0 for backend/config/deploy.
If existing app normal read-only data is used for verification, no user data mutation.

## Completion / K2

When complete:
- status -> review_required
- next_owner -> chatgpt
- Report must include:
  1. fresh main SHA
  2. source audit: current morning/closing architecture and exact files
  3. relationship to X Kabumori content/fact source
  4. exact changed files
  5. final morning structure
  6. final closing structure
  7. portfolio-impact logic and privacy boundary
  8. morning→closing comparison behavior
  9. tests/counts
  10. commit/push/PR status
  11. production mutation=0
  12. remaining limitations / future improvements
  13. whether Codex review is recommended and why
- STOP for K2.

## Report

### Summary

- task_id：`kabumori-app-morning-close-report-detail-and-portfolio-impact-20260924`
- result：**source実装完了・PR作成済み（未merge、未deploy）**。K2待ち。
- changed_files：9ファイル（詳細は4）。
- tests：Denoスイート **151 passed / 0 failed**（ベースライン130、新規21、既存5件を新しいbody形へ更新）。詳細は9。
- commit_hash：`acbc1b6ceac04d978b7fe6fb8e3d266734d3826a`
- push：`origin/g2-app-report-detail-portfolio-impact-20260924` へpush済み。PR https://github.com/anohi-memories/kabumori/pull/19（open、未merge）。
- deploy：**なし**（Edge Functionのdeploy、migration、cron、consumer gate、Vercel/Netlifyのいずれも未変更）。
- remaining_issues：12を参照。
- safety_checks：
  - production mutation 0。
  - 本番への接続は集計だけのread-only SQL 1回（個人の本文・IDは取得していない）。
  - `git diff --check` OK。secret scan 0件。
  - 禁止パス（`x-test-post`、`_shared`、`migrations`、`market-report-*`、`apps/`）の変更 0件。
  - `ACTIVE_TASK.md` など共有ファイルは未変更（本TASKのstatusとReportだけを更新）。
- next_recommendation：11と13を参照。

### 1. fresh main SHA

- 着手時：`0e28d51`（in_progress commitの後は `0cf4b44`）。
- PR branchは `aed4841` の上にrebase済み。報告直前のorigin/mainも `aed4841` だった。
- 着手後にmainへ入ったcommitは `.agent/**` だけで、本TASKの対象ファイルとの重なりは0件。
- 他スロットとの重なりもない：G1（release基盤）、G3（Phase1D）、G4（admin/Netlify）、H1/H2。

### 2. source audit：現行の朝刊・大引けの構成と対象ファイル

- **共有のfact層（X・アプリ共通、変更なし）**
  - `market-report-data-packet`：コードで取得する指標。日経平均、1306、NYダウ、S&P500、ナスダック、SOX、ドル円、米2年・10年債、JGB2年・10年、WTI、ブレント。日経先物とグロース250は「取得元なし」の欠損として扱われている。
  - `market-report-analysis`：Fact-passedの市場分析（`market_report_packet.v1`：claims、themes、key_news、next_watch、risks、x_post）。
  - cron：`market-report-data-packet-*`、`market-report-analysis-*(+retry)`。
- **アプリのenrichment層（今回の変更対象）**
  - `supabase/functions/personalized-reports/{index.ts, report_logic.ts}`
  - cron：`personalized-reports-morning`（`35 23 * * 0-4` UTC）、`personalized-reports-close`（`15 8 * * 1-5` UTC）
  - DB：`personalized_reports`（本人・completed・Fact-passedの行だけを読めるRLS、body/portfolio_snapshotはjsonb）
  - 読み取りと表示：`src/lib/personalized-reports.ts`、`src/lib/report-presentation.ts`、`src/app/reports/[id].tsx`
- **本番の状態（read-only集計）**
  - `market_report_consumer_settings` は `app_enabled=false`、`x_enabled=false`。
  - 共有packetは毎日生成されている（9/24は朝刊・大引けともcompleted）。ただしアプリは旧lane（`app_personalized_v1`：日経平均と1306のみ）のままで、market_sectionは付いていない。
  - 対象ユーザーは1人。

### 3. X「かぶモリ」側との関係

- X朝刊・大引けは現状 `x-test-post` 内の独自収集で作られており（`x_enabled=false`）、共有packetはshadow生成の段階にある。
- 今回のアプリ版は、X版と同じ共有packet（fact＋Fact-passed分析）を唯一の市場の根拠として使う。
  - 市場の方向・材料・論点は、X（gate ON後）と同じものになる。
  - アプリの市場セクションはAIを使わずコードで組み立てるため、共有分析と矛盾しない。既存の方向矛盾チェックも維持している。
- X投稿文をアプリへコピーする設計ではない。共通のfacts/contextから、アプリ向けの上位版を作る。
- X側のファイルは一切編集していない。共有packetを変更しないこと、`formatSharedXPost` の出力が変わらないこともテストで確認した。

### 4. exact changed files

- 新規
  - `supabase/functions/personalized-reports/market_detail.ts`
  - `supabase/functions/personalized-reports/report_upgrade_test.ts`
  - `tests/app/report-impact_test.ts`
- 変更
  - `supabase/functions/personalized-reports/report_logic.ts`
  - `supabase/functions/personalized-reports/index.ts`
  - `supabase/functions/personalized-reports/report_logic_test.ts`
  - `supabase/functions/personalized-reports/shared_market_consumer_test.ts`
  - `src/lib/report-presentation.ts`
  - `src/app/reports/[id].tsx`

### 5. final morning structure

1. 見出し・要約
2. **市場全体の朝刊**（共有packetから、AIなし）
   - 方向感
   - 見出しと要約
   - 主要指標の表：日本株（前営業日の終値と明示）、米国株、半導体（SOX）、為替、金利、原油。先物は「確認できる取得元がないため表示していません」と表示。stale値は日付を付け、前日比は出さない。
   - 海外市場・前日の流れ（overnight claims）
   - 日本市場の状況
   - セクター別の追い風・逆風
   - 国内外の重要ニュース・決算（重要度の理由つき）
   - 寄り付き前の注目ポイントとシナリオ（watch points・risks）
   - 取得できなかったデータ
3. **保有株への今日の影響見通し**
   - stanceの件数サマリー、評価額、ポート見通し
   - 銘柄カード：材料のある銘柄を先に詳しく、材料の薄い銘柄は後ろに簡潔に並べる。stanceバッジ（追い風／逆風／中立／明確な材料なし）と、事実・推定・見るポイントの各欄。
   - 監視銘柄、業種バランス、気をつけたい点、市場ニュース、チェックポイント、注記

経済指標の予定は、共有layerに取得元がない（calendar_refsが未提供）ため欠損として表示する。

### 6. final closing structure

1. 見出し・要約
2. **市場全体の大引け詳報**
   - 主要指標（当日の終値ベース）
   - 今日の相場の流れと主導した材料
   - 海外・為替などの影響
   - 業種・テーマ別の強弱
   - 当日の重要ニュース・決算
   - **朝の想定と実際**（共有の朝刊の見出し・方向・注目点と、大引けの見出し・方向を並べる）
   - 翌営業日に持ち越す注目材料
   - 欠損
3. **保有株への実際の影響**
   - 今日の損益・評価額・1306との比較、ポート総括
   - **朝の見通しとの答え合わせ**（morning_review_ja）
   - 上昇・下落に効いた銘柄
   - 銘柄カード：1306比のポイント差、「朝の見通し『追い風』→見通しどおり／逆／どちらとも言えない」（コード判定）、事実・推定・翌営業日の確認点
   - 監視銘柄など（朝刊と同じ構成）

「場中の流れ」は日中データの取得元がないため、終値ベースで記述する。

### 7. portfolio-impact logic and privacy boundary

- **コードで決めること**
  - 根拠の有無：自社ニュース、業種一致の市場ニュース、共有テーマ、cross-asset。
  - `allowed_basis`：銘柄ごとに、使ってよい根拠の種類。
  - 詳細度：材料があるか、1306比で±1.0pt以上動いたかで「詳しく」か「簡潔に」を決める。
  - 大引けでの1306比の差と、強い／弱い／ほぼ同じの判定。
- **LLMが出すもの**：`holding_impacts`（stance、basis、fact_ja、inference_ja、watch_ja）。
- **ローカル検査で却下するもの**
  - 許可されていないbasis（`BASIS_NOT_AVAILABLE`）
  - basisのない追い風・逆風（`STANCE_WITHOUT_BASIS`）
  - 材料なしなのに自社ニュースを根拠にしたもの（`STANCE_BASIS_MISMATCH`）
  - 推定表現を使っていない推定（`INFERENCE_NOT_HEDGED`）
  - 簡潔枠の超過（`IMPACT_TOO_LONG`）
  - 保有銘柄の漏れ・未知の銘柄・重複
  - 既存の検査（packetにない数字、売買助言、URL、ISO日付、英単語、複数日を前提にした語、共有分析との方向矛盾）も維持している。英字の名称は、packetの本文に含まれる単語（SOX等）だけを許可し、basisのコード名は許可しない。
- **Fact-check**：推定欄での一般的な関係の推論は許容する。事実欄への推定の混入、根拠との矛盾、答え合わせの判定との食い違いは不合格にする。
- **材料が弱い銘柄**：`no_clear_material` にし、「明確な個別材料は確認できていません」と書く。無理に理由は作らない。
- **プライバシー**
  - 保有株は既存どおり、Edge Function内でユーザーごとに分けて扱う。
  - LLMに渡すpacketにuser_idは含めない。他ユーザーの銘柄が混ざらないことはテストで確認した。
  - 朝刊の参照は `user_id=eq.<本人>` で固定し、返ってきた行もuser_idで再確認する。入力が不正なら例外にする。
  - アプリ側の読み取りは既存RLS（本人・completed・passedのみ）から変更していない。service-roleをmobileへ出していない。RLSも変更していない。

### 8. morning→closing comparison behavior

- 大引け時に、同じユーザー・同じ日のcompleted/passedの朝刊から銘柄ごとのstanceを読む。
- コードで判定する：
  - 追い風・逆風が、1306比±0.3ptを超えて一致すれば「見通しどおり」、逆なら「見通しと逆」、帯の内側なら「どちらとも言えない」。
  - 1306が取得できない日は、銘柄自身の騰落で判定する。
  - 中立・材料なし・朝刊なし・価格未取得は「比較なし」とし、推測はしない。
- 判定結果はportfolio_snapshotへ保存し、LLMへは判定の文言だけを渡す（判定を書き換えさせない）。
- 市場全体の比較：共有の朝刊packet（大引け時点で取得）の見出し・方向・注目点を表示する。取得できなければ比較の欄を出さない。
- 新しいschemaやmigrationは不要（既存のjsonbに保存）。朝刊の参照に失敗しても、比較が抜けるだけでレポート自体は作る。

### 9. tests/counts

- `deno test --no-check --no-lock --allow-read tests/app/ supabase/functions/personalized-reports/ supabase/functions/market-report-analysis/`：**151 passed / 0 failed**
  - 既存の130件
  - 新規 `report_upgrade_test.ts` 15件：朝刊の市場詳細、大引けの市場詳細、朝の想定の引き継ぎ、欠損の扱い、X出力・共有packetの不変、保有あり、強い材料のある銘柄、材料のない銘柄、複数銘柄、保有なし、答え合わせの判定表、朝→大引け、user固定・他ユーザー行の無視、cross-user漏れなし、保存するbodyの形と順序
  - 新規 `tests/app/report-impact_test.ts` 6件
- `deno check`（index / report_logic / market_detail）：PASS
- `deno lint`（personalized-reports、7ファイル）：PASS
- `npx tsc --noEmit`：`src/` の新規エラーは0件。
  - `src/` のエラーは既存と同一の2件（CSS moduleの型宣言）だけ。
  - repo全体では1171件から1181件へ増えたが、増えた10件はすべて、既存のテストファイルでも出ている環境由来の種類（root tsconfigがDeno/Node用テストを拾う）。
- `npx expo export --platform web`：PASS（static routes 10）。
- `git diff --check`：PASS。secret scan：0件。
- ESLint：repoにflat configがなく、`expo lint` を実行すると設定ファイルが生成されるため未実行。
- X専用のqueue/plannerの経路が変わっていないこと：該当ファイルの差分0件（禁止パスの確認）に加え、`formatSharedXPost` と共有packetが変わらないことをテストで確認した。

### 10. commit/push/PR status

- branch：`g2-app-report-detail-portfolio-impact-20260924`
- commit：`acbc1b6`（base `aed4841`）
- push：済み
- PR：https://github.com/anohi-memories/kabumori/pull/19（open、**未merge**）

### 11. production mutation=0

- deploy・migration・DDL/DML・cron・consumer gate・Auth/RLS・Vercel/Netlify：いずれも0件。
- 本番への接続は集計のread-only SELECT 1回だけ。

### 12. remaining limitations / future improvements

- **反映には別途の承認が必要**：`personalized-reports` のdeployと、`market_report_consumer_settings.app_enabled=true`（本番DML）。
  - gateがOFFのままでは、保有株のupgradeは効くが市場詳細は出ない（旧laneで日経平均と1306のみ）。
  - gateをONにすると、共有packetがcompletedにならない日（例：9/18の朝刊はblocked）は、既存の設計どおりアプリのレポートがskipされる（fail closed）。この日の扱いを決めるのは別判断。
- **反映直後の答え合わせ**：大引けの答え合わせは、新形式の朝刊が保存された日から有効になる。deploy当日の朝刊が旧形式なら「比較なし」になる。
- **取得元がないため欠損表示にしている項目**：日経先物、グロース250、業種別騰落、経済指標の予定、場中の推移。
- **保有株を持たないユーザー**：ロジック上は市場だけのレポートが成立するが、対象ユーザーの抽出は既存どおり tracked_stocks がある人だけ（Push対象を広げないため）。広げるかは別判断。
- **ユーザー数の上限**：`MAX_USERS_PER_RUN=20` と時間予算は未変更。
- **出力量の増加**：LLMの出力上限を12000に拡大した。1ユーザーあたりの費用は増える見込み（未計測）。
- **確認できていない点**：実LLMの出力でのFact合格率は、dry_run前のため未確認。実機での表示確認も、実際のレポートデータが必要なため未実施。

### 13. Codexレビューの推奨

推奨する。理由：
- Push対象となる本文のLLMプロンプト・スキーマ・ローカル検査を大きく変えている。
- privacyの境界（本人の朝刊だけを参照すること）を含む。
- 既存テストのbody形を更新している。

特に見てほしい点：
- `holdingImpactIssues` と英字許可の緩め方が、防御を弱めていないか。
- 朝刊参照が本人に固定されているか。
- 旧版アプリとの互換（`stock_notes` の継続）。

レビューがPASSした後の順序として推奨する：
1. merge
2. Edge Functionのdeploy（承認後）
3. dry_runの並走で、実LLM出力のFact合格率と表示を確認
4. `app_enabled` をONにするかの判断


## Final K2 — 2026-09-24

Result: **IMPLEMENTATION PASS / merge pending Codex review**.

Accepted:
- PR #19 source implementation complete at head `acbc1b6ceac04d978b7fe6fb8e3d266734d3826a`.
- shared market fact/X paths unchanged.
- app morning/close reports now add detailed market-wide sections and per-holding impact analysis.
- morning→close comparison implemented without new schema/migration.
- user isolation / no cross-user portfolio leakage covered by tests.
- 151 tests passed / 0 failed.
- deno check/lint PASS.
- no new src TypeScript errors.
- Expo web export PASS / 10 routes.
- git diff --check PASS; secret scan 0.
- production mutation=0.

Merge decision:
- Do not merge PR #19 yet.
- Codex review is required before merge because this change materially modifies LLM prompt/schema/validation, user-bound morning lookup, and portfolio privacy boundaries.
- H1 and H2 are currently assigned to other reviews. Queue this review for the first safe Codex slot that becomes free.
