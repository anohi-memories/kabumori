# V3 への段階移行（設計提案・未実施）

この文書は提案。現行ルールの変更、`.agent/` / `.agent_v2/` の切り替え・削除・改名、開始コードの意味の変更は、どれも行っていない。正式に適用するときは別TASKで行う。

## 前提（2026-10-16 の確認時点）

- 旧 `.agent/` のG1〜G10 / H1〜H5は、15枠すべて `done`。継続中のTASKは無い。
- 新系統 `.agent_v2/` のF1〜F10 / J1〜J5は稼働中。`017583cc` 時点で、索引とTASKの食い違いがF2とJ5に残っている（`EVIDENCE.md` の3）。
- Draft PR #172（Codexの最終移行前snapshot）は保護対象。V3はそのパス（`.agent_v2/archive/2026-10-13-*` ほか）に触れない。

## 移行の原則

- 稼働中のF / Jは止めない。v2で始めた `task_id` はv2で完結させる。途中でV3へ移さない。
- V3へ移すのは、slotが空いた後の**次の新規TASK**から。
- 旧系統・v2の履歴は消さない、短縮しない。archiveは追記だけ。
- 開始コードや `return_to` が曖昧な場合は移さず、保留にする。

## 段階

| 段階 | 内容 | 書き込み |
| --- | --- | --- |
| 0（このPR） | V3の仕様・ツール・隔離テスト・調査を独立パスに置く | 本番の管理ファイルへの書き込みなし |
| 1 | L10の確認。必要ならCodexのレビュー（J1〜J4）。対象は transaction・CAS・読み戻し・github backend | なし |
| 2 | 影運用: Fの確認時に `verify --legacy-v2` を `.agent_v2` へ読み取りだけで実行し、食い違いを担当へ知らせる（直すのは各担当） | なし |
| 3 | 正式適用TASK: V3の置き場所（候補: 旧 `.agent/` をarchiveへ移した後の `.agent/`）と、G / H / K / C の名前で使うことを決める。PROJECT_RULES / ORCHESTRATION / AGENTS / CLAUDE / CHATGPT_HANDOFF を改訂 | ルール文書（別TASK） |
| 4 | slotごとの移行: v2のFn / Jnが `done` になりarchiveされたら、その用途の次の新規TASKをV3のGn / Hnへ、ツールで登録する（`REGISTERED_ON_MAIN` を確認） | V3（ツール経由のみ） |
| 5 | v2の全slotが完了・archive済みになったら、v2の最終snapshotを取り、v2をarchiveへ移す。単独 `F` は15枠の統括に戻る | 別TASK |

## GO 条件（段階3・4へ進む前に、すべて満たす）

1. このPRのL10が完了し、Codexレビューを行う場合はその指摘が解消している。fresh mainで `tests/agent_v3` が全件PASSする。
2. **branch上でのCASを実機で確認**している。2026-10-16時点では未確認（下の「未確認の理由」）。
3. ChatGPTの書き込み経路が決まっている。次のどちらかを、専用refでの試験登録1回で確かめる。
   - Git Data APIで複数ファイルを1commitにできる（SPECの7の2段目）。
   - できない場合は「TASKファイル1つだけを書き、索引は書かない」規則（SPECの7の3段目）を採用する。
4. 旧 `.agent/` に継続TASKが無く（現時点で満たす）、最終snapshotのhash照合・復元確認が済んでいる（PR #172、または後継）。
5. 移すslotで、v2の索引とTASKの食い違いが解消している（現時点ではF2・J5が未解消）。
6. 開始コード、`return_to`、単独 `F` の範囲を定めたルール文案が承認されている。

## NO_GO 条件（ひとつでも当てはまれば移さない）

- 移す対象のslotに、未解消の食い違い、`review_required`、未archiveの `done` がある。
- 開始コードや `return_to` が曖昧、または同じ `task_id` をv2とV3の両方で書く必要がある。
- 移行経路の書き込みで原因不明の拒否（`REFUSED_STOPPED`）が出ていて、まだ説明できていない。
- PR #172 などの最終snapshotが確定していない。

## 未確認の理由（branch上のCAS）

専用ref（`refs/agent-v3-live-test/...`）ではサーバー側のfast-forward検査が効かず、CASの実機確認にならなかった（`SPEC.md` の8）。branchで確認すると、push のたびにVercelのプレビューdeployが動く可能性がある（確認できた範囲では、mainのcommitにVercel、PR branchのcommitにVercelとNetlify deploy-previewの状態が付いている。PRの無いbranchで動くかは未確認）。このTASKはdeployを禁止しているため、branchでの確認は行っていない。次のどれかで、承認を得てから確認する。

- 連携の無い使い捨てのリポジトリで確認する。
- Vercelのプレビューを許容したうえで、専用branchを1本だけ作って確認する（push 2回程度）。

## V3導入までの暫定策（v2への提案。適用は別TASK）

- 割当・完了のたびに、書いた側がTASKと索引の両方をmainから読み戻し、一致しなければ「登録未完了」と報告する（「登録済み」と言わない）。
- slotのReport commitでは、自分のslotの索引行も同じcommitで更新する（今の分担ルールの変更が必要）。
- 単独 `F` の第一段階で `verify --legacy-v2` を実行し、食い違いを一覧に入れる。
