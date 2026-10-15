# POSTONA 利用終了クライアント: J4 P2-R1／R2 の修正（F4・ソースのみ・ゲートOFF）

- TASK: `postona-f4-pr197-p2-response-warning-preservation-20261015`（新系統 F4 → L4）
- 基準: PR #197 の先頭 `2171ee4c02ea2eec46562d81595f5460e5507d9d` に積む Draft PR（#197 は無変更）
- 対象: `src/domain/postona-service-end.ts`、`src/lib/postona-service-end-client.ts` と、テスト（新規 `tests/postona-service-end-p2.test.mjs`、`tests/account-deletion.test.mjs` の1か所）。サーバー・旧エンドポイント・画面は無変更。`POSTONA_END_SOURCE_ENABLED` は `false` のまま。

## R1 — 不完全な完了応答を「完了」にしない

F5 PR #193 の `handleWithdrawPostona` の応答の形に合わせて、成功の答えを型ごとに確認する。

| 結果 | 必須 | ありうる任意項目（空なら F5 は付けない） |
|---|---|---|
| `ended`（今回終わった） | `providers`（X は必ず `done`） | `remote_unverified`、`x_posts_unconfirmed` |
| `already_ended`（前に終わっていた） | なし | `providers`、`remote_unverified`、`x_posts_unconfirmed`（記録があるものだけ） |
| `not_registered`（登録なし） | なし | なし（何か付いていたら不一致） |

- `remote_unverified` と各プロバイダの結果を**両方向**で突き合わせる。F5 の規則（`common_account_service_end_result`）どおり、`remote_unverified` に入るのは「ローカル削除・リモート未確認」、または「同意済みで『未接続』」（削除の応答が失われた場合）だけ。
- 今回終わった場合は、本人が同意したプロバイダ（Threads など）すべてに結果が付いていること。
- 足りない・食い違う答えは `RESULT_UNCONFIRMED`（完了とは言わない）。終了後の読み戻し（プレビュー）にはプロバイダの結果が無いので、欠けた警告を補えない。
- 付いた副作用: PR #197 は F5 の正しい形（同意済みで『未接続』の Threads を `remote_unverified` に含む答え）を不一致として拒否していた。これも受け付けるようにした。
- 既存テストの1か所は、F5 が出さない形（`providers` 無しで `remote_unverified` だけ）を成功として期待していたので、正しい形に直し、その形は拒否されることを足した。

## R2 — 応答を受け取った後の確認失敗で、分かっている警告を失わない

- 本人の要求への**正しい形の**答えから、Threads 側の許可が残る旨（`remote_unverified`）と、X の結果が分からない予約の件数（`x_posts_unconfirmed`）を取り出して保持する。
- その後の確認（直後のセッションの読み取りが例外、読み戻しの通信失敗・食い違い、そのほかの例外）で完了を確かめられなくても、`RESULT_UNCONFIRMED` に**両方の警告を付けて**返す。完了や取り消しは言わない。
- 別の人（または誰もいない状態）に切り替わっていたら、前の人の警告は付けない（`SESSION_CHANGED`）。同じ人が別のセッションになった場合は本人の警告として付ける。画面は従来どおり、結果を同じログイン（ユーザーとセッション）にしか見せない。
- 形の崩れた答えからは事実を取り出さない（その本文が述べていることだけを表示）。

## 検証（2026-10-15 JST、合成のセッション・通信のみ）

| 検証 | 結果 |
|---|---|
| 新規 `tests/postona-service-end-p2.test.mjs` を **PR #197 の元のコード**で実行 | **13件中12件が失敗**（修正前の再現）。例: `{ok:true,outcome:'ended'}` を成功（ok=true）として受け付ける、直後のセッション読み取りの例外で X の件数と Threads の警告が消える、読み戻し失敗で Threads の警告が消える、別の人に切り替わっても前の人の件数が付く。通ったのは「ゲート OFF」の1件のみ |
| 同じテストを**修正後**で実行 | 13/13 合格（切り詰め応答・逆方向の食い違い・同意したプロバイダの欠落・F5 の正しい形・直後のセッション例外・読み戻し失敗・読み戻し中のセッション例外・別人／同一人物の切り替え・二重タップと再試行） |
| アプリ全体 `node --test tests/*.test.mjs` | 294/294 合格（J4 の 281 ＋ 新規 13） |
| `npm run typecheck`、`CI=1 npm run lint` | 合格 |
| `POSTONA_END_SOURCE_ENABLED` | `false`（読み戻しで確認） |
| NOT_RUN | 管理された Supabase・F5 の実ハンドラとの結合（J4 が実施した結合プローブは再実行していない）、実機 |

## 変わらないこと・残り

- サーバー（F5 PR #193）、旧サーバー（F3/G3 の旧削除経路の封じ込め）、Threads の SQL（F4 PR #180）、画面には触れていない。J4 が挙げた F3・F5・F4 の別ゲートはそのまま残る。
- 既知の保守的な動き: 同意の後、終了までの間に本人が Threads の連携を解除していた場合、F5 の答えに Threads の結果が無いため `RESULT_UNCONFIRMED`（確認できない）になる。完了を言わない側に倒している。
- 独立した J1〜J4（Sol（高））の再レビューが必要。本番は NO_GO。
