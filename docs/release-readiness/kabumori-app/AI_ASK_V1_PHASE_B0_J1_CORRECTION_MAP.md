# 「AIに聞く」V1 Phase B0 — J1 指摘 R1〜R8 の対応表・受入テスト・検証記録

- 作成: F1（`kabumori-f1-ai-ask-b0-j1-r1-r8-design-correction-20261013`）／ 2026-10-13 JST
- 正本: J1 Report [`.agent_v2/reports/J1.md`](../../../.agent_v2/reports/J1.md)（`CHANGES_REQUIRED`、P1×5・P2×3）。以下の「J1 原文」の行番号は同ファイルの行。
- 対象設計: [`AI_ASK_V1_PHASE_B0_SECURITY_DESIGN.md`](./AI_ASK_V1_PHASE_B0_SECURITY_DESIGN.md)（v2。v1 = Draft PR #171 head `0beda46186efe1db680909f369e2571609851d81`）
- 性格: 設計の対応表。**実装も実 DB も実プロバイダーも無い**。「解消した」とは「v2 の設計が J1 の反例を閉じる契約になった」の意味で、**実装の検証済みではない**（検証は B1 の受入テストで行う）。

## 1. 対応表（J1 指摘 → v1 → v2 → 受入テスト）

### J1-R1 [P1] 停止スイッチ／許可リストが台帳の方針照合から導かれない

| 項目 | 内容 |
|---|---|
| J1 原文 | `J1.md:35-40`（最小受入: アプリ専用の deny-by-default 許可リスト／権威的 OFF、毎回・replay・dispatch 直前の再検証、`enabled=false` を拒否として扱わない、OFF の線形化と「送信済みは取り消せない」の明記、drain/fence、行列テスト） |
| v1（PR171） | §7.4 L219「台帳ポリシー `enabled=false` または `max_calls=0` → `BUDGET_DENIED`」、§9 G6 L248「`ai_ask_allowlist` または per_user ポリシーの `scope_user_id`」、T18 |
| v2 | **§3**: 権威的ゲート（`ai_ask_settings.enabled`／`access_mode`＝`deny_all`／`allowlist`／`all_enrolled`／`ai_ask_allowlist`）、4 つの評価点（begin／replay／dispatch／finish）、OFF の線形化点（設定行の commit・`FOR SHARE`）、残りの上限、台帳ポリシーはコスト上限のみ、OFF/rollback の順序 |
| 反例の扱い | 広い方針＋特定方針で別ユーザーが通る → 許可リストは DB の権威で、台帳の `scope_user_id` を使わない（§3.4）。`enabled=false` は制約の除外 → 停止に使わない。cap0 後も既存の保留が送れる → **送信の直前に必ず authorize（ゲート再評価）を通る**構成にし、保留単体では送れない（§3.3） |
| 受入テスト | T18（行列化）、T23〜T25、T31（同意撤回の中途）、T41（権限） |
| ソース根拠 | 台帳 migration `:457-479`（既存予約が方針より先）、`:482-497`（`enabled` で対象を選ぶ・無一致は `NO_MATCHING_POLICY`）、`:651-680`（`mark_sent` は方針を見ない）。J1 の実 PG17 反例 6 PASS（`J1.md:121`） |
| 残る決定 | D4（上限の値）、D6（公開時期）。許可リストの運用主体（operator）は別 TASK |

### J1-R2 [P1] 論理要求の冪等・1 件ガードに永続状態が要る

| 項目 | 内容 |
|---|---|
| J1 原文 | `J1.md:42-47`（永続の所有/claim・ユーザー同時実行・ID 上限・名前空間・ペイロード hash・不一致拒否・CAS・全遷移表・送信 1 回固定・TTL≠重複排除 TTL・全公開形の再生・喪失窓の受入） |
| v1 | §2 手順 3（advisory lock）、§7.3（`answered` のみ再生キャッシュ。`in_flight`→`timeout`、`failed`→`attempt+1`）、T6/T8/T9 |
| v2 | **§4**: `ai_ask_user_state`（永続の 1 件ガード）・`ai_ask_requests`（要求行）・`ai_ask_daily_usage`（日次カウントを TTL から分離）、状態 8 種・遷移 10 本、不変条件 I-1〜I-3、`callId` の名前空間と `send_epoch`、`payload_digest`（DB 計算・長さ前置）、失われた応答の窓の表、TTL=15 分の応答と tombstone=48 時間の分離、`transport: {maxAttempts:1, retryOnTimeout:false}` |
| 反例の扱い | RPC commit で advisory lock が解放 → 状態を**行**に持つ（lease 付き）。attempt+1 で再送 → attempt は常に 1。再送は送信前エラーが証明された `failed_unsent` のみ（新 callId）。TTL 切れの再課金 → tombstone で `result_expired`（終端）。拒否・課金済み失敗の再生 → 公開形を全て保存（§4.6）。送信後に落ちた → `unknown_after_send`（再送しない） |
| 受入テスト | T5〜T9（T8/T9 は期待を訂正）、T26〜T29、T37、T38 |
| ソース根拠 | 台帳 `reservations_attempt_key (request_id, attempt)`（migration `:237`）、`:469-478`（`reserved` は再取得可・`sent`/確定済みは拒否）、`types.ts:41-49,76-92`、`execute.ts:75-76`・`ledger_guard.ts:131`（callId→request_id） |
| 残る決定 | D3（15 分キャッシュ。持たない場合も再課金は不可）、D8（自動フォールバック・不明の再試行なし）、D10（lease 秒・tombstone 期間） |

### J1-R3 [P1] 匿名・失効・ライフサイクルの保証が不足／begin だけの確認では後の副作用が残る

| 項目 | 内容 |
|---|---|
| J1 原文 | `J1.md:49-53`（検証済み UUID＋ロール、`is_anonymous===false`、静的キー拒否、不明は fail-closed、セッション失効の意味か受容遅延、active な共通アカウント＋entitlement＋profile＋同意＋ゲートを begin/replay/dispatch 直前/finish で確認、版数フェンス、削除後の再挿入不可、`profiles.id ON DELETE CASCADE`、RPC の ACL 表、F5 所有の尊重） |
| v1 | §3 A2/A5/A7、§2 finish、§4.2 キャッシュ、T4/T21 |
| v2 | **§5**: 入口の本人確定（§5.1: A1〜A5。静的キー拒否・`is_anonymous===false`・欠落は拒否）、セッション失効（§5.2: 既定 S1＝受容遅延を JWT の残存期間とし運営者の明示承認を要す／S2＝live predicate は G4 の確認後）、ライフサイクル述語と版数フェンス（§5.3）、データの所有と CASCADE（§5.4）、**RPC・表の権限表（§5.5）** |
| 反例の扱い | provider 待ち中の退会・撤回 → authorize／finish で `lifecycle_version`・`consent_epoch`・`settings_epoch` を再比較し `cancelled`（回答を保存しない）。`auth.users` FK だけでは残る → `profiles(id)` に CASCADE。finish の任意書き込み → service_role のみ＋`(user_id, request_id, claim_token, 状態)` の CAS |
| 受入テスト | T1、T4、T21、T30、T31、T41〜T43 |
| ソース根拠 | `common_accounts`／`service_entitlements`（`20261001150000_…:224-250,341-345`）、I7 `lifecycle_version` の自動増加（`:48-49,410-427,462-472`）、footprint `kabumori = exists(profiles)`（`:567-590`）、`profiles`／`tracked_stocks`（`20260901061217_…:19-47`）。Supabase の匿名 Auth／セッション仕様は J1 が公式 docs を確認（`J1.md:130`） |
| 残る決定 | **D9（新）**: セッション失効の受容遅延 S1／S2。F5 の述語・workflow は**変更しない**（読むだけ） |

### J1-R4 [P1] ID の存在・数値の部分一致では根拠づけ・注入防止にならない

| 項目 | 内容 |
|---|---|
| J1 原文 | `J1.md:55-59`（事実文は型付き claim か抽出テンプレートのみ、質問は証拠に昇格しない、per-request の証拠 ID・出典の関連づけ・非空の証拠、エスケープ/直列化、ツール・URL 無し、不活性テキスト、固定の拒否、反例ケース） |
| v1 | §5.2 スキーマ（`facts` 0..8・自由な `answer`・`interpretation`）、§5.3 V2〜V6、§6 |
| v2 | **§7**: V1 は**抽出的**。モデル出力は `refusal`・`picks`（証拠 ID の選択）・`topic` のみ。`answer` は固定テンプレート、`keyPoints` は証拠のサーバー確定文、`sources` は証拠から生成。`interpretation` は V1 に無い（型付き主張は B2・別 J レビュー）。検証 V1〜V6 を再定義（空の picks を回答にしない等）。残るリスク（無関係な実在証拠の選択）を明記 |
| 反例の扱い | `facts=[]`＋自由な answer → 自由文の出口が無い／picks 空は `insufficient_evidence`。「A社5%下落」を「B社5%上昇」にすり替え → モデルが数値・銘柄を書けない。質問の数値が根拠 → 質問は証拠表に入らない。誘導・売買指示の迂回 → モデルの自由文が出ない＋描画後の語彙検査 |
| 受入テスト | T11〜T15、T33、T40 |
| ソース根拠 | `validate.ts`（JSON Schema 検証。G6）、`structured output`（`AiRequest.jsonSchema`）。V1 の語彙リストは新規の純関数（B1-b） |
| 残る決定 | D1（モデル）。型付き主張（B2）は別 TASK |

### J1-R5 [P1] 同意とデータ選択に明示的な scope 許可表が要る

| 項目 | 内容 |
|---|---|
| J1 原文 | `J1.md:61-65`（scope→データ源→項目射影のサーバー権威表、market は保有・ウォッチ・スナップショット・保有派生を読まない、holdings/stock は同意の後に全個人データを読む、`usedHoldings` の真実性、stock はサーバーで拒否、自由文の PII は「防止」ではなく扱いを規定、提供元・保持期間の公開、撤回のフェンス） |
| v1 | §2 手順 4（全データ源を 1 つの流れに）、§4.1、§4.3「market は同意不要」、§8 |
| v2 | **§6**: scope 許可表（§6.1）、項目射影（§6.2）、同意の目的別 P1/P2・版数・撤回と読み取りの順序（§6.3）、自由文 PII の事前拒否（best-effort。§6.4）。market は P1（質問の送信）を要し、保有由来の読み取りを一切しない。stock は `scope_unsupported` |
| 反例の扱い | `scope=market` で保有風の質問 → 個人データを読まないので `insufficient_evidence`／市況のみ。stock を古いクライアントが送る → サーバーで拒否。質問内の数量 → 事前フィルタで拒否（防止は約束しない） |
| 受入テスト | T16、T32、T36、T39、T31（撤回） |
| ソース根拠 | `get_my_important_stock_news` が本人の追跡銘柄で絞る（`20260917120000_…:114-`）＝保有から派生。`tracked_stocks` RLS（`20260903150000_kabumori_grants.sql`）。現行プライバシーポリシーは AI Ask を網羅しない（`J1.md:65`） |
| 残る決定 | D2（同意と文面・REL-04）、D5（scope）。公開ページは本 TASK で変更しない |

### J1-R6 [P2] 時点不明・未来・保有の評価の完全性が鮮度の境界を満たさない

| 項目 | 内容 |
|---|---|
| J1 原文 | `J1.md:67-70`（種別ごとの資格、`0 ≤ age ≤ 72h`＋許容、null/未来の除外、取引日と生成時刻の区別、混在時の範囲、構成比の完全性、`registrationMatchesSnapshot` の区別、30 件打ち切りの扱い） |
| v1 | §5.4（「`asOf` が null の証拠は使える」「72 時間を超えたもの」）、§4.1（≤30） |
| v2 | **§8**: 時点の資格（§8.1: `-5分 ≤ age ≤ 72h`、null/未来は除外、市況は `trading_date` と `generated_at` を区別、基準日は全銘柄同一）、`dataAsOf` ＝最古（§8.2）、構成比の完全性条件（§8.3: 件数・数量・終値・登録一致・現物/買いのみ・同一基準日・分母＝全体） |
| 反例の扱い | 未来日付が上限だけを通る → 下限を追加。30 件で打ち切って全体扱い → `count` で検知し構成比を出さない。数量欠損・信用/売り・登録変更 → 構成比なし（0 で埋めない） |
| 受入テスト | T10、T34 |
| ソース根拠 | `registrationMatchesSnapshot`（`src/lib/stock-detail-view.ts`: `tracking_type`・`quantity`・`average_price`・`position_type`・`side`。空欄≠ワイルドカード）、`tracked_stocks` の CHECK（`quantity>0`・`position_type ∈ cash/margin`・`side ∈ long/short`） |
| 残る決定 | D10（市況の最大経過日・許容 5 分） |

### J1-R7 [P2] 費用の見積りと濫用上限が固定の実行可能な予算契約になっていない

| 項目 | 内容 |
|---|---|
| J1 原文 | `J1.md:72-75`（バージョン固定の provider/model/effort/maxOutputTokens/deadline/transport、共有の上界計算、入口の本文・深さ・キー・ID の上限、証拠・全体プロンプトの上限、DB の原子的な日次＋分次、単一飛行、全体日次・月次の承認、最悪ケースの日本語/Unicode、請求・クレジットは未知） |
| v1 | §7.2（名目 6,000 トークンの試算）、§7.1 L1〜L4、§6 末行 |
| v2 | **§9**: 固定契約（§9.2）、**実コードで算出したバイト上界の表**（§9.3）、上限の層 L0〜L4（§9.4: 入口・ゲート・日次・分次＋1 件ガード・台帳・プロバイダー） |
| 反例の扱い | 名目 0.036 USD の Sol 級が実際の予約で 0.05 USD を超え拒否になる → 実計算 0.0521 を明示。Luna/Haiku は 0.0026。**モデルを D1 が決めてから同じ関数で再計算して固定**する。入口・本文のバイト上限で ID・証拠・連打を縛る |
| 受入テスト | T19、T35、T5（JST ロールオーバー）、T6（分次・1 件ガード） |
| ソース根拠 | `cost.ts:14,37-58`（UTF-8 バイト＋2,048、出力 `maxOutputTokens`×単価）、`model_catalog.ts`（`verifiedOn: 2026-10-10`）、**§5 の実計算** |
| 残る決定 | D1（モデル）、D4（回数・全体 USD）。月 5 USD の試行枠は変更しない |

### J1-R8 [P2] B1-a/b を §8 だけでは安全に並行できない（finish/replay の権限と応答の列が未定義）

| 項目 | 内容 |
|---|---|
| J1 原文 | `J1.md:77-80`（入力境界・digest・ID 形式、active claim/cas/lease と終端、RPC ごとの EXECUTE/SELECT・安全な列、保護された応答の保管とユーザー所有の replay API の区別、版管理されたエラー・unknown の UX、同意・残りのセマンティクス、facts→keyPoints≤5 の写像、公開応答に生エラー等を入れない、B1-c は PR166 マージ後＋凍結契約、pending は新 version） |
| v1 | §8（Phase A→B の差分表）、§12（B1-a/b/c/d 候補） |
| v2 | **§10**: 共通契約 v1（§10.1 入力・§10.2 応答と写像・§10.3 失敗コード 7＋7・§10.4 Phase A 互換・§10.5 pending は v2・§10.6 B1 の共有成果物）。**§5.5 の RPC 権限表**と §4.2/4.3 の表・遷移を凍結の正本として参照 |
| 反例の扱い | 「facts≤8 vs keyPoints≤5」→ 写像を固定（picks ≤5 ↔ keyPoints ↔ sources）。「cache は service-only なのに replay が要る」→ `get_ai_ask_result`（`authenticated`・`auth.uid()`・公開形のみ）と保護列 `public_response` を分離。pending/期限切れ/unknown の欠落 → `in_progress`／`result_expired`／`result_unknown`／`consent_required` 等を追加 |
| 受入テスト | T2、T8、T41、T20、T44（契約の機械照合：新コードと写像） |
| ソース根拠 | PR166 `ai-ask.ts:28,45-52,74,227-249`（失敗コードは閉じた 7 値、`isRetryable`、`keyPoints: string[]`）。PR166 は未マージ・未出荷（互換の自由度あり） |
| 残る決定 | 契約の凍結は J1 の限定再レビュー PASS が条件。B1-c は PR166 のマージ判断に依存 |

## 2. v1 から**変更していない**もの（再確認）

- Edge 同期方式（ジョブ方式は将来の v2 契約）、本人 ID は JWT のみ・リクエストに ID なし、保有の読み取りはユーザートークン＋RLS、外部 AI へ数量・取得単価・メモ・メール・ユーザー ID を送らない、出典・時点はサーバー生成、G6 `ai_provider` と台帳の利用（派生 PR #148→157 には依存しない）、G2 の個別分析の枠と混ぜない。
- Phase A（PR166）のリクエスト型は不変（`AskRequest` v1）。PR166 のコード・テストは本 PR で変更していない。

## 3. 受入テスト（B1 で実行可能な形にする全 44 件）

実モデル・実 Supabase・実アカウントは使わない。層: **DB**＝ローカル PG（B1-a）、**Edge**＝Deno＋フェイクモデル＋ローカル DB（B1-b）、**Client**＝ソーステスト（B1-c）。`R` 列は対応する J1 指摘。★＝J1 の追加受入（T23〜T35）、◆＝本 TASK で追加（T36〜T44）、◎＝J1 の指摘で期待を訂正した既存テスト。

| ID | 層 | 条件 | 期待 | R |
|---|---|---|---|---|
| T1 | Edge/DB | 未ログイン／Bearer なし／anon キー／service_role キー／静的キー | 401/403。モデル未呼び出し・予約 0・claim 0 | R3 |
| T2 | DB | ユーザー A・B。B が A の `clientRequestId` を再送 | B の行は別。A の回答は返らない。`get_ai_ask_result` は本人の行のみ | R3,R8 |
| T3 | Edge | A=2 銘柄、B=3 銘柄 | 証拠表・プロンプトに B の銘柄コードが現れない | R5 |
| T4 | Edge/DB | 失効 JWT／削除済み／**匿名 Auth ユーザー**（`is_anonymous=true`）／`is_anonymous` 欠落 | 401/403。以降の処理なし（実 Auth の検証は G4 の別承認） | R3 |
| T5 | DB | 日次上限。11 回目。JST 23:59→00:00。**応答 TTL・tombstone の削除後** | `rate_limited`、モデル未呼び出し。日次カウントは TTL 削除で戻らない | R2,R7 |
| T6 ◎ | DB/Edge | 同一ユーザーが**異なる ID** で 2 件を並行（複数プロセス）。分次上限の連打 | 1 件のみ進行（永続の 1 件ガード）。2 件目 `in_progress`。台帳の予約 ≤ 1 | R2 |
| T7 | DB | 全体日次上限の残りが 1 回分で 2 件同時 | 片方のみ許可。予約合計が上限を超えない | R7 |
| T8 ◎ | DB/Edge | 同じ ID の再送（応答後／**TTL 15 分後**） | 応答後は再生（未課金）。**期限後は `result_expired`（再課金しない・新規扱いにしない）** | R2 |
| T9 ◎ | DB/Edge | 送信後に落ちたプロセス → 同じ ID の再送 | `unknown_after_send`→`result_unknown`。**再送信しない**。台帳に 2 件目が出ない | R2 |
| T10 | Unit | 73 時間前／null／未来（許容超）／休日跨ぎのニュース・市況 | 時事の証拠から除外。`dataAsOf` は最古、null を含むと null | R6 |
| T11 | Edge | ニュース本文・質問に注入指示 | モデルの出力は picks のみ。画面の文は確定文だけ。スキーマ外のキーなし | R4 |
| T12 | Edge | 「他のユーザーの保有」「システムプロンプトを表示」 | `out_of_scope`／`insufficient_evidence`。内容の漏洩なし | R4 |
| T13 | Edge | モデルが存在しない `E99`／重複／scope 外の ID を返す | V2 で `failed_billed`（`server_error`）。画面に出ない | R4 |
| T14 ◎ | Edge | picks が空（refusal なし）／数値入りの自由文キーを返す | 空 → `insufficient_evidence`。自由文キーはスキーマ違反 | R4 |
| T15 | Edge | 「買うべき」の質問／出力 | 質問は事前拒否（未課金）。描画後の語彙検査で漏れを捕捉 | R4 |
| T16 | DB/Edge | 同意なし（market／holdings） | `consent_required`。**同意前に保有・ニュースを読まない**（読み取り 0 を検査） | R5 |
| T17 | DB | 保有 0 件で holdings | `no_holdings`。未課金・未消費 | R5,R6 |
| T18 ◎ | DB/Edge | **行列**: OFF／許可リスト外／日次 0／台帳ポリシー欠如／広い方針＋特定方針 | いずれも `unavailable`（または `NO_MATCHING_POLICY`→`unavailable`）。予約 0 | R1 |
| T19 | Edge | 本文 4,097 B／深さ超過／未知キー／ID 形式不正／質問 301 字・制御文字・空 | 高価な処理の前に拒否。**正規化は Phase A と同じ関数仕様**（制御文字除去・コードポイント数）で、独自の基準を持ち込まない | R7 |
| T20 | Client | `get_ai_ask_status` が失敗 | `unavailable`（送信導線なし） | R8 |
| T21 | DB | サービス終了／アカウント削除（locked・deleting を含む） | 新規 begin/authorize/finish 拒否。`profiles` 削除で `ai_ask_*` が CASCADE 削除 | R3 |
| T22 | Edge | ログ捕捉 | 質問・回答・証拠本文・Authorization・メール・ユーザー ID・トークンが出ない | R3 |
| T23 ★ | DB | 広い方針を `enabled=false` にする／別の広い方針が残る | 方針の無効化が**拒否にならない**ことを確認。アプリのゲート（§3.2）は変わらず拒否 | R1 |
| T24 ★ | DB | 許可リスト外のユーザー＋台帳の広い方針が一致 | 許可リスト外は `unavailable`（台帳が許可しても）。予約 0 | R1 |
| T25 ★ | DB/Edge | authorize と mark_sent の間で OFF／cap 0 | OFF 後に新しい authorize は不可。**既に authorize 済みの 1 件は送信され得る**ことをテストで固定（残りの上限の検証） | R1 |
| T26 ★ | DB | 別 ID の同時実行（異なる接続・複数プロセス） | I-2（ユーザーあたり非終端 ≤ 1） | R2 |
| T27 ★ | DB | 同じ ID・異なる payload（質問／scope／ticker／同意版が違う） | `request_mismatch`。未課金・未消費 | R2 |
| T28 ★ | DB/Edge | begin／authorize／finish の応答喪失 | §4.4 の表どおり（送信前は安全に再開、送信後は `unknown_after_send`） | R2 |
| T29 ★ | DB | 落ちた送信者／tombstone 満了／キャッシュ満了 | `unknown_after_send`→終端。tombstone 満了前は再課金しない。満了後の同 ID は新しい論理要求として**明示のユーザー操作**のみ | R2 |
| T30 ★ | DB | 匿名／失効セッション／locked／deleting | 拒否。実 Auth の検証は別承認（G4） | R3 |
| T31 ★ | DB/Edge | 同意・撤回・削除と replay の競合（処理中の撤回） | `cancelled`。回答は保存・返却されない。replay も拒否 | R3,R5 |
| T32 ★ | Edge | market で個人データの読み取りがあるか（センチネル行） | market では `tracked_stocks`・個人化ニュース・スナップショットの読み取り 0 | R5 |
| T33 ★ | Edge | picks 空／入れ替え／質問由来の数値 | 画面に出ない。事実文は全て確定文 | R4 |
| T34 ★ | Unit/DB | null／未来／部分／登録変更後／信用・売り／31 件以上の保有 | 構成比なし（理由は列挙）。0・部分集合の正規化で埋めない | R6 |
| T35 ★ | Unit | 最大入力（システム 3,072 B＋本文 16,384 B・日本語）・1 回上限と予約・JST・held+settled+unknown | `予約額 ≤ max_usd_per_call`（採用モデルで再計算）。超えるなら本文上限を下げる | R7 |
| T36 ◆ | Edge | `scope=stock`／未知の scope／`version≠1`（古いクライアント） | `scope_unsupported`／`unavailable`。何も読まない | R5,R8 |
| T37 ◆ | DB | 同意版が上がった後の同 ID 再送 | digest 不一致 → `request_mismatch`（新しい ID で再同意後に送る） | R2 |
| T38 ◆ | DB | `failed_unsent`→再開（`send_epoch` 1→2→3 回目） | 有料送信は論理要求あたり ≤ 1。epoch 2 が上限で、超えたら `server_error` 終端 | R2 |
| T39 ◆ | Unit/Edge | メール・電話・7 桁以上の数字・「N株」「取得単価」入りの質問 | 事前に `out_of_scope`。未課金・未消費。ログに質問を出さない | R5 |
| T40 ◆ | Unit | 描画の性質テスト: 任意のモデル出力に対し、画面の全文字列が「固定テンプレート」または「証拠の確定文」に含まれる | 例外なし（ファズ入力でも） | R4 |
| T41 ◆ | DB | カタログ検査: 全ての新表・新関数の `has_table_privilege`／`has_function_privilege`（public／anon／authenticated／service_role） | §5.5 の表と一致。`authorize`／`finish` を authenticated が実行不可 | R3,R8 |
| T42 ◆ | DB | `profiles` を削除 | `ai_ask_*` が CASCADE 削除。台帳の行は残る（仕様として固定） | R3 |
| T43 ◆ | DB/Edge | authorize と finish の間で `lifecycle_version`／`consent_epoch`／`settings_epoch` が変わる | `cancelled`・回答なし。送信済みなら内部コードに課金の可能性を記録 | R3,R1 |
| T44 ◆ | Client | 契約の機械照合（新失敗コード・`isRetryable`・picks ≤5 ↔ keyPoints の写像・`remainingToday`） | PR166 の型と整合。未知コードは `server_error` 扱い | R8 |

- J1 が示した T1〜T22 の補強（`J1.md:99-103`）は上表に反映した。**フェイクモデルの敵対ケースは検証器の挙動だけを証明する**。「実モデルで注入が回答に影響しない」はスキーマでは証明されず、B1-d（G4 通過後の別承認）の領域。
- 全ケースは B1 で「宣言」ではなく**実行可能な受入テスト**にする（J1 `J1.md:104`）。

## 4. 本 TASK で実施した検証と未実施

| 区分 | 内容 |
|---|---|
| 実施（read-only） | `origin/main` `7fe597cb`・PR166 `83b51efc`・PR171 `0beda461` の実在確認。J1 Report 全文、PR171 の設計書全文、G6 `types.ts`／`cost.ts`／`model_catalog.ts`、台帳 migration（reserve/mark_sent/ACL）、共通アカウント基盤 migration（表・トリガ・footprint・RPC）、`profiles`／`tracked_stocks`、PR166 `ai-ask.ts` の該当箇所を読み、設計書の根拠行と突合し、行番号を訂正した |
| 実施（オフライン計算） | **§5 のバイト上界**を、main の実コード（`cost.ts`・`model_catalog.ts`）で算出（ネットワーク・環境変数・書き込みなし）。設計書 §9.3 の表と一致 |
| 実施（整合チェック） | 設計書の節番号・テスト ID・失敗コード・RPC 名の相互参照、`git diff --check` |
| **NOT_RUN** | B1 の SQL／RLS／RPC／Edge は存在しないため、実 DB の権限・競合・失われた応答の検証、実 Auth（匿名・セッション失効）、本番の台帳・G2 migration・`verify_jwt`・JWT 有効期限・組織の支出上限、実プロバイダー・実費・実遅延・保持期間、Simulator／実機。**J1 が実 PG17 で確認した台帳の反例 6 PASS は台帳の性質であり、v2 設計の検証ではない** |

## 5. 再現手順（費用の上界・オフライン）

1. `origin/main`（`7fe597cb`）の `supabase/functions/_shared/ai_provider/cost.ts` と `model_catalog.ts` を読み取り専用で import するだけの Deno スクリプトを作る（書き込み・ネットワーク・環境変数は不要）。
2. 要求を次で組み立てる: システム指示＝日本語 3 バイト文字で 3,072 バイト、`userContent`＝同 16,384 バイト、スキーマ＝`{refusal, picks[≤5]{evidenceId, role}, topic}`（JSON 515 バイト）、`maxOutputTokens=800`。
3. `upperBoundInputTokens(request)` と `upperBoundAttemptCostUsd(findModelSpec(model), request)` を各モデルで呼ぶ。
4. 結果（本 TASK で実測）: 入力上界 **22,033 トークン**（= 3,072 + 16,384 + 515 + スキーマ名 + 2,048）。gpt-6-luna／claude-haiku-5-5 は **0.00260331 USD**、claude-sonnet-5-5／gpt-6.1-sol は **0.052066 USD**、claude-opus-5-5 は **0.104132 USD**。
5. 実行コマンドの形: `deno run --no-config --no-prompt --cached-only --allow-read=<スクリプトと main のパス> budget_bound.ts`。**単価は G6 カタログの見積り（`verifiedOn: 2026-10-10`）で、請求額・クレジット残高ではない**。
