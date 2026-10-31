# 専用ユーザー方式 — 一度きりの特権 setup 手順（GO ゲート付き）

目的：非特権の実装（受け口 handoff / 常駐ループ resident / dispatch / 結果受け渡し result_handoff、すべて代役で E2E 済み）を、実機で動かすための**一度きりの特権作業**を、安全に、段ごとにユーザーの GO を取りながら行う。

---
## 大事な前提（安全）
- これらのコマンドは **あなたが自分のターミナルで実行** する。クロちゃん（私）は特権操作・ログイン・chmod・launchctl を実行しない（このアプリの Run ボタンでも実行しない）。
- `sudo` は使わない。**sudoers は変更しない。_kaburun は非管理者のまま。** 必要なのは「自分のホーム／自分が作るフォルダ」への操作と、`launchctl bootstrap gui/503`（_kaburun 自身のセッションで）だけ。
- 各段の「▶GO」は、その段を実行してよいかの確認。**実行は1段ずつ。** 実行したら「検証」で結果を貼ってくれれば次へ進む。
- トークンの新規発行・スコープ変更・Keychain への秘密の保存はしない。秘密は画面に出さない。
- 既存の常駐（pid 92088 / 92090、f998feb5 + policy-v2）はこの手順では触らない。

## すでに済んでいること
- _kaburun 作成済み（UniqueID 503・home /Users/_kaburun・admin ではない）。
- ゲートで _kaburun のログインキーチェーンに Claude トークンが入り、背景エージェントから取れることを実測済み。
- CLI は 2.1.305（yuya: /Users/yuya/.local/share/claude/versions/2.1.305）。

---
# Part A — いま実行できる段（新しいコード不要・各 GO 必要）

## A1. _kaburun 専用の固定版 CLI を置く ▶GO（_kaburun のセッションで実行）
目的：_kaburun が yuya のツリーに依存しない自分の CLI を持つ（後で /Users/yuya を 0700 にしても動くように）。
`cli_realpath` の**ファイル名は版（2.1.305）と一致**している必要がある（go の検査）。

_kaburun にファストユーザースイッチでログインし、_kaburun のターミナルで:

```
mkdir -p ~/clirun && cp -R /Users/yuya/.local/share/claude/versions/2.1.305 ~/clirun/2.1.305 && chmod -R u+rwX,go-w ~/clirun
```

検証（版が出ればよい。これは `--version` の表示だけでモデルは呼ばない）:

```
~/clirun/2.1.305 --version
```

→ 固定版のパスは `/Users/_kaburun/clirun/2.1.305`（go の `cli_realpath`・`home` は `/Users/_kaburun`）。
（代替：ネットワークが使えるなら _kaburun 自身で公式インストールしてもよい。ログインは済んでいるので、どちらでも認証は維持される。）

## A2. _kaburun のログインを確認／必要なら再ログイン ▶GO（_kaburun のセッションで実行）
```
~/clirun/2.1.305 auth status --json
```

→ `"loggedIn": true` を確認（メール等は貼らないでよい。true/false だけで十分）。false なら:

```
~/clirun/2.1.305 auth login
```

（あなたの Anthropic アカウントで対話ログイン。終わったらもう一度 auth status で true を確認。）
再起動後はログインキーチェーンが閉じるので、_kaburun に再ログイン（ファストユーザースイッチ）が必要。

## A3. ACL（向きを固定した）受け渡しフォルダを作る ▶GO（2つのセッションで実行）
置き場：両ユーザーが通れる共有の場所 `/Users/Shared`（sticky 1777）。向きを保つため、**所有者ごとに別の親**にする
（共有の親を片方が所有すると、もう片方がその中に作れない／触れてしまうため）。
- in・flags は **yuya 所有**の `/Users/Shared/g10-handoff/` の下（yuya=書き・_kaburun=読み）。
- out・claims は **_kaburun 所有**の `/Users/Shared/g10-kaburun/` の下（_kaburun=書き・yuya=読み）。
POSIX 0755＋所有者だけ書き込みで向きは成立（group/other は書けない＝コードの安全確認も通る）。sticky なので互いの親は触れない。

まず **yuya のセッション**で:

```
mkdir -p /Users/Shared/g10-handoff/in /Users/Shared/g10-handoff/flags && chmod 0755 /Users/Shared/g10-handoff /Users/Shared/g10-handoff/in /Users/Shared/g10-handoff/flags
```

次に **_kaburun のセッション**で:

```
mkdir -p /Users/Shared/g10-kaburun/out /Users/Shared/g10-kaburun/claims && chmod 0755 /Users/Shared/g10-kaburun /Users/Shared/g10-kaburun/out && chmod 0700 /Users/Shared/g10-kaburun/claims
```

検証（in/flags=yuya、out/claims=_kaburun、どれも group/other に w が無いこと）:

```
ls -lde /Users/Shared/g10-handoff/in /Users/Shared/g10-handoff/flags /Users/Shared/g10-kaburun/out /Users/Shared/g10-kaburun/claims
```

→ 以後のパス: in=`/Users/Shared/g10-handoff/in`、flags=`/Users/Shared/g10-handoff/flags`、
out=`/Users/Shared/g10-kaburun/out`、claims=`/Users/Shared/g10-kaburun/claims`。
（2026-10-31 に Part A を実機で実行・検証済み: 固定版CLI /Users/_kaburun/clirun/2.1.305・loggedIn true・上記4フォルダ作成。）

---
# Part B — 実機結線に、先に必要な小さなコード（非特権・私が次に作る）

Part B の「LaunchAgent 登録」より前に、**常駐ループの起動スクリプトと plist 生成が未実装**。登録対象の実体が要る。
次の非特権コードを私が作る（別TASK・特権なし）:

- B0-1.（実装済み 2026-10-31）常駐ループの bin ドライバ（_kaburun 側）: 固定版 CLI・home・handoff の in/out/claims/flags・
  exec ルートを与えて `resident.ResidentLoop`（HALT/STOP → 固定版の検証 → auth 前チェック → accept → dispatch）を回し、
  ラン後に `result_handoff.export_result` で out へ書く、までを1本にした `g10runner/jobrunner.build_loop` と入口
  `bin/g10_jobrunner.py`。固定版から動くときは `--release-digest` 必須（開始時と各周期で検証）。代役で E2E 済み。
- B0-2.（実装済み 2026-10-31）その LaunchAgent plist 生成（gui/503・ProcessType=Background・KeepAlive・固定版の検証つき）。
  `g10runner/launchd_plan.job_runner_agent_plan`／`validate_job_runner_plan` と入口 `bin/g10_first_run.py jobrunner-plist`
  （固定版からのみ・作って lint するだけ・登録しない）。ラベルは `com.kabumori.g10.phase2.agent.jobrunner`。
- B0-3.（実装済み 2026-10-31）鍵と制御状態の配り方: **pub を ACL 共有（yuya=書き／_kaburun=読み）に分ける**方に決めた
  （`g10runner/layout.SplitLayout`）。control_pub（yuya 所有・読み取り専用・exec_root の外）に control_events・policy・
  HALT/STOP・halt.lock を置き、`exec_root/pub` をそこへの symlink にする（stub/reaper も `Layout(exec_root)` で最新の制御
  状態を読む）。exec が書くのは agent-out・work・requests だけ。`jobrunner.build_loop(..., control_pub=...)`・
  `bin/g10_jobrunner.py --control-pub`・plist の `--control-pub` で配線。agent 鍵は exec 側、runner/human 鍵は yuya 側。
  ジョブ発行後に yuya が置く HALT・取消も最新として効く。root を奪われた exec には対抗しない（固定版コードが前提）。

これで B0 の前提コードは出そろった。下の B1 以降（各特権・各GO）に進む。

## B1. first-run（制御プレーン＝yuya と exec プレーン＝_kaburun の初期化）▶GO（各段・後日）

専用ユーザー方式は**新しい独立したパイプライン**を作る（既存の同一ユーザー常駐 f998feb5／policy-v2 には触れない。承認番号
0005/0006/0007 も使わない）。鍵の持ち分と置き場をはっきり分ける。

### 鍵の持ち分（ここが肝）
- **yuya（制御）**: runner・human・agent・witness の**秘密鍵**を持つ（yuya 所有 0600）。制御イベント・GO・CLAIM・CONFIRM を
  runner/human で署名し、CLAIM 時に witness で Issue #323 の証拠を作る。
- **_kaburun（実行）**: **agent と witness の秘密鍵だけ**を持つ（_kaburun 所有 0600）＋4役割の公開鍵。agent は自分のログ
  （ACCEPTED/used）と結果マニフェストの署名に、witness は起動直前の Issue 再取得の証拠づくりに使う。
  **runner・human の秘密鍵は決して _kaburun に渡さない**（これがあると制御・GO・CLAIM を偽造できる）。
- witness は「取り込んだ Issue の事実に署名する」低権限の鍵で、両プレーンが Issue を取得・照合するため**同じ witness 鍵を
  両方が持つ**（公開鍵は1つなので鍵ペアは共有）。秘密鍵が2ユーザー間を渡るのを避けたい場合の代替（起動直前の再取得を外す）は
  安全性が落ちるので採らない。**witness 秘密鍵の受け渡しは、world-readable に一瞬も置かずに行う**（下記 B1b）。

### B1a. control_pub（共有の読み取り専用）と yuya の制御プレーン ▶GO（yuya のセッション）
制御の公開状態は exec_root の中に置かず、両ユーザーが通れる `/Users/Shared` の下の **yuya 所有・読み取り専用**ディレクトリに置く。

```
mkdir -p /Users/Shared/g10-control-pub && chmod 0755 /Users/Shared/g10-control-pub
```

yuya の制御ルート（priv は /Users/yuya の下＝秘密。pub は上の共有ディレクトリ）を作る。pub を共有先への symlink にしてから
init すると、制御イベント・policy・HALT/STOP が共有 control_pub に出る（init の ensure は exist_ok なので symlink 先を使う）:

```
mkdir -p ~/g10-control && ln -s /Users/Shared/g10-control-pub ~/g10-control/pub
/usr/bin/python3 -I <固定版>/bin/g10_first_run.py init --root ~/g10-control --issue-source github_rest_anonymous
```

→ これで yuya 所有の control_events.log・policy.json・halt.lock が `/Users/Shared/g10-control-pub` にでき、keys/ に4役割の
秘密鍵（yuya 所有 0600）と wiring.json（private={agent,witness}）ができる。検証: `ls -le /Users/Shared/g10-control-pub`（yuya 所有・
group/other に w なし）。

### B1b. witness と agent の鍵を _kaburun に渡す ▶GO（yuya→_kaburun・world-readable を避ける）
_kaburun は agent・witness の秘密鍵の**自分の複製**（_kaburun 所有 0600）が要る。world-readable な場所に平文で置かないため、
**管理者の権限で複製＋所有権の付け替え**を行う（sudo の cp/chown は**あなた**が打つ。クロちゃんは打たない）。目安:

```
sudo mkdir -p /Users/_kaburun/g10-exec/keys && sudo chown _kaburun /Users/_kaburun/g10-exec/keys && sudo chmod 0700 /Users/_kaburun/g10-exec/keys
sudo cp ~/g10-control/keys/agent.key ~/g10-control/keys/witness.key /Users/_kaburun/g10-exec/keys/
sudo cp ~/g10-control/keys/*.pub /Users/_kaburun/g10-exec/keys/
sudo chown _kaburun /Users/_kaburun/g10-exec/keys/* && sudo chmod 0600 /Users/_kaburun/g10-exec/keys/*.key && sudo chmod 0644 /Users/_kaburun/g10-exec/keys/*.pub
```

→ runner.key・human.key は**コピーしない**。検証（_kaburun のセッション）: `ls -le /Users/_kaburun/g10-exec/keys`（agent.key・
witness.key・4つの .pub が _kaburun 所有・.key は 0600）。runner.key・human.key が無いこと。

### B1c. exec プレーンの組み立て（wiring・ディレクトリ・pub symlink）▶GO（_kaburun のセッション）
exec_root の wiring.json（issue_source・ledger は yuya の wiring.json に合わせる。public_keys=4役割の .pub、
private_keys={agent,witness} を上の _kaburun 所有の鍵に向ける）を置き、agent-out/work/requests を作り、`pub` を control_pub への
symlink にする（実体ディレクトリにしない）:

```
ln -s /Users/Shared/g10-control-pub /Users/_kaburun/g10-exec/pub
mkdir -p /Users/_kaburun/g10-exec/agent-out/requests /Users/_kaburun/g10-exec/work
```

wiring.json の形（_kaburun 所有 0600。鍵パスは exec_root/keys を指す。issue_source・ledger は yuya のものと同じ値にする）:

```
{"version": <yuya と同じ>, "mode": "ecdsa",
 "public_keys": {"runner":".../keys/runner.pub","human":".../keys/human.pub","agent":".../keys/agent.pub","witness":".../keys/witness.pub"},
 "private_keys": {"agent":".../keys/agent.key","witness":".../keys/witness.key"},
 "issue_source": {"kind":"github_rest_anonymous"},
 "ledger": <yuya と同じ・または null>}
```

検証（_kaburun のセッション・固定版から）: `python3 -I -c "from g10runner import wiring; print(wiring.load('/Users/_kaburun/g10-exec') is not None)"`
が True（鍵の指紋・公開鍵との一致・runner/human 秘密鍵が無いことを wiring.load が確かめる）。`readlink /Users/_kaburun/g10-exec/pub`
が control_pub を指すこと。

### B1d. exec の S2 見張り役（watchdog）▶GO（_kaburun のセッション）
起動直前の判定は新鮮な S2 心拍を要求する（無いと `supervisor_unavailable` で起動しない）。_kaburun の watchdog を
`~/g10-exec/agent-out/s2_heartbeat.json` に心拍を書くよう常駐させる（B2 と同じく gui/503 の LaunchAgent。別 plist）。
（watchdog の plist 生成はまだ用意していない＝次段の小さな非特権コードの候補。それまでは B3 の検証でも手動で心拍を置く。）

→ B1 が済んだら、下の B2（登録）→ B3（隔離検証）→ B4（実 -p ドライラン）→ B5（本番1回）に進む（各別途 GO）。

## B2. LaunchAgent を gui/503 に登録 ▶GO（_kaburun のセッションで実行・後日）
まず固定版の中の g10_first_run.py で plist を作る（作って lint するだけ・登録しない。B1 で root と鍵・ポリシーができてから）:

```
/usr/bin/python3 -I <固定版>/bin/g10_first_run.py jobrunner-plist --root /Users/_kaburun/g10-exec \
  --in /Users/Shared/g10-handoff/in --claims /Users/Shared/g10-kaburun/claims \
  --out /Users/Shared/g10-kaburun/out --flags /Users/Shared/g10-handoff/flags \
  --cli /Users/_kaburun/clirun/2.1.305 --home /Users/_kaburun \
  --control-pub /Users/Shared/g10-control-pub
```

出力の `path`（既定は `/Users/_kaburun/g10-exec/launchd-plans/com.kabumori.g10.phase2.agent.jobrunner.plist`）を _kaburun の
`~/Library/LaunchAgents/` に置き、登録する:

```
launchctl bootstrap gui/503 ~/Library/LaunchAgents/com.kabumori.g10.phase2.agent.jobrunner.plist
```

恒久停止は `launchctl bootout gui/503/com.kabumori.g10.phase2.agent.jobrunner`。緊急停止は `flags/HALT` を yuya が置く
（次周期・起動直前で効く）。plist は handoff の4パス・固定版CLI・HOME・`--release-digest` を決め打ちで持つ（実行先は変えられない）。

## B3. 隔離の最小検証 ▶GO（後日）
yuya の資産に _kaburun が届かないこと／受け渡しが成立すること／flags/HALT で止まることを、無害なダミーのジョブで確かめる。

## B4. 実 -p の1回ドライラン（指摘3）▶GO（後日・承認番号 0005/0006/0007 は使わない）
限定編集を実 CLI で1回だけ流し、~/.claude の許可集合だけで動くかを確かめ、許可/拒否を最終確定する。

## B5. 本番の1回起動 ▶GO（後日）
yuya が Issue #323 を読み GO 承認 → try_claim → bundle 化して署名付きジョブを in へ → _kaburun の常駐が実行 → out →
yuya が ingest+finalize → REPORT。

---
## 撤去（やめる場合・管理者）
- LaunchAgent: `launchctl bootout gui/503/com.g10.jobrunner`（_kaburun）。
- フォルダ・固定版 CLI: 各所有者が rm（/Users/Shared/g10-handoff は yuya、/Users/Shared/g10-kaburun と ~/clirun は _kaburun）。
- ユーザーごとやめる: `sudo sysadminctl -deleteUser _kaburun`。
- 既存の同一ユーザー自動実行（f998feb5）は独立なので影響しない。
