# G4-12：Threads の本物のアカウント ID の確認と、W1/W2 の拒否コードの整合（offline）（2026-10-20 JST）

- task_id: `postona-g4-threads-account-id-worker-code-offline-fix-20261020`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ／完了コード K4／`next_task_allowed: false`
- 判定: **SOURCE_ONLY（G4 の TS と偽物だけ）**。本物の Auth／管理環境／Threads／本番は NOT_VERIFIED／NO_GO。
- 土台: PR #373（G4-10、head `61e94a10026df2eb6aa5f3acdc4f4512c4cb96fd`）の上。
  - PR #377（G4-11 の SQL、H2 がレビュー中）と PR #367（G4-09 の SQL、H2 CHANGES_REQUIRED_P2）は**含めず、触っていない**。どちらも SQL だけで、この TS は #373 と同じ。

## 1. U2：本物のアカウント ID（`sa_...`）
- **問題**（G3 U2、G4-11 の重ね合わせで確認）:
  - `public.social_accounts.id` の CHECK は `^[a-z][a-z0-9_]{1,80}$`（例: `'sa_' || substr(md5(brand || ':x'), 1, 24)`）。
  - G4-02 `credentialFor`・G4-03 `connectedReceiptAccountId`・G4-04 `bindingProblem` は **UUID だけ** を受け付けていた。そのため、本物のアカウントはどれも拒否されていた（G3 では `THREADS_CREDENTIALS_UNAVAILABLE`）。
- **修正**:
  - 新しい `supabase/functions/_shared/social/social_account_id.ts`（何も import しない）に、表の CHECK と同じ確認 `isSocialAccountId` を1つだけ置いた。
  - 3つの入り口は、どれもこの確認を使う。`threads_disconnect.ts` の `SOCIAL_ACCOUNT_ID` も、ここからの再 export にした（定義は1つ）。
  - テストで、migration `20261007150000` の catalog の確認の文字列と、正規表現が一字一句同じであることを確かめる。
- **拒否するもの**: 空、1文字、82文字以上、先頭の数字・`_`、大文字、`-`、UUID、前後や途中の空白、改行（`$` は文字列の最後だけ）、制御文字、ASCII 以外の文字（全角、ゼロ幅、絵文字など）、`.`・`/`・`'`、文字列でない値（`String` オブジェクト、配列を含む）。
  - どれも、口（アカウントの読み取り・G5・資格情報の1文）に触れる前に拒否する。
- **緩めていないもの**:
  - 人の ID（`auth.users`、UUID）の確認はそのまま。
  - 行の ID がちょうど同じであること、ブランド、結び付けた人、R1、W1／W2、owner epoch と lifecycle_version、G3 の世代は変えていない。
  - 形の正しい別のアカウントの ID は、資格情報の1文がその ID の行を返さないので `CREDENTIAL_UNAVAILABLE`。送信は0回。

## 2. U7：`SERVICE_GENERATION_UNAVAILABLE`
- G5 PR #371（`7140e416e32bafc7ce6c0463c3821e7eac96d1f6`）の W1／W2 は、lifecycle のトリガーが P1 のものとちょうど同じでないときに `SERVICE_GENERATION_UNAVAILABLE` を返す（G3 の通知: Issue #319 コメント 6287876236）。
- `G5_WORKER_VERDICT_CODES` に1つ足した。これで一覧は、#371 の W1 が `active` 以外に返すコードとちょうど同じ15個になる（テストで固定）。
- 変わるのは、拒否の理由のコードが正しく伝わることだけ:
  - 最初の確認で返れば、`refused SERVICE_GENERATION_UNAVAILABLE`。公開の要求は0回。
  - 送信前のフックで返れば、`not_written publish THREADS_PREPUBLISH_REFUSED`。公開の要求は0回。
  - 知らないコード（大文字小文字・空白・似た名前を含む）は、今までどおり `WORKER_VERDICT_UNKNOWN`。

## 3. テスト（実測。head `59b5e2453bcc733ddfb218be40fb583bb7668694`）
| 実行したもの | 結果 |
|---|---|
| Threads の TS 全体（`--no-config --no-check --allow-read=. --deny-net`、entry_composition と H5 の connector を除く） | **310 passed／0 failed**（元の 295＋新しい 15） |
| 同じ一式を土台 `61e94a10` で | 295 passed／0 failed（PR #373 の数を再現） |
| H5 の config（entry_composition＋connector） | 17 passed |
| `deno check --no-config`・`deno lint --no-config`（変更した11ファイル） | エラー0 |
| G4-12 のミューテーション | **25/25 を検出** |
| G3 PR #379（`349d21c3…`）の本物の G5 SQL の重ね合わせ（使い捨ての PG17 17.11） | 土台 `61e94a10`: 12/12 PASS。G4-12: **11 passed／1 failed**（下記） |

- G4-12 のミューテーション: 正規表現（長さ、先頭、大文字、`i`・`m` フラグ、`-`、両端のアンカー、Unicode の文字、typeof なし、常に真）、disconnect の別の定義、3つの入り口それぞれで確認を外す・UUID に戻す、行の ID を比べない、`SERVICE_GENERATION_UNAVAILABLE` を一覧から外す・`active` として扱う・フックで許す、どんな文字列もコードとして通す、知らないコードを一覧に足す。
- G3 の重ね合わせの1件の失敗は、**意図どおりの変化**:
  - R10 の U2 の確認（`g5_real_sql_e2e_test.ts:375`）は、「本物の形の ID は資格情報を得られない」という**直す前の不具合を固定する**ものだった。
  - G4-12 では、本物の SQL の世界で、G4 の本物の資格情報の口が `sa_...` の行を受け取り、G3 の配信は**プロセスの中の偽の Graph** に公開された（`published PUBLISHED`、偽の Graph への要求4回）。本物の Threads には何も送っていない。
  - 残りの 11 件（停止と再開、A→B→A、凍結、リースの喪失、公開の不明など）は、G4-12 でも PASS。
  - G3 に1回だけ通知する（R10 の U2 の期待を新しい振る舞いに改める必要があるため）。
- 以前のミューテーションのスクリプト（G4-08／hook／G4-10）は、今回は再実行していない（NOT_RUN）。
- 公開の要求は、すべての拒否で0回。本物の外への書き込みは0回（`--deny-net`。重ね合わせは `127.0.0.1` の使い捨ての PG17 だけ）。

## 4. 行っていないこと
- PR #377・#367 の SQL とそのレビューのブランチ、H2 のレビューの worktree への変更
- G3／G5／H5 のファイルの変更（G3 の runner・テストは、読むだけの写しで実行した）
- G5 の R0（ブランドなしの bootstrap）の接続、SQL／Auth の作業
- 本物の接続、ゲートを開くこと（4つのゲートは false のまま）
- main への push、マージ、デプロイ
- X の OAuth の PR #353／#355（マージ不可のまま）
