# G10 Phase 2 実行係（偽Claudeのみ）

G10 Issue #323 の TASK `g10-phase2-runner-fake-claude-impl-20261021` の成果物。
H3 レビュー指摘 R1（P1）・R2（P1）・R3（P2）の修正は TASK `g10-phase2-pr423-h3-c3-p1x2-p2-source-fix-20261022`（下の「H3 レビュー修正」）。
H4 再レビュー指摘 P1×2・P2×1 の修正は TASK `g10-phase2-pr423-h4-c4-issue-binding-partial-ps-signal-20261022`（下の「H4 レビュー修正」）。
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
| `g10runner/procs.py` | 観測（`ps` の失敗は `ObservationError`＝unknown）・正確な識別（sysctl の argv・settings・uid・開始時刻）・開始時刻を再照合してからの signal（ゾンビは不在とみなす） | v5.3 §5、H3 R2・R3 |
| `g10runner/issue.py` | Issue #323 の取得証拠（取得係＝witness 鍵の署名）と、要求の本文との結合の検証 | v5 §5-4、H4 P1 |
| `g10runner/binding.py` | 起動要求と承認済みTASK・ポリシーの結合（本文の再ハッシュ・実行項目の照合・型・形式・期限） | v5.3 §2-3、H3 R1 |
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

## H3 レビュー修正（TASK 2・2026-10-22）
- **R1 起動要求の結合**: 実行側（agent の受理前・スタブの開始時・臨界区間の最終判定）が、要求の `prompt` を自分で再検証・再ハッシュし、
  `task_sha256`・正式メタデータ・ポリシーの model→model_id と、要求の実行項目（承認ID・task_id・model・model_id・effort・時間・予算・基点・範囲・本番権限・REPORT方式）が
  すべて一致することを確認する（`binding.check_request`）。runner の鍵だけで内容を変えたり広げたりした要求は、ACCEPTED・ファイル書き込み・起動の前に拒否。
  `run_id`／`request_id`／`session_id` は形式を固定し、パスは `layout._contained` で基点フォルダの直下に限る（絶対パス・`..`・シンボリックリンクの逸脱を拒否）。
  CLAIM に実行項目を記録し、`finalize` は要求の自己申告ではなく CLAIM（承認済み内容）とポリシーを基準に照合する（モデル照合も CLAIM の model_id）。
- **R2 観測の失敗は「不在」ではない**: `ps` の失敗・非0終了・時間切れ・解析できない行・自分自身が載っていない一覧は `ObservationError`。
  停止は unknown なら `stop_unconfirmed`＋HALT_AGENT で HALT を維持し、`finalize`・UNHALT の完了条件・監督の途絶の検知・復旧も、unknown を成功扱いにしない。
  完了条件は、実行側の停止記録（supervisor.log の absent）と制御側の独立観測が食い違えば、それも問題として数える。
- **R3 正確な識別**: 部分文字列ではなく、sysctl `KERN_PROCARGS2` の argv の `--session-id` の値が完全一致・`--settings` が1つで正規化パスが一致・uid が一致するものだけを対象にする。
  起動スタブは pid・開始時刻・uid・`--run-id`・`--root` が一致したときだけ対象にし、親（スタブ）を先頭にして止める。
  signal の直前に開始時刻を再照合し、一致しないもの（pid の再利用）には送らない。開始時刻の記録がないものは本人と認めない。
- 試験: 修正前のコードで再現試験 9件を実行し、16件（subTest 単位）が失敗することを確認してから修正（`tests/test_review_regressions.py`）。
  単体試験 `tests/test_procs_identity.py`、変異試験に H3 用 15件を追加（合計 32件）。

## H4 レビュー修正（TASK 3・2026-10-22）
- **P1 Issue #323 との結合**: 取得係（`issue.IssueWitness`）が Issue #323 を新しく取得し、runner とは別の witness 鍵で
  本文の SHA-256・state・作成者・編集者・更新時刻・取得時刻に署名する。制御側は CLAIM の前にこの証拠を取得して照合し
  （取得失敗・本文不一致・CLOSED・別Issue・信頼できない作成者/編集者は起動しない）、要求に同梱する。CLAIM には証拠のダイジェストを記録。
  実行側（agent の受理前・スタブの開始時・臨界区間の最終判定）は、証拠の署名・鮮度（`issue_evidence_max_age`、既定 120秒）と、
  要求の prompt が証拠の本文と**完全に同じ**（生の SHA-256 と NORM-1 の両方）であることを検証する。TASK側の status: ready・slot・owner は
  本文そのものの検証（meta）で確かめる。runner 鍵だけでは Issue に無いTASK・古い本文を受理させられない。CONFIRM・ENVELOPE の両方で必須。
- **P1 部分観測**: プロセス一覧は、カーネル（libproc）と `/bin/ps` の**和集合**。どちらかの失敗・自分自身を欠く一覧は unknown。
  ps の文字列は識別に使わず、同uidの全プロセスを sysctl の argv で照合する。さらに登録簿の子（pid・開始時刻）を一覧とは独立に直接確認する。
  生存・ゾンビ・uid・開始時刻（マイクロ秒）はカーネルから読み、kill(0) と食い違う状態が続けば unknown（終了処理中の一瞬は短く待つ。
  ゾンビは sysctl の p_stat で確認）。
- **P2 signal 直前の再照合**: `terminate` は collector の `.verify(pid, 開始時刻)` を必須とし、各 pid に送る直前に uid・開始時刻・完全な argv
  （ランの識別子、またはスタブの識別子）を照合して、一致したときだけ送る。照合できなければ送らず unknown、一致しなければ skipped。
- 試験: `tests/test_review_regressions_h4.py`（H4 の反例。修正前HEAD fa1967e8 で 4件すべて失敗）、`tests/test_issue_binding.py`、
  `tests/test_observation_h4.py`。変異試験に H4 用 15件を追加（合計 47件）。

## 実装していないもの・未検証（NOT_VERIFIED）
- 実Claude CLI の起動・Max認証・`--restricted`／`--tools` の実効性・modelUsage の実際の形式（実CLI試験は別TASK）。
- 実際の非対称署名（Ed25519／ECDSA と `openssl`）・人の鍵のパスフレーズ・鍵の保管（試験用 HMAC のみ）。
- 専用macOSユーザー・ACL・Seatbelt・launchd（KeepAlive）・別UID間の `flock`・別UIDのプロセスの `ps` 列挙・F0。
- GitHub からの Issue の取得と HTTP `Date` ヘッダ（呼び出し側が本文・メタ情報・参照時刻を渡す形。Phase 1 の取得コードとは未接続）。
- 作業フォルダの実際の `git` 取得（偽の作業フォルダのみ）。
- `needs_input` の判定（自己申告の `pending_questions:` 行による暫定の判定）。
- Issue の取得: 実際の GitHub からの取得（gh／API・HTTP Date・編集者の取得方法）は未実装。取得元は差し替え可能なインターフェースで、試験は模擬（MockIssueSource）。witness の鍵も試験用 HMAC。**witness 鍵を持つ者は任意の本文を「取得した」と署名できる**ため、実運用では取得係を runner と別の権限（別uid・別鍵）に置く必要がある（未実装）。
- Issue の証拠は取得から最大 `issue_evidence_max_age` 秒有効。その間に Issue が書き換わっても、起動は止まらない（finalize の本文照合で事後に検出し HALT）。
- 照合と signal の間のごく短い時間の pid 再利用・exec は防げない（pidfd 相当が無い macOS の限界。照合はカーネルと sysctl だけで行い、外部コマンドを挟まない）。
- カーネル一覧と ps の**両方**が同じプロセスを欠き、かつ登録簿に無い子孫（逃げた孫など）は見つけられない（両経路の同時の偽装が必要）。
- argv・開始時刻の取得は同じuidのプロセスだけで可能。別uidのプロセスの argv は読めない（試験で確認: 読めないものは unknown）。専用macOSユーザー（別uid）で実行する設計では、監督側の権限が別途必要（未検証）。
- binding の model→model_id 照合は `meta.validate_task` の照合と二重（片方だけを壊す変異は検出されないため、変異試験の対象外）。
- ログと処理済み番号を一緒に古い状態へ戻すことの検出（既知の限界。試験 `test_whole_log_and_seen_rolled_back_together_is_a_known_limit` で記録）。

## 仕様との食い違い（担当ちゃの確認が必要）
- 現在の #323 の本文は `related_pr: none`・`pinned_head: none` の書式だが、仕様 v5.2 §2-3 は「関連PRがない場合、`target_pr`／`pinned_head` は存在してはならない」。本実装は仕様どおり（`pinned_head: none` は拒否）。自動実行用のTASKの書式を、どちらに合わせるか確定が必要。
