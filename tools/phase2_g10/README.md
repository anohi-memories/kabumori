# G10 Phase 2 実行係（偽Claudeのみ）

G10 Issue #323 の TASK `g10-phase2-runner-fake-claude-impl-20261021` の成果物。
仕様 v5 本体＋v5.1〜v5.4 差分（Mac上の `~/Library/Application Support/kabumori-agent-watch/phase2-spec/`、SHA256SUMS照合済み）を暫定基準として、
**実Claudeを呼ばずに**、実行係の source と偽Claude試験を実装した。

> この成果物の合格は「source実装候補・偽Claude検証」だけを意味する。実CLI試験・F0・無人稼働・production の GO ではない。
> 実Claudeの自動起動、専用macOSユーザー・ACL・sudoers・launchd・Keychain の変更は、行っていないし、コードにも経路がない。

## 実行方法
```
python3 tools/phase2_g10/run_tests.py        # 全テスト
python3 tools/phase2_g10/run_tests.py -v test_race_halt
```
- Python 3.9 の標準ライブラリだけを使う（macOS 標準の `/usr/bin/python3`。追加の依存なし）。
- 試験は `/tmp/g10t-*` に一時フォルダを作り、終了時に削除する。ネットワーク・GitHub・実Claudeには触れない。

## 構成（仕様との対応）
| ファイル | 内容 | 仕様 |
|---|---|---|
| `g10runner/norm.py` | NORM-1（`norm1_digest`＝低水準／`compute_hash`＝領域検査つき） | v5 §4、v5.1 §3 |
| `g10runner/meta.py` | 正式メタデータ領域・項目の分類・領域外の同名フィールドの拒否・節・関連PR・`migration_state` | v5 §3、v5.1 §4、v5.2 §2・§3 |
| `g10runner/jstclock.py` | 日次 04:00 JST の失効、時計の検査（参照時計・5分・逆行） | v5 §5-2・§5-3、v5.1 §6-2 |
| `g10runner/chainlog.py`・`logs.py` | 追記専用・`seq`・`prev_hash`・役割つき署名のログ（制御イベント／台帳／HALT_AGENT／used_requests） | v5 §8-1、v5.4 §1・§2-2 |
| `g10runner/signing.py` | 署名の境界（runner／human／agent）。**試験専用の HMAC のみ** | v5.3 §3 |
| `g10runner/state.py` | ログから状態を導く（HALT・UNHALT・STOP・ENVELOPE・CONFIRM）、処理済み番号と巻き戻りの検知、ENVELOPEの範囲 | v5.4 §1 |
| `g10runner/control.py` | 起動ゲート・CLAIM・署名つき起動要求・終了判定・REPORT・通知・HALT／UNHALT・照合・監督の途絶の検知 | v5 §5-4・§10、v5.2 §1-3、v5.4 §3・§4 |
| `g10runner/agent.py` | 起動要求の独立した検証・ACCEPTED の先行永続化・スタブの起動・HALT_AGENT・復旧 | v5.3 §2、v5.4 §2 |
| `g10runner/stub.py` | 起動トランザクション T2〜T9（共有ロック内で最終判定→SPAWNING→起動→`running`） | v5.1 §1-3、v5.2 §1-2、v5.4 §2-1 |
| `g10runner/supervise.py` | 停止（識別確認→SIGTERM→猶予→SIGKILL→不在確認）・S1・S2 | v5.1 §2、v5.2 §1-4 |
| `g10runner/registry.py` | プロセス登録簿（不変項目のダイジェスト・状態遷移） | v5 §7-1 |
| `g10runner/procs.py` | `ps` による観測・識別（ゾンビは不在とみなす） | v5.3 §5 |
| `g10runner/adapter.py` | **偽Claude専用**の実行アダプタ（実行ファイル固定・環境変数の許可リスト） | TASK 実行6 |
| `g10runner/report.py`・`notify.py` | ローカルREPORT（実行事実／自己申告の分離・GitHub用の下書き）・通知（失敗時も NEEDS_ATTENTION） | v5 §10-4・§10-5 |
| `g10runner/ifaces.py` | macOS依存部分のインターフェースとモック（隔離・認証・別UID・作業フォルダの準備） | v5.3 §1〜§5 |
| `fake_claude/fake_claude.py` | 偽Claude（結果JSONの形をまねる。ネットワーク・認証に触れない） | — |
| `bin/` | スタブ・S1・S2 の入口 | — |

## 主な設計判断（仕様の範囲内）
- **イベントの追記は、すべて `halt.lock` の排他ロックの下**（HALT・STOP・取消・承認・UNHALT）。起動スタブは共有ロックを、最終判定から起動の確定（登録簿の `running`）まで保持する（v5.4 の残課題）。
- **取消（ENVELOPE_REVOKE）・STOP の効力**は、イベントが排他ロックの下で fsync された時点から、それ以降に最終判定を行う起動に及ぶ。確定より前に起動が確定したランは、失効と同様に継続する（個別タイムアウト・緊急HALTは適用）。
- **ハードHALT**は、まず合図のフラグを置き（S1・S2 がこれを見て停止。ロックを持ったまま停滞したスタブも停止させる）、次に排他ロックの下でイベントを記録する。完了条件（非終了のランなし・識別子のプロセスなし・登録簿の整合）が満たされるまで、UNHALT は拒否される。
- **`used_requests` の ACCEPTED は、スタブの起動前に永続化**。`request_id`・`approval_id`・`run_id` のどれかが使用済みなら拒否（判定と記録は同じ追記ロックの下）。
- **ゾンビ（終了済みで親が未回収）は、不在とみなす**（停止確認の誤判定を避ける）。

## 実装していないもの・未検証（NOT_VERIFIED）
- 実Claude CLI の起動・Max認証・`--restricted`／`--tools` の実効性・modelUsage の実際の形式（実CLI試験は別TASK）。
- 実際の非対称署名（Ed25519／ECDSA と `openssl`）・人の鍵のパスフレーズ・鍵の保管（試験用 HMAC のみ）。
- 専用macOSユーザー・ACL・Seatbelt・launchd（KeepAlive）・別UID間の `flock`・別UIDのプロセスの `ps` 列挙・F0。
- GitHub からの Issue の取得と HTTP `Date` ヘッダ（呼び出し側が本文・メタ情報・参照時刻を渡す形。Phase 1 の取得コードとは未接続）。
- 作業フォルダの実際の `git` 取得（偽の作業フォルダのみ）。
- `needs_input` の判定（自己申告の `pending_questions:` 行による暫定の判定）。
- ログと処理済み番号を一緒に古い状態へ戻すことの検出（既知の限界。試験 `test_whole_log_and_seen_rolled_back_together_is_a_known_limit` で記録）。

## 仕様との食い違い（担当ちゃの確認が必要）
- 現在の #323 の本文は `related_pr: none`・`pinned_head: none` の書式だが、仕様 v5.2 §2-3 は「関連PRがない場合、`target_pr`／`pinned_head` は存在してはならない」。本実装は仕様どおり（`pinned_head: none` は拒否）。自動実行用のTASKの書式を、どちらに合わせるか確定が必要。
