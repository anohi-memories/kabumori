# IR以外の企業ニュース取得・銘柄紐付け設計（N1）

- 作成: 2026-09-28（N1 調査。G1〜G4 外の直接作業）
- 位置づけ: **設計のみ**。コード・DB・Cron・production は変更していない。
- 関連: [news_source_catalog.md](news_source_catalog.md) / [news_acquisition_architecture.md](news_acquisition_architecture.md)

## 0. 結論

1. 「100銘柄なら100回検索」ではなく、**全銘柄共通の記事プール（1回取得）→ 辞書照合で銘柄へ振り分け（fan-out）** にする。記事数に比例するコストは辞書照合（CPUのみ・ほぼ無料）で、**銘柄数・ユーザー数に比例するコストをゼロにできる**。
2. 紐付けは **AIではなく alias 辞書（Aho-Corasick 相当の多パターン一致）を一次手段**にする。AIに回すのは「曖昧 alias に一致したが文脈で確定できない」ものだけ。
3. alias は6種類（正式名・英語名・略称・ブランド・子会社・人物）を持つが、**全銘柄に同じ深さで持たない**。全約3,900社は「正式名＋英語名＋略称＋コード」まで自動生成、ブランド・製品・人物は**保有・ウォッチされている銘柄と時価総額上位から手作業で厚くする**。
4. 取得経路は「事象タイプ別」に設計する。規約上そのまま使える（Tier A）のは **①EDINET（大量保有・公開買付、公式API・PDL）②金融庁・消費者庁の行政処分・リコール（PDL）③海外相手先の SEC 8-K・NHTSA（米連邦 PD）**。**PR TIMES・@Press・業界媒体は営利利用に許諾が必要**（PR TIMES は提携できれば企業の新製品・提携ニュースで最大の効果）。
5. 最大の弱点は **国内一般報道（NHK・時事・朝日・毎日・Yahoo! 等）が公式規約で個人利用限定／営利利用禁止**であること。事故・訴訟・不祥事の初報はここに依存するため、**許諾・配信契約・限定 Web Search のいずれかが無いと埋まらない**（news_acquisition_architecture.md §10）。
6. alias 辞書と紐付けの仕組み自体は source に依存しないため、**source の許諾状況に関係なく先に作れる**（EDINET・公式・GDELT だけでも価値がある）。

## 1. 全体フロー

```text
[共通記事プール]  RSS / API / sitemap（news_acquisition_architecture.md の取得層）
   │  1記事 = 1行（全ユーザー・全銘柄で共有）
   ▼
normalize        URL正規化・title正規化・published_at(UTC)・言語・publisher
   ▼
dedupe           canonical URL / title類似 / 同一事象クラスタ
   ▼
entity抽出       ① alias辞書 多パターン一致（title + summary）
                 ② 証券コード正規表現（「7203」「(7203)」「7203.T」「TYO:7203」）
                 ③ 英語名・ADRティッカー（"Toyota" "TM" "Sony Group" "SONY"）
   ▼
曖昧解消         ルール（文脈語・否定語・共起）→ 残りだけ軽量AIでbatch判定
   ▼
ticker紐付け     news_entity_link（記事×銘柄×link_type×confidence×根拠span）
   ▼
事象タイプ分類   ルール（リコール/訴訟/事故/提携/M&A/新製品…）→ 不明のみAI
   ▼
fan-out          tracked_stocks / 保有銘柄 と join（DB側。AI不要）
   ▼
保有銘柄ニュース候補（既存の重要度判定へ渡すかは N2 以降で別途決める）
```

- 既存 `important-news-monitor` の TDnet / company_ir レーンは**そのまま**。本設計は並列の新レーン（shadow から開始）を想定する。
- 1記事あたりのコスト: 取得 1 HTTP（フィードに同梱されるため実質 0）＋照合 CPU。**AI呼び出しは曖昧解消が必要な記事だけ**（想定 5〜15%、要実測）。

## 2. alias 辞書の設計

### 2.1 alias の種類と作り方

| alias_type | 例 | 生成方法 | 対象範囲 | 誤爆リスク |
|---|---|---|---|---|
| `official_ja` | トヨタ自動車 / 任天堂 | stocks_master.company_name から「株式会社」「(株)」「ホールディングス」有無の揺れを自動生成 | 全上場（約3,900） | 低 |
| `official_en` | Toyota Motor / Nintendo | EDINET コードリスト（提出者名英字）※項目は要確認、JPX英文銘柄一覧 | 全上場 | 低〜中（"Nikon" 等は低、"Kao" は中） |
| `short_ja` | トヨタ / ソフトバンクG / 三菱UFJ | 報道で使われる略称。自動生成（HD・グループ除去）＋手作業 | 全上場（自動）＋上位（手作業） | **中〜高** |
| `code` | 7203 / 7203.T | 正規表現 | 全上場 | 低（4桁数字は文脈必須：「(7203)」「証券コード」「東証」共起時のみ） |
| `brand` / `product` | ユニクロ→9983、PlayStation→6758、ポケモン→7974（持分）、ドコモ→9432 | 手作業＋Wikidata（CC0: P1716 brand, P355 subsidiary） | 保有/ウォッチ上位＋時価総額上位300 | 中 |
| `subsidiary` | ドコモ→NTT、ダイハツ→トヨタ、Arm→ソフトバンクG | Wikidata＋有報の関係会社（手作業確認） | 同上 | 中 |
| `person` | 経営トップ名 | Wikidata P169（CEO）＋IR役員一覧（手作業） | 時価総額上位100程度 | 高（同姓同名。人名単独では紐付けない） |
| `overseas_counterpart` | TSMC / NVIDIA / Apple | 海外企業は**直接の保有銘柄ではない**ため `relation` として別管理（§3） | 主要テーマ企業50社程度 | — |

### 2.2 曖昧 alias の扱い

曖昧さの典型（例示。実際の辞書は棚卸しで確定する）:

- **一般語と衝突**: 「イオン」（化学用語）、「ライオン」（動物）、「オリンパス」（地名）、「花王」、「東京エレクトロン」は低リスク。
- **グループ名が複数上場**: 「三菱」「三井」「住友」「トヨタ」（トヨタ自動車/豊田通商/トヨタ紡織/デンソー等）、「ソフトバンク」（9984 と 9434）、「ソニー」（6758 と分離上場したソニーFG）、「NTT」系。
- **英語の短い社名**: "Kao"、"Asics"、"Daiwa"。

ルール:

1. alias ごとに `ambiguity`（none / context_required / never_alone）を持つ。
2. `context_required` は、**同じ記事内に文脈語（業種語・社名の完全形・コード）が共起した時だけ**確定。例: 「イオン」＋（店舗|モール|小売|スーパー|イオンモール）。
3. `never_alone`（人名・グループ名）は単独では紐付けず、他の alias と共起した時の confidence 加点にだけ使う。
4. 否定文脈語（「イオン交換」「リチウムイオン」）を alias 単位で持つ。
5. それでも決まらないものだけ AI（Luna 相当、複数件 batch）に「この記事の主語はどの上場企業か」を聞く。**AIの出力は候補リストの中から選ばせる**（自由生成させない）。

### 2.3 保持項目（将来のテーブル案。今回は migration を作らない）

```text
company_alias
  ticker_code, market, alias, alias_norm, alias_type, lang,
  ambiguity (none|context_required|never_alone),
  context_terms[], negative_terms[],
  source (auto|edinet|jpx|wikidata|manual), verified_by, valid_from, valid_to
news_entity_link
  article_id, ticker_code, link_type (direct|brand|subsidiary|product|person|supplier|customer|competitor|theme),
  confidence (0-1), matched_alias, evidence_span, resolver (rule|ai), created_at
```

- `valid_from/valid_to` を持つのは、社名変更・分離上場・上場廃止（stocks_master.delisted_at）に追従するため。
- 除外は PROJECT_RULES「候補選定と除外ログ」に従い、`alias_ambiguous_no_context` / `negative_context` / `delisted` / `low_confidence` など**機械判定できる理由コード**で残す。

### 2.4 辞書の元データ（利用条件）

| 元データ | 内容 | 利用条件 | 判定 |
|---|---|---|---|
| stocks_master（既存） | コード・社名・業種 | 自社DB | 利用可 |
| EDINET コードリスト | 提出者名（和・英）・証券コード | 金融庁 EDINET 利用規約（要確認。政府標準利用規約準拠かを確認） | 有力（要確認） |
| JPX 上場銘柄一覧 | 銘柄名・市場区分・業種 | JPX サイト利用規約（要確認。商用再配布は制限の可能性） | 内部辞書用途なら有力（要確認） |
| Wikidata | ブランド・子会社・CEO・ticker | CC0 | 利用可（ただし鮮度・誤りは手作業確認） |
| 各社IR（役員一覧・ブランド一覧） | 人物・ブランド | 各社規約。内部辞書化は事実情報の抽出 | 手作業で補完 |

## 3. 間接影響（海外企業・競合・サプライチェーン）

ユーザーの保有は主に東証銘柄。NVIDIA・TSMC・Apple 等の記事は **直接紐付けではなく relation 経由** で届ける。

```text
theme_relation
  from_entity (例: TSMC), to_ticker (例: 8035 東京エレクトロン),
  relation (supplier|customer|competitor|theme_peer), strength (high|medium|low), rationale, source
```

- 例（仮説。確定値ではない）: TSMC 設備投資 → 半導体製造装置（8035, 6857, 7735 等）、メモリ価格 → 国内メモリ関連、Apple 新製品 → 電子部品、原油 → 石油元売・商社・空運（逆相関）。
- relation 経由の候補は**直接言及より1段低い confidence** とし、アプリ上も「関連」表示に分ける（誤解防止）。
- relation の初期データは手作業（テーマ50程度）。自動推定は N3 以降。

## 4. 事象タイプ別の取得経路（IR/TDnet 以外）

| 事象 | 一次情報（優先） | 補完（報道・業界） | 機械取得 | 備考 |
|---|---|---|---|---|
| 新商品・新サービス | PR TIMES（全体RDF・企業別。**営利利用は許諾制**）、企業ニュースルーム | 業界媒体（ITmedia・レスポンス・4Gamer・流通ニュース等） | RSS | PR TIMES は件数が非常に多い（全体RDFで200件/取得）。alias一致したものだけ残す |
| 大型契約・提携 | TDnet（既存）、PR TIMES、海外企業の SEC 8-K | 報道RSS | RSS / Atom | 海外相手先の 8-K は SEC の fair access（10 req/s・UA宣言）を守る |
| M&A・TOB・大量保有 | TDnet（既存）、**EDINET API（公開買付届出・大量保有報告書）** | 報道 | API（無料・要キー登録） | アクティビスト保有は TDnet に出ないことがある。EDINET は有力 |
| 訴訟 | 企業IR（重要なもののみ）、裁判所・公取委の公表 | 報道（国内大手は規約上 D。配信契約または限定 Web Search） | RSS / HTML | 報道の商用利用条件が最大の論点 |
| 事故・火災・工場停止 | 企業IR（遅い）、消防・自治体（非構造） | 報道（国内大手は規約上 D）→ GDELT（海外拠点）・限定 Web Search | RSS | 一次情報の機械取得経路が乏しい。**最大の弱点** |
| 不祥事・行政処分 | 金融庁・国交省・消費者庁・公取委の報道発表 | 報道 | RSS（金融庁は RSS 確認済み） | 省庁RSSは政府標準利用規約系が多い（出典明記で商用可が一般的、個別確認要） |
| リコール | 消費者庁リコール情報サイト、国交省自動車リコール、**NHTSA API（米国）** | 業界媒体 | RSS / API | NHTSA は米連邦著作物（パブリックドメイン扱い）。日本車の米国リコールが拾える |
| サイバー攻撃 | 企業IR / お知らせ | 報道・ITmedia・Security NEXT 等 | RSS | 初報は企業サイトの「お知らせ」が多い（IR RSS がない企業も多い） |
| 人事 | TDnet（既存） | 報道 | — | 既存で概ね足りる |
| 海外進出・ブランド | 企業ニュースルーム、PR TIMES | 業界媒体 | RSS | 重要度は低めが多い。ノイズ管理が主課題 |
| 競合動向 | 競合の IR / 8-K / ニュースルーム | 業界媒体 | RSS / Atom | §3 relation で届ける |
| 規制影響 | Federal Register API、BIS、USTR、経産省・金融庁 | 報道 | API / RSS | 業種 theme_relation で届ける |

## 5. ノイズ対策（紐付けの精度）

- **見出し一致を優先、本文一致は加点のみ**。見出しに社名がない記事は「言及あり」だが「主題」ではない可能性が高い。
- 1記事で紐付く銘柄が多すぎる（例: 10銘柄以上）記事は「市況・ランキング記事」として `market_roundup` に分類し、個別銘柄ニュースとして扱わない。
- PR TIMES 等の大量配信は、**alias 一致した記事だけ保存**（一致しない記事は URL と hash だけ dedupe 用に短期保持）。
- 株価ランキング・値上がり率記事（株探等）は「ニュースの原因」ではなく「値動きの記述」。後段の市場異常逆引き（market_anomaly_news_trigger.md）では使えるが、事象ソースとしては低優先。

## 6. 評価方法（N2 で実施）

1. **ゴールドセット**: 保有・ウォッチ上位100銘柄 × 直近2週間の報道見出しを人手でラベル付け（200〜400件）。
2. 指標: 紐付け precision / recall（銘柄単位）、曖昧 alias の AI 送り率、1記事あたり平均紐付け数。
3. 目標（ベンチマーク用の目安、保証値ではない）: 直接言及 precision ≥ 0.95、recall ≥ 0.9、AI 送り率 ≤ 15%。
4. 誤爆事例は alias の `negative_terms` / `ambiguity` へ反映し、辞書をバージョン管理する。

## 7. 既存コードとの関係

- `important-news-monitor` 本体（index.ts / judgement / generation / publish）は変更不要。本設計は**独立した新レーン（まず shadow 相当の観測のみ）**として実装する想定。
- DB は `company_alias` / `news_entity_link` / `theme_relation` / 記事プールの新規テーブルが必要になる見込み。**今回は migration を作らない**。N2 以降で expand-only の新規テーブルとして別途承認を取る。
