# 無料feed主体のニュース取得アーキテクチャ案（N1）

- 作成: 2026-09-28（N1 調査。設計のみ。production・DB・Cron・既存 monitor は変更していない）
- 関連: [news_source_catalog.md](news_source_catalog.md) / [company_news_non_ir_design.md](company_news_non_ir_design.md) / [market_anomaly_news_trigger.md](market_anomaly_news_trigger.md) / [news_cost_estimate.md](news_cost_estimate.md) / [news_recall_benchmark.md](news_recall_benchmark.md)

## 0. 結論

1. 発見の主役を **Web Search → 定点巡回（RSS / Atom / 公式API）** に移す。Web Search は「発見」ではなく**補完・裏取り**専用にする。
2. 既に本番にある **headline trigger レーン（BBC / Al Jazeera の見出し → Luna triage → 見出し語で Web Search）** は、この方向の最小版として既に動いている。新基盤は「見出し源を2本から数十本へ広げ、AIに渡す前にコードで絞る」拡張と位置づけられる。
3. ただし**入口の数を増やすだけでは Recall は上がらない**。効くのは (a) 分野ごとに「最速で出る source」を1〜2本ずつ持つこと、(b) 取りこぼしを event 単位で測ること（news_recall_benchmark.md）。
4. **規約が最大の制約（N1 の最重要所見）**。技術的にはほぼ全ての RSS が取れるが、
   - **国内の大手報道（NHK・時事・朝日・毎日・Yahoo!・Google News・東洋経済・ダイヤモンド・株探等）は公式規約で個人利用限定／営利利用禁止**。海外も Al Jazeera・CNBC・NYT・FT・Dow Jones は禁止、BBC は不明確。
   - **商用で使えることが明確なのは、公式・公的機関（日本は PDL1.0、米連邦は PD、EU/英は条件付き）と GDELT（メタデータ）だけ**。報道で Tier A は 0 件。
   - このため「無料 RSS を広く巡回すれば ChatGPT 並みに発見できる」は、**規約を守る限り成立しない**。無料・規約適合の経路で強いのは「公的機関が発表する事象」（金融政策・指標・関税・制裁・規制・災害・開示）であり、弱いのは「報道が最初に伝える事象」（戦争・事故・海上攻撃・企業の不祥事・国内一般ニュース）。
   - 設計上、source ごとに `usage_scope` と `ai_input_allowed` を持たせ、**許諾範囲を超えた使い方をコードで防ぐ**。規約で禁止されている source は「内部トリガー専用」にもしない（営利目的の利用自体が禁止されているため）。
5. したがって現実的な構成は **「公式・構造化 API（無料・Tier A）＋ GDELT（無料・商用可）＋ 許諾を取った少数の報道/配信（有料または提携）＋ 限定 Web Search」** の4層。報道の穴を何で埋めるか（配信契約・商用ニュース API・Web Search の継続）は**ユーザー判断事項**（§10）。
6. 既存 `important-news-monitor` を変更せずに始められる。最初は**独立した shadow 観測**（記事プールに貯めて event 台帳と突き合わせるだけ。投稿・通知なし）から。

## 1. 全体像

```text
┌──────────── 取得層（無料・定点巡回） ────────────┐
│ Tier A 公式: 日銀/FRB/ECB/BoE/USTR/Fed Register/  │
│   SEC/BEA/BLS/EIA/JMA/USGS/GDACS/金融庁/防衛省…   │
│ GDELT（商用可のメタデータ・世界の報道を横断）     │
│ 許諾済み報道/配信のみ（例: 時事・共同の配信契約、│  ← 許諾状況で usage_scope を分ける
│   BBC/ITmedia/PR TIMES 等は許諾取得後）          │
│ 業界（規約確認後）: EE Times/MONOist/レスポンス/  │
│   4Gamer/流通ニュース/Maritime Exec/gCaptain/     │
│   Defense News/OilPrice/Rigzone/企業newsroom…     │
│ プレスリリース: PR TIMES/PR Newswire/@Press       │
│ 構造化API: Federal Register/EDINET/NHTSA/USGS     │
└──────────────────────────────────────────────────┘
          │ 条件付きGET（ETag / Last-Modified）、source別間隔
          ▼
┌──────────── 正規化・重複除去（コードのみ） ───────┐
│ URL正規化（utm等除去）→ canonical                  │
│ title正規化（全半角・記号・媒体名サフィックス除去）│
│ published_at → UTC（未来時刻・欠損は flag）        │
│ URL hash / title hash / 近似重複（shingle）        │
└──────────────────────────────────────────────────┘
          ▼
┌──────────── ルールベース filter（コードのみ） ─────┐
│ 除外: スポーツ/芸能/天気の定常/占い/レシピ等の     │
│   カテゴリ feed 単位の除外、JMA 定常電文の型除外   │
│ 加点: 市場語辞書（利上げ/関税/制裁/原油/急落…）    │
│ entity 抽出: 国・機関・企業 alias・商品・海峡名    │
└──────────────────────────────────────────────────┘
          ▼
┌──────────── クラスタリング（コードのみ） ──────────┐
│ 同一事象を束ねる（entity集合＋時間窓＋語の重なり） │
│ 「何媒体が報じたか」「一次情報があるか」を集計     │
└──────────────────────────────────────────────────┘
          ▼
┌──────────── 軽量AI一次判定（batch） ───────────────┐
│ クラスタ単位で 20〜40 件を1回にまとめて判定       │
│ 出力: market_relevance / category / 追加確認要否   │
└──────────────────────────────────────────────────┘
          ▼
 重要候補 ──→ 情報十分？ ──YES──→ 既存の候補パス（dedupe/judgement…は変更しない）
               │NO
               ▼
          限定 Web Search（1クラスタ1回まで・日次上限）
```

- 既存 monitor への接続（「既存の候補パス」への受け渡し）は **N1 の範囲外**。STOP 条件に該当するため、接続時は別タスク・別承認とする。まずは記事プールと event 台帳だけで Recall を測る。

## 2. 取得層の設計

### 2.1 source 定義（設定データ）

```text
source_key, name, operator, url, format (rss|atom|rdf|json|api|sitemap),
category[], language, tier (A|B|C|D),
poll_interval_sec, market_hours_interval_sec, off_hours_interval_sec,
retention_window_items (feedが保持する件数), expected_items_per_day,
usage_scope (internal_trigger_only|display_headline_link|display_with_image),
terms_url, terms_checked_at, robots_checked_at,
timestamp_quality (explicit_tz|no_tz|build_time_only|future_skew_seen),
enabled
```

- `retention_window_items` と `expected_items_per_day` から**取りこぼさない最長巡回間隔**を計算する。例: 毎日新聞速報 RSS は20件で約3.3時間分しか保持しない（2026-09-28 実測）→ 60分間隔なら安全。PR TIMES 全体RDF は200件で平日は数時間分の可能性 → 30〜60分。
- 既存 shadow の知見: 「汎用 parser が先頭8件で切る」ため NHK のような多件数 feed で取りこぼしが起きる（SHADOW_COVERAGE_GAP_RESEARCH）。新基盤では**件数上限ではなく「前回取得以降の差分」で処理**する。

### 2.2 巡回間隔の方針

| 区分 | 例 | 市場時間中 | 時間外 | 理由 |
|---|---|---|---|---|
| 速報性が高い報道 | GDELT（5秒に1回制限）、**許諾・契約を得た報道のみ**（国内の NHK・時事・朝日・毎日等は規約上そのままでは不可） | 5〜10分 | 15〜30分 | 地政学・事故の初報 |
| 公式（イベント時刻が決まる） | FRB、日銀、ECB、BLS、BEA | 通常 30分、**発表予定時刻の前後は 1〜2分** | 60分 | 発表時刻が既知。カレンダー駆動にする |
| 公式（不定期） | USTR、Federal Register、財務省、金融庁、防衛省 | 10〜15分 | 30〜60分 | 関税・制裁・処分 |
| 災害 | JMA 高頻度 feed、USGS、GDACS | 1〜2分 | 1〜2分 | 地震・津波は即時性が必要（JMA は高頻度 feed の差分取得前提） |
| 業界・プレスリリース | PR TIMES、業界媒体 | 15〜30分 | 60分 | 量が多いが速報性は中 |
| 企業 newsroom | NVIDIA、Samsung、OpenAI 等 | 30〜60分 | 60〜120分 | 更新頻度が低い |

- 全 source で **ETag / Last-Modified による条件付き GET** を使う（未対応 source でも本文 hash で差分判定）。帯域と相手サーバ負荷を抑える。
- **UA を明示**（例: `Kabumori-news-collector/1.0 contact@…`）。SEC は UA 宣言と 10 req/s 以下が明文の条件。GDELT は「5秒に1回」を超えると 429（2026-09-28 実測）。
- **403/404/429 は即座に source を degraded にし、バックオフ**（再試行で叩かない）。

### 2.3 usage_scope（規約をコードで守る）

| usage_scope | 許すこと | 許さないこと | 典型 |
|---|---|---|---|
| `internal_trigger_only` | 見出しを内部で読み、事象検知・Web Search のきっかけに使う | アプリ・X での表示、本文保存、画像取得 | 許諾未確定の報道 RSS |
| `display_headline_link` | 見出し＋URL＋媒体名をアプリで表示 | 本文転載、画像のキャッシュ | 規約で見出しリンクが認められたもの |
| `display_with_image` | 上記＋OG画像のホットリンク/キャッシュ | 本文転載 | 政府標準利用規約系・パブリックドメイン・明示許諾 |

- **`internal_trigger_only` の source でも AI 処理（Luna triage）に渡すことが規約上問題ないか**は別に確認が要る（Al Jazeera は robots.txt で AI・TDM を明示的に禁止）。この確認が済むまでは、該当 source を AI 入力にしない設定（`ai_input_allowed=false`）を持つ。
- アプリ表示に使う URL は、**可能な限り一次情報（官公庁・企業）へ差し替え**る。報道記事は「発見の手段」、表示は一次情報、が基本。

## 3. 正規化・重複除去

| 処理 | 方法 | AI |
|---|---|---|
| URL 正規化 | スキーム統一、`utm_*`/`ref`/`at_medium` 等の除去、末尾スラッシュ、AMP→正規 | 不要 |
| canonical | feed の link を基本とし、表示時のみ記事ページの `<link rel=canonical>` を取得 | 不要 |
| Google News 等の中継 URL | 中継 URL は保存せず元記事 URL を解決（規約上 Google News RSS は使わない方針。catalog 参照） | 不要 |
| title 正規化 | NFKC、媒体名サフィックス（「 - 日本経済新聞」等）除去、記号除去 | 不要 |
| 時刻 | UTC 化。タイムゾーン無し・未来時刻（Samsung newsroom で +5h の未来時刻を観測）・`lastBuildDate` のみ（防衛省）を flag | 不要 |
| 完全重複 | URL hash、title hash | 不要 |
| 近似重複 | 文字 n-gram shingle（Jaccard ≥ 0.6 等、要調整） | 不要 |
| 言語跨ぎ重複 | 日英で同一事象 → entity 集合＋時間窓でクラスタ化 | 原則不要（残差のみ AI） |

## 4. ルールベース filter と entity 抽出

- **feed 単位の除外**が最も安全で効果が大きい（スポーツ・エンタメ・生活カテゴリの feed を最初から巡回しない）。
- **キーワードでの除外（ブラックリスト）は使わない**（既存調査の結論と同じ。稀な重大事象を落とす）。キーワードは**加点**にだけ使う。
- 市場語辞書（加点）: 金融政策（利上げ/利下げ/政策金利/FOMC/日銀/介入）、通商（関税/輸出規制/制裁/エンティティリスト）、地政学（ミサイル/攻撃/侵攻/停戦/封鎖/海峡/タンカー/ドローン）、エネルギー（原油/OPEC/減産/増産/LNG/製油所/パイプライン）、市場（急落/急騰/サーキットブレーカー/取引停止）、企業（買収/TOB/リコール/不正/提訴/火災/操業停止/サイバー攻撃）、災害（地震/津波/噴火/台風/停電）。
- entity 抽出: 国・地域、機関（FRB/日銀/OPEC…）、海峡・港湾名、商品名、企業 alias（company_news_non_ir_design.md）。
- JMA 高頻度 feed は1日約1,700件（2026-09-28 の10時間で711件）だが、大半は定常電文。**電文種別コードで事前に絞る**（震度速報・津波警報・噴火警報など）ので AI は不要。

## 5. AI の使い方（段階処理）

| 段階 | 処理 | 手段 | 対象件数の目安 |
|---|---|---|---|
| 0 | URL/title 重複、既知 URL | コード | 全件 |
| 1 | feed 単位の除外、定常電文の除外 | コード | 全件 |
| 2 | 市場語辞書・entity 抽出・スコア | コード（正規表現・多パターン一致） | 全件 |
| 3 | 同一事象クラスタ化 | コード | 全件 |
| 4 | **一次判定（batch）** | 軽量AI（Luna 相当）。クラスタの代表見出し 20〜40件を1回で | スコア上位のクラスタのみ（全体の10〜25%想定） |
| 5 | 深い判定 | 既存 judgement（Luna→必要時 Sol）。**既存ルーティングは変更しない** | 一次判定で「重要候補」になったものだけ |

- **AI不要で落とせるもの**: 重複、スポーツ/芸能/生活 feed、JMA 定常電文、既知の定期公表（週次・月次の定型リリース）、Samsung 等の製品プロモーション（newsroom のカテゴリで判別可能なもの）。
- **Regex / keyword で処理できるもの**: 証券コード、国・機関・海峡名、指標名（CPI/雇用統計）、事象語（ミサイル/リコール/TOB）、数値変化（「◯%急落」）。
- **batch 処理できるもの**: 一次判定（市場関連度・カテゴリ付与）、曖昧 alias の主語判定、日英同一事象の判定。
- **Luna 相当で十分なもの**: 一次判定、カテゴリ付与、見出しからの検索語生成（headline trigger と同型）。
- **Sol 級が必要なもの**: 既存 judgement の昇格条件に該当するもの（ここは既存に任せる）。新基盤側で独自に Sol を呼ぶ設計にはしない。

## 6. Web Search の位置付け

原則 **発見手段ではなく補完・裏取り手段**。発火条件（いずれか）:

| 条件 | 例 | 上限 |
|---|---|---|
| 市場異常なのに原因ニュースが記事プールに無い | WTI が短時間で大幅上昇、該当クラスタなし | 異常1件につき1回 |
| 無料 source 間で内容が食い違う | 死者数・関税率・金利幅が媒体で違う | クラスタ1件につき1回 |
| 一次情報が見つからない | 報道のみで官公庁・企業発表が無い重要候補 | 同上 |
| 発生時刻が不明 | feed に時刻が無い（Nikkei Asia RSS・@Press RSS は日付欄なしを観測） | 同上 |
| 重要候補なのに詳細不足 | 見出しのみで数値が無い | 同上 |
| internal_trigger_only source でのみ発見 | 表示可能な出典を探す | 同上 |

- **日次上限**（例: 40回/日、要調整）と**クラスタ単位の1回制限**をコードで持つ。上限到達時は「Web Search 未実施」を理由コード付きで記録（PROJECT_RULES の除外ログ要件）。
- 既存の breaking_market（トピック検索）・headline trigger（見出し検索）は**変更しない**。新基盤で Recall が実証できた分野から、別タスクで既存トピック検索の頻度を下げる判断をする（その判断は cost-optimization 側の所管）。

## 7. 分野別の「最速 source」設計（要約。詳細は catalog）

| 分野 | 最速候補（無料・規約上の見込みが比較的良い順） | 弱点 |
|---|---|---|
| 日本 金融政策・政府 | 日銀 RSS、金融庁 RSS、財務省（RSS URL 変更・要再調査）、官邸（RSS 404・要再調査） | 財務省・官邸・JPX の RSS URL が既存提案ファイルの値では 404。為替介入は事後公表 |
| 米国・世界経済 | FRB（press/speech）、BEA、BLS、Treasury（RSS 取得不可・要再調査）、Federal Register API、ECB、BoE | 発表は時刻既知→カレンダー駆動で十分。市場の反応・要人発言は報道頼み |
| 地政学 | White House / State Dept / DoD（米公式・PD）、EC Press Corner、GDELT（商用可・メタデータ）、BBC・Guardian・SCMP・Kyiv Independent（許諾確認後）、防衛省（遅い） | CNBC・NYT・FT・Dow Jones・Al Jazeera は規約上 D、UN News は非商用規約で C。J-Alert・UKMTO は機械取得経路なし |
| エネルギー | EIA（PD）、White House / State（制裁・中東）、OilPrice、Rigzone、gCaptain、Maritime Executive、Splash247（いずれも規約要確認） | OPEC は 403・RSS なし、IEA は feed なし、CNBC は規約上 D。原油急騰の「原因」は報道頼み。価格データは異常トリガーで補う |
| 半導体・AI | EE Times Japan、MONOist、ITmedia、The Register、TechCrunch、NVIDIA/Samsung/OpenAI newsroom、TrendForce（RSS 空） | TrendForce 等の価格情報は RSS が機能していない。Nikkei Asia RSS は時刻なし |
| 日本企業（IR 以外） | EDINET（大量保有・公開買付）、金融庁・消費者庁（処分・リコール）、PR TIMES・@Press・業界媒体（許諾取得後） | 事故・訴訟・不祥事の初報は一般報道に依存し、**国内報道は規約上使えない**。TDnet も無料の許可経路なし |
| 災害 | JMA 防災情報 XML、USGS、GDACS | 既存調査どおり定常電文のノイズが大きい→電文種別で絞る |

## 8. 運用・観測

- source ごとの成功率・遅延（`published_at` と `fetched_at` の差）・件数/日・403/429 回数を毎日集計。
- **「最後に新着があった時刻」が通常より長い source を自動で警告**（feed の静かな停止を検知。例: Microsoft newsroom feed は最新が 2025-05 で停止していた）。
- 規約・robots の再確認日を source 定義に持ち、90日ごとに再確認。

## 9. 既存との境界（STOP 条件の確認）

- N1 で既存 `important-news-monitor` を編集する必要は**生じていない**。
- 新基盤の shadow 観測は新規 Function・新規テーブルで可能（N2 で別承認）。既存 monitor への接続は、Recall 実証後に cost-optimization 側と合意して別タスクで行う。
- 参考として、以下は**既存 monitor 側の所管事項**として報告のみ行う（編集していない）:
  - headline trigger が使う Al Jazeera の規約（robots.txt に商用・AI・TDM 禁止の明示文言）。
  - `news_collection_scope_proposal.ts`（未接続の提案ファイル）の財務省・官邸・JPX・防衛省 press の RSS URL が 404/403。

## 10. 95% 目標の評価とユーザー判断事項

- **無料・規約適合の経路だけで「株式市場に重要なニュースの約95%」は現実的ではない**と評価する（ベンチマーク前の見立て）。
  - 公的機関が一次発表する事象（金融政策・指標・関税・制裁・規制・災害・法定開示）は、無料・Tier A でかなり高い割合を狙える。
  - 報道が一次情報になる事象（戦争・攻撃・事故・海上封鎖・企業不祥事・国内一般ニュース）は、規約上使える無料 source が GDELT 程度しかなく、**ここが 5% を大きく超える穴になる見込み**。
- 95% を目標に置くなら、次のいずれか（または組み合わせ）が必要:

| 選択肢 | 内容 | 費用 | 評価 |
|---|---|---|---|
| ① 限定 Web Search を残す | 報道起点の分野だけ、見出し起点（GDELT・公式）の補完検索を続ける | 月 $2〜24 程度の見込み（cost 文書） | 最も安い。既存 headline trigger と同型 |
| ② 商用ニュース API | GNews（€49.99/月〜）、newsapi.ai（$90/月〜）など | 月数千〜数万円 | 見出しの表示権は元媒体に残る点を要確認 |
| ③ 通信社・新聞の配信契約 | 時事・共同・ロイター等 | 要見積り | 国内速報の本命。最も確実だが高い |
| ④ 提携・許諾 | PR TIMES（パートナーメディア）、ITmedia（アプリ組込相談）、BBC、日銀（見出し表示） | 交渉次第 | 企業ニュース（PR TIMES）の効果が大きい |
| ⑤ TDnet API | 適時開示の正式経路 | 基本料 ¥70,000/月〜 | 既存 TDnet レーンの規約リスク解消にもなる |

- N1 の推奨: **N2 は無料・Tier A と GDELT で shadow 観測を始め、ベンチマークで「どの分野がどれだけ落ちるか」を実測してから ②〜⑤ を判断する**。① は当面残す（削るのは実測後）。
