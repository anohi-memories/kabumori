# Threads の資格情報の入れ替え：リースと比較交換の候補 SQL（F4・2026-10-17 JST）

TASK: `postona-f4-threads-credential-rotate-cas-sql-contract-20261017`。適用しない候補の SQL と、使い捨ての PostgreSQL 17 でのテスト。

- **H5（Vault の入れ替え・owner の通り道・store port）と F5（ライフサイクルの柵）の合意待ちの提案**。
- 本番と試験運用は NO_GO。
- Draft PR #255（head `7bd54218a45e78f45448aea3ef72ed769f629325`）の上に積んだ。PR251・PR255 自体は変えていない。
- Meta への問い合わせ、トークンや secrets の取得、Vault・管理環境への接続はしていない。

## 0. 結論

- 期限の記録（G4 の候補 `threads_credential_custody_candidate.sql`）は G4 の PR144 で作った F4 の範囲のファイル。H5・F5 のものではない。
- それでも既存のファイルは1バイトも変えず、**新しい候補ファイルを足すだけ**にした: `supabase/candidates/postona_threads_publish/threads_credential_rotation_candidate.sql`
- 延長（PR255 の調整役）が Meta から新しいトークンを受け取った後の書き込みを、次の3つで行う。
  1. **排他のリース**（`claim_threads_credential_refresh`）
  2. **比較交換**（`rotate_threads_credential_custody`）
  3. **リースの返却**（`release_threads_credential_refresh`）
- 次のどれかに当たるときは、拒否して何も書かない。
  - 古い版の資格情報、別のリース、使い済みのリース（リプレイ）
  - 所有者・作業場所の変更、別のアカウント
  - 切断・削除・サービス終了・投稿の途中
  - 期限切れ、おかしな期限
  - 利用者の権限での呼び出し
- テスト（実行スクリプト `supabase/tests/postona_threads_rotation_run.sh`）は、G5／F5 の**本物の**ライフサイクルのマイグレーションの上で動かした。結果は §8。

## 1. 誰が何を持つか（確認した事実）

| 値 | どこにあるか | 誰が書くか |
|---|---|---|
| `secret_id` | `social_accounts.vault_access_token_secret_id` | PR124 の `complete`。初回は `vault.create_secret`、再接続では **同じ id のまま** `vault.update_secret`。H5 の owner の取引から呼ばれる |
| `recorded_at`・`expires_at` | `threads_account_credential_custody`（G4） | 接続: `record_threads_credential_custody`（接続の取引の中だけ）。延長: 今回の `rotate_threads_credential_custody` |
| 期限の読み出し | `threads_account_credential_expires_at`（G4） | 「同じ secret」かつ「最新の確認より後の記録」のときだけ期限を返し、ほかは NULL（＝期限切れ） |
| F5 の柵 | `private.account_lifecycle_assert_brand_service_active(brand, 'x_autopost')`（F5 PR165） | F4 の柵 `threads_manual_publish_owner_fence(brand)` 経由で使う（投稿と同じ対応表） |
| 削除の後片付け | `cleanup_threads_provider_footprint`（F4）。G5 のリースの判定 `private.account_lifecycle_cleanup_authorized` と作業場所のロックの後に、アカウントの行を削除する | 期限の記録とリースは、外部キーの cascade で一緒に消える |
| 切断 | `disconnect_threads_account`（F4、ゲートは閉じたまま） | 同上 |

- 再接続では secret の id が変わらない。このため、**secret の id だけの比較では再接続を見分けられない**。`recorded_at` も比べる（テスト §7・競合 reconnect で確認）。

## 2. 追加したもの（適用しない候補）

| もの | 内容 |
|---|---|
| 表 `threads_credential_refresh_leases` | 1アカウントに最大1つのリース。作業場所・その所有者・secret の id・期限の記録の版（`recorded_at`）に結び付ける。壁時計で60秒。秘密の値は持たない。RLS は有効で、API の役割には権限なし。削除の検査（`social_mobile_deletion_guard`）を付けた |
| `claim_threads_credential_refresh(account)` | リースを取る。答えに **トークンは入らない**（secret の id・`custody_recorded_at`・`expires_at`・`lease`） |
| `rotate_threads_credential_custody(account, lease, expected_secret_id, expected_recorded_at, new_expires_at)` | 比較交換。成功すると期限の記録を書き換え（`recorded_at = now()`、`recorded_by` = 作業場所の所有者）、**リースを使い済みにする** |
| `release_threads_credential_refresh(account, lease)` | そのリースだけを返す。何度呼んでもよい |

- 関数はすべて SECURITY INVOKER・`search_path = ''`。実行できるのは owner だけ（anon・authenticated・service_role・authenticator は不可で、owner のメンバーでもない）。適用の最後に確かめる。
- TASK に書かれた形（引数4つ）に `lease` を足して5つにした。TASK の「リースが無いときは拒否」を、どの持ち主のリースかまで確かめるため。
- 前提が欠けていれば適用を拒否する。前提は次のとおり。
  - 期限の記録の表の形と、読み出し口の本文（md5 で固定）
  - 投稿の試行の表の列
  - F4 の柵と F5 の判定が owner だけのものであること
  - 削除のロックと検査

## 3. 使い方（H5 の owner の通り道から。利用者からは呼べない）

```
取引1: claim(account) = claimed
       → （H5）同じ取引で vault.decrypted_secrets から、返された secret の id のトークンを読む → COMMIT
取引なし: Meta GET /refresh_access_token（PR255 の調整役、10秒で打ち切り）
取引2: rotate(account, lease, secret_id, custody_recorded_at, 新しい期限) = rotated
       → （H5）vault.update_secret(<rotated が返した同じ secret の id>, <新しいトークン>) → COMMIT
       ※ 1つの取引。Vault の書き込みが失敗したら、期限の記録もリースの消費も一緒に戻る（テスト §11）
必ず: release(account, lease)（rotate 済みなら not_held。拒否・中断のときはリースを返す）
```

- **ロックの順**: 接続・切断・後片付け・投稿のリリースと同じ順にした。
  1. 作業場所の所有者のライフサイクル（F5。許可したときは COMMIT まで保持）
  2. 作業場所の advisory lock
  3. 作業場所 FOR SHARE
  4. 所有者の membership FOR SHARE
  5. Threads のアカウント FOR UPDATE
  6. 期限の記録 FOR UPDATE
  7. リース FOR UPDATE
- アカウントの行の FOR UPDATE は、次を待つ。
  - 投稿のリリース（FOR SHARE）
  - 切断・後片付け・再接続（FOR UPDATE）
- 待った後に確定した行を読み直し、壁時計で判定する。
- ロックの前に1つだけ確認する。「このアカウントにこの id のリースがあるか」。無ければすぐ `LEASE_NOT_HELD` にする。このため、関係ない呼び出しが所有者のライフサイクルの行の待ち列に並ばない（競合 stray で確認）。

## 4. 拒否の一覧（拒否は何も変えない）と store port への対応

PR255 の `RefreshStore` に合わせた対応の提案。

| コード | 意味 | claim のとき | rotate（commit）のとき |
|---|---|---|---|
| `BUSY`・`LEASE_HELD`・`PUBLISH_IN_FLIGHT` | ロックの待ちが長い、ほかのリースがある、投稿の途中（`creating_container`・`publishing`、または5分のグラントが有効） | `"busy"` | `PUBLISH_IN_FLIGHT` は `"conflict"`。`BUSY` はリースの期限内なら1回だけ再試行し、だめなら `"conflict"` |
| `ACCOUNT_NOT_FOUND`・`CONNECTION_NOT_VERIFIED`・`WORKSPACE_CHANGED`・F5 の `SERVICE_NOT_ACTIVE`・`WORKSPACE_INACTIVE`・`ACCOUNT_LIFECYCLE_BLOCKED` | 切断・削除・サービス終了・停止・ロック・所有者が不明・別の作業場所 | `null`（gone） | `"conflict"` |
| `CUSTODY_UNKNOWN`・`CREDENTIAL_EXPIRED` | 期限の記録が今の資格情報のものでない、または期限切れ | いまは `null`（投稿は既に止まる。PR255 の port に `"reauth_required"` を足すのは後続） | `"conflict"` |
| `LEASE_NOT_HELD`・`OWNER_CHANGED`・`STALE_CREDENTIAL`・`EXPIRY_INVALID`・`EXPIRY_NOT_EXTENDED` | リースが無い・別・期限切れ・使い済み、所有者の変更、版の違い、おかしな期限 | — | `"conflict"`（新しいトークンは捨て、Vault に書かない） |
| `SERVER_ONLY`・`REQUEST_INVALID` | 利用者の JWT の情報付きで呼んだ、形の誤り | 例外（実装の誤り） | 例外（実装の誤り） |

- `credentialVersion` は `<account>|<secret_id>|<custody_recorded_at>` のような、外から意味の分からない文字列で持つ（commit に account id が無いため）。
- 期限: `(now, now+61日]`。かつ **いまの記録より後**。60日の延長が、14日前からの窓で記録より短くなることは、普通は起きない。起きたら誤りとして扱う。

## 5. H5 への提案（H5 のファイルは変えていない）

H5 の owner の通り道（専用の owner の役割、`db.<ref>:5432` の直接接続）で store port を実装するとき、次を守ってほしい。

1. **取引2は1つの取引**: `rotate` が `rotated` を返したときだけ、**同じ取引で** `vault.update_secret(<答えの vault_secret_id>, <新しいトークン>)` を呼ぶ。
   - 別の secret の id に書かない。
   - `rotated` 以外の答えでは何も書かずに ROLLBACK する。
   - Vault の書き込みが失敗したら ROLLBACK する（期限の記録もリースの消費も戻る）。
2. **Meta への通信の間は、取引を開かない**（ロックを持ったまま外部に問い合わせない）。
3. owner の通り道は、**利用者の JWT の情報を付けずに**呼ぶ（付けると `SERVER_ONLY`）。
4. 分離レベルは READ COMMITTED（既定）。REPEATABLE READ では、待った後に同時更新で 40001 になる。そのときは `"conflict"` として扱えば安全。
5. トークンは、ログ・答え・エラーに出さない（SQL の答えにもトークンは入らない）。
6. **確かめてほしいこと**（管理環境の Vault の振る舞いで、ここでは確認していない）:
   - `vault.update_secret` が同じ id のまま値を差し替え、`vault.decrypted_secrets` にすぐ反映されること。
   - もし `vault.secrets.updated_at` が更新されるなら、遅延の制約トリガーで「同じ取引で secret が書き換わったこと」を COMMIT のときに確かめる案がある。ただし未確認のため、今回は入れていない。

## 6. F5 に確かめてほしいこと

- 延長を許すのは、作業場所の所有者の POSTONA が **active のときだけ**（停止・終了・削除中・ロック・所有者が不明なら拒否）。投稿と同じ方針で、切断の「取り除くことはいつでも可」とは違う。
- **削除が優先**される。
  - リースは行であってロックではない。後片付けは、アカウントの行を消すとき cascade でリースも消す（テスト §13）。
  - 実行中の rotate とは、作業場所のロックとアカウントの行で直列になる。
  - 削除を始めた後の rotate は `ACCOUNT_LIFECYCLE_BLOCKED` になる。

## 7. 残るリスク（ここでは閉じていない）

| リスク | いまの扱い | 閉じ方（V2 の後） |
|---|---|---|
| claim と rotate の間に投稿がリリースされた | rotate は `PUBLISH_IN_FLIGHT` で拒否し、新しいトークンを捨てる。T7（延長で古い文字列が無効になるか）次第で、その後の投稿が 190 になり、要再接続になりうる（誤った資格情報は書かれない） | 投稿の `threads_manual_publish_authorize` が「有効な延長のリースがある間は BUSY」を返すようにする（F4 の範囲。F4 の柵の md5 固定も更新）。PR251 の V2 のレビューの後に別 TASK で行う |
| Vault の書き込みを SQL から確かめられない | H5 の約束（§5-1）。守られないと、古いトークンに新しい期限が付く。投稿は Meta で 190 になる（ほかのアカウント・利用者・secret には届かない） | §5-6 の案を H5 と検討する |
| 190 のときの「要再接続」の印 | SQL はまだ無い（store の `markReauthRequired` は何もしない）。投稿は 190 を `THREADS_TOKEN_INVALID` として記録する | 同じリースと比較交換で、期限の記録を消す `mark_threads_credential_reauth_required` を後続で足す |
| T7・Meta のエラーの形 | 文書に無い（PR255 の設計の文書のとおり） | 本番でない project で、本物の Meta の応答を確かめる（別の承認） |
| 管理環境の Auth・PostgREST・Vault・H5 の owner の通り道 | このテストでは動かしていない | 統合と配備の前の関門で確かめる |

## 8. テスト（`supabase/tests/postona_threads_rotation_run.sh`）

ローカルの使い捨て PostgreSQL 17（Unix ソケット、テストごとの superuser でない owner）で動かした。土台は `postona_threads_t13_run.sh` と同じ世界。

- G5 の本物のマイグレーション: T13・Phase 4・F5 のサービス状態・Phase 6
- X と Phase 2a-2
- PR124: ツリーにあるファイル。PR124 の版とバイト単位で同じことを確かめた
- G4 の投稿の一式、後片付け、切断、F4 の柵

| 部分 | 内容 |
|---|---|
| 前提 | 次の7件で、適用を拒否すること: F4 の柵が無い、柵を service_role が実行できる、API の役割が owner のメンバー、読み出し口の本文が違う、期限の記録の表の形が違う、試行の表にグラントの期限が無い、superuser で適用した。もう一度の適用も拒否 |
| 1つの接続で順に（`postona_threads_rotation_behavior.sql`、14節） | ACL。claim から rotate、Vault の書き込みまでを通し、**投稿のリリースが新しいトークンを渡すこと**。投稿の途中（作成中・公開中・有効なグラント）は拒否し、予約だけ・終わったグラントは通す。リプレイ（使い済みのリースは今の版でも拒否、新しいリースでも古い版は拒否）。別のアカウント・リース・secret・作業場所。所有者が2人・別の1人。F5 の各状態（終了・停止・ロック・アカウント削除・POSTONA 削除）と、active に戻した後の同じリース。再接続（その場の更新）と、記録の無い確認。切断。期限（過去・61日超・記録より前・NULL・infinity・期限切れ・記録なし）。リース（2つ目・期限切れ・引き継ぎ・返却）。Vault の失敗で一緒に戻ること。利用者の権限での呼び出し。削除の後片付け。リースの後に secret の id が変わった場合（アカウント側・期限の記録側） |
| 2つの接続の競合（10種） | 切断・再接続・投稿のリリース・所有者の凍結・同じ rotate の二重・claim の二重・ロックの待ちの上限（BUSY）・ロックの順（ライフサイクルが先、デッドロックなし。rotate と claim のそれぞれ）・関係ないリースが待ち列に並ばないこと |
| fail-before | 候補が無いと、テストが動かない（リースの表が無い） |
| ミューテーション | 候補を壊すと、テストが必ず失敗すること（件数と結果は Report） |

## 9. V2 の後の統合は安全か

- この候補は **追加だけ**（新しい表1つと関数6つ）。既存の関数・表・権限は変えない。
- 適用の順: G4 の投稿の一式 → F4 の柵 →（後片付け・切断）→ この候補。
- PR251 の V2 のレビューの対象（OAuth の入口・アプリの戻り・既存の SQL）の振る舞いは変わらない。
- 新しいリースの表は、アカウントの削除で cascade する。そのため、切断・後片付けは今までどおり完了する（テスト §8・§13）。
- ただし、**動かすのは次がそろってから**。スイッチ・定期実行・配備は OFF のまま。
  - §5 の H5 の実装と確認
  - §6 の F5 の同意
  - §7 の1行目（投稿がリースを待つこと）
  - 独立したレビュー
