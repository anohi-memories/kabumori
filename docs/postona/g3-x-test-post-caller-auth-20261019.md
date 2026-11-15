# G3｜x-test-post の呼び手の認証を全モードで閉じる修正候補（2026-10-19、Issue #318 TASK 4/50）

- task_id: `postona-g3-x-test-post-caller-auth-all-modes-source-fix-20261019`
- 返却先: POSTONA G3のちゃ
- 完了コード: K3
- 判定: **SOURCE_CANDIDATE（deny-net で修正前の漏れを再現、修正後に閉じることを確認）／本番 NO_GO**
  - 未配備で、本番の設定・Cron・秘密は触っていない。
  - **配備には §4 の順番とユーザーの承認が必要**（順番を誤ると、毎分の予約投稿が止まる）。
- 根拠: G5 の一回限りの指摘（Issue #318 #6267545726）と、G3 の前の REPORT（#6267726506）。

## 1. 何が漏れていたか（ソースと、ネット不許可の再現）

- x-test-post は `verify_jwt=false`（2026-10-16・17 の本番の監査の記録。今回は本番を読んでいない）。
  - そのため、プラットフォームは呼び手を確かめない。
  - 修正前の `index.ts` で呼び手を確かめていたのは、`publish_morning_greeting_manual` だけだった。
- `caller_auth_entry_test.ts` は、**本物の `index.ts` の入口**を取り出して呼ぶ。外への通信は、行き先を記録してすべて拒否する。偽の環境変数を使う。修正前の結果:

  | 要求 | 修正前（main の `index.ts`） |
  |---|---|
  | 認証なしの `POST {}` | `rest/v1/scheduled_posts`（古い朝の記録の整理）と **`rest/v1/rpc/claim_due_post`（予約投稿の取得）** に到達 |
  | 認証なしの `{"mode":"useful_tip_dry_run"}` | `rest/v1/useful_tips` に到達。この先で OpenAI を呼ぶ |

- 本番で匿名の呼び出しが実際に通るかは、**確かめていない**（本番の `verify_jwt`、URL の公開の範囲）。断定はしない。

## 2. 修正（`caller_auth_logic.ts` と、`index.ts` の入口の 20 行）

- 本文を読んだ直後、**モードの分岐と、秘密を読むより前**に、全モード共通で呼び手を確かめる。
- 呼び手の種類:
  - **内部**: 次のどちらか。どちらも一定時間の比較で、期待値が空や未設定のときは一致しない。
    - `X-Cron-Secret` が `X_TEST_POST_CRON_SECRET` と一致する（リポジトリの Cron の型。send-push-notifications と同じ）
    - `Authorization: Bearer` が `SUPABASE_SERVICE_ROLE_KEY` と完全に一致する（今の Cron の header が分からないための互換）
  - **管理者**: 既存の検証済みの `resolveAdminAuthorization`（Supabase Auth の `/auth/v1/user` と `admin_users`）。新しい検証の仕組みは足していない。
- モードごとの判断:

  | モード | 副作用 | 許す呼び手 |
  |---|---|---|
  | 指定なし・未知（予約投稿の実行） | 取得、X への投稿、OpenAI、DB の書き込み | **内部だけ**（管理者でも不可） |
  | `useful_tip_dry_run`・`kabumori_voice_dry_run`・`morning_report_dry_run`・`close_report_dry_run`・`us_premarket_report_dry_run` | OpenAI | 内部、または管理者 |
  | `test_morning_greeting_payload` | OpenAI（文章） | 内部、または管理者 |
  | `test_morning_greeting_image` | OpenAI（画像）、Storage への保存 | 内部、または管理者 |
  | `publish_morning_greeting_manual` | X への投稿 | 既存の管理者の確認のまま（403 の応答の形は変えていない） |

- 拒否は 401 `{"error":"X_TEST_POST_CALLER_UNAUTHORIZED"}`。記録（ログ）は出さず、資格情報を返さない。
- 互換: GET は 405 のまま。手動公開の応答の形も変えていない。

## 3. テスト（すべてネット不許可・模擬）

- **修正前に FAIL、修正後に PASS**（`caller_auth_entry_test.ts`、本物の入口）:
  - A1: 予約投稿の実行は、6 種の本文 × 8 種の悪い呼び手で、すべて 401、外への通信 0 回。
    - 悪い呼び手: 認証なし、anon の鍵、偽の JWT、違う Cron の秘密、Cron の秘密を Authorization に、service role を X-Cron-Secret に、service role に余計な文字、役割を偽った header。
  - A2: 試行・テストの 7 モード × 同じ 8 種で、すべて 401。外へは管理者の問い合わせだけ。
- 修正後の正常系と互換:
  - A3: 内部の呼び手（2 種）は通り、DB の最初の呼び出しまで進む。
  - A4: 手動公開は、今の 403 の応答の形のまま。
  - A5: Cron の秘密が未設定なら、service role の完全一致だけが内部。
  - A6: GET は 405。
  - A7: 検証済みの管理者は試行を使える。管理者でない人は 401。**管理者でも予約投稿は実行できない**。
  - A8: 判定のモード名が入口の定数と同じで、入口のすべてのモードを覆っている。判定はモードの分岐と秘密の読み取りの前にある。
  - A9: 管理者の確認の設定が欠けていれば閉じる。
- 単体（`caller_auth_logic_test.ts`）6 件:
  - モードの分類
  - 秘密の比較（先頭のバイトが偶然一致する別の値も不一致）
  - 内部の呼び手
  - 判断の表（予約投稿は管理者の確認を呼ばない、管理者の確認の失敗は閉じる）
  - ソースに記録・env・通信が無いこと
- 変異テスト: 14 個すべて検出（最初は 2 個が生き残ったため、検査を 2 つ足した）。
- 回帰: x-test-post と `_shared` の全体（ネット不許可）。
  - main: 1148 合格・1 失敗、このブランチ: 1163 合格・1 失敗。
  - 失敗は両方とも同じ既存の 1 件（`_shared/brand/ai_lab_event_dedupe_test.ts:786`、外部のプロセスを起動する許可が要る）。
  - 増えた 15 件は新しいテスト。
- 型検査: `index.ts` の既存の型エラーは、main とこのブランチでどちらも 6 件（増えていない）。新しいファイルは 0 件。lint は問題なし。

## 4. 本番に出す順番（別のユーザー承認が必要。この PR は何もしない）

1. **読むだけの確認（許可を得てから）**:
   - 本番の `x-test-post` の `verify_jwt`
   - Cron `dispatch-scheduled-posts` が送っている header の**種類**（値は読まない）
2. Cron が service role の Bearer を送っていれば、この修正はそのまま通る。送っていなければ、次の順で行う。
   - 2-1. `X_TEST_POST_CRON_SECRET` を Function の秘密に設定する。
   - 2-2. Vault に同じ値を名前で置き、Cron の命令を `X-Cron-Secret` を付ける形に変える（send-push-notifications と同じ形）。
   - 2-3. その後に x-test-post を配備する。
   - **配備を先にすると、毎分の予約投稿が 401 で止まる**（安全側ではあるが、運用の停止になる）。
3. 配備の後に読むだけで確かめる: 認証なしの POST が 401 になること（GET は 405）。予約投稿の実行は、Cron の次の回で進むこと。
4. 管理画面などから試行モードを呼んでいる人がいれば、管理者としてログインした JWT で呼ぶ必要がある（これまで認証なしで動いていた呼び方は動かなくなる）。

## 5. 残ること
- **Codex Sol（高）の限定レビュー**（認証の境界）。
- §4 の本番の確認・設定・配備（ユーザーの承認）。
- F2 の Draft PR #213 も `index.ts` に触れている（入口の付近ではない）。マージの順で、小さな衝突が起き得る。
