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
