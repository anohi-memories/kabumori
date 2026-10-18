# admin Ignored Build Step（設定は未適用）

推薦モデル: Sonnet5（高）。ユーザーの直接依頼による独立PR。G/H/F/Jの割当・TASK・Report・ACTIVE_TASKは変更しない。

## 判定

`ignore-admin-build.sh` は終了コード **0 = skip / 1 = build**。
前回成功デプロイから今回のコミットまでの**リポジトリ全体のtree差分**を調べる。
`.agent/`、`.agent_v2/`、`.agent_v3/`、`.agent_v3_gh/` の配下だけの変更ならskip。
追加・削除・mode変更を含み、renameは削除＋追加として両側を調べる。
`apps/admin/`、POSTONA、共通基盤、workflow、ルート設定、このスクリプト自身を含む他の変更が1つでもあればbuild。
途中のコミットだけを調べる `HEAD^`、パス限定diff、merge-base起点の三点diffは使わない。
変更して完全に戻されたファイルはtree差分には現れない。

両SHAはGitHubの40桁小文字commit ID必須。未設定・不正・欠損・commit以外・checkoutとの不一致、
祖先関係不明（shallow/force push/分岐/履歴断絶を含む）、diff失敗・空差分・一時ファイル失敗はbuild。
NUL区切りで空白・改行・タブ・引用符・非ASCII・バックスラッシュを保持する。
Git replaceは無効化。fetch・依存インストール・ネットワークアクセスはしない。
Bash 3.2以降とGit、mktemp、rmだけで動く。`sh script.sh` は使用しない。

## 確認した設定と仕様（2026-10-18 JST）

- 最新main基点: `0ca5f61137aeb8ed4480fe97b53cdec5642c6654`。
- 新旧ACTIVE_TASK、CURRENT_STATEの現在部分、全30 TASKの最新metadata、F10の対象範囲を確認。
  F2はTASK冒頭readyよりCURRENT_STATEのreview_requiredが新しい。再割当しない。
  F10のPR268はpilotルール候補で、Vercel設定を変更する権限は含まない。
  取得した351 remote refsに対し今回の3パスの変更重複なし。独立cloneで作業。
- [admin設定画面](https://vercel.com/kabumori/admin/settings/build-and-deployment) を読み取り確認:
  Root Directory = `apps/admin`、Include files outside root = Enabled、Skip unaffected deployments = Disabled。
  Ignored Build Step欄には `Run my Bash script` / `bash your-script-name.sh` が表示されていた。
  Saveは有効であり、この欄が保存済みかは断定できない。編集・Save・reloadはしていない。
  `HANDOFF.md` の過去のRoot Directory記録とも一致する。
- [Vercel公式: Ignored Build Step](https://vercel.com/docs/project-configuration/project-settings#ignored-build-step):
  Root Directory内で実行され、0でCANCELED、1でbuild継続。
- [Vercel公式: VERCEL_GIT_PREVIOUS_SHA](https://vercel.com/docs/environment-variables/system-environment-variables#vercel_git_previous_sha):
  **同じproject・branchの最後の成功デプロイ**のSHA。Ignored Build Stepでのみ公開され、branch初回は空。
  実プロジェクトでの値はデプロイを起動していないため未検証。手動で古いSHAを環境変数へ固定しない。
- [Vercel公式ガイド](https://vercel.com/kb/guide/how-do-i-use-the-ignored-build-step-field-on-vercel):
  cloneはdepth=10。前回成功以降に管理コミットが多数続くと基点が範囲外になり、意図的にbuildする。
  判定できる履歴が揃っているshallow cloneはskip可能。System Environment Variables公開も設定時に確認する。
- これは**ビルド処理の省略**。CANCELEDでもdeployment数・同時実行枠に計上されるため、
  deploymentイベントや上限消費を完全に止める仕組みではない（上記公式設定仕様）。

## 手動設定用コマンド

別途マージ承認を得て、このスクリプトが対象デプロイのコミットに含まれてから、
adminの Settings → Build and Deployment → Ignored Build Step → **Custom** に次を設定する。
今回のPRでは設定変更・main merge・手動Preview/本番deployは実施しない。

```sh
sh -c 'root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 1; bash "$root/scripts/vercel/ignore-admin-build.sh"; code=$?; [ "$code" -eq 0 ] && exit 0; exit 1'
```

`apps/admin`、repo rootどちらからでも同じコマンド。Git root探索失敗、ファイル欠損、bash欠損、
構文エラー等の非0終了も1へ正規化する。`|| exit 0` や `|| true` は付けない。
既存Root Directoryや外側参照、ビルド・環境変数設定をこのPRのために変更しない。
設定適用後の実Vercel動作は未検証。初回branchやscript導入コミットはbuildが想定動作。
既存の自動Git連携はPR branch pushでもPreviewを起動する可能性がある。本PRは手動deployを呼ばない。

## ローカル検証

```sh
python3 -m unittest discover -s tests/vercel -v
```

標準ライブラリだけを使用し、使い捨てGit repoとfile:// shallow cloneで検証する。
上記の設定コマンドそのものもREADMEから取り出して実行し、root/admin双方を検証する。
実Gitの履歴・rename・merge・ファイル名テストに加え、Git diffの異常と一時ファイル失敗を注入する。
既存のアプリ、DB、Auth、SNS、workflowには変更なし。

2026-10-18の結果: **39 tests PASS**（macOS / Bash 3.2.57）。`bash -n` と `git diff --check` もPASS。
System Environment Variablesの実値、Vercel上のLinux実行とCANCELED/BUILDING状態は未検証。
