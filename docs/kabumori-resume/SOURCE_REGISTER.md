# 受領済み部屋別引き継ぎ原本台帳
受領日: 2026-10-17 / 受領数: 5 / 保存完了: 2026-10-17

**受領5原本の保存完了。** `docs/kabumori-resume/rooms/` に添付原文をバイト単位で保存し、GitHubから読み戻した5件すべてについて、受領原本とのサイズ・SHA256・全バイト一致を確認した。

| 原本（会話添付） | 担当 | 保存先 | サイズ（bytes） | SHA256 | GitHub読み戻し |
|---|---|---|---:|---|---|
| 貼り付けたテキスト（1）(20261017-041353).txt | G6/F6 共通AI | [g6-f6-common-ai.txt](rooms/g6-f6-common-ai.txt) | 40046 | `b438b37383b496cf5446980ca2ede316bd4209c1f82619d7f4a777718501c719` | 全バイト一致 |
| 貼り付けたテキスト（2）.txt | G8/G9・F8/F9 ニュース/API | [g8-g9-f8-f9-news-api.txt](rooms/g8-g9-f8-f9-news-api.txt) | 41398 | `5fa6558b8fd65e6748fe225b255439844251688ea638c999bae62274cd7e920e` | 全バイト一致 |
| 貼り付けたテキスト（3）.txt | G5/F5 共通アカウント | [g5-f5-common-account.txt](rooms/g5-f5-common-account.txt) | 47668 | `6dbbf00af9c856d1d5408e2648c91edf5cae2d3114ef2aadc929600c7782b328` | 全バイト一致 |
| 貼り付けたテキスト（4）.txt | G7/F7 MIC | [g7-f7-mic.txt](rooms/g7-f7-mic.txt) | 43734 | `d47860c3896e80bc805039b66940b13d8c9803a2c454df15988cd8bbfc0a7791` | 全バイト一致 |
| 貼り付けたテキスト（5）.txt | G2/F2 市況/Push/X | [g2-f2-market-push-x.txt](rooms/g2-f2-market-push-x.txt) | 41836 | `5ed88df724a8940d482bf2d62d590d7ed078015715070a9ca6a0ea5a29b05e40` | 全バイト一致 |

## 保存・検証記録
- 原本保存commit: [`0c3d7ad112f356c8e7c6405ffe98975f0b2de43b`](https://github.com/anohi-memories/kabumori/commit/0c3d7ad112f356c8e7c6405ffe98975f0b2de43b)
- GitHub読み戻し検証日時: 2026-10-17T19:07:11+09:00（日本時間）
- 原本の出典: 会話「G1」`6ad0dba6-8454-83ee-8f8f-a4dd1a1dd5e7` に添付された5ファイル。元ファイル名と保存先の対応は上表のとおり。
- 合計: 5ファイル / 214,682 bytes。
- 保存方法: 元ファイルのバイト列をそのまま複写。改行、空白、前置き、コードフェンス、末尾を保持し、整形・要約・文字コード変換を行っていない。
- 検証方法: 上記commitをrefに指定してGitHub Contents APIから取得し、Base64を復号した実データを受領原本と直接比較。サイズ・SHA256・Git blob SHAも一致。存在確認だけで完了とはしていない。
- 再検証時は上記commitの各保存先を取得し、上表のサイズ・SHA256と照合する。原本は保存時点の記録として保持する。

## 保存完了の範囲
この完了判定は受領した5原本の保全に限る。原本内の実装・本番状態・未完了事項を今回あらためて検証したという意味ではない。本番操作、製品コード変更、既存archiveの変更は実施していない。

G1/F1の全体統括原本は受領5件には含まれないため、MASTER_HANDOFFを暫定統合版とする。UI/製品資産の完全棚卸しは未了。

矛盾時の優先順は現在の `PROJECT_RULES.md` / TASK/Report/ACTIVE_TASK/CURRENT_STATE/PR/本番read-only → 2026-10-17受領原本 → 要約。変更時は日付を残す。
