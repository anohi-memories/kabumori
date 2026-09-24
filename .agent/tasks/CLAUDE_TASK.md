# Claude Task 2

- task_id: none
- owner: claude
- slot: claude-2
- status: idle
- next_owner: none
- priority: normal
- recommended_model: Sonnet5（中）
- purpose: かぶモリアプリ用の未割当実装スロット。現在はNetlify Web Preview対応を進めない方針のため空き。

## Routing

- かぶモリアプリ実装はG1/G2を使用する。
- X自動投稿実装はG3/G4を使用する。
- ユーザーから明示指定がない限り、空き状況・競合・依存関係を見てChatGPTが割り当てる。
- idle状態では勝手に作業を開始しない。

## Deferred note

- `kabumori-netlify-expo-web-preview-pipeline-20260924` はユーザー判断により現時点では不要として保留。
- かぶモリ本体はExpo/native中心のため、Vercel rate limit対策としてNetlify Web Previewを優先する必要はない。
- 将来Web Previewが必要になった場合のみ、新しいTASKとして再割当する。
