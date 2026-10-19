# G3｜x-test-post の認証（PR #349）を入れる前の、Cron と全呼び手の互換性の検証（2026-10-20、Issue #318 TASK 5/50）

- task_id: `postona-g3-x-test-post-cron-caller-compat-offline-20261020`
- 返却先: POSTONA G3のちゃ
- 完了コード: K3
- 判定: **OFFLINE_COMPAT_PROVEN / PRODUCTION_PROFILE_UNKNOWN → PR #349 の配備は NO_GO**
  - Cron の header が分かるまでは、配備しない。
  - 今回は、本番の読み取りも書き込みもしていない。
- 対象:
  - PR #349（`d61017cfd3a5dd94cde35cb91d6f314760b4713a`、認証の修正候補、**本番に未適用**）
  - main（修正前）
- 置き場所: `supabase/candidates/x_test_post_caller_compat/`（Function からは import されない）。PR #349 のファイルは変えていない。

## 1. 呼び手の証拠一覧（リポジトリだけで分かること）

| 呼び手 | 証拠 | PR #349 の後 |
|---|---|---|
| Cron `dispatch-scheduled-posts`（jobid 1、毎分、active） | `docs/kabumori-resume/evidence/2026-10-17-final-audit/observations.json`: edge_function = x-test-post、command の指紋 `88b3310282eedc9f49d56878992b1094`。**24 時間の x-test-post の呼び出しは、すべて user agent `pg_net/0.20.4`**（200 が 1221 回、201 が 11 回、500 が 2 回）。**header はどの監査でも読まれていない** | header 次第（§2）。**UNKNOWN** |
| 手動公開（`publish_morning_greeting_manual`） | `index.ts` の管理者の確認（`resolveAdminAuthorization`） | 変わらない（管理者だけ。応答の形も同じ） |
| 試行・テストの 7 モード | リポジトリの中（docs・scripts・apps・workflows・migrations）に呼び出しの手順は 0 件。2026-10-17 の 24 時間の観測でも、pg_net 以外の呼び手は 0 | 管理者の JWT か内部の資格情報が必要（認証なしの呼び方は 401） |
| GitHub Actions・管理画面 | x-test-post への呼び出しは見つからない | — |

- 同じ DB の他の Cron の例:
  - `send-push-notifications`: Vault の秘密を `X-Cron-Secret` で送る（`20260910163500`）
  - important-news: `Content-Type` だけ（`20260908110000`）

  x-test-post の Cron が、そのどちらの型でもあり得る。

## 2. 互換表（本物の入口を、修正前と修正後で実測。ネット不許可）

`caller_compat_run.sh` は、`supabase/functions` を一時フォルダに 2 つ写し、修正前（main の `index.ts`）と修正後（このブランチ＝PR #349）の、本物の入口を呼ぶ。

| Cron の header の形 | 修正前 | PR #349 の後 |
|---|---|---|
| `Authorization: Bearer <service role の古い JWT>`（Function の env と同じ） | 実行される | **実行される** |
| `X-Cron-Secret: <X_TEST_POST_CRON_SECRET>` | 実行される | **実行される**（秘密が設定済みなら） |
| `Authorization: Bearer <anon>`（＋apikey） | 実行される | **401 で止まる** |
| `Authorization: Bearer sb_secret_…`（新しい形式の鍵） | 実行される | **401 で止まる**（env は古い JWT のため不一致） |
| `apikey` だけ | 実行される | **401 で止まる** |
| 認証なし（Content-Type だけ） | 実行される | **401 で止まる** |
| `X_TEST_POST_CRON_SECRET` が未設定で、Cron の秘密を送る | 実行される | **401 で止まる** |
| `SUPABASE_SERVICE_ROLE_KEY` が未設定で、Bearer を送る | 500（秘密が無い） | **401 で止まる** |

- 予約投稿の実行に、人の呼び手（認証なし・管理者・管理者でない人・期限切れ）を当てた場合:
  - 修正前は、すべて実行される。
  - 修正後は、すべて 401。**管理者でも実行できない**。外への副作用は 0。
- 試行・テストの 7 モード × 6 種の呼び手:
  - 修正前は、すべて通る（認証なしでも）。
  - 修正後は、管理者と内部の資格情報だけが通る。認証なし・管理者でない人・期限切れの JWT は 401 で、副作用は 0。
- 手動公開: 修正前も修正後も同じ（管理者だけ、ほかは 403）。
- **正規の Cron が、設定の不足だけで止まり得る**ことを、そのまま示した。拒否する側を緩めてはいない。

## 3. 本番に出す順番（`rollout_model.ts` で検査できる形にした）

- `evaluateRollout(plan)` は、今の状態（main を配備済み、Cron の形は UNKNOWN、Cron の秘密なし）から、計画の各段階の後に毎分の予約投稿が実行され続けるかを判定する。
- 判定の根拠は、§2 で実測した本物の入口の動き（テストで一致を確認）。
- 結論（テストで確認したこと）:
  1. **Cron の形が UNKNOWN のまま配備する計画は、どれも NO_GO**。
  2. 形を読んだ後の安全な順番は、**Function の秘密の設定 → Cron を `X-Cron-Secret` に切り替える → PR #349 の配備**。どの形でも、各段階で止まらない。
  3. **配備を先にすると**、service role の Bearer 以外のすべての形で、配備の時点で止まる。
  4. Cron を秘密より先に切り替える計画は、拒否する（Function が確かめられない header になるため）。
  5. Cron が service role の Bearer なら、変更なしで配備だけでよい。
  6. ロールバック（main に戻す）で止まりは解けるが、それで計画は合格にならない。
- 手順の全体（それぞれ別の明示の GO が要る）:
  1. **読むだけの事前確認**（`read_only_preflight.sql`）。真偽の値だけを返し、命令の本文・header の値・秘密は読まない。`verify_jwt` と秘密の名前の確認も含む。
  2. Cron の header と秘密をそろえる（Vault の名前で秘密を置き、Function の秘密を設定し、Cron の命令を変える）。
  3. **PR #349 の Codex Sol（高）の限定レビュー**。
  4. ステージングまたはオフラインでの再試験（このランナーを、決まった形で流し直す）。
  5. 配備（x-test-post だけ）。
  6. 読み戻し:
     - 認証なしの POST が 401、GET が 405 になること。
     - Cron の次の回が 200 か 201 になること（`net._http_response` の状態コードの件数だけを見る）。
     - 止まっていたら、すぐ main の版に戻す。

## 4. 個別の承認が必要な、本番を読むだけの確認（ソースでは埋まらないもの）
1. Cron `dispatch-scheduled-posts` の header の**形**（`read_only_preflight.sql` の 1）。値は読まない。
2. Cron が Vault を読んでいる場合の、秘密の**名前**（同じく 2）。
3. x-test-post の `verify_jwt` と、Function の秘密の名前（CLI のメタデータ）。
4. 直近の呼び出しの状態コードの件数（同じく 3）。

## 5. F2 の PR #213 との重なり
- 読むだけの merge-tree で確かめた。PR #213（`c10f1da593ba3dc365cf340e9569ae1caa9789b1`）と PR #349 は、**`index.ts` で衝突しない**（自動で合わさる）。
- 衝突は PR #213 の古い管理ファイル（`.agent_v2/ACTIVE_TASK.md`・`.agent_v2/tasks/F2.md`）だけ。
- PR #213 の追加は秘密の確認より後ろ、PR #349 の確認はその前なので、順番の上でもぶつからない。

## 6. テスト
- `caller_compat_run.sh` → `X_TEST_POST_CALLER_COMPAT_ALL_PASS`
  - 修正前の表: 5 件
  - 修正後の表: 5 件
  - 順番の模型: 4 件
  - 表の行は修正前と修正後で 62 行ずつ。どの行も、模型の予測と一致することを確かめた。
- 変異テスト: 模型と、PR #349 の判定（このブランチの写しの中だけで改変）に 8 個。すべて検出した（最初は 1 個が生き残ったため、表の行を足した）。
- 回帰: PR #349 のテスト 15 件が合格。型検査は新しいファイルで 0 件。lint も問題なし。
- NOT_VERIFIED:
  - 本番の Cron の header
  - `verify_jwt`、秘密の有無
  - ステージング
  - 配備後の動き
