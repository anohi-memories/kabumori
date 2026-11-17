# G1 — 初期公開（Threads と X）の iPhone ユーザー経路の点検（G1-02 第2 TASK、2026-11-17）

task_id: `postona-g1-gen2-02-threads-x-ios-minimum-release-flow-20261117`（Issue #316）。
範囲: G1 の `apps/social-mobile/**` の実コードの点検と、G1 所有の欠けの結線だけ。G3 の SQL・Edge・Worker、G4 の Threads provider・OAuth、G5 の Auth・Push、G6 の AI は変えていない。
前提: 初期公開の SNS は **Threads と X**。Instagram は後日追加（この文書の経路には入れない）。実 Provider・実 OAuth・managed・production には触れていない。本番は NO_GO。

読み方: 「いまできるユーザー操作」は実コードにある操作。「gate」は製品ソースの定数（すべて OFF）。「ローカルPASS」は G1 のモックまたは使い捨てのローカル環境で通ったテスト。「実 Provider 未検証」と「依存」は、混ぜずに別の列にする。**gate が OFF のものを「使える」とは書かない。**

## 1. 経路（共通）

| 手順 | いまできるユーザー操作 | gate（製品ソース） | ローカルPASS | 実環境・実 Provider 未検証 / 依存 |
| --- | --- | --- | --- | --- |
| ログイン | メール・パスワード等でログイン、パスワード再設定、ログイン方法の確認 | なし（常時） | `auth-*.test.mjs`、`auth-boundary-regression` | 実 Supabase Auth（managed）未検証 |
| サービス開始・ワークスペース | Xの自動投稿サービスの利用開始、個人ワークスペースの確保、初回の案内 | なし | `service-enrollment`、`personal-workspace*`、`onboarding` | 実 G5 の SQL（managed）未検証 |
| 退会・再登録 | 退会の確認、退会後の閲覧専用（出口付き）、再登録 | なし | `account-deletion`、`ended-history`、`approvals`（G1 第47・第50） | 実環境未検証 |
| 本人の切り替え | A→B、サインアウトで画面・既読・要求が混ざらない | なし | 各 `*-harness` の A→B テスト、承認・通知の e2e | 実機未検証 |

## 2. X

| 手順 | いまできるユーザー操作 | gate（製品ソース） | ローカルPASS | 実環境・実 Provider 未検証 / 依存 |
| --- | --- | --- | --- | --- |
| 接続する | アカウント画面でXの接続（OAuth）、接続状態の表示（接続記録／未確認／要再接続）、再接続、切断 | なし（OAuth 開始は画面から） | `x-connect-*.test.mjs`、`x-connect-product-flow.e2e.mjs`（G3 のローカル実環境） | 実 X OAuth、実トークン。G4 の X 認証（G4-02）に依存 |
| 素材 | 設定 →「素材BOX」で画像・動画を保存・確認・削除 | `POSTONA_MEDIA_BOX_ENABLED = false` | `media-box.test.mjs`、`local-stack/media-box.e2e.mjs` | 実 Storage 未検証。**素材を X の投稿に付ける契約は、いまない**（X の単発投稿は `media: []` だけ。`single-post-port.ts`）。G3 の契約が必要 |
| テキスト・手動投稿 | ホーム →「投稿を作成する」で本文を入力 → プレビュー → 送信前の確認 | 送信は**未接続**（`getManualPublishPort()` は `not_connected`。`manual-publish-port.ts`） | `manual-publish-*.test.mjs`（入力・プレビュー・確認・二重送信・再起動・結果不明の扱い） | **送信そのものは、この版では届かない**。G3 の単発投稿 Edge（#272 系）は gate が 503 を返し、準備確認の endpoint もない（`single-post-port.ts`）。G3 の第26 TASK（X の予約・手動送信の準備、Issue #589）と G4 の X 資格情報に依存。G1 は注入口（transport）だけ用意済みで、契約を決めていない |
| 日時予約 | 投稿予定タブで本文・日時を決めて予約、AI 提案、確認の同意 | `POSTONA_RESERVATION_PERSISTENCE_ENABLED = false` | `x-reservation-composer`、`schedule-screen-wiring`、`remote-reservation-store`、`reservation-flow` | 実 G3 の予約 Edge・Worker 未検証。実際に X へ投稿されることは未検証 |
| 予約の管理 | 予約の管理で日時の変更・再確認・取消、行の状態（予約済み／投稿済み／投稿できませんでした／結果不明） | 同上 | `reservation-screens`、`x-row-generation`、`home-reservations` | 同上 |
| 結果を見る | 予約の管理の状態、お知らせ（承認の依頼・予約の状態の変化）、投稿詳細、履歴 | `POSTONA_APPROVAL_UI_ENABLED = false`（お知らせ・承認） | `approvals*`、`notification-pages`、`notification-final-page`（50/51/100/101/150/151/279）、`local-stack/approvals.e2e.mjs` | 実 Push は届かない設計（G5 の Push は G1 外）。実機未検証 |

## 3. Threads

| 手順 | いまできるユーザー操作 | gate（製品ソース） | ローカルPASS | 実環境・実 Provider 未検証 / 依存 |
| --- | --- | --- | --- | --- |
| 接続する | アカウント画面でThreadsの接続（H5 の OAuth runtime 経由）、接続済み／要再接続、再接続（同じ Threads ユーザー）、切断 | `THREADS_CONNECT_UI_ENABLED = false`、`THREADS_DISCONNECT_UI_ENABLED = false` | `threads-connect*.test.mjs`、`threads-disconnect`、`threads-connect-product-flow.e2e.mjs`、G1 第49 の iOS 偽 OAuth rig | 実 Threads OAuth、実トークン。G4 の接続 Edge に依存 |
| 素材 | X と同じ「素材BOX」 | 同上 | 同上 | **素材を Threads の投稿に付ける契約は、いまない**（Threads の投稿の入力は text だけ。`threads-manual-publish.ts` に media の項目がなく、G4 契約 §1.2 にもない）。G4 の契約が必要 |
| テキスト・手動投稿 | **ホームまたは手動投稿の画面の「Threadsに投稿する」→ Threads アカウントの詳細の投稿カード**（同意、サーバーの確認、投稿、状態の確認、結果不明の確認、同じ Threads ユーザーでの再接続） | `THREADS_MANUAL_PUBLISH_UI_ENABLED = false` | `threads-manual-publish.test.mjs`、`threads-refusal-body`、`local-stack/threads-g1-recovery.scenario.mjs`（G4 の runner 上のシナリオ36） | 実 Threads への投稿は未検証。G4 の publish Edge に依存。`uncertain` を成功として見せない・再送を出さない（G4 契約 §1.2・§1.3） |
| 日時予約 | 予約の管理で本文・日時を入れて Threads の予約を作る・取消・レシート確認 | `POSTONA_THREADS_RESERVATION_PERSISTENCE_ENABLED = false` | `remote-threads-reservation-store`、`reservation-screens` | **G3 の Threads の予約 Worker は、G4 の送信 ledger の契約待ち**（G4 契約 §2: 予約経路は別の台帳か明示の契約が要る。中央決定）。実投稿は未検証 |
| 結果を見る | 投稿カードの状態（投稿済み／リンクを特定できない／確認中／投稿できませんでした）、予約のレシート（sent／failed／cancelled／pending／uncertain）、お知らせ | 上の gate | 同上 | 同上 |

## 4. 今回 G1 で結線した欠け（4 つ）

1. **Threads の入口がなかった**: ホームの「投稿を作成する」と手動投稿の画面は X 専用で、Threads の人が投稿を始める場所がアカウントの詳細の奥にしかなかった。ホームと手動投稿の画面に「Threadsに投稿する」を足し、Threads アカウントの詳細（既存の投稿カード）へ案内する。Threads アカウントがなければアカウント画面へ。案内だけで、要求も状態も持たない（`threads-entry.ts`）。
2. **お知らせの入口が設定の中だけだった**: ホームから「お知らせを開く」を足した。
3. **Instagram の見せ方**: 接続の表示を「後日対応」、自動投稿の説明を「後日対応。いまは接続も投稿もできない」にした。画面や機能のコードには Instagram を出さない（テストで固定）。
4. **Threads の自動投稿の説明**: 「まだ利用できません」が Threads は使えないと読めたので、「この切り替えはない。手で投稿するのはアカウントの詳細、日時を決めるのは予約の管理」に直した。

固定したもの（`tests/release-flow-threads-x.test.mjs`）: 登録した画面がすべて別の画面から開ける、ホームから手動投稿・予約・Threads・お知らせへ行ける、Instagram を出さない、製品ソースの gate がすべて OFF。

## 5. G1 だけでは決められない欠け（G3・G4・G5・中央へ）

- **X の手動投稿の送信（G3、最優先）**: 送信が未接続。G3 の単発投稿 Edge の gate、準備確認（readiness）の endpoint、G4 の X 資格情報の判定が揃えば、G1 は `single-post-port.ts` の transport と `checkReadiness` をつなぐだけ。契約が決まるまで G1 は結線しない（G3 の第26 TASK の対象）。
- **素材を投稿に付ける契約（G3・G4）**: X の単発投稿は `media: []`、Threads は text のみ。素材BOX は保存・確認・削除までで、投稿には付かない。付けるなら、両方の契約（media の形、権利、容量）が先。
- **Threads の予約の実送信（G3・G4・中央）**: G4 の契約 §2。予約の経路が手動の attempt 台帳を使うか、別の台帳を作るかの決定が先。
- **通知の「投稿の結果」（G3）**: お知らせの種類は、承認の依頼・承認・却下・予約の状態の変化まで。手動投稿の結果は投稿カード、予約の結果は予約の管理に出る。結果を通知として残すなら、G3 の notification kind が要る。
- **Push（G5）**: 通知は一覧で読み返す設計。端末へ届く Push は G5 の領分で、G1 は届くと表示しない。

## 6. 実 Provider の試験に必要な、ユーザーの許可・資格情報・外部設定

- Threads: 実 Threads アプリ（Meta の開発者アプリ）の App ID・Secret、テスト用 Threads アカウントとテスターの招待、OAuth の redirect URI の登録。
- X: 実 X の開発者アプリの Client ID・Secret、テスト用 X アカウント、OAuth の redirect URI、投稿に必要な権限（scope）。
- managed Supabase: 検証用プロジェクト（本番と分けたもの）の接続、Edge の環境変数（Vault の鍵）、migration の適用の許可。
- 実機: Apple Developer の署名と TestFlight（EAS・署名は、中央の許可があるまで使わない）。
- 費用の出る試験（AI、実 SNS への投稿）の許可。
- 中央の判断: gate（`*_ENABLED`）を ON にする順序と、release の窓。

## 7. 再現

```bash
cd apps/social-mobile
npm ci
npx tsc --noEmit && npm run lint
node --test tests/*.test.mjs          # ネット遮断下では: sandbox-exec で network を拒否して実行
node --test tests/release-flow-threads-x.test.mjs
```

実環境（Kong → Edge → PG17）は `tests/local-stack/run-x-disconnected.sh`（G3 の使い捨て環境を G1 の名前で起動）と `run-threads-g1-flow.sh <G4 #664 を手元で merge した使い捨ての木>`。どちらも 127.0.0.1 だけで、managed・実 SNS には届かない。
