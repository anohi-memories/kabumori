# Claude Task 2

- task_id: kabumori-app-morning-close-report-detail-and-portfolio-impact-20260924
- owner: claude
- slot: claude-2
- status: in_progress
- next_owner: claude
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
