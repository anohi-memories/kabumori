# POSTONA 素材BOX の非本番ローカル統合（G1 第43TASK）出典 manifest

- TASK: Issue #316 `postona-g1-43-real-media-box-screen-upload-list-read-delete-local-integration-20261104`
- 用途: 非本番・ローカル検証専用。merge・deploy・フラグ ON の承認ではない。本番は NO_GO
- branch: `claude/g1-postona-media-box-ui-20261104`（G1 RC #635 の固定 HEAD から作成）
- 基準の main: `92884b331043a4ff1e289ac8139a64fd46b6337f`（作業時の fresh origin/main）

## 取り込んだ source

| 順 | 担当 | PR | 固定 HEAD | 方法 | 衝突 |
|---|---|---|---|---|---|
| 0 | G1 | #635（起点、第42の RC） | `bf518a9f6ba02491bbdf9aab04e37a1f44119c1d` | branch の起点 | — |
| 1 | G5 | #638（#637 → #636 → #602 の上） | `c20f7ae1150b4ec90637f2faa8daa5ed18a907ca` | `git merge --no-ff`（merge commit `fc40d35d7d4d99e7105a05d6cda6f5cef162ef2c`） | なし |

- G5 #602 は #635 にすでに含まれるため、#638 の取り込みで増えるのは #636・#637・#638 の 3 commit と 8 ファイル（G5 所有のみ）
- 取り込んだ 8 ファイルは、#638 の固定 HEAD と一致した（内容不変）
- #635・#636・#637・#638 の HEAD・branch と main は変更していない

## G1 の変更（`apps/social-mobile/` と、この manifest だけ）

| path | 内容 |
|---|---|
| `src/features/media-box/media-box-client.ts` | G5 `supabase/candidates/postona_personal_media_box/client.ts`（#638）の**無変更コピー**。blob `3bd880ddf4011b18662eac0948bb1c9a660440a2`。テストで一致を確認する |
| `src/features/media-box/media-box-gate.ts` | `POSTONA_MEDIA_BOX_ENABLED = false`（製品ソースは OFF） |
| `src/features/media-box/media-box-view.ts` | 選んだファイルの型・大きさの事前確認、失敗分類ごとの文言、再送できる失敗の判定 |
| `src/features/media-box/pick-media.ts` | `expo-image-picker` で 1 件選び、`expo-file-system` の `File` でバイト列にする |
| `src/features/media-box/use-media-box.ts` | 一覧・追加・再送・削除・解放確認・ページ送り。利用者と workspace ごとに保持し、切り替えや拒否の答えでは捨てる |
| `src/app/media/index.tsx` | `mockRepository` の画面を置き換えた。認証付きのプレビュー（画像と動画）と、2回押しの削除 |
| `src/app/(tabs)/settings.tsx` | 素材BOX への入口（これまで画面への導線がなかった） |
| `app.json`、`package.json`、`package-lock.json` | `expo-image-picker` ~57.0.20、`expo-video` ~57.0.5、`expo-file-system` ~57.0.7（`npx expo install` で SDK 57 の版を選択）。写真の権限文言。カメラとマイクは使わない |
| `tests/media-box.test.mjs`、`tests/media-box-harness.mjs` | 画面と hook を G5 サーバーの代役の上で確かめるテスト |
| `tests/local-stack/run-media-box.sh`、`build-media-box.py`、`media-box.e2e.mjs`、`make-media-fixtures.swift` | 実ローカル環境のテスト。G5 のランナー（#638）を元に、project 名とポートを変え（`g1mb`、563xx）、最後の段を G1 のテストに置き換えたもの |

## 変更していないもの

- G5 の SQL、ACL、RLS、Storage のポリシー、client の契約。G3・G4・G6 のソース
- 新しい Auth、Storage、RPC、Edge の追加はしていない
- managed、hosted、本番への接続（読み取りを含む）はしていない

## 採用の前に必要なこと（この branch では解除していない）

1. G5 の素材BOX の SQL を managed で使う前の、限定のセキュリティ確認とユーザーの承認（G5 ACCEPT の条件）
2. G2 による Simulator の実タップでの QA（このTASKでは端末の操作許可が得られず NOT_RUN）
3. フラグ ON は別のゲート。merge の順序は中央が決める
