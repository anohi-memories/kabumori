# G4-03：Threads の OAuth 接続の後の、アカウントの結び付けの判定（offline）（2026-10-19 JST）

- task_id: `postona-g4-threads-oauth-account-bind-offline-adapter-20261019`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ／完了コード K4／`next_task_allowed: false`
- 判定: **SOURCE_ONLY_CANDIDATE（固定 OFF・読み取りだけ・どこにも接続しない）**。本物の Auth／結び付け／管理環境／本番は NOT_VERIFIED／NO_GO。
- 土台: PR #337（head `37fe0bd32ebf1fcf01d726d66adae14648d283da`）の上。

## 1. OAuth の戻りから G4 の port までの照合（関数とパス）

| 段階 | 実際のコード | 状態 | 担当 |
|---|---|---|---|
| アプリ：開始・戻り | `apps/social-mobile/src/features/threads-connect/threads-connect-starter.ts` | ソースあり・UI のゲート OFF。最初の戻りだけ、同じ人（`SESSION_CHANGED`）、期限、コードと state は転送だけ | G4 |
| アプリ：戻り先（iOS／Android） | `threads-connect-runtime.ts`（`configuredThreadsCallback`）、PR #260 | callback と app link が未設定（運用の手順） | G4／運用 |
| Edge の応答の形 | `_shared/social/threads_connect_edge.ts`（`createThreadsConnectHandler`） | ソースあり・`THREADS_CONNECT_EDGE_WIRED = false` | G4 |
| Edge の入口 | `_shared/social/threads_connect_entry.ts`（PR #251）→ H5 の `disabled_entry.ts` | ゲート OFF。H5 の合成は配備できない | G4／H5 |
| 本人の確認・コードの1回限りの claim | `candidates/postona_threads_auth_runtime/`（`verified_actor.ts`、`claim_candidate.sql`、`runtime.ts`） | 候補（未適用） | H5 |
| state を本人・ワークスペース・Threads の行に結び付ける | `candidates/postona_threads_oauth_workspace_candidate.sql` の `begin_…`／`consume_…` | 候補（未適用・付与なし）。10分・1回だけ | G4（PR #124） |
| 署名つきの本人確認と結び付け | 同じファイルの `complete_social_mobile_threads_oauth_connection` | 候補（未適用）。結果は `identity_verified` | G4（PR #124） |
| 接続と投稿の連鎖の段階の表 | `_shared/social/threads_connect_publish_integration.ts` | 契約だけ | G4 |
| **接続の後、そのアカウントを「結び付け済み」とみなす判定** | **無かった** | → **今回** `_shared/social/threads_account_binding.ts` | G4 |
| 資格情報と送信の port | `_shared/social/threads_send_port.ts`（G4-02） | ゲート OFF。1文の SQL は無い | G4 |

`complete` の詳細:
- 本人の個人用のワークスペースに owner として、state を1回だけ消費する。
- 再接続は同じ Threads の利用者 ID だけを受け付ける。
- 別の場所で接続済みの ID は拒否する。
- `connection_status = 'identity_verified'`、`verified_at`、`publish_enabled = false`。

### 見つけたこと（G4 の SQL と G5 の判断が要る。今回は SQL を変えていない）
1. **PR #124 の begin／consume／complete は、利用権の確認を `account_lifecycle_assert_active_service_write(uid, 'x_autopost')`（X のキー）で行っている。** Threads の投稿の service key は G5 が未決定。X のキーの流用は、決定の後に直す必要がある。
2. **PR #124 は、結び付けたときの所有者の epoch を記録しない。**
   - X（PR #282／#287）では、所有者 A→B→A で古い結び付けが復活しないように記録した。
   - Threads にも同じ記録が要る。今は個人用のワークスペース（メンバーは本人1人）だけなので影響は小さい。G5 のブランドの形が広がると必要になる。
3. 結び付けた人（`bound_by`）も行に記録していない。state の `initiated_by_user_id` にはある。

## 2. 今回の判定（`decideThreadsAccountBinding`）
入力:
- H5／Edge の「connected」の受領票（権限ではない）
- アプリの流れの文脈（開始した人・今の人・ブランド・state の期限・受け取った時刻・再接続の前の Threads の ID）
- 注入する2つの口（読み取りだけ）
  - G4 の口：アカウントの行の読み取り
  - G5 の口：本人・ブランド・サービスの判定

順に確かめて、どれか1つでも外れたら、固定のコードで拒否する。

| 順 | 条件 | 拒否のコード |
|---|---|---|
| 1 | ゲート | `BINDING_DISABLED`（口に触れない） |
| 2 | service key が決まっている。`x_autopost`／`kabumori` ではない | `SERVICE_KEY_UNDECIDED`（口に触れない） |
| 3 | 受領票が Edge の形どおりの connected（`publish_enabled:false`、ちょうどその6項目、UUID）。refused／uncertain は結び付けではない | `RECEIPT_INVALID` |
| 4 | 今ログインしている人がいる | `AUTH_REQUIRED` |
| 5 | 今の人が、開始した人と同じ | `PRINCIPAL_CHANGED` |
| 6 | state の期限の内 | `STATE_EXPIRED` |
| 7 | アカウントの行がちょうど1つで、その ID・Threads・`identity_verified`・資格情報あり・Threads の ID の形 | `ACCOUNT_UNAVAILABLE`／`ACCOUNT_NOT_FOUND`／`ACCOUNT_AMBIGUOUS`／`ACCOUNT_NOT_THREADS`／`ACCOUNT_NOT_VERIFIED`（解除済みも含む） |
| 8 | 接続しようとしたブランドの行 | `BRAND_MISMATCH` |
| 9 | 再接続なら、前と同じ Threads の利用者 | `IDENTITY_CHANGED` |
| 10 | この人が結び付けた | `BOUND_BY_OTHER_PRINCIPAL` |
| 11 | G5 がこの本人・ブランド・キーについて allow（読めない・別の対象・deny は拒否） | `ENTITLEMENT_UNAVAILABLE`／`VERDICT_MISMATCH`／`SERVICE_NOT_ACTIVE` |
| 12 | owner／admin | `ROLE_INSUFFICIENT` |
| 13 | 所有者の epoch が分かり、結び付けのときと同じ | `OWNER_EPOCH_UNKNOWN`／`BIND_EPOCH_UNRECORDED`／`OWNER_EPOCH_CHANGED` |

- 口は、ローカルの確認がすべて通った後にだけ呼ぶ。アカウント → G5 の順。
- **書き込みの口は無い**。同じ受領票が二重に届いても、再送されても、同じ判定で、何も変えない（1回限りは DB と H5 の役目）。
- 結果は凍結した `ThreadsAccountBinding`:
  `{socialAccountId, brandId, threadsUserId, principalId, serviceKey, ownerEpoch, entitlementVersion}`
  これは、G4-02 の資格情報の1文の SQL が同じ文の中で確かめるべき条件の一覧でもある。
- **権限ではない**: 資格情報は、この判定ではなく、将来の1文の SQL だけが渡す。
- 今の PR #124 では、本物の結び付けは必ず `SERVICE_KEY_UNDECIDED` か `BIND_EPOCH_UNRECORDED` になる（安全側）。

## 3. G5 に要る、未実装の依存（G5-01 の契約で決まる。G4 は推測していない）
- `principalVerdict(principalId, brandId, serviceKey)` →
  `{principalId, brandId, serviceKey, verdict: allow|deny, role: owner|admin|member|null, entitlementVersion, ownerEpoch|null}`
- Threads の投稿の service key。
- 退会・凍結・サービスの終了は `deny`、所有者の epoch が不明なら null（拒否）。
- G5 の判定の形が違えば、この口の形を合わせる（G4 の変更）。

## 4. テスト（実測）
| 実行したもの | 結果 |
|---|---|
| `threads_account_binding_test.ts` と `threads_send_port_test.ts`（`--allow-read=.` だけ） | 26 passed／0 failed |
| Threads の TS 全体（`--no-check --allow-read=.`、entry_composition を除く、新しいテストを含む） | 269 passed／0 failed |
| H5 の config で entry_composition と connector | 17 passed／0 failed |
| check・lint | エラー0 |
| ミューテーション（判定に 31種） | **31/31 を検出** |

- G4-02 の分離のテストを2点直した（G4 自身のテスト）:
  - 新しい判定が service key の規則を import するので、許す一覧に1つ足した。
  - import の検出を、文字列の出現ではなく `from`／`import(` の文に限った。
- 外への通信0回、書き込み0回（偽の口だけ）。
- NOT_RUN: SQL（行の読み取りの SQL は無い）、アプリの node のテスト（アプリは変えていない）、本物の Auth・Meta・管理環境・本番。

## 5. 次の作業の候補（G4、別の TASK）
1. PR #124 の SQL の候補を直す（G5 の service key の決定の後）。
   - 利用権のキーを Threads のものにする。
   - 結び付けの所有者の epoch と、結び付けた人を記録する。
   - PG17 のテストを付ける。
2. 資格情報の1文の SQL（G4-02）を、この判定と同じ条件で作る。G3 の世代の関数と G5 の口が前提で、Sol（高）のレビューが要る。

## 6. 行っていないこと
- ゲートを開くこと、service key を決めること
- PR #124 の SQL・共有の Auth／RLS／RPC／GRANT／trigger の変更
- 本物の Meta・OAuth・トークン・Vault・投稿
- main への push、マージ、デプロイ
- G3・G5・H5 のファイルの変更
