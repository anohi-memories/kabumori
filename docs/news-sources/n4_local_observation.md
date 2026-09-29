# N4 ローカル実データ観測 — 2026-09-29（STOP：BLOCKER 1 件）

- branch: `claude/n4-local-observation-20260929`（worktree `/Users/yuya/Developer/kabumori-n4-local-observation`）
- base main: `435ddc5`（N3 統合 commit `2fc9e47` を含むことを確認）
- 判定: **STOP**。Run 1 で observer の保存が全件失敗した（実質的な observer crash）。規定により Run 2 は実行していない。
- production_mutation = 0、production_observer_invocations = 0、OpenAI_API_requests = 0。コード変更なし。

## 環境

| 項目 | 内容 |
|---|---|
| DB | 使い捨て PostgreSQL 17.11（`/private/tmp` の Unix ソケットのみ）。既存 proof runner（`supabase/tests/news_discovery_observer_run.sh`、`KEEP_DB=1`）で N3 migration だけを適用し、proof は PASS。全 migration chain は流していない |
| stocks_master | repo のテスト fixture に書かれている 23 社だけを使用（本番データは不使用）。誤一致の罠（リコー、ベース、キング、リズム、宝HD、山口FG）を含む |
| Data API | 既存の PostgREST shim（`supabase/tests/news_discovery_postgrest_shim.ts`、127.0.0.1 のみ） |
| observer | 実際の `createObserverHandler` を、repo 外の一時 harness から 1 回だけ実行した。source は実 fetch |
| 検索 | search provider なし（Web Search は実行できない状態）。OpenAI と `*.supabase.co` は harness で遮断し、`--deny-net=api.openai.com` も指定 |

## Run 1（1 invocation）

- 要求内容：既定の DIRECT source 18 本＋GDELT 1 クエリ、`search.enabled: true`（provider がないので skip されることを確認する目的）
- 結果：**HTTP 500 / run `failed`**、`RUN_FAILED:DB_RPC_FAILED:news_discovery_insert_signals:23514:400`
- 外部 request：**19 回**（1 source 1 回、retry なし）

| 指標 | 値 |
|---|---:|
| 全体の所要時間 | 65.5 s（deadline 120 s・使用可能 95 s に対して未到達。`deadline_reached: false`） |
| source 取得時間の合計 | 63.0 s（逐次） |
| 最長の source | GDELT 20.0 s（**timeout**）、SEC 8-K 13.6 s、消費者庁 5.4 s、USTR 4.3 s |
| RPC 合計 | 0.9 s（begin 91 ms、find_duplicates 18 回で各 20〜80 ms、insert 258 ms で失敗、finish 24 ms） |
| source の成否 | 対象 19、完了 19、skip 0。DIRECT 18 本はすべて HTTP 200、GDELT は timeout |
| documents | 取得 517、事前 filter 124（気象庁の定常電文：eqvol 24・extra 100）、正規化 393、run 内の重複 1（SEC） |
| signals | 保存 **0**（topic 付き候補 324、ticker は候補 3・確定 0） |
| 検索 | search_count 0、ai_calls 0、web_search_calls 0 |
| execution | `{"elapsed_ms":65511,"deadline_reached":false,"sources_completed":19,"sources_skipped":0,"searches_completed":0,"searches_skipped":0,"signals_persisted":0}` |

- 失敗後の DB は整合していた。run は `failed` で正しく閉じられ（`running` のまま残らない）、source ごとの結果と totals も記録された。
- 部分保存はなかった（バッチが原子的に rollback された）。

## BLOCKER：一つの不正 URL で run 全体の保存が失敗する

- **事象**：BEA の RSS に、スキームの無いリンク（`www.bea.gov/news/2026/gdp-advance-estimate-…`）を持つ item があった（Postgres ログの DETAIL で確認）。
  1. `normalizeItem` は生のリンクを `source_url` に入れる。
  2. DB の `CHECK (source_url ~ '^https?://')` がこれを拒否する。
  3. `insert_signals` は 1 バッチ＝1 トランザクションなので、**全 source の 393 件が rollback され、run は failed になった**。
- **付随する問題**：`canonicalizeUrl(link, feedUrl)` は、スキームの無い host 付きリンクを相対パスとして解決する。その結果、実在しない canonical（`https://apps.bea.gov/rss/www.bea.gov/news/…`）が作られる。
- **影響**：BEA がこの形式の item を出している間は、observer の実行が毎回保存 0 件で失敗する。production canary の前に修正が必須。
- **修正案（今回は実装していない）**:
  1. 正規化で、`source_url` にも検証済みの絶対 http(s) URL だけを入れる。スキームが無く `host.tld/…` 形式のリンクだけは `https://` を補う（相対パスとは区別する）。それ以外の不正なリンクは item 単位で `invalid_url` として落とし、統計に数える。
  2. DB の CHECK に当たる値を client 側で事前検証し、不正な 1 行が他の source の保存を巻き込まないようにする（source 単位のバッチ化、または行単位の除外）。
  3. 回帰テストに、BEA 形式のスキーム無しリンクを fixture として追加する。

## SHOULD FIX

1. **GDELT の timeout 20 s が、run の約 3 割を占めた**。
   - 既定は off だが、有効にすると単独で最長になる。deadline の gate は開始前の判定なので、timeout 自体は守られている。
   - GDELT の timeout を短くする（例：8 s）か、既定の off を維持する。
2. **失敗経路で error_summary が上書きされる**。
   - `search.enabled: true`（provider なし）の skip 記録 `SEARCH_PROVIDER_NOT_CONFIGURED` が、失敗経路の `RUN_FAILED:…` で上書きされ、run には残らなかった。
   - 正常終了時は記録されることを自動テストで確認済み。失敗経路でも note を保持したい。

## FUTURE

1. SEC 8-K の取得に 13.6 s かかった（28 KB）。巡回間隔の設計で考慮する。
2. source 取得は逐次で、合計が source 数に比例する。source を増やす前に、host 単位での並列化を検討する。
3. GDELT の HostRateGate による最大 6 s の待ちは、今回は 1 クエリのため 0 s（実測）。2 クエリにすると最大 6 s が deadline 計算の外で加わる。

## 未実施（STOP のため）

- Run 2（再取得時の dedupe の観測）。
- 保存済み signal の人手による品質分類（relevant / irrelevant / stale / 誤一致など）と代表例。保存 0 件のため、DB から確認できない。候補はメモリ上にしかなく、再取得は禁止のため行っていない。
- 実データでの会社 alias の誤一致確認。ticker 候補 3 件の中身は保存されていない（確定 0 件）。
- 実データでの tracking parameter（`client_id` / `session_id` など）の有無。signal が保存されていないため未確認。

## 安全

- secret、生の応答、記事本文は保存していない。
  - harness の出力（scratchpad）には source URL・状態・所要時間だけが残っている。
  - secret らしき文字列の scan は 0 件。
- 使い捨て DB・shim・ローカル専用 key は削除済み。
- テスト 123 件合格、型検査・lint・`git diff --check` は OK。

---

# 再観測（BLOCKER 修正後）— 2026-09-29：PASS

- 修正 branch：`claude/n4-fix-schemeless-url-20260929`、commit `f11fa84`（base main `c617fac`）。
  - `resolveHttpUrl` を追加し、`source_url` を解決済みの絶対 URL にした。不正なリンクは記事単位で除外する。
  - migration と DB 制約は変更していない。テスト 131 件合格。
- 環境は前回と同じ。新しい使い捨て PostgreSQL 17（N3 migration のみ、proof PASS）、テスト fixture の 23 社、ローカル shim、実 feed を使い、Web Search provider はなし。
- invocation は 2 回（Run 1＋Run 2）、外部 request は 38 回（各 run 19 回、retry なし）。

## Run 1（新規）

| 指標 | 値 |
|---|---:|
| 結果 | HTTP 200、`completed`、`deadline_reached: false` |
| 所要時間 | 37.7 s（source 取得の合計 34.0 s、RPC 合計 約 1.0 s） |
| 最長の source | GDELT 17.0 s、EC 4.0 s、SEC 1.9 s |
| source | 対象 19、成功 19（GDELT 含む）、skip 0、redirect 0 |
| documents | 取得 575、事前 filter 131（気象庁の定常電文）、正規化 444、不正 URL による除外 0、run 内の重複 0 |
| signals | **保存 444**（topic 付き 353、ticker は候補 3・確定 0） |
| 検索 | 0 回。skip は `SEARCH_PROVIDER_NOT_CONFIGURED` として run に記録された |

- BEA 48 件のうち **42 件がスキーム無しの `www.` リンク**だった。すべて `https://www.bea.gov/...` として保存された。
  - `apps.bea.gov/rss/...` のような誤った canonical は 0 件、`^https?://` を満たさない URL も 0 件。

## Run 2（同一条件で再実行）

| 指標 | 値 |
|---|---:|
| 結果 | HTTP 200、`completed`、29.7 s、`deadline_reached: false` |
| source | DIRECT 18 本は成功。GDELT は **429**（任意の層なので run は悪化しない） |
| dedupe | 正規化 394 件が**すべて重複**と判定され、保存 0 件。pool は 444 件のまま |

- 同じ canonical URL を再保存しなかった。不要な重複 signal も増えなかった。
- ESRI の「同じ URL に新しいタイトル」は、前回どおり別 signal として保持されている（N2 の規則どおり）。

## 品質（20 件を人手で確認）

| 分類 | 件数 | 例 |
|---|---:|---|
| relevant | 7 | 財務大臣会見（9/29）、流動性供給入札の実施額、金融庁 会計基準の改正公布、EIA Henry Hub 価格、月例経済報告の閣僚会議、GDELT「Iran currency record low」「Iran war timeline」 |
| ambiguous / low relevance | 5 | 日モンゴル首脳会談、FRB の銀行合併承認、Boeing 耐空性改善通報（FR）、気象庁 震源・震度（規模次第）、UAE–Netanyahu 報道 |
| irrelevant | 5 | 消費者庁「電気・ガスの契約トラブル」、FR 空港指定の取消、White House「College Sports」、SEC 8-K（Onar Holding）、GDELT 住宅ボイラー補助金（アイルランド） |
| low-quality | 2 | GDELT のタグ一覧ページ（`newsroomamerica.com/tag/texas_diesel_prices`）、米国の小規模なローカル紙が中心 |
| stale | 1 | BEA「Multinational Companies, 2011」（2013-04-18） |
| wrong topic | 3 件で topic の不足 | 月例経済報告 → topic なし、UAE–Netanyahu → topic なし、流動性供給入札 → fiscal のみで rates が無い |
| restricted-source | 0 | 保存された signal で `restricted_publisher` は 0 件 |

- **会社 alias**：候補 3 件はすべて弱い一致で、確定は 0 件。
  - 「山口政務官」→ 山口FG（候補止まり）。
  - 「指定報告機関**ベース**」→ ベース（4481）が 2 件（候補止まり）。
  - 誤って確定された例は無い。
- **age**：保存 444 件の内訳は 1 日以内 69、1〜7 日 87、7〜30 日 118、30 日超 77、時刻なし 93。
  - 30 日超のうち 46 件は BEA（feed に 2013 年以降の履歴が入っている）。EIA は 20 件、Fed は 9 件。
- **URL / tracking**：`client_id` / `session_id` などは**実 source には 0 件**（query は `id` 19 件、`update` 2 件、`ID` 1 件だけ）。redirect 0、不正 URL 0。
- **GDELT**：
  - Run 1 は 17.0 s で 200、記事 50 件（すべて英語）。topic 付きは 24 件。
  - host は米国のローカル紙が中心（arkansasonline 5、business-standard 4 など）で、日本株向けには質が低めだった。
  - Run 2 は 11.5 s で 429。
  - HostRateGate の待ちはクエリ 1 本のため 0 s。

## 判定：PASS

- 次の条件をすべて満たした：実 DIRECT source の取得成功、crash なし、restricted の保存 0、誤った確定 0、重複処理は期待どおり（Run 2 で保存 0）、deadline に余裕あり（最大 37.7 s / 使用可能 95 s）、Web Search 0、production traffic 0、secret 漏洩 0。

## SHOULD FIX（production canary 前に直す価値が高い）

1. **古い item の取り込み**：鮮度の窓が無いため、BEA / EIA / Fed の古い release（2013 年など）が「新しい signal」として初回に大量に入る。source ごとの取り込み窓（例：公開から 30 日以内）が必要。
2. **GDELT の質と時間**：17 s・429、ローカル紙中心。既定は off のまま維持し、使うなら timeout の短縮とドメインの質の filter が必要。
3. **topic の不足**：月例経済報告（macro_data）、地政学の見出し（UAE–Israel）、入札（rates）で topic が付かなかった。辞書の拡充が必要。

## FUTURE

- 失敗経路で search の note が上書きされる件（前回観測）。
- SEC 8-K のノイズ：米国の小型株が大半。日本株との関係づけ（ADR・取引先）が必要。
- source の並列取得、GDELT の待ちを deadline 計算に含めること。
