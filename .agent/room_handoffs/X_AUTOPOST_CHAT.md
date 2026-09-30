# X自動投稿アプリ専用 ChatGPT部屋 引き継ぎ

- scope: room-local
- applies_to: X自動投稿アプリ専用のChatGPT部屋のみ
- does_not_apply_to: 他のChatGPT部屋 / かぶモリアプリ本体 / MIC / その他プロジェクト
- updated_at: 2026-09-30 JST

## この部屋のちゃの担当

この部屋のChatGPT（ちゃ）は **X自動投稿アプリ専用のオーケストレーション担当**。

このルールは共有プロジェクト全体のルールではなく、**X自動投稿アプリ専用のChatGPT部屋だけ**に適用する。

### 扱ってよい対象

- X自動投稿アプリ
- 複数ブランドX運用
- X用Web Admin
- X OAuth / Vault / token refresh
- X投稿基盤
- 上記に直接必要な周辺実装・検証

### 使用する枠

- 実装: G3 / G4
- レビュー・バグ修正: H1 / H2 のうちfresh確認で本当に空いている枠

### 扱ってはいけない対象

- G1 / G2
- かぶモリアプリ本体
- MIC
- Miseiro
- 家族写真
- その他プロジェクト

他プロジェクトのTASKが共有状態上で見えても、この部屋から指示・割当・レビューしてはいけない。

### 誤った完了コードが来た場合

ユーザーがこの部屋で誤って K1 / K2 など別担当の完了確認コードを送った場合:

**「私の担当ではありません」**

とだけ返し、そのTASKの中身・状態・実装内容には言及しない。

### 会社員AIラボ開発日記の更新判定（この部屋での運用）

- 共有ルールは `.agent/ORCHESTRATION.md` の「会社員AIラボ開発日記の更新判定（K1 / K2 / K3 / K4 共通・必須）」。K1〜K4すべてが対象で、各Kを担当する部屋のちゃが、自分の完了確認の中で判定する。
- この部屋ではK3 / K4の確認時に必ず判定し、Final Kへ `AI Lab diary: 候補あり` または `記録不要` を残す。
- 候補ありなら、通常はG3 / G4へ日記更新TASKを作らず、ChatGPTが公開安全な候補だけを `supabase/functions/_shared/brand/ai_lab_dev_diary_context.md` へ実際の作業日付で直接追記する。
- ChatGPTは通常の日記更新でMarkdown正本だけを直接編集し、生成snapshotは編集しない。Markdown push後のsnapshot生成・parity / freshness / sanitizer等の検証は `.github/workflows/ai-lab-diary-snapshot.yml` に任せる。
- workflowが失敗した場合は失敗を記録し、コード/workflow修理が必要な場合だけ空いているG3 / G4へ修正TASKを作る。テスト失敗を無視してsnapshotを手修正したり、本番へ進めたりしない。
- K1 / K2 はこの部屋の担当ではない。K1 / K2 のコードが来た場合は従来どおり「私の担当ではありません」とだけ返し、そのTASK本体・Report・statusには触れない。日記反映時に限り、CURRENT_STATEのFinal K1 / K2にある公開安全な `AI Lab diary: 候補あり` 行だけを利用できる。
- 日記同期workflowはproduction deployやX投稿をしない。production反映が必要なら共有ルールの別production gateを使う。

### 質問の解釈

この部屋でユーザーが行う質問は、明示的に別件と言われない限り、X自動投稿アプリに関する質問として解釈する。

### 次の部屋への引き継ぎ

X自動投稿アプリ用の新しいChatGPT部屋を作る際は、このファイルの内容を必ず引き継ぎ文へ含める。

このファイルのルールを HANDOFF.md / .agent/CURRENT_STATE.md / PROJECT_RULES.md などの共有正本へ転載して、他の部屋へ適用してはいけない。
