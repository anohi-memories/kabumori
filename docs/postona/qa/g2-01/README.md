# G2-01 POSTONA Threads 画面・X UI 回帰 独立QA — 証拠（QA専用、製品コード変更なし）

- Issue: #317（G2 固定 Issue）。前TASK `postona-g2-threads-ui-offline-qa-x-regression-20261019`（REPORT #6265547242 / ACCEPT #6267507711）、本TASK `postona-g2-threads-uncertain-republish-regression-evidence-20261019`。
- 対象: Threads PR #140 → #144 → #154 → #167（HEAD `02fd1989303879979b137f8338f8bc6944f266b1`、このブランチの base）、X 手入力 PR #325（HEAD `400616ea2efe0504624b9da3e593d9e3d7520a2f`）。
- 実 Threads / Meta / X / Supabase には一切接続していない。全サーバー応答はテスト内の注入スタブ。feature gate は OFF のまま。

## 再現テスト

`apps/social-mobile/tests/g2-threads-ui-qa.test.mjs`（16件）。実フック・実カードのソースを TypeScript 変換して、スタブの React / React Native / Supabase で動かす。

```bash
cd apps/social-mobile && node --test tests/g2-threads-ui-qa.test.mjs
```

| 区分 | テスト |
|---|---|
| ゲートOFF | 3つのリリースフラグが false／投稿カードは全接続状態で入力0・送信0／接続・解除ボタンは disabled、ハンドラを押しても開始0 |
| G2-T1（P2, owner G4）**FINDING** | 応答喪失→サーバーでは公開済み→本文が残り再確認で**新しい idempotency key**の2回目 publish。案内文の「確認する」ボタンも存在しない（現状の挙動を固定。修正でこのテストは変わる想定） |
| G2-T1 境界（現状安全） | 操作しなければ publish は1回のまま／publishing・container_created は入力欄なし、「続ける」は同じ attempt id で resume／要再接続・未接続は状態取得すら0／投稿許可OFFは同意が先で送信0／同じ確認の連打は1回、証明済みの failed の後の新しい確認だけ新キー／他アカウントの応答は採用しない／本人が変わった確認は送らない／uncertain は読み取り確認のみ |
| G2-T2（P3, owner F4）**FINDING** | 解除後の再読込中（一覧が一時的に空）に「解除しました」と表示し、読み戻しでアカウントが残れば「確認しています」に戻る |

- `g2-threads-ui-qa.test.log`: 上記の実行ログ（16/16 pass、ローカルパスは `<g2-worktree>` に置換）
- `app-suite-summary.log`: `node --test tests/*.test.mjs` 303件 pass
- `negative-controls.log`: 製品ソースの10か所を一時改変（各回復元）→ 10/10 検出

## Simulator 証拠（`evidence/`、900px に縮小。mock データのみ、個人情報・トークンなし）

特殊起動（iOS 27 の通常ビルドは起動直後に UIScene 未対応でクラッシュするため、ビルドのコピーを SDK 26.0 表記に変えて ad-hoc 再署名）。通常ビルドでの確認は NOT_VERIFIED。端末は iPhone 18 Pro / iOS 27.0 の QA 専用 Simulator（削除済み）。

| ファイル | 内容 |
|---|---|
| C01 | #325 ホーム（ライト） |
| C02 | #325 手入力画面を開いたときの開発レッドボックス（G2-S1, P3, owner G1） |
| C03 | キーボード表示中、本文入力欄がキーボードの上に出る |
| C04 | 下方向ドラッグでキーボードが閉じ「内容を確認する」が見える |
| C05 | キーボード上から始めたスワイプではスクロールしない（操作位置の確認） |
| C06 | 「内容を確認する」タップ後の確認画面（ライト） |
| C07 / C08 | ダーク: 確認画面・キーボード表示中もステータスバーが読める（#325 P3 PASS）。注: C07 は C06 とバイト一致（画面が固定ライト配色で、ステータスバーも濃色固定のため見た目が変わらない）。端末がダークだった証拠は C08（ダークのキーボード）と C09（同時刻帯のホームで白いステータスバー） |
| C09 | ダークでホームへ戻るとステータスバーが白で読めない（G2-S2, P3, #325 対象外） |
| T01 / T02 | アカウント一覧（Threads 3状態）、Threads 接続・解除カード（プレビューのため不可、解除ボタン disabled） |
| T03 | アカウント詳細にヘッダー・戻るボタンが無く、見出しが時刻と重なる（G2-S2） |
| T04 / T05 | Threads 接続済み・要確認アカウントの投稿カード「準備中…投稿されることはありません」、入力欄なし |
| T06 | 同画面ダーク: ステータスバー不可視（G2-S2） |

## 未確認（NOT_VERIFIED）

- #325「キーボードを表示したまま最下部へスクロールして確認ボタンを押す」: `keyboardDismissMode="on-drag"` のためドラッグで閉じる。閉じた後のタップ PASS とは別扱い。
- iOS 27 の通常ビルド起動、実機、Threads のゲートON時の実画面（同意・投稿・uncertain・解除確認）。
