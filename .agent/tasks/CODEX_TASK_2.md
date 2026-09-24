# Codex Task 2

- task_id: none
- owner: codex
- slot: codex-2
- status: idle
- next_owner: none
- priority: normal
- recommended_model: Luna
- purpose: X自動投稿アプリ専用のCodex作業スロット。かぶモリ本体の作業は、ユーザーから明示指定がない限りここへ入れない。

## Routing rule

- H2 / G2: X自動投稿アプリ専用
- H1 / G1: かぶモリ本体側を優先
- ユーザーの明示指定がある場合はその指示を優先
- idle状態では勝手に新規作業を開始しない
