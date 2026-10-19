# G4-04：Threads の接続 → 資格情報 → 投稿のオフライン縦断 adapter（2026-10-19 JST）

- task_id: `postona-g4-threads-connect-to-send-offline-vertical-adapter-20261019`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ／完了コード K4／`next_task_allowed: false`
- 判定: **SOURCE_ONLY_CANDIDATE（固定 OFF・どこにも接続しない）**。本物の DB／Auth／Meta／Threads／本番は NOT_VERIFIED、PRODUCTION_NO_GO。
- 土台: PR #341（head `badf3c59c61c2016c4752f78ad2c0ad2f8b2dfea`）の上。

## 1. 何を組み合わせたか（新しく作り直したものは無い）
`supabase/functions/_shared/social/threads_connect_to_send.ts`

| 段階 | 使う既存の部品 | 呼ぶ口 |
|---|---|---|
| 接続の後の結び付け `bind` | G4-03 `decideThreadsAccountBinding` | アカウントの読み取り → G5 の本人の判定 |
| 投稿 `postOnce` ①ローカルの確認 | — | 口に触れない（ゲート・キー・結び付けの形と凍結・owner epoch・結び付けた時刻・世代の形・本文） |
| ② 資格情報 | G4-02 `createGatedThreadsCredentialPort`（1文・キャッシュなし） | 資格情報の文 |
| ③ 照合 | — | 資格情報の Threads の ID＝結び付けの ID、世代＝G3 の preflight の世代 |
| ④ 最後の確認 | G5-02 の W2 の形（`'active'` か G5 のコード） | G5 の worker 判定（ブランド・キー・結び付けの epoch・結び付けの時刻） |
| ⑤ 送信1回 | G4-02 `createGatedThreadsSendPort`（既存の2段階の投稿） | Threads（再送しない） |
| G3 向け | 同じ G4-02 の2つの口（`credentials`／`sender`） | G3 は W1 を自分の preflight の文の中で使う |

## 2. いまは必ず閉じている（テストで固定）
- `THREADS_VERTICAL_PATH_ENABLED` と、組み合わせた3つのゲートがすべて false。
  - 送信0、DB の読み取り0、トークンの読み取り0。
  - 本番用の口は、`transport: 'threads'` を名乗る（呼び手が `simulated` を渡しても変えられない）。
- `THREADS_POSTING_SERVICE_KEY = null`。`x_autopost`／`kabumori` も、今の G4 の規則では拒否（下の §4）。
- **PR #124 の今の行（結び付けの owner epoch が無い）は結び付けではない** → `BIND_EPOCH_UNRECORDED`。資格情報・送信には進まない。
  - PR #124 の `x_autopost` の利用と epoch の無い記録を、正しい実接続とはみなしていない。
- 資格情報の文と G5 の worker 判定は、どちらも存在しない（`CREDENTIAL_UNAVAILABLE`／`WORKER_VERDICT_UNAVAILABLE`）。
- テストでは、架空のキー `postona_threads_test` を、テストの中だけで使った。

## 3. 拒否と再送0（テストで確かめたこと）
- **結び付けで拒否**: 別の人（`PRINCIPAL_CHANGED`）、別のブランド（`BRAND_MISMATCH`）。
- **二重の callback**: 同じ判定、書き込み0。
- **口の前で拒否**: 偽の・凍結していない結び付け、キーの違い、owner epoch の欠落、結び付けの時刻の欠落、世代の形、本文の不正。
- **資格情報の文の後で拒否**（G5 の worker・Threads の呼び出し0）:
  - 文の拒否（失効・取り消し・所有者の変化）は `CREDENTIAL_UNAVAILABLE`
  - 別の Threads の利用者は `CREDENTIAL_IDENTITY_CHANGED`
  - 世代の違いは `GENERATION_CHANGED`
- **G5 の worker 判定で拒否**（Threads の呼び出し0）:
  - G5 のコードはそのまま返す: A→B→A（`OWNER_EPOCH_CHANGED`）、`SERVICE_NOT_ACTIVE`、`SERVICE_REACTIVATED_SINCE_BIND`、`ACCOUNT_DELETION_IN_PROGRESS`、`FACTS_UNAVAILABLE`
  - 想定外の答え（`'ACTIVE'`・true・オブジェクト）は `WORKER_VERDICT_UNKNOWN`、失敗は `WORKER_VERDICT_UNAVAILABLE`
- **送信の結果はそのまま返し、再送しない**:
  - 公開の不明は要求3回だけ
  - コンテナの不明は1回だけ
  - 読み戻しの不明は4回だけ
- **呼び出しの順**: アカウント → G5 の本人 → 資格情報 → G5 の worker → Threads の4回。1本の記録で固定した。

## 4. G5 への最小の IF の差分の提案（G4 はまだ採用していない）
G5-02（PR #344 `3a900d54`）の通知（Issue #319 コメント 6267736897）への返答。

1. **service key `x_autopost`**:
   - G5 の契約は「POSTONA は X と Threads で1つのサービス」。G4 の今の規則（G4-02 `acceptableServiceKey`）はそれを拒否する。
   - 採用するときの G4 の差分は小さい:
     - `THREADS_POSTING_SERVICE_KEY = "x_autopost"`
     - 拒否の一覧から `x_autopost` を外す
     - G4-02／03／04 のテストの更新
   - これは **G4 担当ちゃ（とユーザー）の判断**。採用したら、PR #124 の `x_autopost` の guard は正しくなる。ただし、結び付けの epoch の記録が無いことは残る。
2. **owner epoch の表現**:
   - G4 は JS の安全な整数（≥1）で扱い、`===` だけで比べる。
   - G5 は `bigint` で、R1 の wire では中身の見えない値。
   - G5 にお願い: wire の `owner_epoch` を「JSON の数（2^53 未満）」か「10進の文字列」のどちらかに固定してほしい。文字列なら G4 は文字列の一致に変える。
3. **W1／W2 の `p_bound_at`**:
   - G4-03 の結び付けには、結び付けの時刻が無い（PR #124 も記録していない）。
   - 今回は投稿の要求の `boundAtMs`（G3 の予約が epoch と一緒に持つ、G5-02 §4 のとおり）を使った。
   - 接続の側でも記録するのは、PR #124 の SQL の修正（G4、別の TASK）。
4. **R1（`threads_connect`）をコードの交換の直前に**: Threads の OAuth の実行部分（H5 の runtime・G4 の入口）の変更が要る。今回は扱っていない。

## 5. テスト（実測）
| 実行したもの | 結果 |
|---|---|
| 縦断と G4-02／03 のテスト（`--allow-read=.` だけ） | 37 passed／0 failed |
| Threads の TS 全体（`--no-check --allow-read=.`、entry_composition を除く） | 280 passed／0 failed |
| H5 の config で entry_composition と connector | 17 passed／0 failed |
| check・lint | エラー0 |
| ミューテーション | 縦断 **24/24**、G4-03 の判定 31/31、G4-02 の port 25/25 |
| G3 PR #334 `threads_dispatch.ts`（変更なし、SHA-256 `875175a5…`）× 縦断の口の重ね合わせ（作業用フォルダだけ、コミットなし、型チェックあり） | 3 passed |

- 重ね合わせで確かめたこと:
  - bind の後、G3 の dispatcher が1回だけ送って、`published`／`simulated` と記録する。
  - 本番用の口では G3 は claim しない。
  - 世代が変わると送信0。
- G4-02／03 の分離のテストに、新しい import 元を許した（G4 自身のテストだけ）。
- 偽の送信だけ。本物の外への書き込みは0回（ネットの権限なし）。
- NOT_RUN: SQL（文が無い）、本物の G5 の判定、Auth、Meta、Threads、管理環境、本番。

## 6. 行っていないこと
- ゲートを開くこと、service key を採用すること
- PR #124 の SQL・共有の Auth／RLS／RPC／GRANT・Vault・worker・Edge の本体の変更
- 本物の Meta・OAuth・トークン・投稿
- main への push、マージ、デプロイ
- G3・G5・H5 のファイルの変更
