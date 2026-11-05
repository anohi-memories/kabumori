# G2-02 第8 TASK：G1 PR #640 素材BOX の iOS Simulator 実タップ QA（手元の本物の Storage）

- task_id: postona-g2-gen2-08-g1-pr640-real-media-box-native-simulator-ui-qa-20261104
- 実施: 2026-11-04 13:24〜13:58 JST、iOS 27 Simulator の実タップ、手元の実 GoTrue／Kong／PostgREST／storage-api v1.70.3／PG17（env.txt）
- 対象: G1 PR #640 `203e9e2c`（base #635 `bf518a9f`）。使い捨てのコピーだけで `POSTONA_MEDIA_BOX_ENABLED = true`（throwaway-flags.diff）
- 実操作（この作業の記録から数えた）: tap 66、swipe 7、text 9、press_key 7、screenshot 52。写真 24 枚（evidence/、ログインの文字は写っていない）
- 外部 SNS への送信 0、本物の OAuth なし

## 結果

| 項目 | 結果 | 根拠 |
|---|---|---|
| 1 設定 → 素材BOX に実タップで入る | PASS | M01 |
| 2 写真の選択から PNG・JPEG・HEIC・MP4・MOV を追加 → 保存 → 一覧 | PASS | M02〜M05、server-assets-final.txt |
| 2 サーバーの保存物と本人の範囲 | PASS | 5 件とも ready、object 5 件、バイト列の SHA-256 が元ファイルと 5/5 一致（http-probe.txt） |
| 3 画像のプレビュー | PASS | M06（HEIC） |
| 3 動画の再生 | PASS | M07、M08a/b（6 秒の動画で再生中に画面が明るくなる：中央の明るさ 40 → 62 → 76） |
| 3 読み取りの認証 | PASS | 本人 200、認証なし 400、他人の token 400、public 400（http-probe.txt） |
| 4 2 回押しの削除 → タイルが消える → 解放 | PASS | M09（1 回目は確認だけ、表は ready のまま）、M10「保存領域の解放もサーバーで確認済み」、表は deleted・purged=t、object は消えた |
| 4 purged:false の文言 | NOT_RUN | 手元では毎回 purged=t。失敗を起こす方法がサーバーの書き換えしかない |
| 5 未対応形式（GIF） | PASS | M11、資産は増えない |
| 5 大きすぎる（27 MB の PNG） | PASS | M12「画像は 20MB まで保存できます。」、資産は増えない |
| 5 選択のキャンセル | PASS | M13、資産は増えない |
| 5 通信を切って追加 → もう一度送る | PASS | M14（「二重には保存されません」）、切ったままの再送でも増えない、つないで 1 回押すと ready 1 件・request 1 つ（M15、server-assets-final.txt の 27ff65f1） |
| 5 上限（200 件・2 GB）・move だけの失敗 | NOT_RUN | 量が大きすぎる／Storage の一部だけを壊す方法がない。G1・G5 の実装者の試験のみ |
| 6 A → ログアウト → B | PASS | 開いた直後の 1 枚目から空（M16a・M16b）、B の追加は B だけ（M17） |
| 6 JWT 失効（B の session を削除） | PASS | M18：タイルは閉じて「ログインを確認できませんでした。ログインし直してください。」 |
| 6 B → A に戻す | PASS | 開いた直後の 1 枚目から A の 6 件だけ、B の物は出ない（M19a・M19b） |
| 6 サービス終了 | PASS | M20「表示していた素材は閉じました」。その状態で追加を押しても保存されない（M21、資産数 8 のまま） |
| 6 ページング | NOT_RUN | 31 件以上が必要。今回は最大 6 件 |
| 7 実機・Android・hosted／managed・2 GiB・実 SNS | NOT_VERIFIED | 対象外 |

## 気づいた点（P3、G1 の判断）
- 開いた直後に通信を切った「読み込み中の画面」は撮っていない（通信を切ったのは追加の時だけ）。
- サービス終了やログイン切れの後も「素材を追加」のボタンは押せる。押すと写真の選択は開くが、保存はされず誤成功もない（M21）。押せない見た目にするかは G1 の判断。
- 一覧の動画のタイルは再生マークだけで、絵の見本は出ない（設計どおりかは G1 の判断）。

## 片付け
G2 の Simulator・Metro・手元の環境（コンテナ 0）・DerivedData（WorkspacePath で G2 の物と確認）・使い捨ての作業場所・試験の人の記録を削除。終わりにパネルを閉じた時、他の担当の端末（iPhone 17、G8-TSUNAPIC）の表示の接続も外れた。端末は起動したまま、操作・停止はしていない。
