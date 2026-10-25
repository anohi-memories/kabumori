# G10 Phase 2 実行係（偽Claudeのみ）

G10 Issue #323 の TASK `g10-phase2-runner-fake-claude-impl-20261021` の成果物。
H3 レビュー指摘 R1（P1）・R2（P1）・R3（P2）の修正は TASK `g10-phase2-pr423-h3-c3-p1x2-p2-source-fix-20261022`（下の「H3 レビュー修正」）。
H4 再レビュー指摘 P1×2・P2×1 の修正は TASK `g10-phase2-pr423-h4-c4-issue-binding-partial-ps-signal-20261022`（下の「H4 レビュー修正」）。
H3 第10TASK（C3）指摘 P1・P2 の修正は TASK `g10-phase2-pr423-h3-c3-identity-drift-nan-evidence-fix-20261022`（下の「H3 C3 レビュー修正」）。
Issue の鮮度・取消の起動直前安全契約は TASK `g10-phase2-pr423-issue-freshness-revoke-fake-gate-20261022`（下の「Issue の鮮度・取消の契約」）。
H4 C4 P2（遅延する再取得の後の HALT・期限の再判定）の修正は TASK `g10-phase2-pr423-h4-c4-delayed-fetch-halt-expiry-p2-fix-20261022`（同じ節の「再取得の後の再判定」）。
実行中の Issue の変化の検出は TASK `g10-phase2-pr423-running-issue-change-monitor-fake-20261023`（同じ節の「実行中の Issue 監督」）。
H2 C2 P2×2（監督スレッドの異常・正常時刻）の修正は TASK `g10-phase2-pr423-h2-c2-monitor-worker-stale-heartbeat-p2-fix-20261023`（同じ節の「監督スレッドの結果と正常時刻の契約」）。
ゲート1（実 GitHub の Issue #323 の読み取り専用取得元の候補）は TASK `g10-phase2-gate1-github-readonly-witness-candidate-20261023`（下の「ゲート1」）。
ゲート1追加（編集者の根拠・認証・回数の予算）は TASK `g10-phase2-gate1-editor-provenance-rate-budget-20261025`（下の「ゲート1追加」）。
H2 第9TASK の P2×2（provenance の項目の欠落・予算の同時の呼び出し）の修正は TASK `g10-phase2-gate1-editor-rate-p2-fix-20261025`（同じ節の末尾）。
監督付き初回自動起動の準備（G10 一枠）は TASK `g10-phase2-supervised-autostart-integration-prep-20261025`（下の「監督付き自動起動の準備」）。
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
| `g10runner/github_source.py` | ゲート1: 実 GitHub の Issue #323 の読み取り専用取得元（候補。既定は無効・起動経路に未結線） | TASK 10 |
| `g10runner/github_graphql.py`・`rate_budget.py` | ゲート1追加: 編集者の根拠（GraphQL・要認証）、回数の予算（見積もりと実行時の歯止め） | TASK 11 |
| `g10runner/shared_ledger.py`・`ecdsa_signing.py`・`launchd_plan.py`・`claude_cli_plan.py` | 監督付き自動起動の準備: 別プロセスの共有台帳、非対称署名（ECDSA P-256）、launchd の計画（dry-run）、実 Claude CLI の起動計画（dry-run・実行しない） | TASK 13 |
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

## H3 C3 レビュー修正（TASK 4・2026-10-22）
- **P1 既知のプロセスの識別の変化（identity_drift）**: 登録簿の子・スタブが**同じ pid・同じ開始時刻で生存**しているのに、
  argv・uid が一致しない、または照合できないときは、signal を送らない（pid だけでは止めない）うえで、
  「居ない」の根拠にもしない（`collector().drift()`）。`terminate` は drift が残る限り absent にせず、
  `run_processes_present` も drift を「居る」と数える。これにより stop_run・finalize（END の不在確認）・ハードHALT の解決・
  UNHALT の完了条件・S1/S2・クラッシュ復旧のすべてで stop_unconfirmed／HALT 維持になる。完了条件には
  `identity drift (known process alive, identity changed)` を出す。開始時刻が違う（本当に pid が再利用された別プロセス）・
  不在・ゾンビは drift にせず、signal も送らない。開始時刻は sysctl KERN_PROC_PID の p_starttime から読む
  （別uidのプロセスでも読めるため、uid の変化と pid の再利用を区別できる。同じuidなら libproc の値とも照合）。
- **P2 時刻・数値の有限性**: 署名・ハッシュ用の正規化JSON・ファイル・ログの書き込みは NaN／Infinity を拒否（`allow_nan=False`）、
  読み込み（`read_json`・ログ・偽Claudeの結果）も NaN／Infinity を拒否（`loads_strict`）。Issue 証拠の fetched_at・updated_at、
  検証時刻、`issue_evidence_max_age`、起動要求の時刻、参照時計・ローカル時計・ENVELOPE の失効時刻、ポリシーの時間・回数は、
  **有限の正の数**だけ許可（NaN・±Infinity・bool・欠損・文字列・0以下は fail-closed）。取得係も時計が非有限・0以下なら証拠を作らない。
- 試験: `tests/test_review_regressions_h3c3.py`（H3 C3 の反例。修正前HEAD 75a4bf92 で 4件すべて失敗）、`tests/test_drift_and_finite.py`。
  変異試験に 12件を追加（合計 59件）。

## Issue の鮮度・取消の契約（TASK 5・2026-10-22。偽Claude・模擬 Issue のみ）
CLAIM 時の証拠（最大 `issue_evidence_max_age`＝120秒前の写し）は、**起動時の最新性の証明として扱わない**。

1. **起動直前の再取得（必須）**: スタブは、共有ロックの下の最終判定の最後に、取得係から Issue #323 を再取得する
   （`purpose: spawn`、`nonce = spawn:<run_id>:<request_id>:<ACCEPTED の event_id>`＝事前に作れず、別の起動に使い回せない）。
   受理の条件: witness 署名・有効時間 `spawn_evidence_max_age`（10秒）・OPEN・作成者/編集者・本文の完全一致（生の SHA-256 と NORM-1）・
   ACCEPTED より後の取得・**CLAIM 時から世代（updated_at）と本文が変わっていない**こと。取得の失敗・打ち切り（`issue_fetch_timeout`＝5秒）・
   署名不正・古い時計は、すべて起動しない（`aborted_before_spawn`）。CLOSED・idle・review_required・本文の変更・同じ本文での世代の変更も起動しない
   （idle・review_required は本文の変更として現れる）。再取得の証拠は `runs/<run_id>/spawn_evidence.json` に残す。
2. **取消（ISSUE_REVOKE）**: 人またはランナー鍵の署名つきイベントを、制御ログに**排他ロックの下で**追記する（`Control.revoke_issue`）。
   対象は task_id（必須）と、任意で approval_id・task_sha256（指定が無ければその task_id 全体）。取消は解除しない（UNHALT でも消えない）。
   CLAIM・agent の受理・スタブの最終判定はいずれも取消済みのTASKを拒否し、起動後に取消されたランは S1（と S2）が `issue_revoked` で停止する。
3. **finalize の再照合**: 終了判定で Issue を再取得し（`purpose: postflight`）、OPEN・本文・世代が CLAIM 時と同じことを確かめる。
   **CLOSED だけ（本文は不変）の変更もここで検出**し、安全違反として HALT・通知する。取得できない・検証できないものも成功にしない。
   取消されたランの結果は成功にしない（`issue_not_revoked: false`）。

**再取得の後の再判定（TASK 6・H4 C4 P2）**: 起動直前の再取得は最大 `issue_fetch_timeout` 秒かかるため、最終判定は
停止（HALT／STOP のログとフラグ）・要求の期限・認可（CONFIRM／ENVELOPE と失効）・取消・受理状態の判定（`stub._local_gate`）を、
再取得の**前と後の2回**行う。再取得の間に HALT・STOP のフラグが立つ（HALT・STOP はフラグを先に書いてから排他ロックを待つ）、
または要求の期限が過ぎた場合は、SPAWNING・起動へ進まない（`aborted_by_halt`／`aborted_before_spawn`）。
2回目の判定から実際の起動（Popen）までのごく短い間に立ったフラグは、起動の後に S1/S2 が止める（ハードHALT）。

**実行中の Issue 監督（TASK 7）**: running 中のランについて、S1 が `issue_monitor_interval`（既定5秒。試験は0.3〜0.5秒）ごとに
Issue #323 を再取得し（`purpose: monitor`、毎回ちがう nonce）、OPEN・本文・世代（updated_at）が CLAIM 時と同じことを照合する。
CLOSED（本文は不変でも）・idle・review_required・本文だけの変更・世代だけの変更・取得の失敗・打ち切り・署名不正・要求が読めない、の
いずれでも「変更なし」とはみなさず、まず HALT（HALT_AGENT `issue_changed_while_running`）を記録してからランを止める
（`stop_reason: issue_changed_while_running`。識別の照合・drift の扱いは従来どおりで、止められなければ stop_unconfirmed）。
照合の結果は毎回 `runs/<run_id>/issue_monitor.jsonl` に監査記録として残し、finalize の通知には停止の理由を載せる。
- 再取得は S1 の**別スレッド**で行うので、取得の遅れ（最大 `issue_fetch_timeout`）の間も、S1 の HALT・取消（ISSUE_REVOKE は毎周期・
  再取得より優先）・期限の確認は止まらない。打ち切り時間＋間隔を過ぎても戻らない取得は失敗として扱う。
- S2 は、S1 の最後の正常な照合（reaper の heartbeat の `issue_ok_at`）が「間隔×3＋打ち切り時間」より古いときだけ、自分で照合する（予備）。
- **監督スレッドの結果と正常時刻の契約（TASK 8）**: スレッドの結果は「未完了／成功（取得時刻）／失敗（理由）」で区別する。
  取得係の生成（鍵が読めない等）・取得・署名照合・監査のどこで例外が起きても、例外の型名だけの決まった理由
  （例: `issue witness unavailable: ValueError`）で**失敗**にし、例外の本文は記録しない。例外で終わった・結果を残さずに終わったスレッドも失敗。
  失敗では `issue_ok_at` を更新しない。成功の `issue_ok_at` は**証拠の取得時刻**で、親（S1）が受け取った時刻ではない（後戻りもしない）。
  受け取りが遅れて `spawn_evidence_max_age`（10秒）より古くなった成功は「新しい照合」として公表せず、すぐ取り直す。
  したがって S1 が遅れ・停止しても、S2 は `issue_ok_at` の古さで気づいて自分で照合する（S2 の照合も例外を投げない）。
- **誤停止の扱い**: 取得の一時的な失敗でも止めて HALT にする（安全側）。人が Issue と監査記録を確認し、問題が無ければ UNHALT して、
  必要なら担当ちゃが TASK を出し直す。
- **残るリスク**: Issue の変化から停止までは、最大で「監督の間隔＋取得時間＋停止時間（猶予20秒＋確認10秒）」かかる。
  GitHub の変化と監督の照合は原子的ではない。実際の GitHub の API の回数制限（間隔5秒なら1ランあたり毎時720回）は未検証。

**線形化点**: 起動の可否は「スタブが共有ロックを保持して行う最終判定（取消イベントの確認と起動直前の再取得）」で決まる。
取消（排他ロック）は、それより前なら起動しない、後なら起動の確定の後になり S1/S2 が止める（どちらの順序も試験で確認）。

**残るリスク（隠さない）**:
- GitHub と OS の起動は原子的にできない。起動直前の再取得から実際の起動（数ミリ秒〜）までの間の Issue の変化は、起動前には止められない
  （その後の S1/S2 の取消確認・finalize の再照合で事後に止める・検出する）。
- 再取得はロックの中で行うため、取得の遅れ（最大5秒）の間、HALT・取消の追記が待たされる（ハードHALT はフラグで S1/S2 がスタブも止める）。
- 起動後の取消は、S1 の確認間隔（既定1秒）までは走り続ける。Issue 側の CLOSED・変更（取消イベントを伴わないもの）は、TASK 7 から実行中の監督で検出する（間隔は上記）。
- 取得係・witness 鍵・模擬の Issue はすべて試験用。実際の GitHub 取得・HTTP 参照時刻・編集者の判定・鍵の権限分離は未実装（次段階のゲート）。

**人が止める手順**（模擬の範囲）: 特定のTASKを止める → `Control.revoke_issue(task_id, approval_id=..., reason=...)`（起動前なら起動しない、
起動後なら S1/S2 が止める）。すべてを止める → ハードHALT（`Control.halt("hard", ...)`）。S1/S2 が両方止まっている場合は、
手順書の最終手段（プロセスの手動停止）に従う。

## ゲート1: 実 GitHub の読み取り専用取得元（TASK 10・2026-10-23。候補・未結線）
- `g10runner/github_source.py` の `GitHubIssueSource`。`FileIssueSource` と同じ `fetch(timeout)` の契約で、`IssueWitness` の取得元になれる。
  **既定は無効**（`enabled=False`）で、`spawn_witness`・S1/S2 の監督には**結線していない**（起動経路は従来どおり偽Claude・模擬 Issue のみ）。
- 取得するのは `https://api.github.com/repos/anohi-memories/kabumori/issues/323` の HTTPS GET だけ。GET 以外・他ホスト・他リポジトリ・他の番号・
  リダイレクト・別 URL からの応答は拒否。HTTP 200 以外・JSON の不正（NaN を含む）・部分応答・打ち切り・接続失敗・回数制限の残り0・
  Date ヘッダの欠落・ローカル時刻との5分超のずれは、すべて取得失敗（例外の本文は理由に出さない）。
- 認証: リポジトリは公開なので、既定は**認証なし**（token を一切使わない）。環境変数・gh の認証情報は読まない。token を渡す場合は、
  classic token の `X-OAuth-Scopes` が空（公開情報の読み取りのみ）のときだけ受け付け、scope の見えない fine-grained token は拒否。
- **最後の編集者は REST では取れない**（GraphQL の `editor`／`userContentEdits` は認証が必須）。そのため編集者は `UNKNOWN_EDITOR` とし、
  証拠の検査（editor は None か信頼済みのみ）で**必ず拒否**される。つまり、この取得元だけでは起動できない（fail-closed）。
  編集者を確かめるには、読み取り専用の認証で GraphQL を使う設計の追加と、その認証の決定が必要（次の判断）。
- 回数制限: 認証なしは1時間60回。監督間隔5秒（1ランあたり毎時720回）では足りない。認証ありでも間隔の正式値は別途決める。
- 限定ライブ取得（2026-10-23）: 認証なしの GET 2回で、本文の SHA-256・state・作成者・updated_at が gh での読み取りと一致。
  編集者は不明となり、証拠は拒否された（想定どおり）。

## ゲート1追加: 編集者の根拠・認証・回数の予算（TASK 11・2026-10-25。候補・未結線）
- **編集者の根拠**（`github_graphql.py`）: REST に編集者は無いので、GraphQL の `editor`・`lastEditedAt`・`userContentEdits` を使う。
  送るのは変数の無い固定の読み取り問い合わせ1つ（`FIXED_QUERY`。mutation なし）だけ。`determine_editor` は、
  未編集（履歴0件・lastEditedAt と editor が null）なら None、編集ありなら「履歴が欠けていない（100件以内で件数一致）・
  すべての編集が信頼済み・削除された版が無い・Issue の editor が信頼済み・lastEditedAt が履歴の最新と一致」のときだけ
  信頼済みのアカウント。それ以外は `UNKNOWN_EDITOR` で、証拠は必ず拒否される。編集履歴の完全性は GitHub の仕様に依存（NOT_VERIFIED）。
- **認証の最小権限と事前確認**: 認証なし（既定）以外は、classic の個人用 token（`ghp_`＋36文字）で scope が空のものだけ。
  1. 送信の前に形を判定（gh CLI の OAuth token `gho_`・fine-grained `github_pat_`・App の token などは、1回も送らずに拒否）
  2. `verify_token` で、データを返さない `GET /rate_limit` に1回だけ送り、`X-OAuth-Scopes` が空であることを確認（確認前は取得しない）
  3. 取得のたびに応答の scope を再確認
  scope を「送る前に」証明する方法は GitHub に無いため、確認の送信は副作用の無い GET の1回だけに限る。
  運用の設計案（未実施）: token は scope なし・有効期限つき（例: 30〜90日）で作り、Keychain など主ユーザー以外が読めない所に置き、
  期限の前に作り直す（ローテーション）。作成・保管・ローテーションの実施は、ユーザーの承認と別TASKが必要。
- **回数の予算**（`rate_budget.py`）: 1時間あたりの最悪の消費＝同時実行数×（S1 3600/監督間隔＋S2 3600/S2の周期）
  ＋1ランごとの固定3回（CLAIM・起動直前・finalize）×1時間の最大起動数。上限×0.5 を超える設定は不可（`check`）。
  既定の設定（10分に10回まで起動＝固定だけで毎時180回）では、**認証なし（毎時60回）はどの間隔でも不可**。
  認証あり（毎時5000回／5000点）なら、監督間隔30秒・S2 30秒で REST 420回／GraphQL 840点（推奨の候補）。
  実行時の `RateBudget` は、直近1時間の送信数・サーバの残り回数（Reset まで）・Retry-After を見て、超えそうなら送らない
  （`RateLimited`。自動の再試行はしない）。REST は ETag の条件付き取得に対応（304 なら前回の内容を使う。
  **認証なしの 304 も回数に数えられることを実測**）。スケジューラ（S1/S2・起動）には結線していない。
- **TASK 12（H2 R1・R2 の修正）**:
  - 編集者の根拠: 固定の問い合わせで要求した項目（editor・lastEditedAt・includesCreatedEdit・userContentEdits、各版の
    editedAt・deletedAt・editor）は、まず**あること**と型を確かめる。項目が無いのを null（未編集・未削除）と同じに扱わない。
    includesCreatedEdit が true なのに履歴が0件・1件の矛盾は不明にする（true なら作成時の版＋編集で2件以上のはず）。
  - 予算: `RateBudget` の古い記録の切り捨て・判定・枠の予約と、observe／block を1つのロックの下で一体に行う
    （同じ予算を共有するスレッドが、残り1枠を同時に取らない）。別プロセスでの共有（共有の台帳）は対象外で、結線のときの別設計。

## 監督付き自動起動の準備（TASK 13・2026-10-25。G10 一枠。すべて未結線・dry-run）
### 1. 編集者の証拠・本文の一致・実際の回数の検証計画（token が安全に提供されたときに実施。今回は未実施）
1. token の条件: classic の個人用 token、scope なし（公開情報の読み取りのみ）、有効期限つき（30〜90日）。作成・保管（主ユーザー以外が
   読めない所）・ローテーションはユーザーの操作。既存の広い権限の token（gh の `gho_` 等）は使わない。fine-grained は scope を確かめられないので不可。
2. 事前確認: `verify_token`（`GET /rate_limit` 1回）で `X-OAuth-Scopes` が空であることを確認してから先へ進む。
3. GraphQL の実機確認: 固定の問い合わせで、未編集・編集ありそれぞれの Issue について `determine_editor` の判定が期待どおりか、
   編集履歴の件数と lastEditedAt が一致するかを確認する。
4. 本文の一致: 同じ時刻の REST の本文と GraphQL の本文の SHA-256 が一致することを確認する（改行の扱いを含む）。
5. 実際の点数: 応答の `X-RateLimit-Remaining`（resource: graphql）の減り方から、1回あたりの点数を実測する（見込み1点、見積もりは2点）。
6. 二次制限: 短時間の連続取得はしない（監督間隔の候補30秒）。429・403 は RateLimited で、自動の再試行なし。
### 2. 監督間隔と、主体ごとの共有の予算
- GitHub の主な回数制限は**ユーザーごと**。同じユーザーの Phase 1 の監視（gh の GraphQL、2分ごと＝毎時30回）と G10 の取得係は
  同じ枠を分け合う前提で数える（`rate_budget.principal_check`）。
- 単一プロセスの監督間隔の候補は30秒（認証あり・GraphQL で毎時840点＋Phase 1 の30＝870、上限5000×0.5 の内側）。正式な値は別判断。
- 別プロセス（制御側・S1・S2）で同じ主体の使用量を共有する台帳 `shared_ledger.SharedRateLedger` を用意した（ファイル＋排他の flock。
  読み・判定・予約・書き込みを一体に行う。壊れた台帳・ロックを取れないときは送らない）。結線は実通信の安全ゲートの後の別TASK。
### 3. 信頼の境界と非対称署名
- 監督する側（制御側＝runner 鍵・取得係＝witness 鍵・人＝human 鍵）と、実行する側（専用ユーザーのスタブ・S1・S2＝agent 鍵、
  Claude CLI は鍵を持たない）を分ける。各秘密鍵はその役割のプロセスだけが持ち、検証する側は公開鍵だけを持つ。
- この Mac の openssl（LibreSSL 3.3.6）は **Ed25519 に未対応**（確認済み）なので、ECDSA P-256・SHA-256（`ecdsa_signing.py`）を使う。
  秘密鍵は 0600・所有者のみ、検証器は公開鍵だけを受け付ける。現在の起動は試験用 HMAC のまま（未結線）。
  人の鍵のパスフレーズ・鍵の保管（Keychain 等）・ローテーションは未実装。
### 4. 専用 macOS ユーザー・ACL・launchd・停止の方法（設計と dry-run のみ。実際の変更は禁止）
- 専用ユーザー（名前は `_g10` で始まる）で、S2 の見張り役を LaunchDaemon（KeepAlive・RunAtLoad・Umask 077・環境変数は PATH と LANG のみ）
  として動かす。`launchd_plan.watchdog_daemon_plan`／`validate_plan` が規則を確かめ、`plutil -lint` で形式を検査する（インストールはしない）。
- 主ユーザーのホームへの拒否 ACL、専用ユーザーの作成、Claude CLI の配置は F0 手順書（phase2-spec/PHASE2_F0_PROCEDURE_DRAFT.md）のとおり。
- 停止の方法（人が実行）: `sudo launchctl bootout system/com.kabumori.g10.phase2.watchdog` → `launchctl print` で見つからないことを確認。
  監督が止まっている場合は、ハードHALT のうえ手順書の最終手段（プロセスの手動停止）。
- 別uid のプロセスの argv は同じuid でないと読めない（unknown として安全側）。監督をどの uid で動かすかは F0 で決める。
### 5. Claude CLI（読み取りだけの調査。CLI は一度も実行していない）
- 場所: `~/.local/bin/claude` → 実体 `~/.local/share/claude/versions/2.1.305`（版はパスからの推定。未実行のため未確認）。
- `claude_cli_plan.build_plan` は、起動するなら使う argv（`-p --output-format json --model --session-id --settings --max-turns`）・
  環境変数（PATH・LANG・HOME のみ。`ANTHROPIC_API_KEY` 等は渡さない＝Max の範囲）・標準入力（TASK 本文。argv に入れない）を返すだけで、
  実行しない。フラグの受け付け・modelUsage の形・予算の上限の効き方・Max の利用条件は**実機で未検証**。
- 実行部分（`adapter.get_adapter`）は、引き続き偽Claude 以外を拒否する。
### 6. G10 一枠のオフライン E2E（`tests/test_g10_offline_e2e.py`）
承認済み TASK の受付 → 取得係の証拠 → CLAIM → 受理 → 起動直前の再取得 → 偽Claude の起動 → 実行中の監督 → 終了判定 → REPORT の下書き、
および「起動直前に TASK が古くなった」「実行中の取消」「二重起動・再送」「時間切れ」「自己申告の秘密情報の伏せ字」を、模擬 Issue と偽Claude で確認。
### 7. 実 Claude の初回起動の前提（すべて未了）と、人が確認する GO チェックリスト
前提（各項目に独立レビューの PASS とユーザーの承認が必要）:
1. 読み取り専用 token の用意と、上の検証計画 1〜6 の実施（編集者の根拠・本文の一致・点数）
2. 取得元（GraphQL）と共有台帳を、起動直前・実行中の監督・finalize に結線する別TASK
3. 非対称署名への切り替えと鍵の配置（runner・witness・human・agent を分離）
4. F0（専用ユーザー・ACL・Claude CLI の配置・専用ユーザーでのログイン・F0a／F0b の極小の実行）
5. 実 Claude のアダプタ（明示の設定でのみ有効）と、modelUsage・予算・停止の実機確認
GO チェックリスト（初回の監督付き起動の直前に、人が1つずつ確認する）:
- [ ] PR の HEAD・main・Issue #323 の TASK（ready・readonly_trial・task_id・承認ID）を読み返した
- [ ] ENVELOPE または CONFIRM が今日の分として有効（04:00 JST の失効前）
- [ ] HALT・STOP が解除されていて、Phase 1 の監視が正常
- [ ] S2 の見張り役が動いている（ハートビートが新しい）。止め方（bootout とハードHALT）を手元に用意した
- [ ] 取得係の token は scope なしで確認済み（verify_token）。主体の予算に余裕がある
- [ ] 実行する TASK は readonly_trial・同時1・短い上限時間・小さな予算
- [ ] 実行中は人が見ていて、異常があればすぐハードHALT・ISSUE_REVOKE できる
- [ ] 終了後、ローカルの REPORT の下書き・作業フォルダに変更が無いこと・実使用モデルを確認してから、担当ちゃに渡す

## 実装していないもの・未検証（NOT_VERIFIED）
- 実Claude CLI の起動・Max認証・`--restricted`／`--tools` の実効性・modelUsage の実際の形式（実CLI試験は別TASK）。
- 実際の非対称署名（Ed25519／ECDSA と `openssl`）・人の鍵のパスフレーズ・鍵の保管（試験用 HMAC のみ）。
- 専用macOSユーザー・ACL・Seatbelt・launchd（KeepAlive）・別UID間の `flock`・別UIDのプロセスの `ps` 列挙・F0。
- GitHub からの Issue の取得と HTTP `Date` ヘッダ（呼び出し側が本文・メタ情報・参照時刻を渡す形。Phase 1 の取得コードとは未接続）。
- 作業フォルダの実際の `git` 取得（偽の作業フォルダのみ）。
- `needs_input` の判定（自己申告の `pending_questions:` 行による暫定の判定）。
- Issue の取得: 実際の GitHub からの取得（gh／API・HTTP Date・編集者の取得方法）は未実装。取得元は差し替え可能なインターフェースで、試験は模擬（`FileIssueSource`／`MockIssueSource`）。起動直前の再取得（スタブ側）も、偽Claudeのアダプタのときだけ試験用の模擬と試験用の witness 鍵で行う（それ以外では取得係が無く、起動しない）。witness の鍵も試験用 HMAC。**witness 鍵を持つ者は任意の本文を「取得した」と署名できる**ため、実運用では取得係を runner と別の権限（別uid・別鍵）に置く必要がある（未実装）。
- Issue の鮮度: 上の「Issue の鮮度・取消の契約」を参照（再取得から起動までの短い窓は残る）。
- 照合と signal の間のごく短い時間の pid 再利用・exec は防げない（pidfd 相当が無い macOS の限界。照合はカーネルと sysctl だけで行い、外部コマンドを挟まない）。
- カーネル一覧と ps の**両方**が同じプロセスを欠き、かつ登録簿に無い子孫（逃げた孫など）は見つけられない（両経路の同時の偽装が必要）。
- 権限: **argv は同じuidのプロセスだけ**読める（別uidの argv は読めず、unknown として扱う。試験で確認）。**開始時刻は別uidのプロセスでも** sysctl KERN_PROC_PID の p_starttime で読める（同じuidなら libproc の値とも照合）。専用macOSユーザー（別uid）で実行する設計では、argv を読むための監督側の権限が別途必要（未検証）。
- binding の model→model_id 照合は `meta.validate_task` の照合と二重（片方だけを壊す変異は検出されないため、変異試験の対象外）。
- 変異試験の「検出」は、assert の失敗（AssertionError／FAIL）で落ちたときだけ数える（例外・起動不能だけで落ちたものは error-only として失敗にする。TASK 5 で厳しくした）。
- ログと処理済み番号を一緒に古い状態へ戻すことの検出（既知の限界。試験 `test_whole_log_and_seen_rolled_back_together_is_a_known_limit` で記録）。

## 仕様との食い違い（担当ちゃの確認が必要）
- 現在の #323 の本文は `related_pr: none`・`pinned_head: none` の書式だが、仕様 v5.2 §2-3 は「関連PRがない場合、`target_pr`／`pinned_head` は存在してはならない」。本実装は仕様どおり（`pinned_head: none` は拒否）。自動実行用のTASKの書式を、どちらに合わせるか確定が必要。
