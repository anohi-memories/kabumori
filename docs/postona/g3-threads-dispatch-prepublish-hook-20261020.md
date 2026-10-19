# G3｜Threads 予約の dispatcher に公開直前の再確認（beforePublish）をつないだ候補（2026-10-20、Issue #318 TASK 6/50）

- task_id: `postona-g3-threads-dispatch-prepublish-recheck-source-20261020`
- 返却先: POSTONA G3のちゃ
- 完了コード: K3
- 判定: **SOURCE_ONLY（模擬・ネット不許可・使い捨て PG17）／本番 NO_GO**
  - `THREADS_DISPATCH_ENABLED = false` のまま。G4 の `threads_send_port.ts`（PR #337 `37fe0bd32ebf1fcf01d726d66adae14648d283da`）は変えていない。
- 積み順: PR #343（`4ebaa156a23028f9dd592e1752b969113f87243a`）の上。

## 1. 何を直したか
- G4 の報告（#6265351981）と、G3 の E2E（PR #343 の W2）で確かめた穴: Threads の 2 段階投稿では、コンテナの準備を待つあいだ（既定で 3 回・3 秒おき）に、所有者・利用権・凍結・世代が変わっても、公開に進んでいた。
- `threads_dispatch.ts` は、送信口の `send` に **3 番目の引数 `{ beforePublish }`** を渡すようにした。
  - 送信口は、コンテナが準備できた**後**、公開の要求の**前**に、これを 1 回 await する。
  - `beforePublish` は、**取得済みの同じ行・同じリース**について、店（007）の preflight をもう一度呼ぶ。
    - 確かめるもの: 本人、作業場所と F5 の所有者、G4 の確認、G5 の Threads の状態、凍結・停止・削除、投稿スイッチ、取得時に結び付けた世代、リース。
    - 上限時間（既定 5 秒、`prepublishTimeoutMs`）の中で、**OK で、かつ資格情報が持つ世代と同じとき**だけ true を返す。
  - 拒否・読めない・時間切れは、どれも false。**送信が戻った後の呼び出しは、DB の確認すら呼ばずに false**（送ったかもしれない行を、店が planned に戻してしまうのを防ぐ）。
  - hook にトークンは渡さない（hook の中身は `beforePublish` だけ）。
- 拒否の後の記録:

  | 場合 | 扱い |
  |---|---|
  | 店がすでに決めた（failed・planned に戻した・リースが失われた） | **もう一度は記録しない**。報告は skipped か released（uncertain とは数えない） |
  | 時間切れ・読めない、または世代が違う（行は取得済みのまま） | `failed_before_send`（`THREADS_PREPUBLISH_UNVERIFIED` / `CREDENTIAL_GENERATION_CHANGED`）として記録する |

  - 報告に `prepublishRechecks` と `prepublishRefused` を足した。
- 送信口が拒否を無視して公開してしまった場合: 送信口の答えのとおりに記録を試みる（隠さない）。店はすでに行を失敗にしているので、dispatcher は uncertain と数える（成功とは数えない）。
- 3 番目の引数を受け取らない今の PR #337 でも、動きは今までと同じ（hook は呼ばれず、`prepublishRechecks` は 0）。

## 2. G4 への契約（変更は G4 の持ち分。1 回だけ通知した）
- IF は前回の依頼（#6267703384）と同じ: `send(credential, text, hooks?: { beforePublish(): Promise<boolean> })`。
- 今回はっきりさせた点:
  1. `beforePublish` は**必ず await してから**公開の要求を送る。await しない実装は、契約違反になる（拒否が間に合わない）。
  2. false・例外のときは、公開の要求をせず、`not_written publish THREADS_PREPUBLISH_REFUSED` を返す。
  3. 時間の上限は G3 の側で持つ（最大 30 秒、既定 5 秒）。G4 は追加の上限を持ってもよいが、時間切れは false として扱う。
  4. 公開の要求の 1 回の往復のあいだの停止は、防げない。after_freeze として記録する（M1-F3 と同じ）。

## 3. テスト

### 単体（`threads_dispatch_prepublish_test.ts`、ネット不許可）: 9 件
| 番号 | 確かめたこと |
|---|---|
| P1 | 変化なし: 再確認 1 回で true、公開 1 回 |
| P2 | 待ちのあいだの変化 4 種（許可の取り消し、世代の入れ替え、延長の開始、リースの喪失）: 公開 0 回。記録の二重化なし。数え方が正しい |
| P3 | 再確認の例外・時間切れ、OK でも世代が違う場合: 公開 0 回、`failed_before_send` を正しいコードで記録 |
| P4 | 送信の後の呼び出しは false。hook にトークンが無い |
| P5 | 拒否を無視する送信口は、隠さず記録を試みる（成功とは数えない）。hook を受け取らない送信口は、今までどおり |
| P6 | hook の後の停止は 1 回だけ公開。publish 段階の不明・読み戻しの不一致は uncertain で、再送しない |
| P7 | 2 つの worker でも、それぞれの行に 1 回だけ |
| P8 | 既定 OFF、送信口・資格情報口が使えない場合は、取得 0 |
| P9 | 記録が失われて行が取得済みのまま残っても、送信の後の呼び出しや遅い答えは許可しない。DB の確認も呼ばない |

### 使い捨ての PG17（`dispatch_native_hook_pg_e2e_test.ts`、007 と合わせて）: 6 件
| 番号 | 確かめたこと |
|---|---|
| N1 | 変化なしなら公開され、published になる |
| N2 | 待ちのあいだの利用終了・削除中・所有者 2 人・G4 の確認の取り消し・スイッチ OFF は `NOT_PUBLISHABLE_AT_SEND`、資格情報の入れ替えは `CREDENTIAL_CHANGED`。どれも公開 0 回で、uncertain は 0 |
| N3 | 延長の開始は戻し（planned）、終わった後に 1 回公開 |
| N4 | 時間切れは公開 0 回で、`THREADS_PREPUBLISH_UNVERIFIED` |
| N5 | hook の後の停止は after_freeze=true で published。不明は uncertain で、再送しない |
| N6 | 2 つの worker で 6 件を 1 回ずつ。PR #337 の配備用の形は取得 0 |

### 変異テスト・回帰
- 変異テスト: hook の部分に 12 個。すべて検出した（最初は 3 個が生き残ったため、テストを足した）。
- 回帰:
  - PR #334 の dispatcher のテスト 13 件
  - 007 のランナー（PR #339）`POSTONA_THREADS_RESV_ALL_PASS`
  - HTTP・worker のランナー（PR #343、15 件）`POSTONA_THREADS_HTTP_WORKER_ALL_PASS`
  - Deno の予約・単発投稿・worker・dispatcher で 112 件
  - テスト用の入口の単体 8 件
  - 型検査・lint・`git diff --check`
  - X の予約のスキーマの指紋は不変
- NOT_VERIFIED:
  - G4 の本物の送信口での hook の実装
  - G5 の Threads の利用権
  - 本物の Threads・Meta・Auth
  - Edge・Cron・付与
