# 共通AI基盤 Phase 1b — AI利用量台帳・予算管理・利用制限

- task_id: `common-ai-provider-budget-ledger-20261010`
- 基準: PR #117（Phase 1a）head `2ddae0dc` の上に積む stacked PR
- 状態: **ソースのみ。migration は未適用**。本番DB・Edge・secrets・既存の業務処理への変更はなし
- 対象: `supabase/migrations/20261010050613_ai_provider_budget_ledger.sql`、`_shared/ai_provider/ledger_guard.ts` ほか

## 1. 全体の流れ

```text
executeAiRequest（Phase 1a）
  ├─ reserve      ai_ledger_reserve    すべての上限を確認し、上限額を原子的に予約する（送信前）
  ├─ markSent     ai_ledger_mark_sent  「送ってよい」と返ったときだけ HTTP を送る
  ├─ provider     OpenAI / Anthropic へ 1 回の HTTP（Phase 1a のアダプタ）
  └─ settle       ai_ledger_settle     費用・usage・結果を、追記専用の台帳 1 行として確定する
```

予約の状態（`ai_ledger.reservations.status`）は次のとおり。

| 状態 | 意味 | 次に進める状態 |
|---|---|---|
| `reserved` | 予約済みで**未送信**（mark_sent がまだ成功していない＝送っていないと証明できる） | sent / released / settled / unknown |
| `sent` | 送信済みで結果待ち | settled / unknown |
| `settled` | usage が分かり確定した | （終端） |
| `unknown` | 結果が不明（タイムアウト・接続断・確定が来ない）。**上限額のまま確定し、解放しない** | （終端） |
| `released` | 未送信のまま解放した | settled / unknown（解放後に確定が届いた場合も、費用は必ず計上する） |

逆向きの遷移と、識別項目の変更はトリガーで拒否します。

## 2. テーブル（schema `ai_ledger`。Data API に公開しない）

| テーブル | 役割 | 主な列 |
|---|---|---|
| `budget_policies` | 予算ポリシー | スコープ（provider / model / application / feature / logical_role / subject_kind / 特定の brand / 特定の user）、`per_brand` / `per_user`（ブランドごと・利用者ごとに別の計数）、`period`（JST の月 / JST の日）、`max_estimated_usd` / `max_calls` / `max_usd_per_call`、`enabled` |
| `budget_buckets` | 月次・日次の利用集計（現在値） | ポリシー × 期間（× brand × user）ごとの `calls`、`held_usd`（送信中の予約）、`settled_usd`（確定額。上限額で確定したものを含む） |
| `reservations` | 予算予約 | `request_id`（論理呼び出しID）、`attempt`、`attempt_id`（生成列。一意）、provider / model / application / feature / logical_role、`subject_kind`、`user_id` / `brand_id`、`billing_month`、`reserved_usd`、`status`、各時刻 |
| `usage_events` | AI 利用量台帳（**追記専用**。1 試行 1 行） | 上記の識別項目、`actual_model`、`outcome`（succeeded / failed / unknown）、`error_code`、`cost_basis`（measured / upper_bound）、入力・出力・キャッシュ読み・キャッシュ書き（5分/1時間）・推論のトークン数、`estimated_cost_usd`、`reserved_usd`、`price_catalog_version`、`provider_request_id`、`http_status`、`latency_ms` |
| `billing_observations` | provider 側で確認した金額（追記専用） | Console の利用額、付与・充当されたクレジット、確認時点のクレジット残高、自己負担額、確認日時、出所（console_manual / usage_cost_api / invoice） |

TASK が求めた管理項目と列の対応:

- provider / model / application / feature / logical_role / request_id / attempt_id / created_at / billing_month / status: 同じ名前の列
- brand_id / user_id: 同じ名前の列（**system 処理では両方 NULL**、user 処理では user_id が必須。検査制約で混同を防ぐ）
- input_tokens / output_tokens: 同じ名前の列
- cache_tokens: `cache_read_input_tokens`、`cache_write_5m_input_tokens`、`cache_write_1h_input_tokens`
- estimated_cost_usd / cost_basis: 同じ名前の列

**金額:**

- 型は NUMERIC（小数8桁。`ai_usage_events.cost_usd` と同じ精度）。
- 予約額は8桁に切り上げて保存します。
- 費用は**その時点の料金表で計算した値と料金表の版**（`price_catalog_version`）を保存します。後から料金が変わっても書き換えません。

**一意制約:**

- `(request_id, attempt)`、`attempt_id`（予約と台帳の両方）
- `usage_events.reservation_id`（1つの予約から確定は1回だけ）

## 3. 予算ポリシー

- **すべて満たす:** 呼び出しに当てはまる有効なポリシーを**すべて**満たした場合だけ予約できます。例:
  - 全体の上限内でも、ブランドの上限を超えれば拒否します。
  - ブランドの上限内でも、利用者の上限を超えれば拒否します。
- **適用範囲:** `per_brand` のポリシーは brand_id を持つ呼び出しにだけ、`per_user` は user_id を持つ呼び出しにだけ適用されます。
  - 同じ利用者が複数のブランドを持つ場合: ブランド別のカウンタは別々に、利用者別のカウンタは合算されます（テスト済み）。
- **fail-closed:** 当てはまるポリシーが1つもない呼び出しは `NO_MATCHING_POLICY` で拒否します。運用では必ず「全体」のポリシーを置きます。
- **初期値:** ポリシーは migration に含めていません（初期値なし）。**月 $100 を固定の利用可能額として設定しない**ためです。
  - 金額はユーザーが Console で確認してから、運用SQLで登録します。

設定例（**未適用。値は仮。実際の値は専用のちゃとユーザーが決める**）:

```sql
-- 全体（全 provider・全アプリ、暦月 JST）
insert into ai_ledger.budget_policies (policy_key, period, max_estimated_usd, note)
values ('all.monthly', 'month', 0, '確認後に設定。0 = 実質停止');
-- Anthropic 全体
insert into ai_ledger.budget_policies (policy_key, scope_provider, period, max_estimated_usd)
values ('anthropic.monthly', 'anthropic', 'month', 0);
-- かぶモリ市況レポート（機能別）
insert into ai_ledger.budget_policies (policy_key, scope_application, scope_feature, period, max_estimated_usd, max_usd_per_call)
values ('kabumori.market_report.monthly', 'kabumori', 'market_report', 'month', 0, 0.6);
-- POSTONA：ブランドごとの月間回数、利用者ごとの日次 AI相談回数（プラン別の回数は未確定）
insert into ai_ledger.budget_policies (policy_key, scope_application, scope_subject_kind, per_brand, period, max_calls)
values ('postona.brand.monthly_calls', 'postona', 'user', true, 'month', 0);
insert into ai_ledger.budget_policies (policy_key, scope_application, scope_feature, scope_subject_kind, per_user, period, max_calls)
values ('postona.consult.user.daily_calls', 'postona', 'consult', 'user', true, 'day', 0);
```

**プラン別の上限:** 今は `scope_user_id` / `scope_brand_id` で個別に上書きするか、ポリシーを分けて対応できます。プランという概念を列として持つかは、料金プランが決まってから決めます。勝手に回数を決めていません。

## 4. RPC（すべて `p jsonb -> jsonb`、`SECURITY DEFINER`、`search_path = ''`、EXECUTE は service_role だけ）

| RPC | 入力 | 出力・効果 |
|---|---|---|
| `ai_ledger_reserve` | request_id, attempt, provider, model, application, feature, logical_role, subject_kind, user_id?, brand_id?, amount_usd, hold_seconds? | `{allowed, reservation_id, status, reused, reason?, policy_key?, level}`。同じ (request_id, attempt) をもう一度送ると同じ予約を返します（二重計上なし）。内容が違えば `AI_LEDGER_ATTEMPT_CONFLICT`。**未送信（reserved）のときだけ allowed を返します。送信済みなら `ATTEMPT_IN_FLIGHT`、確定済みなら `ATTEMPT_FINALIZED` で拒否します**（C1 R1 の修正） |
| `ai_ledger_mark_sent` | reservation_id | `{status, may_send}`。**送信許可は1回だけです。** `may_send:true` を返すのは、その呼び出しで reserved → sent に遷移させたときだけで、送信済みなどへの2回目以降は常に `false` です（C1 R1 の修正）。期限切れの未送信予約はここで解放し、`may_send:false` を返します |
| `ai_ledger_settle` | reservation_id, outcome, cost_basis, estimated_cost_usd, トークン数, actual_model?, error_code?, provider_request_id?, http_status?, latency_ms?, price_catalog_version | `{status, usage_event_id, duplicate}`。同じ確定の再送は最初の結果を返し、内容が違えば `AI_LEDGER_SETTLEMENT_CONFLICT`。上限額での確定は予約額を下回りません |
| `ai_ledger_release` | reservation_id | 未送信（reserved）のときだけ解放します。送信済みは変更せずに返します |
| `ai_ledger_recover_stale` | sent_grace_seconds?, limit? | クラッシュからの回復: 期限切れの reserved は解放し、猶予時間を過ぎた sent は**上限額の unknown として確定**します（解放しない） |
| `ai_ledger_usage_summary` | billing_month (`YYYY-MM-01`), dimension | 集計: total / provider / model / application / feature / logical_role / subject_kind / brand / user。件数・トークン数・推定額・上限額で計上した分 |
| `ai_ledger_budget_status` | `{}` | 今期の各カウンタ、上限、使用率の段階（ok / notice / warn / critical） |

TypeScript 側は `SupabaseLedgerBudgetGuard`（`ledger_guard.ts`）がこれらを呼びます。Phase 1a の `BudgetGuard` interface は維持し、拡張は任意項目だけです（`markSent?`、`release?`、`settle` の第3引数）。`InMemoryBudgetGuard` も、そのままの呼び出し元も動きます（Phase 1a の85テストを変更せずに PASS）。

## 5. 同時実行・冪等性・費用の保護

- **予約の直列化:** 予約は transaction 単位の advisory lock で1件ずつ処理し、さらに該当するカウンタ行を id 順に `FOR UPDATE` でロックします。
  - 実SQLで確認済み（並行セッションによる実行）:
    - 150件を同時に送り、回数上限50 → ちょうど50件
    - 0.02 ドル × 150件、上限 0.5 ドル → ちょうど25件
    - 3ブランド × 50件、ブランド上限10・全体上限25 → 全体25件、どのブランドも10以下
  - **ロックを外す mutation では57〜65件が通ってしまい、テストが失敗する**ことを確認済みです（テストが競合を本当に検出できる証拠）。
- **冪等性:**
  - 同じ試行の予約を60並行で送ると、予約1件・計上1回。
  - 同じ確定を60並行で送ると、台帳1行・計上1回。
- **タイムアウトなど結果が分からない試行:**
  - usage が分からない試行は**上限額で確定**し、予約額を下回りません。
  - 送信済み（sent）は、期限切れでも**解放しません**。
- **未送信の証明:**
  - HTTP は mark_sent が `may_send:true` を返したあとにしか送りません。
  - mark_sent は期限切れの予約を解放して `false` を返します。
  - このため「reserved のまま期限切れ」は送信していないことの証明になり、回復処理で安全に解放できます。
- **1つの予約からの送信は最大1回（C1 R1 の修正）:**
  - 予約の冪等性と、送信の冪等性は別のものとして扱います。
  - 送信許可は、mark_sent が行ロックのもとで reserved → sent に遷移させた1回だけです。
  - 同じ callId を同時に実行した場合（別の Guard インスタンスでも）や、送信済みの試行を再実行した場合は、2回目の送信許可を出しません。
  - mark_sent の応答がタイムアウトした場合も、許可が出たとは推測しません。何も送らず、送信済みかもしれない予約はそのまま計上しておきます（release では解放されず、回復処理で上限額の unknown になります）。
  - 通常の再試行は別の attempt として、予約から計上まで別々に扱います。
  - 確認済みのテスト:
    - 実SQL: 同じ予約への60並行の mark_sent で送信許可は1件、mark_sent と release／recover_stale の競合
    - TS＋実SQL＋偽 API の E2E: 同じ callId の同時実行（上限1回・10回）で API 通信1回・計上1回、mark_sent のタイムアウト後の再実行、送信後に通信が切れたあとの再実行、通常の再試行
- **クラッシュ後の回復:**
  - `ai_ledger_recover_stale` を定期的に実行します（例: 5〜15分ごと）。**Cron の設定は今回していません**（Phase 2 の本番ゲートで行う）。
  - 確定のRPCが失敗した試行は sent のまま残り、回復処理で上限額の unknown になります（保守的に扱う）。
- **失敗の原子性:** 確定の途中で書き込みが失敗すると全体がロールバックし、カウンタも状態も変わりません（テスト済み）。

## 6. セキュリティ（RLS・ACL・権限）

- **schema:** `ai_ledger` は anon / authenticated / service_role / PUBLIC のどれにも USAGE を付けません。テーブル・シーケンス・補助関数への権限も一切付けません。全テーブルで RLS を有効にし、ポリシーは置きません（所有者以外は見えない）。
- **RPC:** public に7つ置き、EXECUTE は **service_role だけ**です。Supabase の既定の権限（新しい関数・テーブル・schema に anon / authenticated へ自動で権限を付ける設定）も、migration 内で取り消します（テスト済み）。
- **SECURITY DEFINER が必要な理由:** テーブルに直接書ける役割をなくすためです。service_role ですら台帳を直接書き換えられず、不変条件（原子的な予約、冪等な確定、追記専用、送信済みを解放しないこと）を守る RPC 経由でしか変更できません。
  - `search_path` は空に固定し、すべてスキーマ名付きで書いています。補助関数は DEFINER ではありません。
- **事後検証（既存 migration と同じ方式）:** 作成の最後に、次を確認します。条件を満たさなければ migration 全体をロールバックします（何も補修しない）。
  - 所有者、ロールの所属関係、直接付与された権限（ACL）
  - **継承を含む実効権限**（`has_*_privilege`）
  - **到達できるロールの権限（C1 R2 の修正）**
    - anon / authenticated / service_role から、継承（USAGE）または SET ROLE（直接、または SET が有効な付与を何段もたどる経路）で到達できるロールを調べます。
    - そのロールにも、次の同じ規則を課します。
      - anon / authenticated から service_role・所有者・superuser に到達できない
      - 台帳の schema・テーブル・列・シーケンス・補助関数・RPC に権限を持つロールに到達できない
    - 継承しない（NOINHERIT）で SET ROLE だけができる経路も拒否します。
    - PostgreSQL 16 未満では、より厳しい「所属しているか」で判定します。
    - 危険な構成を GRANT / REVOKE で補修することはしません。
  - 列単位の権限、RPC の形（DEFINER と search_path）
  - RLS が有効か
- **危険な構成での拒否（テスト済み）:**
  - 次のどの構成でも適用を拒否し、カタログは1か所も変わりません。
    - authenticated が所有者ロールに所属している
    - service_role が pg_read_all_data を持つ
    - anon が pg_write_all_data を持つ
    - anon が superuser
    - （C1 R2）SET ROLE 経由の経路:
      - authenticated → service_role（継承なし・SET あり）
      - anon → service_role（継承なし・SET あり）
      - 2段の SET 経路
      - SET → 継承の混合経路
      - SET で pg_read_all_data へ到達
      - 非superuserの所有者で適用した場合の SET 経路
  - 安全な対照ケースは拒否しません。継承も SET もない所属や、継承はできるが SET ができない中継などです。実際に `SET ROLE service_role` ができないことも確認しています。
  - 個々の安全機構を壊した16種類の mutation（R1・R2 用の4種を含む）も、すべてテストが検出しました。
  - **修正前の migration では**、SET ROLE 経由の6種がすべて適用されてしまい、R1 の再現テスト（同時実行で API 通信2回、送信許可60件中60件）も失敗することを確認しています。
- **ID の信頼境界:**
  - RPC は service_role 専用のため、`user_id` / `brand_id` を検証するのは**呼び出し側（サーバー）の責任**です。
  - Phase 4/5 で接続するときは、次の値だけを渡します。
    - user_id: Edge Function が検証した JWT の主体
    - brand_id: その利用者が所有していると DB で確認したブランド
  - クライアントが送ってきた値は使いません（設計上の必須事項）。
- **G5 の領域:** 共通アカウントの Auth・権利情報（entitlement）・削除処理には触れていません。`user_id` / `brand_id` には外部キーを付けていないため、G5 の削除処理を妨げません。

## 7. Claude API クレジットと請求の区別

| 区分 | どこに持つか | 決め方 |
|---|---|---|
| API の推定費用 | `usage_events.estimated_cost_usd` | 料金表 × usage（不明な分は上限額） |
| Console 上の実利用額 | `billing_observations.console_usage_usd` | Console で確認した値（または Usage & Cost API。Admin キーが必要なので Edge には置かない） |
| API クレジット | `billing_observations.credit_granted_usd` / `credit_applied_usd` / `credit_balance_usd` | 確認した値だけ。**推測で入れない** |
| 実際の自己負担額 | `billing_observations.out_of_pocket_usd` | 請求書・Console で確認した値 |

**月 $100 の扱い:** 固定の予算として扱いません。対象の組織・残高・有効期限が未確認のため、ポリシーの値はユーザーの確認後に入れます。

**照合:** 推定と実額の差は `usage_summary` と `billing_observations` を並べて確認します。照合用の画面と自動取得は後続の作業です。

## 8. 個人情報・保持期間・削除方針

**保存するもの:**

- 利用主体の識別子（uuid）
- provider、model
- トークン数、推定費用
- 結果・エラー種別
- provider の request id
- 時刻

**保存しないもの:**

- APIキー、Authorization ヘッダー
- プロンプト、生成本文、会話履歴
- エラーの本文

テストで次を確認済みです。

- 余分な入力項目（prompt / authorization / output など）は無視される
- 台帳の全テーブルに目印の文字列が残らない
- 自由記述を入れられる列が存在しない

**保持期間（案。専用のちゃ・ユーザーの承認待ち）:**

- `usage_events` / `reservations` は 13か月保持します（請求の照合と前年比較のため）。
- その後は user_id / brand_id を外した集計だけを残します。
- `budget_buckets` は今期と前期だけを使います。それ以前は集計のみに置き換えます。
- **Phase 1b に削除処理はありません**（追記専用）。期限切れの処理は、仮名化した状態を許すための別 migration として後続で行います。

**アカウント削除との連動（G5 との調整事項）:**

- 削除した利用者の user_id を、即時に仮名化するか、保持期間のあとに処理するかを決めます。
- あわせて、削除オーケストレーターのどの段階で実行するかを G5 と調整します。今回は実装していません。

## 9. プライバシーポリシーの変更が必要な点（今回は変更しない）

`apps/kabumori-web/pages/privacy.html` は、現在 OpenAI だけを委託先として書いています。個別レポートや AI 相談の個人データを Anthropic へ送る前に、少なくとも次が必要です。

1. **委託先の追加:** 委託先の表に Anthropic（Claude API）を加え、目的・送るデータの種類・送らないデータを OpenAI の行と同じ粒度で書きます。
2. **データの扱い:** Anthropic API の入出力の保持期間と学習への利用について、**公式の現行規約で確認したうえで**書きます。未確認のまま断定しません。
3. **国外移転:** 国外（米国など）への移転について記載します。
4. **利用量台帳:** AI の利用量と利用者識別子を費用管理・不正利用防止のために保存していることと、その保持期間（§8）を書きます。
5. **POSTONA の開示:** POSTONA 側にも同等の記載を確認します（POSTONA の開示ページの場所は、G3/G4 と確認する）。

**Phase 1b の時点で、個別レポートと AI 相談の Anthropic 接続は禁止のまま**です。

## 10. Fallback

- provider 層の自動切替は**OFF のまま**です（Phase 1a）。通信の再試行（同じ provider）と provider の切替は別のものとして扱います。
- 将来、明示的な fallback を入れる場合も、次の扱いにします。
  - 切替先の呼び出しは、**同じ台帳の reserve を通し**、provider 別・利用者別などの上限の範囲内でしか実行しません。
  - 安全上の拒否（REFUSAL）を回避するための再実行はしません。

## 11. Phase 2 との関係

- **Phase 2a の対象:** 共有市況レポート（K1/K2）だけです。個別レポートは対象外です。
- **G2 との調整:** 接続は G2 の PR #110 と Fact 関連の修正が終わってから、G2 と方法を決めます。Phase 1b では朝刊・大引けの実装を変更していません。
- **既存の再試行との関係:** 接続時は `executeAiRequest` に `SupabaseLedgerBudgetGuard` を渡します。既存の `transport_retry.ts` を残す場合は `transport.maxAttempts: 1` にして、再試行が二重にならないようにします。

## 12. テスト（実API 0回）

| 項目 | 結果 |
|---|---|
| `supabase/tests/ai_provider_budget_ledger_run.sh`（使い捨て PG17 で実SQL） | behaviour / supabase / nonsuper（非superuserの所有者で適用）/ concurrency（R1 の3件を含む）/ adverse（R2 の8件と安全な対照2件を含む）/ rollback / e2e のすべて PASS |
| `supabase/tests/ai_provider_budget_ledger_mutations.sh` | 16 mutants すべて検出（R1・R2 用の4種を含む） |
| `deno test --no-config -A supabase/functions/_shared/ai_provider` | 94 passed（Phase 1a の85件 + ledger guard 9件） |
| e2e（TS → PostgREST shim → PostgreSQL、provider は偽物） | 10 passed（R1 の5件を含む） |
| `deno check` / `deno lint`（ai_provider と新しいテスト TS） | PASS |
| 既存の回帰（migration_source_invariants・mic_scenario_phase3c_cron・モデルガード3本） | 17 + 22 passed |

**TASK の必須30項目の主な対応:**

- 1〜8: behaviour の [1] [2]-[8]
- 9・10: [9] [10]
- 11: concurrency
- 12・13: [12][13]
- 14: [14]
- 15・16: [15][16]
- 17: [17]
- 18・19: [18][19] と ledger_guard_test
- 20〜23: [20]-[23]
- 24・25: [10][24][25]
- 26: [26]
- 27: rollback と adverse（拒否時の原子性）
- 28: rollback（既存構造の digest が変わらない）
- 29: Phase 1a の85件、e2e、ledger_guard_test
- 30: [30] と ledger_guard_test の30

**限界:** ローカルの PostgreSQL で証明できるのは SQL の契約です。次の点は**未検証**です。

- 本番の Supabase で PostgREST が `public.ai_ledger_*` を RPC として公開するか
- Data API の公開設定の変更（新しい public オブジェクトの扱い）の影響

これらは本番適用前の確認項目とします。

## 13. 本番適用の手順案（今回は実施しない）

1. **独立レビュー:** Phase 1a と 1b をまとめて、独立した Codex レビューを受けます（推奨 Sol（高））。
2. **本番の確認（読み取りのみ）:** schema `ai_ledger` と `public.ai_ledger_*` が存在しないことを確認します。あわせて、ロールの所属関係・既定の権限・PostgREST の公開範囲を確認します。
3. **適用の進め方:** G5 / G3 など同じDBへの DDL と時間をずらし、短い書き込み期間だけで行います。migration は自前の BEGIN/COMMIT を持つため、既存の「schema → 読み戻し → 履歴」の順に進める runner 方式で適用します。
4. **読み戻し:** 事後検証と同じ観点（実効権限・RLS・RPC の形）を本番で確認します。
5. **ポリシーの登録:** ユーザーの Console 確認後に、ポリシーを登録します。
6. **回復処理の定期実行:** 回復 RPC の定期実行を設定します（Cron の変更は別のゲート）。

## 14. 未解決事項

- 本番 PostgREST での RPC の公開可否（未検証）
- 保持期間と、アカウント削除時の扱い（G5 と調整）
- プラン別上限の表し方（料金プランの決定待ち）
- `migration_source_invariants_test.ts` の予約一覧（RESERVED）に、今回の version `20261010050613` を加えるか。共有の管理ファイルなので**編集しておらず、調整待ち**
- `billing_observations` を記録する手段（今は運用者の SQL だけ。RPC は未作成）
- 回復処理の定期実行の設定（Cron。本番ゲート）
- 通常の `deno lint`（`--no-config` を付けない場合）で `no-import-prefix` が1件出る
  - 対象: Anthropic SDK のインライン固定 `npm:@anthropic-ai/sdk@0.132.1`
  - 既存の本番コード（重要ニュースの `npm:unpdf@1.8.1`）でも同じ指摘が出る、リポジトリにもともとある慣行です。セキュリティ上の問題ではありません。
  - 対応案:
    - (a) 固定版のインライン指定（既存方針）を維持し、lint は `--no-config` または `--rules-exclude=no-import-prefix` で運用する
    - (b) 該当行に理由付きで `// deno-lint-ignore no-import-prefix` を書く（PR #117 のファイルを変えることになるため、今回は未実施）
    - (c) `supabase/functions` に import map（deno.json）を導入する（全関数の bundle と deploy に影響するため、別タスク）
  - 推奨は (a)。専用のちゃの判断を待ちます。
- `ai_ledger_mark_sent` の応答が失われた試行は sent のまま計上が続き、回復処理で上限額の unknown になります（実際には送っていなくても、保守的に計上する）。同じ callId での再実行はできないため、呼び出し元は新しい callId でやり直します。
