# F8｜news-discovery-observer 停止ゲート実装候補（source-only）

- 作成: 2026-10-16 JST（F8）。task_id `kabumori-f8-news-discovery-observer-pause-gate-20261016`。基点 main `1be51d39`。入力: 設計 PR #228（HEAD `41fc4f58…`）、契約 PR #212（HEAD `b38064c2…`）。
- **merge・deploy・本番接続・実HTTP/AI/Push なし。** PRODUCTION_NO_GO。DB列・migrationは追加していない（既存 `important_news_monitor_settings.is_active` のみ）。`_shared/news_discovery`・`important-news-monitor`・F2/POSTONA・共通Cron/Auth/AI/Secretsは変更していない。

## 1. 変更（`supabase/functions/news-discovery-observer/` のみ）

| ファイル | 内容 |
|---|---|
| `pause_gate.ts`（新規） | PR #212 の契約を**この関数の中に複製**（所有範囲を越えず、`_shared` や他関数を編集しない）: `readNewsPauseState`（厳密に1行・`is_active===true` のみ running／読取失敗・不正値・timeout は拒否）、`PauseCoordinator`（読取開始番号・停止番号）、`createPauseGuardedFetch`、`enforceNewsPauseEntry`、`installNewsPauseGuard` |
| `observer_handler.ts` | **認証（405/503/401）の直後・body読取と `beginRun` の前**に入口ゲート。`pauseCheck` が `running` 以外／例外なら 503（`NEWS_HARD_PAUSED` / `NEWS_PAUSE_STATE_UNREADABLE`）を返す。（`pauseCheck` は型上optional＝`_shared/news_discovery` の既存テストが未配線で構築するため。本番配線は `index.ts` が必ず渡し、静的テストが固定する。egressガードはoptionalでも全外向き通信を保護） |
| `index.ts` | `installNewsPauseGuard()` を**最初**（`postgrestRpcClient` と `new OpenAiWebSearchProvider` の構築より前）に実行し、`pauseCheck: () => enforceNewsPauseEntry(...)` を渡す。fetchはmodule読込時に束縛されるため順序が必須 |
| テスト | `pause_gate_test.ts`（新規13件）、`observer_handler_test.ts` / `n3_hardening_test.ts` は構築に `pauseCheck: running` を追加（既存の意味は不変） |

## 2. 契約（重要ニュースと同一）
- 設定: `rest/v1/important_news_monitor_settings?id=eq.true&select=is_active`。**`is_active===true` のみ**継続。欠落・null・不正値・読取失敗・timeout は 503、body・trigger_type・search 指定で解除不可、許可リスト空。認証の緩和なし（401/405/503 は設定読取より先）。
- 入口と外向き呼出（RPC書込み・外部feed・GDELT・OpenAI web_search）の両方で、呼出ごとに自前の権威的読取（TTL0、硬い期限3秒）。DBのGET/HEAD（`stocks_master` 読取と設定読取）は開放。入口のOFF/unreadable/timeout観測は、同一isolateの未完了の egress 認可を失効させる（古い true は何も許可しない）。
- **停止完了** = 設定OFFのコミット ＋ 読取の観測上限3秒 ＋ in-flightの収束 ＋ no-new-effects のread-back。**既送信HTTPの取消・瞬時停止は保証しない。**

## 3. 検証（実network・DB・SDK・環境変数なし、全てmock）

| 区分 | 結果 |
|---|---|
| observer 全体（`news-discovery-observer/`） | **50 PASS**（新規13＋既存37） |
| `_shared/news_discovery/` を含めた回帰 | observer＋`_shared/news_discovery` 合計 **175 PASS / 0 FAIL**（`_shared` の既存N3テストは未変更・全PASS） |
| 入口ゲート | 8種のリクエスト形（default / 明示source / scheduled / GDELT / web search / search+anomalies / invalid JSON / bogus trigger）× paused・unreadable・例外 で **503、RPC 0・feed 0・stocks 0・search 0**（body読取前） |
| 認証不変 | 401（誤/欠落secret）・405・503（secret未設定）は pause 判定前（`pauseCheck` 呼出0） |
| 稼働中 | 通常どおり run 開始・feed取得・stocks読取 |
| 50回反復 | 停止中に追加の副作用0 |
| 実 `index.ts`（Deno.serve捕捉、mock fetch） | 停止中は RPC・外部feed・OpenAI 0（4形）／稼働中は begin_run と feed に到達／**同一warm isolate: Aのegress認可読取を保留 → Bが入口でOFF観測し503 → Aに古いtrue → AのbeginRun RPCは0** |
| 停止観測の共有 | 入口のOFFが保留中のegress認可を失効（逆順＝先に完了したtrueは正当な認可として通る） |
| 静的 | ガード導入が `postgrestRpcClient` / provider の構築より前、`pauseCheck` 配線、認証 < pause判定 < body読取、moduleレベルfetch保持なし |
| 変異（コピー上、control通過後） | **12種すべて検出**: 入口ゲート除去／`pauseCheck`未配線／ガード未導入／ガードを構築後に導入／拒否しないガード／null・欠落を許可／読取失敗を許可／読取期限削除／stale-trueフェンス削除／入口停止観測の不記録／egressが共有coordinatorを使わない／DB書込みをガードから除外 |
| lint / 型 | observer配下 clean、`deno check index.ts` エラーなし、`git diff --check` clean |

再現: `deno test --no-config --no-lock --allow-read=supabase --allow-run --allow-env --no-check supabase/functions/news-discovery-observer/`、`tools/kabumori-pause/f8/observer_mutation_check.sh`。

## 4. 残存・限界
- **起動元（外部Cron/手動）・実jobid・配備版・設定値・稼働状態は NOT_VERIFIED**。本ゲートは Cron そのものを止めない（停止中は503を返し続ける）。Cron停止・既enqueue Push・4 news Cronは別TASK/別承認（runbook: `OBSERVER_STOP_GAP_PLAN_20261016.md`）。
- `is_active` を観測にも共用するため、deploy前に現在値（default false）と運用意図を read-only で確認すること（false のままdeployすると observer も即停止＝JP公式レーンが読む新規signalsも止まる）。
- `pauseCheck` は型上optional（理由は §1）。誤って未配線の構築を増やさないよう、本番配線は静的テストで固定している。
- 実handlerのdeny-net/deny-envはmockによる代替（OS権限による封じ込めではない）。実環境でのPreview確認は未実施。
