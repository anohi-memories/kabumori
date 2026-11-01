# G3｜P7 失効したセッションでの取り消し・受領票（2026-10-20、Issue #318 TASK 14/50）

- task_id: `postona-g3-p7-session-revocation-isolated-negative-20261020`
- 返却先: POSTONA G3のちゃ
- 完了コード: K3
- 判定: **SOURCE_ONLY（テスト・ランナー・文書だけ。使い捨て PG17・deny-net）／P7 は未修正／本番 NO_GO**
- 積み順: G3 PR #390（`8a1239ce7e52bf61076b229c2f2cd2cbd1c541c8`）の上。007・SECURITY DEFINER・付与・RLS・Auth・Edge、G4 と G5 のコードは変えていない。
- **P7 を直したとは言わない**。修正の着手は、G5 の IF の確定と Codex Sol（高）の限定レビューの後。U8 は未決定で NO_GO のまま。

## 1. 007 の 3 つの入口が確かめること（読み取りの解析）

| 入口 | 本人（`auth.uid()`） | セッションが生きているか | 匿名でないか | owner_epoch・lifecycle_version | 作業場所・ブランドの境界 |
|---|---|---|---|---|---|
| `create_reservation` | ○ `postona_x_resv.caller()` | ○ G5 の R1（`auth.sessions` の行・`not_after`・本人のものか） | ○ R1 | ○ R1 の allow の 2 つの数を保存 | ○ fence（Threads・利用者の作業場所・唯一の所有者が本人） |
| `cancel_reservation` | ○ `caller()` | **× 見ない** | **× 見ない** | × 見ない（取り消しは止める側なので、安全側） | ○ `r.user_id = caller()` の行だけ（他人の行は 404） |
| `receipt` | ○ `caller()` | **× 見ない** | **× 見ない** | × 見ない | ○ `r.user_id = caller()` かつアカウント・ID が一致する行だけ |
| （worker）`claim_due`・`preflight`・`record` | —（worker の役割だけ） | — | — | ○ W1 で照合 | ○ fence・W1 |

`caller()` は `auth.uid()` を返すだけで、claims の `session_id`・`role`・`is_anonymous` を見ない。

## 2. 何を実測したか（`postona_threads_p7_session_run.sh` → `POSTONA_THREADS_P7_GATE_PASS`）
同じテストファイル（`tests/p7_session_revocation_pg_test.ts`）を 2 回流す。
- **現行**（`P7_MODE=current`）: 今の 007 の振る舞いを記録する。合格すること。
- **望ましい**（`P7_MODE=desired`）: 直した 007 が満たすべき振る舞い。今は D1〜D5 の **5 件だけが失敗**することを、ランナーが名前で確かめる。それ以外が失敗したら、ランナーは止まる。
  - 作業の途中で、ランナーが D の行しか数えておらず、不変条件の失敗を見逃しうることに気づいた。全部の失敗を数える形に直した。その結果、テストの誤り（存在しない人物を指していた）が 1 つ見つかり、直した。

呼び方は、予約の Edge と同じにした。API のログイン → `SET ROLE postona_resv_api` → 要求の JWT の claims を settings に置く。claims はモックで、「署名と期限だけを確かめた検証器」が通す形にした。JWT の偽造や独自の検証はしていない。

| 番号 | 場面 | 現行（合格） | 望ましい |
|---|---|---|---|
| C1 / D1 | セッションの行が消えた（サインアウト） | 受領票も取り消しも答える。行は cancelled になる | 拒否し、行は planned のまま（**今は失敗**） |
| C2 / D2 | セッションの期限切れ（`not_after` が過去） | 同上 | 同上（**今は失敗**） |
| C3 / D3 | subject は本人だが、セッションは他人の生きているもの | 同上 | 同上（**今は失敗**） |
| C4 / D4 | 存在しないセッション ID | 同上 | 同上（**今は失敗**） |
| C5 / D5 | 匿名のサインイン（`is_anonymous: true`）で、本人の subject と生きているセッション | 同上 | 同上（**今は失敗**） |

不変条件（両方のモードで合格）:

| 番号 | 確かめたこと |
|---|---|
| I1 | **境界**: 取り消しと受領票を呼べるのは `postona_resv_api` だけ。anon・authenticated・service_role・worker は 42501。`postona_resv_api` はログインできず、authenticated はその役割になれない（PostgREST から利用者が直接呼ぶ道は無い）。 |
| I2 | セッションが死んでいても、他人の予約は「知らない ID」と**同じ答え**（存在を漏らさない）。他人の行は変わらない。 |
| I3 | claims が無い → どちらも `POSTONA_RESV_AUTH_REQUIRED`。 |
| I4 | **修正案 (A) の根拠**: 同じ claims を G5 の本物の R1 に渡すと、5 つの場面すべてで allow にならない（`SESSION_REVOKED`・`SESSION_EXPIRED`・`SESSION_REVOKED`・`SESSION_REVOKED`・`AUTH_REQUIRED`）。 |
| I5 | U8 は fail-closed のまま: 生きているセッションでも作成は `PUBLISH_DISABLED`。公開 0、スイッチ ON 0。 |

もう 1 件は、現行のモードだけで記録した（正しいかどうかは決めない）。
- **Q1**: 作業場所の所有者が A → B に変わった後も、A は A 自身の行を読めて、取り消せる。007 は、取り消しと受領票を「行の `user_id`」で決め、「今の所有者」では決めない。

## 3. 被害の範囲（確認済みと未確認）
- **確認済み**:
  - 他人の予約は、読めも、取り消しもできない（I2、TASK 13 の P2）。
  - 作成はできない（U8。作成はもともと R1 でセッションを確かめる）。
  - 投稿は 0。
  - 007 を直接呼べるのは Edge の API の役割だけ（I1）。
- **残る影響**: 「失効したセッションのトークン」でも、**本人の予約の状態を読める（受領票）**、**本人の予約中の行を取り消せる**。
  - 取り消しは投稿を止める側なので、二重の送信や誤った送信にはつながらない。
  - ただし、サインアウトした端末や漏れたトークンで、本人の予約を消されうる。受領票からは、状態と（送信済みなら）投稿 ID が見える。
- **未確認**（G3 からは確かめられない）:
  - 本物の Edge の G5 の検証器が、サインアウト・失効したセッションを断るか。本物の JWT の有効期限と `auth.sessions` の関係。
  - managed の PostgREST の settings の形。
  - **この検証器が断るなら、P7 は深い層の防御の欠け**にとどまる。断らないなら、上の残る影響がそのまま出る。

## 4. 修正の候補（G5 への IF の質問。どれも採用していない）

| 案 | 内容 | G5 への質問 | 007 の変更（未着手） |
|---|---|---|---|
| (A) | 取り消しと受領票の始めに R1 を呼び、`subject.user_id = caller()` かつ `session.state = 'active'` のときだけ進める | R1 を「読むだけの確認」（feature `read_workspace` など）に使ってよいか。サービスが終了した人（R1 は `SERVICE_NOT_ACTIVE`）にも、受領票を見せるべきか（R1 の allow を求めると見えなくなる） | 2 つの関数の始めに数行 |
| (B) | G5 が「セッションだけ」の判定を出す（例: `private.account_lifecycle_session_verdict()` → `active` / `revoked` / `expired` / `anonymous` / `unknown`） | この口を作るか。名前・返り値・owner 限定の ACL・匿名と role の扱い | 2 つの関数の始めに 1 行 |
| (C) | 既にある G5 の関数を使う（`private.account_lifecycle_assert_active_service_write`、`private.account_lifecycle_enrollment_fence`。どちらも `auth.sessions` の行を確かめる） | 書き込みのガード（サービスが有効であることも求める）や登録の柵を、読み取り・取り消しに流用してよいか。用途が違うので、G3 は (B) を推す | 同上 |

どの案でも、次を変えないこと:
- 403・404 の情報を出さない性質（他人と存在しないものは同じバイト）
- 503 `OUTCOME_UNKNOWN` の冪等性
- 取り消しと受領票は、送信の経路とは独立に止まる（送信は増えない）

## 5. G1（画面）への影響
- 受領票・取り消しが、セッションの失効で拒否されるようになると、HTTP の答えは **401 `AUTH_REQUIRED`**（もう一度ログイン）になる見込み。今の TASK 13 の一覧の 401 と同じ扱いにできる。
- サインアウトした端末では、受領票が見えなくなる。予約の状態は、再ログインの後に見る。
- サービスが終了した人の受領票を見せるか（§4 の (A) の質問）で、画面の文言が変わる。
- Q1（所有者が変わった後の、元の所有者の行）の扱いは、G1・G5 と一緒に決める。

## 6. 回帰（すべて合格）
- この TASK: `POSTONA_THREADS_P7_GATE_PASS`（現行 11 件合格、望ましい側は D1〜D5 の 5 件だけ失敗。G4 の #377 の木と、#377 + #381 の木の両方）
- #390 → `POSTONA_THREADS_HTTP_CONTRACT_ALL_PASS`
- #386 → `POSTONA_THREADS_U8_FAILCLOSED_ALL_PASS`
- #382 → `POSTONA_THREADS_G4_CREDENTIAL_ALL_PASS`
- #379 → `POSTONA_THREADS_G5_REAL_ALL_PASS`
- #374 → `POSTONA_THREADS_CROSS_OWNER_ALL_PASS`
- #360 → `POSTONA_THREADS_RESV_ALL_PASS`・`POSTONA_THREADS_HTTP_WORKER_ALL_PASS`
- Deno の単体 116 件、型検査・lint

## 7. NOT_VERIFIED
- 本物の Edge・G5 の検証器・JWT・managed の Auth・DB・RLS。
- 007 の修正（作っていない）。G5 の (B) の口（存在しない）。
- 本物の Threads・Meta、アプリ・実機。
