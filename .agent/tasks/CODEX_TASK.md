# Codex Task

- task_id: none
- owner: codex
- slot: codex-1
- status: idle
- next_owner: none
- priority: normal
- recommended_model: GPT-5.6 Sol Medium
- purpose: かぶモリアプリ側のCodex作業用スロット。X自動投稿系はユーザーから明示指定がない限りCodex slot 2（H2）を使用する。

## Routing rule

- H1 / G1: かぶモリアプリ側を優先
- H2 / G2: X自動投稿・複数ブランドX運用側を優先
- ユーザーが明示的に別スロットを指定した場合はその指示を優先
- idle状態では勝手に新規作業を開始しない
