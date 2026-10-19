## Report（F3｜main 未登録のため PR ブランチに保存）
- task_id: postona-f3-m1-ui-receipt-atomic-credential-contract-offline-20261019（**main に未登録**）
- slot: F3 / owner: claude / completion_code: L3 / return_to: POSTONA G3のちゃ / recommended_model: Opus5.5（高）
- 本来の状態: status review_required / next_owner chatgpt（main の TASK と ACTIVE には反映していない）
- result: **implemented_offline_contract_pass（source-only・本番 NO_GO・本物の X は未実施）**
- 登録しなかった理由（Issue #286 の分類 B）:
  - main への管理コミットが、今も Vercel の本番デプロイを起こしている。
  - 2026-10-19 01:29（日本時間）のアーカイブだけのコミット `865f7634` で Production deployment が完了していた。Ignored Build Step 保存の報告（01:24）の後。
  - 総合指令室 #6260001714 の「未解除なら無断 push しない」に従った。
  - 書き込みの拒否（分類 A）は起きていない。GitHub 側の拒否は試していない。
- 事前の確認:
  - 前の F3 TASK は、main で TASK・ACTIVE とも done。
  - 新しい task_id は main の中で 0 件（未登録）。
  - PR #278 の head は `bf76a7c7b54ff8aa1155aace2045235e9408c18a` のまま。
  - G1 PR #283 `b4b761c4dd43`、PR #288 `c41e20ce508530328570d22c4a0cbc0a43fb2a2e`、G4 PR #282 `39b9064dc79ad52b430ba820006cd3310bf3140f`、PR #287 `30170626983a`、F5 PR #285 `3a5eef3d6b98` を読み取りだけで確認した。
- changed_files（新規 6、既存の変更なし）:
  - `docs/postona/x-single-post-m1-ui-receipt-credential-contract-20261019.md`（契約と調査の結論）
  - `supabase/functions/_shared/postona_reservations/contract_vectors/single_post_result_vectors.json`（答えの表 34 件）
  - `supabase/functions/_shared/postona_reservations/single_post_receipt_contract.ts`（受領票の**提案**。型と読み方だけ）
  - `.../single_post_receipt_contract_test.ts`
  - `.../single_post_ui_contract_test.ts`（G1・G4・F5 との契約テスト 15 件）
  - この Report
- 調査の結論:
  1. **本文なしの受領票はない**。代わりになりそうな既存の読み取りは、どれも使えない。
     - begin の繰り返しは本文が必要。
     - readback は予約 ID が必要で、Edge もない。
     - get・list は本文を返し、X の ID も印もない。G4・G5 が外れると読めない。
     - 実装はせず、契約（R1〜R5）と担当（F3 が SQL と Edge、F1 が利用、F5 が R2 の方針）を文書 §1 に書いた。
  2. G1 との契約: 6 種類と `simulated` / `afterFreeze` が一致。G1 PR #288 の読み方も、作業用フォルダでの照合で 34 件すべて同じだった。
  3. `simulated=true` の成功は、F3 が本物の投稿として返さない（S1・S2）。G1 は未解決として扱う。
  4. `uncertain` は再送しない。再起動後の同じ ID は読み直すだけ（U1〜U3）。新しい ID の抑止はアプリの責任（G1 PR #283）。
  5. G4 PR #282: `credentialFor` だけを使う。64 桁の小文字以外や一致しない世代は送らない。別々の取得方法は未接続。G4 の実際の取得口は G1〜G5 を満たした（作業用フォルダ）。
  6. F5: 開始時と送信直前の拒否、世代の変更による拒否は、どれも送らない（F1〜F3）。
- tests（MOCK_ONLY・DENY-NET。`deno test` に `--allow-net` を付けず、`fetch` を数えて例外にする代わりの関数に差し替えた）:
  - 新規 `single_post_ui_contract_test.ts` 15 件と `single_post_receipt_contract_test.ts` 4 件: **19 件合格**。ネットへの呼び出しは 0 回（N1）。
  - `_shared/postona_reservations` と `postona-x-single-post` の全体: **81 件合格**（PR #278 の 62 件と新規 19 件）。
  - 型検査（新規 3 ファイル）OK、lint 0 件、`git diff --check` OK。
  - 変異テスト:
    - 受領票の読み方: 7 個すべて検出。
    - 新しい契約テストだけで、既存の F3 コードの変異 8 個を検出。1 回目は 7 個で、世代の形を緩める変異 1 個が生き残ったため、検査を 1 つ足して 8 個とも検出した。
  - 作業用フォルダでの照合（PR には含めない。照合の結果だけ）:
    - G1 PR #288 の `single-post-contract.ts` が、34 件で F3 と同じ答え。
    - G4 PR #282 の `x_posting_credential_source.ts` が、G1〜G5 を満たす。既定は未接続。32 桁の世代と問い合わせの失敗では送らない。
  - **実行していないもの**:
    - PostgreSQL での E2E。PR #278 の `single_post_live_fence_run.sh` の結果を引用しているだけで、今回は再実行していない。
    - G1 の node テスト（PR #283 の再起動テストなど）。G1 の PR の証拠を参照した。
    - 本物の X・OAuth・Vault・managed Supabase、アプリの実機と Simulator
    - F5 PR #285 の owner epoch との結合
- commit: `fe7f7418f49028cecd4af07a616ad6ec16c5b78b`（コードと文書。git rev-parse の出力）。この Report は、その次のコミットで足している。最終の head は PR の本文に書く。
- push: `claude/f3-m1-ui-receipt-contract-20261019`（PR ブランチだけ。main への push はしていない）
- PR: Draft。base は `claude/f3-m1-f1-live-fence-20261018`（PR #278）。
- merge・deploy: not_performed。migration の適用、Vercel・Supabase の設定、本物の X への投稿もしていない。
- dependencies:
  - F3 PR #278 → #272 → … の積み順
  - G1 PR #283・#288（アプリ側の写しと、再起動の記録）
  - G4 PR #282・#287（`credentialFor` と 003）
  - F5 PR #275（B1〜B8）・#285（owner epoch）
  - Issue #286（Vercel のゲート）
- remaining_issues:
  1. 受領票の実装（F3 の新しい TASK。F5 の R2 の判断が先）。
  2. 世代に F5 の owner epoch を含めるかの合意（F5・G4・F3）。
  3. G4 の口座 ID の形が F3 より狭いこと（安全側だが、そろえるかは G4 と相談）。
  4. Vercel のゲートが解除された後に、この TASK と Report を main に正規の形で登録する。
  5. 本物の Auth・X での確認と、Sol（高）による合同レビュー。
  6. production は NO_GO。
- safety_checks:
  - 作ったのは F3 の文書・型・テストだけ。G1 の画面、G4 の OAuth・トークン、G5 の Auth・利用権、共有の DB・RPC・Edge は変えていない。
  - ネット・DB・Vault・トークンには触れていない。テストのトークンは偽の文字列だけ。
  - main への push・merge・deploy・force push はしていない。
