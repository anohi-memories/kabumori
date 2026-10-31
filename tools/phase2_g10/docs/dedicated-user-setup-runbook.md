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
- B0-2. その LaunchAgent plist 生成（gui/503・ProcessType=Background・KeepAlive・固定版の検証つき）。
- B0-3. 鍵と制御状態の配り方の確定（Q の延長）: exec プレーンの Agent は request 封筒の runner 署名検証・Issue 結合・
  認可のために、yuya 側の**公開物**（pub の control_events・policy・wiring・GO 本文）を**読み取り専用**で参照する必要がある。
  これを handoff で配るか、pub を ACL 共有（yuya=書き／_kaburun=読み）にするかを決める。agent 鍵は exec 側、runner/human 鍵は yuya 側。

これが入ってから、下の B1 以降（各特権・各GO）に進む。

## B1. exec プレーンの first-run（_kaburun のレイアウト初期化）▶GO（後日）
`/Users/_kaburun/g10-exec` を root に、exec 側の鍵（agent）とポリシー公開物を置く。鍵の生成は要 GO。

## B2. LaunchAgent を gui/503 に登録 ▶GO（_kaburun のセッションで実行・後日）
B0-2 が生成する plist（ProgramArguments は B0-1 のドライバ＋固定版パス・handoff のパス）を _kaburun の
`~/Library/LaunchAgents/` に置き:

```
launchctl bootstrap gui/503 ~/Library/LaunchAgents/com.g10.jobrunner.plist
```

恒久停止はこのラベルの `launchctl bootout gui/503/...`。緊急停止は `flags/HALT` を yuya が置く（次周期・起動直前で効く）。

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
