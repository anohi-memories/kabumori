# G2-02 第14TASK QA: G1 PR689 × G3 PR690 通知最終ページ

- task_id: postona-g2-gen2-14-g1-pr689-g3-pr690-final-notification-native-qa-20261115
- 固定HEAD: G1 PR689 = c7b2ac41913530c574949293da6af87c3c44eedd / G3 PR690 = 0b5b997004a65c2b6bfae11add027f47f990b2ea（実行前に `gh pr view` で一致確認、いずれもOPEN）
- base: origin/main 6ddb725c47fda021e2648b265d787a9dcd24eeae
- 競合PR #691 (b093c568) は未採用の重複候補として一切触れていない。
- 製品ソースは未編集。QA証拠のみ。

## 結果

| 項目 | 結果 | 実測の別 |
|---|---|---|
| G1 PR689 アプリ側テスト（`npm ci` 後 `node --test tests/*.test.mjs`、全体） | PASS 1113/1113 | G2実測 |
| G1 通知ページング新規2ファイル（notification-final-page / notification-pages） | PASS 30/30 | G2実測 |
| G3 PR690 `api_test.ts`（deno test --no-config --no-check） | PASS 9/9 | G2実測 |
| G3 公式ローカルスタック runner（実PG17/GoTrue/Kong/Edge、port 55921/55922、podman）の Deno 45ステップ | PASS 45/45（L42〜L44含む） | G2が固定HEADのG3 runnerを再実行（G3第25の証拠の再現であり、G2独自のドライバではない） |
| L42: 279件を100/100/79の3ページで重複なく降順到達、他人に見えない | PASS | 同上 |
| L43: 最終ページ nextCursor:null（0/50/51/100/101件）、途中削除、サインアウト済セッション | PASS | 同上 |
| L44: 2照会の間の実GoTrue logout → HTTP 401 `POSTONA_RESV_AUTH_REQUIRED`、取得済み行返却0、次要求も401（G3認可401の再現） | PASS | 同上 |
| runner 末尾の G1画面統合（g1_screen_integration.test.mjs） | FAIL（環境）: `Cannot find module 'typescript'`。runnerが抽出したG1ピンの木に node_modules が無いため。製品不具合ではないが未検証 | 環境起因・NOT_RUN扱い |
| runner の cron/RB(rollback) 以降のステップ | G1統合ステップでrunnerが中断したため未到達 → NOT_RUN | |
| G2独自のG1アプリ×実JWT×Edge 合成（50/51/100/101/150/151/279/300、初回50/以降100、20ページ上限、壊れたcursor、A/B隔離、退会後read-only） | NOT_RUN | 独自ドライバ未作成。件数の一部（50/51/100/101/279）はG3 runnerのL42/L43で確認、150/151/300・20ページ上限・壊れたcursorはG1側テスト（上記30件）のみ |
| lookahead一時障害時のcursor維持とリトライ | G3 `api_test.ts`（L24）とG1ユニットでのみ確認。実スタックでの障害注入は NOT_RUN | |
| iOS Simulator 実タップ（最後までのタップ、退会後閲覧専用末尾、401ログイン導線） | NOT_RUN | 専用Simulatorの新規作成・アプリビルド・タップ権限が無人実行では得られないためGUI STOP。既存のBooted iPhone 17 等は他slotのものとして触れていない。ローカルHTTPの結果とは区別 |

## 不具合
P2/P3の新規不具合は検出なし。ただし上記NOT_RUNの範囲は未検証。

## 残件
1. G2独自の合成ドライバ（G1ピンHEADの実フック × 実GoTrue/Edge）と専用Simulator実タップ（人手のGUI権限が必要）。
2. G3 runnerのG1統合ステップが `typescript` 無しで落ちる（runner側の改善点。G3へ差戻し候補、P3）。

## 安全チェック
ローカルのみ（127.0.0.1:55921/55922、podman、使い捨て）。本番/managed read/write、SNS/OAuth/Push、有料API、EAS、main push/merge/deploy、フラグONは一切なし。他slotのworktree/process/Simulator/containerには触れていない。実行後 g3ls のコンテナ0・ポート解放を確認、一時worktreeは削除済み。
