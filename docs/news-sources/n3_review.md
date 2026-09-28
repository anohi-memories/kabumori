# N3 review — 2026-09-28

## Overall result

**ローカルレビュー・N3限定の修正完了。本番移行はNO。**

- review base: `1ef3a2af986c1e696f66cf99d80d6160e5a8c44f`
- N3 original branch: `claude/n1-news-source-inventory-20260928`（元worktreeはcleanのまま）
- prior commits: N1 `d02de0786b7678d837af012c34a346d4c7d73c8e`; N2 `b1500321ce53c56ae421b377e1029216ed909afe`
- review worktree: `/private/tmp/kabumori-n3-review-20260928`
- review branch: `codex/n3-review-20260928`
- 開始時fresh origin/main: `19c00bf`。終了前read-only確認: `828a2fde387b0e5a6e5893ccc3462bfbf6b20d01`。
  他workstreamによる更新はレビューbranchへ混ぜていない。
- commit_hash: 新規commitなし（HEADはreview base）。修正はこの独立worktreeの未commit差分。
- push: 未実施。H1/H2の既存TASK/Reportは上書きしない。
- deploy / production migration / production API / Cron / secrets変更: **すべて0**。

## BLOCKER

### B1. 実OpenAI APIの組み合わせ未検証（残存）

モデル・requestパラメータは公式仕様と照合済み。ただし、このアカウントでの
`gpt-5.6-luna` + `web_search` + strict JSON + required tool + `max_tool_calls:1` +
`blocked_domains` + sources/citationsの実応答は一度も確認していない。
mock成功を実検索成功と扱わない。安全な専用keyと明示承認によるstaging smoke確認が本番前に必要。
production secretを取得していない。

### B2. 古いsnapshotによるhard cap超過（修正済み）

元migrationではadvisory lockだけで、REPEATABLE READのsnapshotは更新されない。
隔離DBでcap=1、二つの並行transactionがともにallowed=true、予約2件を再現。
修正: advisory lock後にconfig行をno-op UPDATEし、新しいrow versionを作る。
stale snapshotはserialization failureでabortし、予算を超えない。
最終proofでは実際のhard limit **48**、既存予約47件からREAD COMMITTEDと
REPEATABLE READの両方で、追加成功は1件のみを確認。

## HIGH

### H1. invocation全体の実行deadlineがない（残存）

`observer_handler.ts`で全source取得後に検索を開始し、`web_search.ts`の検索queueは
trigger最大2 + rotation1 + follow-up最大2 = 最大5 request。各検索のtimeoutは60秒。
検索だけでも最悪300秒、さらに順次feed取得・DB処理が加わる。
Supabaseのrequest idle timeout 150秒内の応答は保証されない。
Free worker wall limit 150秒 / paid 400秒とは区別すること。
失敗応答・stale run・消費済みreservationを避けるため、共有deadline、残時間に応じた
fetch/search skip、最後のDB保存用余裕が本番前に必要。N2 fetch orchestrationまで
拡張する変更は今回実施していない。

### H2. 制限domain・URL・partial応答の境界（修正済み）

- `ft.com.`は元のsuffix判定を抜けた。hostnameの末尾ドットを正規化。
- 元parserはcitationにあればlocalhost/private IP/credentials付きURLも受理。
  N3の`safeSearchUrl()`でhttp(s)、credentialなし、IP literalなし、local hostnameなしに限定。
  公開IP literalも保守的に除外する。sources/citations側とmodel items側の双方に適用。
- 完了statusの確認がなくpartial responseを取り込み、null items/content等が例外になった。
  root completed・completedのsearch action **1件**を要求し、malformed応答は安全停止。
- providerエラーでも実応答にあるtool call/token数を保存対象に残す。
- 保存時のno_access結果破棄だけでは、モデルが当該publisherを参照する可能性がある。
  `blocked_domains`をregistryから組み立てて検索requestへ追加。
  NHK等のno_direct_fetchは除外せず、flag付きdiscoveryとして扱う。

### H3. RPC replay・run整合・DB constraintの穴（修正済み）

- `begin_run`と`reserve_search`はidempotentではないのにtransport/5xxで再送していた。
  ACK消失時の二重run/予約を防ぐため、この2RPCだけretry 0。
  read-only/insert/finish/completeのidempotent RPCは最大1 retryを維持。
- signalが別runのsearch_idを参照できた。insert RPCで同一runのnon-denied searchを要求。
- escalation親は同run・同JST日・同lane・trigger rootに限定。in-memory実装も揃えた。
- insert時のrun状態確認をFOR UPDATEにし、finishとの競合中に終了runへ追加しない。
- `multiple_weak`にweak alias1個、または同aliasの重複を渡して確定できた。
  tableで2個以上、RPCでdistinct alias2個以上を要求。
- discovery raw_referenceに任意body keyを隠せた。
  storeはfeed_url/item_indexだけを送り、DBもallowlistと値型を検証する。

## MEDIUM

### M1. useful_signal_countは永続化成功件数ではない（残存）

`web_search.ts`はrun.ingestのin-memory fresh件数でcomplete_searchし、その後
`observer_handler.ts`のrun.finishでsignalをDB保存する。
後続保存失敗やinsert conflictでもsearchのuseful/new countは減らない。
さらにcatchのfinish_runはtotals={}を渡すため、run集計上は検索数/AI数が0へなる。
検索rowのtoken/call情報が残る場合でも、run側だけから費用/有用性を集計してはいけない。
「1 persisted useful signalあたり費用」はsearch_id joinによる実保存数との照合、
失敗時の途中metrics保存が必要。今回このライフサイクルは大きく組み替えていない。

### M2. 別sourceをまたぐdedupeは並行runで完全atomicではない（残存）

DB uniqueはsignal idと(source_id, external_id)のみ。
先行find_duplicatesが両runでmissになれば、異なるsource/idの同URL/同titleが両方insert可能。
今回追加したrun row lockは別runを相互排他しない。
同source同titleの別documentを消さない条件を維持しつつ、DB内の判定とinsertのatomic化を検討する。
観測用poolの重複・有用率に影響するが、既存monitor/Push/Xへは接続していない。

### M3. URLの公開性と鮮度は完全証明ではない（残存）

文字列上の危険URLは除外するが、公開名がprivate IPに解決するDNS rebinding、
redirect先、tracking wrapperの最終destinationは確認しない。N3は記事ページをfetchしない。
将来fetcherへ渡す前にDNS回答・全redirect hopの検査が必須。
また「6時間以内」はprovider prompt条件で、一次資料のpublication timeを検証していない。
search signalに架空のpublished_atを保存せず、primary確認待ちとして扱う設計は維持。

## LOW

- request.text / provider response.json / feed arrayBufferはstream上限前に全量を読む。
  feedの5MB判定も全量受信後。固定source・専用secretではあるが、bounded readerが改善候補。
- reservation ACK消失・runtime強制終了でrunning/reservedが残る可能性はある。
  二重APIを避けるため自動再実行・自動予算返却はしない。全non-denied予約を当日予算へ含める
  保守的な設計で、障害日は実検索0でも枠を消費し得る。別途観測/安全なreconciliationを検討。
- anomaly抑制は「同lane topicの直近DIRECT signal」単位。原因を特定した保証ではない。
  discovery triggerのDIRECT確認はfresh batchのみで、recent context全部は使わない。

## DB / RLS / SECURITY DEFINER result

- 隔離PostgreSQL 17、Unix socket専用、fake fixtureのみ。productionに接続していない。
- 7 tableすべてRLS ON、anon/authenticatedのSELECT/DML不可。
- service_roleは7 tableのSELECTと7 RPCのEXECUTEのみ。直接INSERT/UPDATE/DELETE/TRUNCATE不可。
- 7 RPCすべてSECURITY DEFINER、empty search_path、PUBLIC executeなし。
- ローカルの全RPC ownerはnon-superuserの`kb_news_discovery_owner`。
  production owner/ACLは未確認。実apply前にlive schema互換性・owner・ACL read-backが必要。
- SQL内は対象tableをschema-qualified参照。dynamic SQLなし。JSONはSQL文字列連結に使わない。
- service_roleは内部trusted callerであり、tenant別のrun所有権認証ではない。
  任意の既存run IDを知るservice_roleをcaller単位で隔離する設計ではない。
  anonymous/authenticatedにはRPCを一切開放せず、Edge専用secretで入口を制限する。
  SQLはregistryのpolicy対応表そのものは再計算しないので、service_roleの安全な管理が前提。
- malformed input/batch上限/status/type/parent/constraint違反はSQLでabort。
- batch失敗は全体rollback、同batch再送はON CONFLICTでrelationを重複作成しない。
- migration apply前後とrollback後の既存stand-in catalog/ACL fingerprint:
  `f40125a68cf49acc742bdeb04e30dc8d`（すべて一致）。rollback後N3 object0、reapply成功。
  stand-in fixtureはproduction全schemaの互換性証明ではない。

## Function auth / trigger / GDELT

- POSTのみ。secret未設定503、不一致/なし401、GET405。これらはDB/fetch開始前に終了。
- 32byte base64urlの専用secretを比較。固定長xor比較は十分で、外部認証の代替とは考えない。
- CORS許可なし。ブラウザoriginによる管理者認証は提供しない。
- GDELT/search enableをboolean検証。search配列/null、malformed anomaly、任意queryを400で拒否。
  allowlisted instrumentと型検証済み数値を固定queryへ埋める。
- source endpointはregistry固定。caller指定URLをfetchしない。
- defaultはDIRECT sourceのみ。GDELT default OFF。
- GDELT 429は記録して継続。GDELTだけのrunも失敗/degradedにしないよう修正。
- 429/source failureだけからtrigger searchは発火しない。provider失敗からfollow-upしない。
- trigger最大2/run、同theme3h cooldown、親ごとのfollow-up最大1/day。
- WORLD/MARKET/ENERGY/JAPAN/TECHのlane rotationは72分slot、同lane6h cooldown。
  通常rotationは最大4/lane/JST day=20/day。triggerを足しても予約hard cap48が優先。
  ソース間でtopicが重なる部分はあるが、1社1検索や際限のない再検索ではない。

## WebSearchAdapter / cost units

- endpoint: `POST https://api.openai.com/v1/responses`（今回はmockのみ）
- model: `gpt-5.6-luna`; reasoning low; store false; max_output_tokens1500。
- web_search low context、required、max_tool_calls1、strict JSON最大8item、sourcesをinclude。
- 出力itemのURLは実応答のsources/citations内のcanonical URLとの一致を要求。
  modelのJSON URLだけでは保存されない。text以外の本文/summary/imageは保存しない。
- timeout60秒、API retry0、429/network/HTTP/bad/partial応答を分類。
- budget1 = **non-denied reservationに対応するResponses request最大1回**。
  succeeded/failed/reservedをすべて含める。予約のDB retryは0。
- ai_calls = model call推定数（timeoutも1）。web_search_calls = 応答内tool item数。
  1 tool action内のqueries本数ではない。`ai_calls <= search_count`はこのrequest単位なら妥当。
  HTTP error/timeoutの課金確定・tool回数は不明で、0は「課金なし」の証明ではない。
- lane/reason/result/useful/duplicate/restricted/policy-blocked/rejected/error/tokensはsearch rowにある。
  不正partialでも取得できたusageを捨てないよう修正。永続化済み有用数はM1参照。
- mocked会計値と実課金は異なる。複数queries、料金内訳、実source payload、拒否/partialの
  実response形状、timeout時の課金は実API未検証。

## Restricted publisher / dedupe / alias / discovery-only

- no_accessは検索前block + 保存前drop。NHK等no_direct_fetchはdiscovery flag/primary待ち。
- hostname case/www/subdomain/trailing dot対応。`nhk.or.jp.evil.com`等はNHKではない。
  URL parserのpunycodeは別hostとして扱い、lookalikeを信頼済publisherへ昇格させない。
- 同source同titleでも別external ID/URLのdocumentは保持。官邸の再利用titleケースを
  TypeScriptとSQL両方で確認。跨source title matchは72時間・短すぎるtitleは除外。
- URL追跡param/fragment等のnormalizationとDB retry時のid/source-external uniqueは維持。
- リコール→リコー、BASEのASCII境界、山口等のunreviewed短縮名、NFKC、strong seed優先、
  複数tickerは既存17 alias testsと今回追加の3ケース回帰testで確認。weak単独はcandidate止まり。
  contextありのweak確認はtrusted alias matcherの判断で、DBが自然言語根拠まで再評価するものではない。
- discovery-onlyはsummary/image/表示用title許可を禁止。発見用headlineは内部titleとして保存。
  raw_referenceはmetadata2keyのみ。Search/GDELTどちらも既存投稿/表示coreに未接続。

## Tests

- baseline: 101/101 PASS（既存手順の--no-check）。
- final: **112/112 PASS、type checking込み**。新規境界11 tests追加。
- `deno check` observer index + 新規review test: PASS。
- `deno lint` N2/N3 discovery/observerの27 files: PASS。
- `bash -n` proof runner: PASS。`git diff --check`: PASS。
- disposable SQL: apply → 全7table/RPC ACL/RLS/owner/search_path read-back → behavior →
  RC/RR 47/48競合 → rollback → reapply: PASS。
- localhost PostgREST stand-in integration: 初回mock provider2回、signal2件保存、制限1件drop、
  restricted1件flag。二回目はcooldownでprovider0回、2予約denial。全run completed。
  実OpenAI/ニュースsource/production APIは呼んでいない。
- root package/lock/npm install不要。Deno --no-config --node-modules-dir=none --cached-only
  で既存cacheを利用し、型検査をskipせず実行。
- 途中の新規fixture欠落による1失敗と、旧testの型不整合3件はN3 test scopeで修正済み。
  最終未解決の失敗test0。

```sh
deno test --no-config --no-lock --node-modules-dir=none --cached-only --allow-read=supabase \
  supabase/functions/_shared/news_discovery/ supabase/functions/news-discovery-observer/
deno check --no-config --no-lock --node-modules-dir=none --cached-only \
  supabase/functions/news-discovery-observer/index.ts supabase/functions/_shared/news_discovery/n3_review_test.ts
deno lint supabase/functions/_shared/news_discovery/ supabase/functions/news-discovery-observer/
bash -n supabase/tests/news_discovery_observer_run.sh
git diff --check
```

## changed_files

1. `supabase/functions/_shared/news_discovery/source_registry.ts`
2. `supabase/functions/_shared/news_discovery/supabase_store.ts`
3. `supabase/functions/_shared/news_discovery/supabase_store_test.ts`
4. `supabase/functions/_shared/news_discovery/web_search.ts`
5. `supabase/functions/_shared/news_discovery/web_search_test.ts`
6. `supabase/functions/_shared/news_discovery/n3_review_test.ts`（新規）
7. `supabase/functions/news-discovery-observer/observer_handler.ts`
8. `supabase/migrations/20260928120000_news_discovery_observer.sql`（未適用candidateのみ）
9. `supabase/tests/news_discovery_observer_behavior.sql`
10. `supabase/tests/news_discovery_observer_run.sh`（race出力先もworktree専用mktempへ変更）
11. `docs/news-sources/n3_review.md`（本Report）

## Safety / remaining issues / next step

- 正式repoとClaude worktreeの既存未commit変更に変更/stage/commitなし。
- important-news-monitor/breaking_market/headline/shadow/Fact/Voice/Push/X/app-copy/usage/
  production news tables/production設定/apps/admin/HANDOFF/他TASKは変更0。
- production migration/deploy/Cron/Web Search/secret取得・表示は0。通常docs閲覧のみ。
- 既存のH1/H2 TASK/Reportは保護し、このN3専用Reportへ記録。
- Supabase skillとOpenAI Docs skillに従い、権限・公式API仕様・SQL lockingを確認した。
- 次工程: このN3修正差分のレビュー → invocation deadlineとM1/M2の扱い決定 →
  専用staging環境・安全なkeyで実検索1回の承認 → live schema/owner/ACL互換性read-back。
  その後にのみproduction rolloutを別途判断する。
- 推薦モデル: **Sol（高）**（DB/API境界の再レビュー）。

## Primary references checked

- [GPT-5.6 Luna model / supported features](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [Responses max_tool_calls](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [Web search: search action, sources, domain filters](https://developers.openai.com/api/docs/guides/tools-web-search)
- [Supabase database functions: definer/search_path/privileges](https://supabase.com/docs/guides/database/functions)
- [Supabase Edge runtime / request limits](https://supabase.com/docs/guides/functions/limits)
