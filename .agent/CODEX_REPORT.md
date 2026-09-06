# Codex Report

- task_id: important-news-freshness-coverage-diagnosis-20260906
- result: review_required
- next_owner: chatgpt
- observation_cutoff: 2026-09-06 22:03:25 JST
- source_of_truth:
  - code: GitHub `origin/main` at `2c5ac415ee7e4d5ee89ad13706d2b551e515d45d`
  - production: `important-news-monitor` v29 ACTIVE, deployed 2026-09-06 00:04:18 JST, verify_jwt=false
  - data: Supabase production read-only SQL / Cron metadata / retained `pg_net` response diagnostics

## 結論

### なぜ03:20 JSTの雇用統計候補は遅かったか

主因はFetch停止ではなく、`breaking_market`の検索設計です。

1. Fetchは20分ごとでも、6 queryを2本ずつ回すため、雇用統計queryは毎時`:20`の1時間間隔でしか走らない。
2. 対象AP記事は2026-09-05 23:11:18 JST公開。公開後の自然検索機会は23:20、00:20、01:20、02:20にあったが、4回ともvalidation後breaking candidateは0件で、03:20に初めて候補化された。
3. 各runはcompleted、source error 0。したがってruntime/quota/timeoutではない。
4. raw Responses payload、query別raw candidate数、validation除外理由を保存していないため、過去4回が「検索結果に出なかった」のか「モデルは返したがURL/timestamp等で落ちた」のかはDBから最終確定できない。
5. `search_context_size="low"`、各queryでweb_search最大1回、allowed domain限定、さらに「具体的な市場影響が見込まれない軽微な話題は候補にしない」という取得段階の強い選別が、検索yieldを低くしている。

加えて、03:20候補はイベント自体の初回捕捉ではありません。同じ8月雇用統計はBLS一次資料で9/4 22:38 JSTに既に候補化済みです。AP後追い記事の公開時刻だけが24h以内だったため、元イベントから約29時間50分後でも新規速報候補になりました。つまり「検索の4時間遅延」に加え、「記事時刻だけを見る24h freshness」と「cross-source同一event dedupe不足」があります。

### なぜ当日のニュース件数が少なかったか

日曜によるTDnet 0件だけでは説明できません。海外マクロ/速報lane側に独立した入口問題があります。

- 00:00〜22:03 JSTの自然Fetchは67回。67/67 completed、error/source error 0、running/failed 0。
- breaking queryは1 cycle 2本なので、Responses requestは計134回。exactな`web_search_call`数は永続化されていないが、全query providerが例外なく完了している。
- validation後breaking candidateは延べ24件（既存duplicate 21、新規3）。49/67 cycle（73.1%）はbreaking候補0。
- DBに新規作成された当日candidateは3件だけで、全件`breaking_market`。`market_macro` / `tdnet` / `company_ir` / その他は0。
- 当日3件は全件がimportance `important`または`most_important`。`no_post`は0。件数不足はDB後段judgementで落としすぎた結果ではない。
- `market_macro`は毎cycle 56件のRSS itemを取得しているが、固定source順で先頭30件をdedupe前に切る。選択30件は毎回すべて既存duplicateで、残り26件は毎回deferされる。source順が固定なので、後段sourceは次回も同じ位置に残り、恒常的に候補化されない。

## 2026-09-06 JST 当日candidate

| created/fetched JST | published JST | lag | lane | category | status / importance | title / source |
|---|---|---:|---|---|---|---|
| 01:00:20 | 9/5 22:53:46 | 126.6分 | breaking_market | major_security_incident | ready_for_publish / most_important | 米軍、イランの石油タンカー3隻を攻撃 / AP |
| 03:20:22 | 9/5 23:11:18 | 249.1分 | breaking_market | other_market_moving | generation_failed / important | U.S. August payrolls rise by 162,000... / AP |
| 04:00:23 | 9/5 19:14:08 | 526.3分 | breaking_market | major_security_incident | generation_failed / most_important | U.S. military says it struck three Iranian oil tankers... / AP |

レーン別件数:

- `breaking_market`: 3
- `market_macro`: 0
- `tdnet`: 0
- `company_ir`: 0（active source設定行自体が0件）
- その他: 0

## 雇用統計イベントの時系列

同じ`entity_key=breaking:us_economic_data`で3候補存在する。

| source | source published JST | fetched JST | lag | final status |
|---|---|---|---:|---|
| BLS archive一次資料 | 9/4 21:30:00 | 9/4 22:38:19 | 68.3分 | generation_failed / important |
| BLS current page | 9/4 21:30:00 | 9/5 13:20:21 | 950.4分 | rejected / no_post |
| AP後追い記事 | 9/5 23:11:18 | 9/6 03:20:22 | 249.1分 | generation_failed / important |

03:20候補の取得経路:

- lane: `breaking_market`
- query key: `us_economic_data_surprise`
- query: `US CPI inflation jobs report payrolls surprise data today`
- rotation slot: 毎時`:20`、同時queryは`fx_intervention_boj_fed_emergency`
- 根拠: rotation式と候補`entity_key=breaking:us_economic_data`。query keyはcandidate/run DBへ直接保存されないため、コードと決定的slotからの確定的推定。

公開後に空振りした自然cycle:

- 9/5 23:20 JST: fetched_count 56 / breaking accepted 0 / error 0
- 9/6 00:20 JST: 56 / 0 / 0
- 9/6 01:20 JST: 56 / 0 / 0
- 9/6 02:20 JST: 56 / 0 / 0
- 9/6 03:20 JST: 57 / breaking new 1 / error 0

## Fetch稼働とyield

当日67 cycleの内訳:

| JST slot | query pair | cycles | validation後breaking延べ件数 | breaking 0件cycle | 新規unique |
|---|---|---:|---:|---:|---:|
| :00 | Trump/tariff + war/geopolitics | 23 | 16 | 9 | 2 |
| :20 | FX/BOJ/Fed + US economic data | 22 | 2 | 20 | 1 |
| :40 | market move + bank/China stimulus | 22 | 6 | 20 | 0 |

全体:

- completed: 67/67
- failed/running: 0/0
- run/source errors: 0
- raw official macro fetched: 56/cycle
- macro selected: 30/cycle（全件duplicate）
- macro deferred: 26/cycle
- breaking validation後延べ: 24
- breaking unique新規: 3
- summed duplicate count: 2,031（macro 2,010 + breaking 21）

`important_news_monitor_runs.fetched_count`は「新しいニュース件数」ではない。毎回再取得する14日以内のofficial macro item 56件とbreaking validation通過件数の合計であり、同じRSS itemを繰り返し数える。runだけを見ると取得量が多く見えるが、実際の新規candidateは3件。

## 現行収集仕様

### Corporate lane

- TDnet: 当日JSTの一覧を最大3ページ、20分ごと。PDF enrichment/groupingは最大3 group / 原則3 PDF。
- company IR: DBのactive sourceを逐次取得するが、本番設定は0件。
- company identityはcorporate laneでは持つ。`market_macro` / `breaking_market`は`company_name` / `company_code` nullで候補化可能。

### Official `market_macro`

- source順: BOJ RSS → Fed press RSS → USTR RSS → UN Peace & Security RSS → EIA press RSS。
- freshness: 14日、future skew 1時間。
- 全sourceを逐次fetch、RSS itemを固定順で連結後、先頭30件をcap。
- dedupeはcap後。このため当日raw 56件中、先頭30件の既知itemだけを毎回duplicate判定し、後ろ26件は毎回未処理。
- 現在DBに保存済みの最初の30件はBOJ 25、Fed系3、USTR 1、UN 1。EIAは固定順最後なので、EIAがcandidateを返していてもこのcap境界では到達できない。

### `breaking_market`

- query総数: 6
- 1 cycle: 2 query
- 1巡: 3 cycle = 60分
- 各query: Responses API `gpt-5.6-luna`, reasoning low, `web_search`, `search_context_size=low`, `max_tool_calls=1`, output最大3 candidate。
- lane cap: 15だが自然上限は2 query × 3 = 6なので通常は非拘束。
- freshness: 記事`published_at`が24時間以内、future skew 1時間以内。
- allowed source: Reuters/AP/Bloomberg/Nikkei、MOF/BOJ/Fed/USTR/White House/Commerce/BIS/State/BLS/BEA/Treasury、CENTCOM/Defense。
- source URL: HTTPS、allowed domain、raw response内のallowed-domain URLとのcanonical matchを要求。
- 注意: コメントは`web_search_call.action.sources`限定を意図するが、実helperはraw response全体の`url` keyを再帰収集しており、厳密にはaction.sources限定ではない。
- timestamp: modelが返した`published_at`をparseし24h範囲検証するが、source本文上の時刻との独立照合、時刻精度、event発生時刻は検証しない。
- prompt段階で、未確定/予定/分析を除外し、日本株/世界市場への具体的影響が見込まれない軽微な話題を候補化しない。最終judgement前に重要度相当の選別が入る。

query一覧:

1. `trump_tariff_semiconductor`: Trump / tariff / sanctions / China/Japan / semiconductor export controls / Fed rate-cut pressure
2. `war_geopolitics_taiwan`: war / ceasefire / Taiwan / Middle East / Iran/Israel/Hormuz / oil tanker / maritime attack
3. `fx_intervention_boj_fed_emergency`: Japan yen / FX intervention / MOF / emergency BOJ/Fed decision
4. `us_economic_data_surprise`: US CPI / inflation / jobs / payrolls / surprise data
5. `market_move_breaking`: USDJPY / yen / Nikkei futures / NASDAQ / SOX / crude oil surge/plunge
6. `bank_china_stimulus`: bank collapse/failure / China stimulus/economic policy

## 原因候補 A〜G

| 要因 | 判定 | 位置づけ | 根拠 |
|---|---|---|---|
| A 24h freshnessが広すぎる | YES | 主因（速報品質） | 8時間46分遅れの記事や、元イベント約29時間50分後のAP後追い記事も速報候補になる。 |
| B query rotation待ち | YES | 主因（初動） | 各queryは60分に1回。雇用queryは公開後4回空振りし03:20取得。 |
| C query文面が弱い | PARTIAL | 副因 | jobs/payrollsは含むためcoverage自体はあるが、汎用語句 + `today`のみで公式release/event時刻を強く指定せず、1検索low context。 |
| D published_at検証不足 | YES | 副因 | parse/24h判定だけ。source本文との照合、event時刻、精度を持たず、後追い記事で古いeventが再浮上。 |
| E web_search品質/更新遅延 | LIKELY | 主因候補 | 同queryが4回0件後に同記事を取得。errorなし。raw結果未保存のためindexing/順位/モデル選別の分離は不能。 |
| F 後段filter/judgement過剰 | NO（DB後段）/ PARTIAL（取得段階） | 件数不足の副因 | 当日3件は全件important以上でno_post 0。だがfetch promptが候補化前に市場影響で選別し、macro capもdedupe前。 |
| G 実行/quota/error/timeout | NO | 非原因 | 67/67 completed、run/source error 0、Cronは20分間隔。 |

## 改善案（未実装）

### 最小修正

1. **重要event固定枠**: CPI/雇用/緊急中銀/介入/市場急変用queryを毎20分必ず1枠実行し、残り1枠を他テーマrotationにする。既知release時間帯だけ優先を上げる方式ならコスト増を抑えられる。
2. **速報freshness短縮**: `breaking_market`の速報扱いは例として2〜3時間以内にし、event/release時刻も出力・検証する。既存24hは削除せず別の補完扱いへ送る。
3. **macro cap順序修正**: DB既知duplicateを除いてから30件cap、またはsource別quota/round-robinで30枠を配分する。固定順の後段source starvationを解消する。
4. **取得promptの役割整理**: 検証可能な候補は広めに返し、重要度は既存judgementへ任せる。捏造/公式source/URL/timestamp guardは維持する。
5. **観測性**: runごと・queryごとにResponses status、実web_search call数、raw candidate数、accepted数、拒否理由（URL/domain/timestamp/freshness）を保存する。生本文やsecretは保存しない。
6. **URL検証の厳密化**: actual source URLは`web_search_call.action.sources`だけから抽出する。

### 構造改善

1. `breaking_now`（毎20分、短いevent freshness、直接一次資料/速報向け）と`daily_context`（24h補完）を分離し、共通normalize/dedupe/judgement/Fact/Voiceへ合流する。
2. BLS/BEA/Fed/MOF等の高重要公式releaseは、検索順位に依存しない直接pollingを追加する。市場価格急変は信頼できるmarket data sourceを別laneにする。
3. `entity_key + event type + release/event timestamp`をevent identityに使い、一次資料・AP/Reuters後追い・current/archive URLをcross-sourceで統合する。
4. official RSSはsourceごとのwatermark/last-seenを持ち、新規itemだけを公平にmergeする。14日分を毎回56件再処理しない。

## 未確認・限界

- 過去のOpenAI raw response、検索結果順位、web search index反映時刻は保存されていない。
- `important_news_monitor_runs`にはquery key、query別raw/accepted/rejection内訳がない。selected queryは決定的rotationと保持中の`pg_net` responseで照合した。
- したがって03:20以前の4回について「検索結果に無かった」か「raw候補がpost-validationで落ちた」かは断定しない。
- Web検索や外部APIの追加実行は行っていない。

## Safety / changes

- changed_files: `.agent/tasks/CODEX_TASK.md`, `.agent/CODEX_REPORT.md`のみ（共有タスク状態・調査Report）
- implementation_code_changes: 0
- production_db_writes: 0
- migrations/DDL/GRANT: 0
- Edge Function deploy: 0
- Cron/settings changes: 0
- candidate/status updates: 0
- OpenAI manual API calls: 0
- X API / X posts: 0 / 0
- apps/admin changes: 0
- HANDOFF.md changes: 0
- secrets exposed: 0
- other dirty worktree changes touched/staged: 0
- tests: 調査タスクのため実行なし。production read-only DB/Cron/Edge metadataとorigin/mainコードを照合。
- next_recommendation: ChatGPTが`C`で本Reportを評価後、まず「固定速報query枠 + macroのdedupe前cap解消 + per-query diagnostics」を競合しない実装タスクへ分ける。
