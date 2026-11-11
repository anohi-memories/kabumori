# G2 第30世代 — 公開前の NO_GO の証拠のずれ（ドリフト）を検出する判定の試験（QA専用）

- Issue #317 TASK `postona-g2-release-no-go-evidence-gate-drift-offline-20261022`
- 土台: origin/main `0c42933ca5030ab31a56267529430d0473d9b155`（この PR の base）。製品のコードは変更していない。
- 新規: `apps/social-mobile/tests/g2-release-evidence-drift.test.mjs`（16件）と、その入力 `snapshot.json`（2026-10-22 11:57 JST に `gh pr view`・`git ls-remote` で読み取りだけで集めた PR の版・状態・親の枝の先端）。試験は保存した入力だけを読み、実行中に外へ問い合わせない（G2-RE5 で確認）。
- G2 #387（2026-10-20）は止める理由の一覧。本試験は一覧を作り直さず、**判定の規則と、その入力がずれたときの振る舞い**だけを試す。

## 1. 判定の規則（失敗側に倒す）
止める理由（関門）ごとに、修正の PR と、外すのに**全部**必要な証拠の種類（製品の修正・独立したセキュリティレビュー・G2 の QA・実機・実 API）を決め、次をすべて満たすときだけ外す:
1. 修正の PR が**統合済み**（OPEN・Draft は不可）
2. 各証拠が、修正の PR の**今の版**で取られている（G2 の QA は「どの PR のどの版で測ったか」まで一致）
3. 証拠の判定が受け入れ（ACCEPT / PASS / APPROVED）で、**受け入れを保留する言葉**（CHANGES_REQUIRED、REVIEW_REQUIRED、REREVIEW_REQUIRED、NO_GO、FINDING、NOT_VERIFIED、CANDIDATE など）を一つも含まない
4. レビューの後に**親の枝が動いていない**
5. 今の版に CHANGES_REQUIRED のレビューが残っていない
6. 未解決の指摘・既知の失敗する試験・赤い QA の関門が無い
G2 の QA は QA の証拠にしかならず、製品の修正・レビュー・実機・実 API の代わりにならない。ソースだけ・オフラインだけの PASS は、実機・実 API の関門を外さない。

## 2. 今の状態（2026-10-22 11:57 JST の入力、G2-RE1・RE2）
すべての関係 PR（22件）は OPEN・Draft・未統合。結果は **NO_GO**（10 の関門すべてが外れない）。

| 関門 | 重さ | 担当 | 修正の PR（版） | 証拠の種類と版 | 外れない主な理由 |
|---|---|---|---|---|---|
| THREADS_T1（二重公開） | P2 | G4 | なし | QA: G2 #391 `e729b2f2`（FINDING）、#439 `94b3e09b`（修正候補なし） | NO_FIX、OPEN_FINDINGS、製品の修正・レビュー・実 API なし |
| THREADS_T2（解除の早すぎる成功） | P3 | G4 | なし | QA: G2 #393 `2f318231`（FINDING） | NO_FIX ほか |
| THREADS_T1X（解除の照合試験） | P3 | G4 | なし | QA: G2 #442 `d2845005`（準備の不足と切り分け） | NO_FIX、KNOWN_FAIL（G4 の試験はまだ失敗）、PRODUCT_FIX_MISSING。**#442 は QA で修正ではない** |
| X_STALE_NONE_LIVE_RETRY（X の二重送信） | P2 | G1 | #435 `5a6c51ca`（#427 `38bf60cd` の上） | 製品の修正: #427（再レビュー必須の候補）、#435（同じ）／レビュー: H1 が #427 に CHANGES_REQUIRED（#427 の今の版のまま）／QA: G2 #430 は **#427 で**測った | CHANGES_REQUIRED、DRAFT、NOT_MERGED、PRODUCT_FIX_NOT_ACCEPTED、SECURITY_REVIEW_NOT_ACCEPTED、**STALE_QA**、OPEN_FINDINGS |
| X_OAUTH_OWNER_SESSION（X 接続の人の照合） | P3 | G4 | #426 `03968e5c` | 製品の修正: G4 ACCEPT（独立 Auth レビュー必須の候補）／QA: G2 #433 `12928760`・#436 `898a551d` は #426 の今の版で測定 | DRAFT、NOT_MERGED、PRODUCT_FIX_NOT_ACCEPTED、SECURITY_REVIEW_MISSING、REAL_API_MISSING、OPEN_FINDINGS |
| IOS27_UISCENE（標準ビルドが起動しない） | 公開条件 | 未決（native 設定） | なし | QA: G2 #397 `a0f66c77`／実機: #348 `e3963e11`（**検証用に直したビルドだけ**） | NO_FIX、DEVICE_NOT_ACCEPTED |
| EXPO_IDENTIFIERS（ID1・ID5） | P3 | 未決（native 設定） | なし | QA: G2 #401 `22e574f8` | NO_FIX、DEVICE_MISSING |
| ANDROID_DEVICE_APP_LINKS | P3 | G4・native 設定 | なし | QA: #362 `a2145eed`、#419 `1ffd1b20`（オフラインの PASS） | NO_FIX、**DEVICE_MISSING**（オフラインの PASS は実機ではない） |
| SESSION_MARK_SM（SM2・SM3R-T・SM4・SM4-D） | P3 | G1・G5（Auth IF） | なし | — | NO_FIX ほか |
| REAL_AUTH_AND_SNS | 公開条件 | 利用者の承認 | なし | — | REAL_API_MISSING、DEVICE_MISSING |

参照した記録（Issue のコメント、判定はそのまま写した）: H1 #306 6329625617（#427 CHANGES_REQUIRED、HEAD `38bf60cd`）、G1 #316 6329047680（#427 候補）・6331460282（#435 候補 `5a6c51ca`）、G4 #319 6329054895（#426 候補）、G2 #317 の各 REPORT・ACCEPT。H1 #306 の現行 TASK は #435 の再レビュー（ready、未実施）。

## 3. ずれ（ドリフト）の試験（G2-RE3・RE4）
本当に終わった関門（統合済み・今の版でレビュー PASS・今の版で QA PASS・実 API の承認あり）を合成して、**外れる**ことを先に確認（RE3、判定が常に NO_GO ではない証拠）。そこから一つずつずらし、厳密な判定は外さず、素朴な規則（「何か PASS があれば完了」）は外してしまうことを確かめた:

| ID | ずれ | 厳密な判定の理由 |
|---|---|---|
| D1 | レビュー・QA・実 API が古い版で取られ、PR が先に進んだ | STALE_SECURITY_REVIEW・STALE_QA・STALE_REAL_API |
| D2 | レビューの後に親の枝が動いた | PARENT_DRIFT |
| D3 | 受け入れ済みだが Draft・未統合 | DRAFT・NOT_MERGED |
| D4 | 今の版のレビューが CHANGES_REQUIRED | CHANGES_REQUIRED |
| D5 | 「候補 PASS／再レビュー必須」の担当の ACCEPT をレビュー扱い | SECURITY_REVIEW_NOT_ACCEPTED |
| D6 | G2 の QA の PASS を製品の修正の代わりにする | PRODUCT_FIX_MISSING |
| D7 | ソース・オフラインの証拠を実 API の代わりにする | REAL_API_MISSING |
| D8 | QA の関門がまだ赤い（todo の失敗） | QA_GATE_RED |
| D9 | 既知の失敗する試験が残る | KNOWN_FAIL |
| D10 | 未解決の指摘が残る | OPEN_FINDINGS |
| D11 | QA が一つ前の修正 PR（#427→#435 の形）で測られている | STALE_QA |

## 4. 負例（規則そのものの確認）
規則を一つずつ外すと、それに頼るずれが外れてしまう: 版の確認を外す → D1・D11 が外れる／統合の確認を外す → D3 が外れる／判定を「PASS を含めば受け入れ」にする → D5 が外れる。保留の言葉を含む実際の判定文（G1 の #427・#435、G2 の #433 の ACCEPT）は受け入れにならないことも確認。

## 5. 全体
main + 本試験: 293 件中 293 通過（本試験 16 件）。記録: `run.log`。

## 6. 分類と残り
- 新しい担当間の誤った公開判定は見つからなかった（どの担当の ACCEPT も「候補・レビュー必須・本番 NO_GO」と書いており、整合している）。新しい引き継ぎは無し。
- 見つけたずれ（記録のみ）: G2 #430 の関門 SN1・SN2 の PASS は #427 で測ったもので、今の修正候補 #435 では測っていない（STALE_QA）。#435 がレビューで受け入れられたら、#430 の試験を #435 で流し直す必要がある。
- G2 #442 は QA の成果で、G2-T1-X は G4 の試験の修正待ちのまま。G1 #435・G4 #426 は本番の安全の承認ではない。
- 保護したまま: G2-T1（P2）・T2・T1-X、G1/H1 の P2（#435 再レビュー待ち）・G2-SN5、G4 #426 の独立 Auth レビュー・実サーバーの古い token、iOS 27 の標準ビルド、識別名 G2-ID1・ID5、Android 実機・App Links、SM 系、実 Auth／SNS。本番 NO_GO。
- 入力は 2026-10-22 11:57 JST 時点のもの。PR の版が変わったら `snapshot.json` を集め直し、変わった関門だけ確認する。

## 7. 実行
```bash
cd apps/social-mobile && node --test tests/g2-release-evidence-drift.test.mjs
```
