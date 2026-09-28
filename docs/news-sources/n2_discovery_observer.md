# N2 — 低コスト News Discovery 観測基盤 ＋ 銘柄紐付け v0

- 作成: 2026-09-28（G1〜G4 外の直接作業。worktree `kabumori-n1-news-sources`、branch `claude/n1-news-source-inventory-20260928`）
- 位置づけ: **観測専用**。`important-news-monitor`、breaking_market、headline trigger、shadow、Fact/Voice、app copy、Push、X、アプリには**接続していない**。
- production 変更・migration・Cron・deploy・Web Search・AI 呼び出し：**すべて 0**。

## 1. 構成

```text
source_registry.ts   Source Registry + Source Policy（DIRECT_SOURCE / DISCOVERY_ONLY / DISABLED）
      │  fetchableSources() … DISABLED・未許可・APIキー要は取得しない
      ▼
fetcher.ts           1 source 1 リクエスト。source 別 timeout、ホスト別間隔（GDELT 6 秒）、
      │              宣言 UA、条件付き GET、失敗は例外でなく分類（TIMEOUT/HTTP_ERROR/RATE_LIMITED/…）
      ▼
parsers.ts           RSS 2.0 / RSS 1.0(RDF) / Atom / Federal Register JSON / GDELT JSON / EDINET JSON
      ▼
pipeline.ts          filter（JMA 定常電文）→ normalize.ts（URL・タイトル・時刻）
      │              → dedupe（store.ts）→ topics.ts（topic・entity）→ company_alias.ts（ticker）
      │              → same_event_group → NewsSignal
      ▼
store.ts             NewsSignalStore インターフェース（InMemory / JSON ファイル）。DB 案は news_pool_schema_proposal.md
holdings.ts          将来の「保有銘柄ニュース」用の純関数（tracked_stocks とは未接続）
observe.ts           ローカル read-only 実行 CLI（統計 JSON を出力）
```

- 配置は `supabase/functions/_shared/news_discovery/`。`_shared` は単独の Function として deploy されないため、誤 deploy の経路がない。将来 Function 化する場合もここから import できる。
- 既存 monitor・shadow のコードは import していない（逆方向の import もない）。

## 2. Source Policy

| policy | 意味 | 保存してよいもの |
|---|---|---|
| DIRECT_SOURCE | 公式一次情報（米連邦 PD、日本 PDL1.0、ECB・EC の出典表示条件） | 見出し、280 字以内の要約ヒント、URL、時刻。本文は N2 では保存しない。画像は使わない |
| DISCOVERY_ONLY | 「報道がある」ことの発見だけ（GDELT） | URL、ドメイン、見出し（照合用・**表示禁止**）、言語、国、GDELT 検出時刻。本文・画像・要約は保存しない |
| DISABLED | N1 で規約上 D、または不明確・事前相談が必要 | 取得しない（registry に理由付きで残し、再追加を防ぐ） |

`validateRegistry()` は次の編集をテストで検出して失敗させる。

- DISABLED の有効化
- 商用利用が prohibited / unclear の source の有効化
- DISCOVERY_ONLY で本文・画像を許可すること
- DIRECT_SOURCE に公式一次情報以外を入れること

### 一覧（2026-09-28 時点）

- **DIRECT_SOURCE（有効 18）**
  - 米国：Federal Register API、FRB press、SEC EDGAR 8-K、White House news、USTR、BEA、EIA Today in Energy、EIA press、USGS significant
  - 欧州：ECB press、EC Press Corner
  - 日本：財務省、金融庁、首相官邸、ESRI、消費者庁、気象庁 eqvol、気象庁 extra
- **DIRECT_SOURCE（登録済み・N2 では無効 2）**
  - EDINET API v2：無料 API キーの取得にユーザーのアカウント登録が必要。パーサーは fixture でテスト済み。
  - 米国務省 press：N1 のブラウザ相当の取得は 200 だったが、宣言した observer UA では 403。UA を偽装して取得することはしない。
- **DISCOVERY_ONLY（1）**：GDELT DOC 2.0（英語ソースに限定した 4 クエリ）
- **DISABLED（16）**
  - 国内：日銀（商用転載は事前相談）、NHK、時事、朝日、毎日、Yahoo!ニュース、TDnet 閲覧サイト、JPX RSS、PR TIMES、ITmedia
  - 海外・横断：Google News、BBC、Al Jazeera、UN News、CNBC、FT

## 3. NewsSignal

`types.ts` の `NewsSignal`。主な方針:

- `published_at` は source が明示した時だけ。精度 `datetime` / `date`（Federal Register は日付のみ）を併記。
- Atom の `updated` は `updated_at` に入れ、`published_at` には流用しない（SEC 8-K・USGS・気象庁は `published_at=null`、`updated_at` あり）。
- GDELT の `seendate` は公開時刻ではないため `detected_at` に分離。
- 金融庁は時刻を「JST」と略号で書くため、明示された略号だけを +09:00 として解釈する。タイムゾーンの無い ISO 時刻は拒否する（UTC と仮定しない）。
- 未来時刻（Samsung の例）は値を変えずに `future_timestamp` フラグを付ける。
- `needs_verification`：Web Search が役立ちそうな理由を記録するだけで、**検索は実行しない**。値は `no_published_at`、`date_only_precision`、`future_timestamp`、`discovery_only_needs_primary`、`weak_ticker_only`。
- `image_url` は `image_usage_allowed` の source だけ（N2 の DIRECT は全て不可なので常に null）。画像のダウンロードはしない。

## 4. 重複除去

1. `source_id` ＋ `external_id`（guid / document_number / accession / docID）
2. canonical URL（tracking パラメータ・fragment・既定ポート・末尾スラッシュ除去、パラメータ整列）
3. 正規化 URL キー（スキーム・www 無視）
4. タイトル指紋（NFKC・記号除去・媒体名サフィックス除去）

**実データで分かった重要な例外**:

- URL 一致でも、同じ source が**別タイトル**で同じ URL を使う場合は新しい signal とした。ESRI の指標ページが毎回同じ URL だったため。
- タイトル一致は**別 source のときだけ**重複とした。同じ source の同名文書は別物として残す。
  - 修正前は、官邸の「北朝鮮弾道ミサイル発射に関する総理指示」が 9/20 の同名の指示に統合されていた。新しい発射の取りこぼしにつながる危険な誤りだった。
  - Federal Register の同名の別文書 4 件も誤統合されていた。
- 同一事象グループ（`same_event_group`）は AI を使わない。別 source 間で次のどちらかを満たせば同じグループにする。
  - タイトルのバイグラム類似度が 0.6 以上（日本語は平仮名を除いて比較）
  - 同じ確定 ticker を持ち、topic が 1 つ以上重なる

## 5. 銘柄紐付け v0

- 辞書は 2 種類。
  - stocks_master の上場 4,442 社（read-only で取得）から自動生成：正式名と、HD・グループを除いた略称。
  - 手で確認した seed（18 社）：英語名・ブランド・製品・子会社。例：8136 サンリオ → Sanrio / ハローキティ / Hello Kitty / サンリオピューロランド。
  - AI での alias 生成はしていない。stocks_master に無いコードの seed は捨てる（警告を出す）。
- 強さは `EXACT_COMPANY_NAME` / `STRONG_ALIAS` / `WEAK_ALIAS` / `TICKER_CODE` の 4 段階。**WEAK だけでは確定しない**。確定には、文脈語、2 つ目の弱い alias、ticker コードのいずれかが必要。
- 誤検出対策:
  - **最長一致**：「日立建機」を「日立」、「トヨタ紡織」を「トヨタ」と判定しない。
  - **英字の語境界**：TEL と HOTEL、LINE と LINEAR を区別する。
  - **カタカナの境界**：「リコール」の中の「リコー」、「データベース」の中の「ベース」、「ワーキング」の中の「キング」、「ツーリズム」の中の「リズム」を一致させない。いずれも実データで起きた誤りへの対策。
  - **未レビューのカタカナ 3 文字以下の正式名は弱い扱い**（キング・リズム・レイ など）。
  - **1 文字の生成略称は作らない**：宝ホールディングスの「宝」が「金宝堂」に一致しないようにする。
  - **打ち消し語**：「リチウムイオン」の中の「イオン」を一致させない。
  - **同じ表記を複数社が持つ場合は両方弱い扱い**：「ソフトバンク」は 9434 と 9984 の両方に候補として返し、確定させない。
  - **1 見出しで 10 社超は市況記事として全て候補止まり**。
- ticker コードは次の形式を認識する：`7203.T`、`TYO:7203`、`証券コード7203`、`東証プライム 7203`、`(7203)`。括弧内の 19xx・20xx は年と区別できないため、社名の裏付けがあるときだけ採用する。EDINET の secCode は構造化 ticker として扱う。

## 6. 実地確認（2026-09-28、read-only、1 source 1 回）

### 1 回目（修正前）

- 15 リクエストすべて成功、signal 277 件。
- 実データでの問題を検出した：誤った確定紐付け 7 件、タイトル一致による誤統合、金融庁の時刻が取れない、GDELT の 32/38 件が非英語で topic 無し。
- §4・§5 と JST 対応、GDELT の英語限定で修正した。

### 2 回目（修正後、代表 source 19 本＋GDELT 2 クエリ）

| 指標 | 値 |
|---|---:|
| リクエスト | 21（成功 19 / 失敗 2：米国務省 403、GDELT 429） |
| 取得 item | 437 |
| 事前 filter（気象庁の定常電文） | 69（eqvol 29、extra 40） |
| 正規化成功 | 368 / 368（100%） |
| 重複 | 1（官邸 feed 内の同一 URL の重複掲載） |
| 新規 signal | 367 |
| published_at 取得率 | 77%（datetime 精度 71%。Atom の updated のみの source を含めると時刻あり 100%） |
| thumbnail（image_url）率 | 0%（N2 の DIRECT は画像不可の方針。取得はしていない） |
| topic 付与率 | 76% |
| ticker 確定 / 候補のみ | 0 / 2（「ARE」→AREホールディングス、「山口政務官」→山口FG。どちらも弱い alias で確定させていない） |
| AI 呼び出し / Web Search | 0 / 0 |
| 転送量 | 約 1.4MB |

- **繰り返し取得**：同じ pool に 3 source（財務省・消費者庁・FRB）を再取得したところ、80 件すべてが重複判定（`source_external_id` 40・`canonical_url` 40）で新規 0 件だった。
- **source 別の取得件数（2 回目）**：

| source | 新規 signal | 備考 |
|---|---:|---|
| 財務省 | 40 | |
| SEC 8-K | 40 | |
| BEA | 40 | |
| GDELT | 40 | 1 クエリ分。もう 1 クエリは 429 |
| White House | 30 | |
| 官邸 | 22 | |
| Federal Register | 20 | |
| FRB | 20 | |
| 消費者庁 | 20 | |
| EIA Today in Energy | 19 | |
| 金融庁 | 15 | |
| ECB | 15 | |
| EIA press | 11 | |
| USTR | 10 | |
| EC | 10 | |
| ESRI | 10 | |
| 気象庁 eqvol | 4 | 震源・震度 3、噴火警報 1 |
| USGS | 1 | M6.6 New Caledonia |
| 気象庁 extra | 0 | 特別警報なし |

- **topic 例**：

| topic | source | 見出し |
|---|---|---|
| war | 官邸 | 北朝鮮弾道ミサイルの可能性があるものの発射に関する総理指示 |
| tariffs | Federal Register | Tin Mill Products From China, Taiwan, and Turkey |
| recall | 消費者庁 | リコール製品で火災等 |
| disaster | USGS | M 6.6 - New Caledonia |
| oil / energy | GDELT | Brent 価格の上昇報道 |
| macro_data | BEA | U.S. International Transactions |

- **ticker 確定の実例は今回の実データでは 0 件**。公式 source が上場企業名を見出しに出すことが少ないためで、確定の動作はテスト（fixture）で確認している。GDELT の日本企業クエリは 60 秒空けても 429 で、実データでは確認できなかった。

## 7. テスト

`deno test --no-check --allow-read=supabase/functions/_shared/news_discovery supabase/functions/_shared/news_discovery/` → **55 passed / 0 failed**。

- Fetcher：正常、timeout、network error、HTTP error、429、GDELT の文面による制限通知、malformed、truncated、空・空白 body、item 0 件の正常 feed、DISABLED・未許可・APIキー要は無通信で拒否、ホスト間隔、条件付き GET（304）、Shift_JIS
- Normalize：published あり・なし、日付のみ、JST 略号、タイムゾーン無しの拒否、未来時刻、canonical URL、tracking パラメータ、scheme・www、日本語・全角、要約ヒントの文字数上限
- Alias：正式社名（全角）、英語名、strong、weak の誤検出防止、文脈による確定、複数企業候補、最長一致、seed 優先、打ち消し語、コード形式、構造化 ticker、上場廃止、実データの回帰（リコール・データベース・ワーキング・ツーリズム・金宝堂）
- Dedupe：同一 URL、tracking 違い、タイトル正規化、別 source の同記事、再実行、短い一般タイトルは統合しない、同一 source の同名文書は保持、同一 URL の新タイトルは保持
- Pipeline：1 source の失敗で止まらない、GDELT は discovery only、画像の扱い、same_event_group、保有銘柄 fan-out、topic と entity（大文字略語の大小区別）、気象庁 extra の filter
- 本体（テスト以外）の `deno check` と `deno lint` は通過。テストファイルの `deno check` は `node:test` の型定義（npm:@types/node）が無いため不可で、既存テストと同じ既知の環境制約。

## 8. 利用規約上の注意

- GDELT：引用とリンクが条件。見出しは元媒体の権利なので**表示しない**（`discovery_only`、`holdingNewsCandidates` も既定で除外）。GDELT 経由で DISABLED 媒体（例: Al Jazeera）の URL が見つかることもあるが、保存するのは URL・ドメイン・見出し（照合用）だけで、本文は取得しない。将来表示するのは一次情報の URL に限る。
- 日本の PDL1.0 と ECB・EC：将来表示する場合は出典表記（registry の `attribution`）が必須。
- 気象庁：警報を出典付きで伝えるのは可。独自の警報のように見せる表示は気象業務法 23 条に抵触し得る。
- SEC：UA 宣言と 10 req/s 以下。本 observer は 1 回 1 リクエスト。
- 米国務省：observer UA で 403。UA を偽装して取得しない方針で無効化した。

## 9. 残課題

1. **GDELT が 429 を連発**。5 秒間隔を守っていても出る。共有 IP 制限の可能性があり、本番の巡回に組み込めるかは要検証。1 日の観測で成功率を測る必要がある。
2. **ticker 確定の実データ例が無い**。公式 source だけでは企業ニュースがほぼ出ない（N1 の結論どおり）。PR TIMES の提携、EDINET の API キー、TDnet API のいずれかが無いと、企業紐付けの価値は発揮されない。
3. **EDINET の API キー**（ユーザーのアカウント登録が必要）。大量保有・公開買付は Tier A の企業情報源。
4. **気象庁電文の重要度判定**：震度の閾値（例: 5 弱以上）や津波の区分の判定は未実装で、今はタイトルの allowlist だけ。
5. **alias 辞書の網羅**：seed は 18 社。自動生成の略称（「ARE」「山口」）は弱い候補を出すので、候補の表示方針が必要。EDINET コードリストと Wikidata からの取り込みは N3。
6. **topic ルールの精度**：英語の一般語（oil を名前に含むファンドの 8-K、rule 等）によるノイズ。正例・負例の fixture を増やして調整する。
7. **米国務省・BLS・BoE** は未追加・無効。アクセス条件を確認してから追加する。
8. DB 永続化は未実装（schema 案のみ）。`fetched_at` を持つ pool が無いとベンチマーク（N2-b）で遅延を測れない。

## 10. N3 への推薦

1. **N3-a：schema 案のレビューと承認 → expand-only migration → Postgres 版 store**。新規 Function（観測専用）を作り、Cron は低頻度（例: 30 分）で別承認。
2. **N3-b：2 週間の観測とベンチマーク開始**（event 台帳、ChatGPT ログとの突き合わせ）。source 別の成功率、GDELT の 429 率、topic 精度を実測する。
3. **N3-c：EDINET API キーの取得（ユーザー作業）→ EDINET を有効化**（大量保有・公開買付・臨時報告書で ticker 確定の実例を得る）。
4. **N3-d：alias 辞書 v1**（EDINET コードリストの英字名、Wikidata のブランド・子会社、保有上位 100 社の手作業レビュー）。
5. **N3-e：気象庁電文の本文を解析**（最大震度・津波の区分）して、定常電文との区別を強化する。
6. 既存 monitor との接続は、ベンチマークで Recall を実証した後に cost-optimization 側と合意して行う（STOP 条件の対象）。
