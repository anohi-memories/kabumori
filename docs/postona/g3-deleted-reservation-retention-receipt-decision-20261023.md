# G3｜削除済みの利用者の予約データの保持と受領票の答え：意思決定資料（2026-10-23、Issue #318 TASK 27/50）

- task_id: `postona-g3-deleted-reservation-retention-receipt-policy-decision-docs-20261023`
- 返却先: POSTONA G3担当ちゃ（Issue #318）／完了コード: K3
- 判定: **docs だけ。方針は決めていない。** データの削除・SQL・migration・本番は変えていない。法律・事業の方針は G3 が決めない。本番は NO_GO。
- 根拠:
  - G3-24（PR #463 `045e4f05`）、G3-25（PR #466 `81ea17b1`、ずれ 43 個）、G3-26（PR #471 `a208ecce`、ずれ 8 個）
  - X の候補（PR #392 `f34aab97`）、G4 の Threads の候補（PR #472 `4303a159`）
  - main `0c42933c` の social-mobile の文書
  - ここでは新しいテストを作っていない（43・8 のずれを参照するだけ）。
- 根拠の印:
  - [M] main
  - [C] Draft PR の候補（未適用）
  - [D] G3-25・G3-26 の実測（使い捨ての PG17）
  - [E] 推定
  - [U] 未確認

## 1. 既にある基準（social-mobile の削除。main の文書）
`apps/social-mobile/docs/account-lifecycle-phase4.md:162-172`（§9 の表）[M]:

| データ | 削除のとき |
|---|---|
| social の workspace、X のアカウントの行、OAuth の状態、refresh の状態、予定・履歴・ログ・claim・fingerprint、Vault の秘密 | **削除**（前提: 法的な保持の義務は無い。owner・法務の判断） |
| X 側の許可 | X で取り消す |
| 共通のログイン | `social_and_login` のときだけ削除 |
| X に公開済みの投稿 | 残る（利用者に伝える） |
| 監査（利用者 ID の `subject_sha256`、固定のコード、時刻） | **残す**。保持の期間は未決定。仮名で、匿名ではない |
| 発行済みのアクセスの JWT | 期限まで有効。即時の失効とは言わない |

- 同じ運用の手順書は「履歴の保持は今は無く、social の履歴は全部消す。owner・法務の判断が要る」と書く（`apps/social-mobile/docs/account-deletion-rollout-runbook.md:194-195`）[M]。
- **POSTONA の予約の表（`postona_x_resv.*`・`postona_threads_resv.reservations`）は、この表に入っていない**（候補の表で、main には無い）。

## 2. 予約データのライフサイクル（ソースと実測）
| 出来事 | X（`postona_x_resv`） | Threads（`postona_threads_resv`） | 確度 |
|---|---|---|---|
| 通常の取消 | 行・本文は残り `cancelled`。監査（`audit`）に `cancel` の行（コードと版だけで本文は無い）。`001:522-536`・`001:119-127` | 行・本文は残り `cancelled`。監査の表は無い。`007:254-265` | [C] |
| サービスの停止（X: F3 の公開停止） | 予定の行は `cancelled`。claim 中は数えて止める。`postona_x_publish_entitlement/001:242-250` | G4 の切断・後片付けは social account を消す → 予約の行は cascade で消える（受領票も消える）。G4 `threads_disconnect_candidate.sql:192`、`threads_provider_cleanup_candidate.sql:159`（PR #472） | [C] |
| アカウントの削除（social-mobile の saga ＋ purge） | 002 の saga: claim 中で lease が切れたものを `uncertain` に。`uncertain` を `social_mobile_account_deletion_x_unconfirmed`（`subject_sha256`＋予約 ID だけ）に記録。監査を `user_id` で消す（`002:169,185-189,210-211`）。purge: 依存の表 → social account → brand の順で消し、予約の行は social account の cascade で消える（main `20260928160000:568-579`、G3-26 O7 の模型 [D]） | social account の削除で cascade して消える [E]（social-mobile の purge には Threads の予約は書かれていない） | X は [C][D]。Threads は [E] |
| ログインだけの直接の削除（saga を通らない） | **行・本文・監査が残る**（`user_id` に FK 無し、`001:77-90`）。worker は claim しない・送信しない（G3-26 の B1〜B4）[D] | 行・本文が残る見込み（`007:82` に FK 無し）。worker は G5 の W1 で止まる見込み [E] | X は [D]。Threads は [E] |
| 運用の障害（lease 切れ） | `uncertain/LEASE_EXPIRED` で固定。再び claim しない（`004:178-181`） | 同じ（`007:299-302`） | [C] |
| 期限切れ | `expired`（行は残る、`004:178`） | この TASK では確かめていない | X は [C]。Threads は [U] |

- 監査の行（X）は本文を持たない。ただし `user_id` を持つので、仮名ではない（social-mobile の監査は `subject_sha256`）。
- G5 の共通アカウントの削除の手順（`20261009120000` など）には、`postona_x_resv`・`postona_threads_resv` を扱う箇所が無い（G5 #371 の写しを検索して 0 件）[C]。

## 3. 受領票・読み戻しの答え（今と、選べる形）
| 呼び出し | 今の答え（実測・ソース） | 選択肢 |
|---|---|---|
| 本人の生きているセッション | 答える | （変えない） |
| サインアウト・期限切れ・他人のセッション・不明・`session_id` 無し・匿名 | X は 7 つの入口が答える（ずれ 43 個、G3-25 [D]）。Threads の取消・受領票も答える（P7、D1〜D5 [D]） | (a) **401 `AUTH_REQUIRED`**（行を探す前に止める。G5-11 の C-3）←G5・G3 の既定の案 / (b) 404 に揃える |
| サービス終了の後（ログインは生きている） | X の readback は答える、list・get などは `SERVICE_NOT_ACTIVE`（G3-25 S10 [D]）。Threads の受領票は答える | (a) 受領票は見せる（G5 の推奨：本人の記録で、送信も書き込みもしない）/ (b) 見せない / (c) 期間を区切って見せる |
| アカウントの削除の後（まだ署名が有効なトークン） | X の readback は `pending` を答える。list・get・cancel は `ACCOUNT_NOT_FOUND`（G3-26 O5 [D]）。saga と purge が済めば行が無いので `NOT_FOUND` | (a) 401（ログインが無い＝セッションが無い）←P7 の修正で自然にそうなる / (b) 行を消したうえで 404 |
| 他人の行・存在しない ID | 同じ答え（`NOT_FOUND`、G3-25 S11 [D]） | （変えない：存在を漏らさない） |
| Threads の切断の後 | 予約の行が消えるので、受領票は `NOT_FOUND` [E] | (a) 今のまま（切断で履歴も消える）/ (b) 本文を除いた最小の記録を残す |

- 401 と 404 の同一性: 死んだセッションは、行を探す前に 401 で止める（行の有無を漏らさない）。生きたセッションでの他人・不明は、同じバイトの 404。これは G5-11 の C-3・C-5 と G3 の既存の契約（PR #390・#392）。

## 4. 総合指令に決めてほしい質問（少数）
| # | 質問 | 選択肢 | G3 の見立て（決定ではない） |
|---|---|---|---|
| Q1 | アカウントの削除のとき、POSTONA の予約の本文・状態を消すか | (a) social-mobile の基準に合わせて全部消す / (b) 本文を消し、状態・時刻・投稿 ID だけを仮名（`subject_sha256`）で残す / (c) 期間を決めて保持の後に消す | 既存の基準（§1）に揃える (a) が最も一貫する。法的な保持の要否は法務・ユーザー |
| Q2 | X の監査の行（`user_id` 付き、本文なし）を削除のときどうするか | (a) 消す（今の 002 の saga）/ (b) `subject_sha256` に置き換えて残す（social-mobile の監査と同じ）/ (c) 期間を決める | 監査の目的と期間は、social-mobile の監査の期間の未決定と一緒に決める |
| Q3 | ログインだけが直接消される道を、どう扱うか | (a) 道を塞ぐ（Kabumori の account-delete は G5 の手順を必須にし、管理画面の削除の手順を決める）/ (b) 後から片付ける（孤立した行の定期の掃除）/ (c) 両方 | (a) を先に。(b) は (a) が守られない場合の網として、別に判断 |
| Q4 | 受領票を、サービス終了の後とアカウントの削除の後に見せるか | サービス終了の後: 見せる / 見せない / 期間を区切る。削除の後: 見せない（401／行なし） | サービス終了の後は G5 の推奨（見せる）。削除の後は見せない（P7 の修正と Q1 で自然に決まる） |
| Q5 | 死んだ・他人の・匿名のセッションへの答え | 401 `AUTH_REQUIRED` で統一 / 404 に揃える | 401（G5-11 C-3）。他人の行・不明は 404 の同一性のまま |
| Q6 | Threads の切断で予約の履歴も消えることを受け入れるか | (a) 受け入れる / (b) 本文なしの最小の記録を残す | G4 と一緒に決める |

## 5. 責任の境界と依存の順番
| 項目 | 担当 | 依存・関門 |
|---|---|---|
| P7 の修正（X・Threads の入口に `session_verdict()`、C-1〜C-5） | G3 | G5 の `003` の install（G5 の TASK・Sol・ユーザー）→ G3 → Edge の `session_id` → Codex Sol（高） |
| 削除の saga・purge に、POSTONA の予約（X・Threads）と監査の後片付けを入れる | G3（予約の表の持ち主）と social-mobile の削除の持ち主 | Q1・Q2 の決定 → Codex Sol（高） |
| 共通アカウントの削除の手順で、POSTONA の残りを blocker か checkpoint にする | G5 | Q1・Q3 の決定 |
| Kabumori の `account-delete` の本番の版と、直接の削除の道を塞ぐ | G1・G2（とユーザー） | 本番の確認はユーザーの承認（Q3） |
| Threads の切断・後片付けでの予約の扱い | G4 | Q6 |
| システム列の ACL（PR #370 の P2） | G3 | A1・A2・B・C の決定（別トラック） |
| U8・U9 | G3・G4 | 別トラック |

- 共有の SQL の編集の順番（G3-22 の考え方）: 方針の決定 → 持ち主の 1 つの枠が書く → PG17 の試験 → Sol → ユーザーの承認。それまで、どの枠も予約の表・削除の SQL を変えない。

## 6. 決定の後に限って登録する、次の安全な実装 TASK の案
| 案 | 内容 | 前提 |
|---|---|---|
| T-A（G3） | X・Threads の予約と X の監査を、削除の saga・purge の中で消す（または仮名にする）候補 SQL と、PG17 の試験。G3-26 のずれ 8 個（行・本文・監査の残り）を名前で減らす | Q1・Q2 |
| T-B（G5） | 共通アカウントの削除の手順で、POSTONA の残りを検査する（blocker または checkpoint） | Q1・Q3 |
| T-C（G3） | P7 の修正（G3-25 の 43 個、G3-24 の AC-1〜AC-9） | G5 の `003` |
| T-D（G1・G2） | Kabumori の `account-delete` の直接の削除の道を塞ぐ確認と手順 | Q3、本番の確認の承認 |
| T-E（G3、条件付き） | 孤立した行の掃除（読み取りで数えて、決めた期間の後に消す） | Q3 で (b) を選んだときだけ |

- どの案も、本番は NO_GO のまま。データの削除の実行はユーザーの承認と本番の作業時間が要る。

## 7. 確認済みと未確認
- 確認済み: §2 の X の行・本文・監査の残り方（G3-26 [D]）、送信されないこと（B1〜B4 [D]）、入口の答え（G3-25 [D]）、既存の基準（§1 [M]）、G5 の削除の手順に POSTONA の扱いが無いこと（検索 [C]）。
- 未確認: Threads の削除の後の実際の動き（[E]）、本番の削除の道と `account-delete` の版、Supabase のバックアップ・ログの保持（social-mobile の文書も「プライバシーポリシーで扱う前提」）、法的な保持の義務。
- P7、PR #370 の P2、U8・U9 は未解決のまま。本番は NO_GO。
