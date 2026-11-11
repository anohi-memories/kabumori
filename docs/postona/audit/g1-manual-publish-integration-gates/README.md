# X手入力投稿 PRスタック 統合前ゲート監査（G1・read-only）

- 作成: 2026-10-20（JST）。Issue [#316](https://github.com/anohi-memories/kabumori/issues/316) TASK `postona-g1-manual-publish-pr-stack-integration-gates-audit-20261020`（第6TASK、K1）
- 性格: **read-only の監査文書**。merge 判断・実投稿・本番 GO ではない。製品コード・共有設定・他 owner のファイルは変更していない。本番は NO_GO のまま。
- 根拠の版: origin/main `0c42933ca5030ab31a56267529430d0473d9b155`。各 PR の head は同じディレクトリの `heads.txt`（`gh pr view`／`gh api compare` の出力をそのまま保存）。ここに書いた SHA は `heads.txt` から機械的に転記した。**どれかの head が変わったら、この監査は該当部分を再検証する必要がある。**
- 実測の範囲: 下の「3. 実測した事実」に書いたものだけ（オフライン、独立 clean checkout）。Simulator・実機・実 Auth・実 X は私（G1）は一切実測していない。G2 の実測は G2 の報告として引用し、**G1 が再実測したとは書かない**。

## 1. PR の一覧と依存順序

| PR | head | base | 変更 | 内容 | 状態 |
|---|---|---|---|---|---|
| #274 | `007dc3d68bdb6c57e2cfb6831090f6544704a3c3` | `main` | 10 | X 手入力の画面（入力・プレビュー・送信前の確認、送信は未接続） | Draft・未マージ |
| #277 | `abd18fc34b5c61b0178187a455a5ade8fc105dc0` | #274 の枝 | 14 | F3 単発投稿契約アダプター・明示同意・同一 ID 再試行 | Draft・未マージ |
| #283 | `b4b761c4dd43cc4c8c1ee1533413b46f088ba21f` | #277 の枝 | 11 | 再起動後の二重送信防止（hash-only 記録） | Draft・未マージ |
| #288 | `c41e20ce508530328570d22c4a0cbc0a43fb2a2e` | #283 の枝 | 13 | F3 #278 の結果印 `simulated`／`afterFreeze` への対応 | Draft・未マージ |
| #325 | `400616ea2efe0504624b9da3e593d9e3d7520a2f` | #288 の枝 | 3 | キーボード回避・ダーク時ステータスバー | Draft・未マージ |
| #346 | `c71f2a1f59d3b1eb72447a73b602adf51639c691` | #325 の枝 | 3 | StatusBar レッドボックス除去・キーボード表示中スクロール | Draft・未マージ |
| #366 | `44ab2e6bb812f3484c85f847574de103757e3dfc` | #346 の枝 | 8 | 下書きをコールバック遷移後も保持（24 時間・平文・セッション印） | Draft・未マージ |
| #369 | `6c363afeec63327deeedeec4ee37ae8f3206fa96` | `main` | 2 | 未定義リンク用の安全な日本語 not-found 画面 | Draft・未マージ |
| G2 QA | #361 `44a04fc0e9604f02fff2e1a77a452be870c9ecd9`、#376 `66cce840924820bbd223e70071efbb4eb125ebcc`、#380 `825fc837227af9b81c7d6e9db3c0744d9b8f01ed`、#385 `fb11542fb2febc592337e83361f2c9462d553c65` | #346／#366 の枝 | 5／33／4／5 | G2 の QA（テスト・証拠）。**G1 は編集していない** | Draft |
| F3（依存先） | #272 `559b3e54f04a89ffe23ebbf54d71857ad064b1e7`、#278 `bf76a7c7b54ff8aa1155aace2045235e9408c18a` | F3 の枝 | 16／21 | 単発投稿の契約とサーバー側 | Draft |

- **依存順序**: #274 → #277 → #283 → #288 → #325 → #346 → #366 は**一本の直列スタック**（各 head は直前の枝の head を含み、`behind=0`）。#369 は main に対して独立（新規ファイル 2 本）。G2 の QA PR は #346／#366 の上に積まれている。
- **#274 の base は古い**: `main` に対し `ahead=1 behind=164`（`diverged`）。GitHub は mergeable と判定している。**#366 まで全部を現在の main へ模擬マージした結果は「競合なし」**（3 章）。統合の時点でさらに main が進めば再検証が必要。
- **スタック相互の前提が変わる場面**: ①どれかの PR の head が変わると、それより上の PR は再検証が必要。②#278（F3）の契約が変わると #288 以降の結果印の読み方に影響する。③G2 の #361／#380／#385 は **FINDING の「現状」を固定するテスト**なので、G1 が修正すると意図どおり FAIL に反転する（修正後に G2 が反転させる前提）。

## 2. 手入力投稿の安全契約チェックリスト（#366 の head のソースとテストを読んだ結果）

凡例: **PASS(src)** = ソースとオフラインテストで確認済み。**NOT_VERIFIED** = 実機・Simulator・実サーバーでは未確認（PASS と書かない）。

| # | 契約 | 判定 | 根拠（#366 の head） |
|---|---|---|---|
| C1 | 送信ボタンは常時 disabled。送信口は `UNCONNECTED_MANUAL_PUBLISH_PORT` 固定で、準備確認は `not_connected` | PASS(src)。実機は NOT_VERIFIED | `manual-publish-port.ts` 93・100–101 行（`getManualPublishPort()` が未接続ポートを返す）、`manual-publish-model.ts` 485 行（`port_not_connected`）。画面テスト「this build: …」、`createSinglePostPort` は定義（`single-post-port.ts`）だけで、`src` 内に呼び出しは無い（`git grep` の一致は定義の 1 行のみ） |
| C2 | `simulated`: 明示の `false` だけが本物。欠落・不正は模擬。模擬の `published` は `sent` にならず、未解決（`uncertain`）で保持され、自動再送なし | PASS(src) | `manual-publish-model.ts` 188 行（`simulated: given.simulated !== false`）、202 行（`marks.simulated ? simulated : sent`）、342 行（simulated→uncertain）。契約の写しは F3 #278 と照合（parity 7/7）。ミュータント検出済み |
| C3 | `afterFreeze`: 明示の `true` だけ。本物の `sent` は注記つきで投稿済み表示、pending／uncertain／failed は種類も再送規則も変えない（結果不明を成功にしない） | PASS(src) | 同 188 行、画面テスト「afterFreeze: …」 |
| C4 | `uncertain` は自動再送しない・再送ボタンもない。pending／unconfirmed は**同じ clientRequestId のみ**再試行できる | PASS(src) | `mayRetrySameId`（`manual-publish-model.ts` 252–254 行）。アダプターのサイクルテスト（同じ ID・同じ要求本文） |
| C5 | clientRequestId は 1 試行 1 つの小文字 UUID。別の本文・別アカウントとは共有しない。送信前に端末へ書いて読み返せなければ送信しない | PASS(src) | `manual-publish-flow.ts`（`runSend`：記録の書き込み→読み返し→ポート呼び出し）。再起動テスト |
| C6 | 未解決の試行の端末記録は **hash-only**（試行 ID・アカウント・本文の SHA-256・種類・時刻のみ。本文・トークン・同意は保存しない） | PASS(src) | `manual-publish-store.ts` 53 行（許可リスト）・58 行（`serialize`）。ガードテストが項目を固定 |
| C7 | 同意は復元しない。復元される下書きはエディタに戻るだけで、同意・確認・readiness・要求 ID は空。送信ゲートはやり直し | PASS(src) | `draft_restored`（`manual-publish-model.ts`）、`manual-publish-draft-store.ts` 30 行・47 行（許可リスト）。画面テスト「U1: only the editor comes back…」 |
| C8 | **24 時間の下書き**と**送信試行**は分離する: 送信開始で下書きを消し、未解決の試行がある間は下書きを持たない | PASS(src) | `manual-publish.tsx` 243 行（`void draftStore.clear(userId); // the text now lives only in this attempt`）。画面テスト「U1: starting a send removes the stored draft…」 |
| C9 | 別ユーザー・別セッション・アカウント消失・解除・期限切れ・破損の下書きは復元しない | PASS(src)、**ただし G2 の指摘 SM1／SM3 が未修正**（下の 4 章）。実 Auth では NOT_VERIFIED | `manual-publish-draft-store.ts`（`decideRestore`）。G2 #380／#385 |
| C10 | 通信なし: 関連テストが `fetch／XMLHttpRequest／WebSocket` をトラップし、呼び出し 0 | PASS(src) | 各テストファイルの deny-net |
| C11 | キーボード回避・ステータスバー・レッドボックス | PASS(src)。Simulator は **FIXTURE_ONLY**（G2 #348／#376）。標準ビルドは NOT_VERIFIED | `manual-publish.tsx`（`automaticallyAdjustKeyboardInsets`、iOS `interactive`、`<StatusBar style="dark" />`、画面オプションに `statusBar*` なし） |
| C12 | スクロール停止後・キーボード表示中の最初のタップ（AC1） | G2 #376 の実測で 2/2 PASS（FIXTURE_ONLY）。G1 は実測していない。標準ビルド NOT_VERIFIED | G2 #376 `README.md` AC1 の行 |

## 3. 実測した事実（G1、オフライン、独立 clean checkout）

`verification.txt` に集計をそのまま保存した。

- **#366 の head（スタック全体）**: `tsc --noEmit` exit 0／`expo lint` exit 0／`node --test tests/*.test.mjs` **491 件: 490 PASS・0 FAIL・1 skipped**（skipped は F3 契約ファイルとの parity で、F3 の #278 のファイルを指定すると 7/7 PASS）／`manual-publish-*` のみ 214 件（213 PASS・1 skipped）。実行前後とも未コミットの変更 0。
- **現在の main への模擬マージ**（push しない・破棄）: #366（#274〜#366 の全 22 ファイル）を `origin/main` にマージして **競合なし**、`tsc` exit 0、491 件 490 PASS・0 FAIL・1 skipped。
- **#369 の head（main の上）**: 283 件 283 PASS（PR #369 の記録）。#369 は manual-publish に触れないため、スタックとの競合はない。
- これらは**製品の動作の PASS ではない**（ハーネスと模擬による検証）。ChatGPT の独立再実行はない。

## 4. G2 QA の証拠と、標準 Simulator との差、各 owner ゲートの分類

G2 の実測は **FIXTURE_ONLY**: iOS 27 では標準の開発ビルドが UIScene 未対応で起動直後に落ちる（G2 #348）。G2 は未追跡の `ios/` に scene 対応のパッチを当てた検証用ビルドで確認しており、**これは通常の iOS 27 製品ビルドの PASS ではない**。

| ゲート | 症状・状態 | 担当 owner | G1 の位置づけ | 統合前に必要な確認 |
|---|---|---|---|---|
| iOS 27 UIScene（標準ビルドが起動しない） | 未修正（G2 #348 の `scene-fixture.diff` は提案） | native／アプリ共通設定（未決） | G1 は native 設定を変更しない | config plugin 等で scene を生成し、標準 `expo run:ios` が起動、ディープリンク・OAuth の戻りが scene 経由で届く |
| 共有のダーク時ステータスバー（G2-S2） | ホーム・アカウント詳細・Threads が未修正。手入力画面は #325／#346 で固定済み | 共有 `_layout.tsx` の担当（未決） | G1 は `_layout.tsx` を編集しない | 担当決定後に両外観で画面確認 |
| `/_sitemap` の本番無効化 | `app.json` の expo-router に `sitemap: false` が無く、`/_sitemap` は既定で生成される（#369 は not-found 画面から導線を消しただけ） | 共有アプリ設定の担当（未決） | NOT_FIXED／BLOCKED_OWNER_GATE | 設定後に `/_sitemap` を開けないこと |
| 実 Auth の `last_sign_in_at`（下書きのセッション印） | トークン更新で変わらない／再ログインで変わる、は**仮定のまま**（G2 #376・#380）。**さらに G2 は、この値が「人ごと」で「セッションごと」でない可能性を指摘（SM2）** | G5（印の選定）・G1（採用） | NOT_VERIFIED | 実 Auth でトークン更新・再ログイン・別端末ログインを観測。セッションごとの値に変更するかを決める |
| 下書き平文保存・ログアウト／退会時の即時削除 | #366 は平文で最大 24 時間。ログアウト・退会で消さない（SM4／SM4-D、G2 #380／#385）。G5 へ IF を依頼済み（#320） | G5/Auth（共有 Provider）・G1（画面・文言） | 未決。G1 側の文言・起動時掃除は別 TASK で実施可能 | 方針決定後、削除フックと、保存方式（平文か否か）の最終判断 |
| G4 Threads 二重公開（G2-T1、P2） | 未修正（G2 #387）。X 手入力とは別機能 | G4 | G1 は介入しない | G4 の修正と G2 の再確認 |
| X の送信口の接続 | 未接続。F3（#272／#278）、G4 の資格情報、F5 の利用権・T13 が未接続・Draft | G1（`manual-publish-port.ts` の接続点）／F3／G4／F5 | 接続は G1 単独ではできない | 下の 5 章の段階 4 |

## 5. 統合する場合の安全な依存／検証順序と GO／NO_GO（提案）

merge や配備を勧める文書ではない。各段階は、その段階の「GO 条件」がすべて満たされてから次へ進む。**どの段階も本番 GO ではない。**

| 段階 | 内容 | GO 条件 | NO_GO 条件 |
|---|---|---|---|
| 0 | 現状の凍結 | 各 head を `heads.txt` に固定。変更があれば再検証 | head が変わっていて再検証していない |
| 1 | G1 所有の残修正（別 TASK） | SM1（印が無ければ保存・復元しない）、SM3（印が変わったら画面を作り直す）、N1（下記）、必要なら N2 が修正され、G2 が #380／#385 の FINDING を反転して PASS | SM1／SM3 が未修正のまま #366 を統合 |
| 2 | 共有・別 owner のゲート | S2（共有ステータスバー）、`/_sitemap`、iOS 27 UIScene、ログアウト／退会時の削除、`last_sign_in_at` の実 Auth 確認の担当が決まり、各 owner が修正 | 担当未決のまま標準ビルドを出す |
| 3 | スタックの統合（UI のみ、送信は未接続のまま） | #274 → #277 → #283 → #288 → #325 → #346 → #366 の順に、各 PR の base を main へ付け替えて（またはスタックを一括で）統合し、そのたびに main 上で `tsc`／`lint`／`node --test` が通る。#369 は独立に統合可。模擬マージは競合なし | 送信口が接続されていないことの確認（C1）が崩れる |
| 4 | 送信口の接続（**別の明示承認が必要**） | F3 の公開スイッチ・G4 の資格情報口（Issue #131）・F5 の利用権と T13 が適用済みで、本物の送信手段が `simulated:false` を明示する。`getManualPublishPort()` を接続する変更に、readiness（サーバー側）・同意・同一 ID の契約テストが付く。N2 の `mock_preview` 条件を解消 | 上のどれかが未適用、実投稿の個別承認がない |
| 5 | 標準ビルドでの Simulator／実機の確認 | 標準 iOS 27 ビルドが起動し、G2 が A03／B11／B17／A07／U1／U2／AC1 を標準ビルドで確認 | 検証用ビルド（FIXTURE_ONLY）の PASS を標準の PASS とみなす |

## 6. 新しく見つけたこと（既に G2／G4／G5 へ送った連携は再掲しない）

**N1（P3・G1）送信中の確認カードに、初回の送信でも「前回と同じ内容・同じ送信IDで確認します。…」が出る。**
- 根拠: `manual-publish.tsx` 404–405 行の表示条件が `state.unresolved !== null`。送信開始時に `unresolved` は `in_flight` で必ず設定されるため、初回の送信中でも条件が成り立つ。G2 #376 が「観察（未分類）」として触れていたが、分類・担当は決まっていなかった。
- 再現（オフライン、#366 の head）: 初回の送信を開始 → `phase=sending`・`unresolved.kind=in_flight` → 文言が表示される（`verification.txt` の N1）。
- 影響: 誤解を招く文言のみ。送信・二重送信の安全性には影響しない。
- owner: G1。必要な追加 TASK: 「再試行のときだけ表示する」（送信開始前の `unresolved` の有無を保持）＋テスト。

**N2（P3 の観察・接続時の GO 条件・G1）`mock_preview`（デモデータ）でもゲートが通り、送信口が接続されるとデモのアカウントで送信を試みられる。**
- 根拠: `manual-publish-model.ts` 467 行は `dataStatus` が `ready` か `mock_preview` のときだけ通す。現状は送信口が未接続なので無害。
- 再現（オフライン）: `dataStatus=mock_preview` と ready を返す偽の送信口で、送信ボタンが有効になる（`verification.txt` の N2）。
- 影響: 現在なし。送信口の接続後は、サーバーがアカウントの所有で拒否する想定だが、**クライアント側でも `ready` のときだけに絞る**のが fail-closed。
- owner: G1（接続の TASK に含める）。段階 4 の GO 条件に入れた。

**N3（運用・情報）G2 の SM1／SM3（G1 の route／画面）は、G1 の修正 TASK がまだ無い。** 内容は G2 #380／#385 に詳細がある。重複投稿はしない。段階 1 の前提として、G1 担当ちゃが修正 TASK を起こす必要がある（私は修正していない）。

その他、新しい P1／P2 は見つけていない。

## 7. 未実施・NOT_VERIFIED
- 実機・Simulator（標準ビルド）、実 Auth（`last_sign_in_at` の挙動）、実 X・実 OAuth、managed Supabase・本番。
- 旧 F1 M3 archive（MANIFEST／SHA256SUMS／HISTORY_INDEX）の不足は、原本を保護したまま未完了（本 TASK では触れていない）。
- 他 slot の worktree・branch・dev server、G2 の QA rig には触れていない。

## 8. 変更範囲
本 PR の変更は `docs/postona/audit/g1-manual-publish-integration-gates/` の 3 ファイル（この文書、`heads.txt`、`verification.txt`）のみ。製品コード・テスト・`app.json`・`_layout.tsx`・native・Auth／OAuth／DB／RLS／RPC／Edge・G2／G3／G4／G5 のコード・テスト・Issue 本文は変更していない。
