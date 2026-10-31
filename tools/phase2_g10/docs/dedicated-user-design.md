# 第32TASK 専用macOSユーザー方式の設計（限定コード編集の隔離）

限定コード編集で、CLIの子プロセスだけを専用のmacOS標準ユーザーとして動かし、本人の `~/.claude`・キーチェーン・他slotの作業フォルダから**OSのユーザー権限で**分離する方式の設計。実行係・監視・通知・REPORT生成は、従来どおり本人アカウント（本人UID）に残す。sandbox-execは二重目の防御として残す。

この文書は設計・準備のみ。専用ユーザーの作成・権限変更・常駐登録・認証・実機の動作は、すべて別途ユーザーGOまで行わない。

## 1. 役割の分担（どのUIDで何を動かすか）

| 役割 | 動かすUID | 内容 |
|---|---|---|
| 実行係（既存のstub/control） | 本人 | #323の本文検証、ランの確定、照合、テスト、REPORT生成 |
| 監視（watchdog/autorun） | 本人 | 承認・GO・HALTの確認、起動判断 |
| 通知 | 本人 | 承認待ち・ログイン切れ・HALT・ラン終了をMac通知で本人に知らせる |
| **CLIの子プロセスだけ** | **専用ユーザー** | 許可ファイルの編集。本人のHOME・キーチェーン・他slotに権限なし |

ポイントは、「隔離をソフトで自作する」のをやめ、**別ユーザーにすればOSのファイル所有権で最初から届かない**という点に土台を移すこと。これまで反復していたサンドボックス境界の自作修正が不要になる。

## 2. 専用ユーザーの要件

- **非管理者の標準ユーザー**（adminグループに入れない、sudoersに追加しない）。
- 専用のホーム（例 `/Users/_kaburun`）。本人のホームとは別。
- ログインシェルは不要（対話ログインしない運用を基本に検討）。
- 作成は `sysadminctl` 等の正規の方法で、**管理者パスワードが要る＝ユーザーが行う**。この文書では作成しない。

## 3. 「別ユーザーとしてCLIを起動する」方法の比較

macOSで、あるプロセスを**別のユーザーとして**起動するには、原則として特権（root）か、あらかじめ入れた特権ヘルパーが要る。本人UIDの実行係が、パスワードなしで勝手に別ユーザーになることはできない（これは制限であって、むしろ安全側）。

| 方法 | 内容 | 評価 |
|---|---|---|
| A. LaunchDaemon（`UserName`指定） | rootのlaunchdが、指定ユーザーとしてプロセスを起動 | 起動のたびにオンデマンドで呼びにくい。常駐向き |
| B. 特権ヘルパー（1回だけ管理者が導入） | rootまたは専用ユーザーで動く小さな常駐が、本人側からの署名付き依頼を検証して、CLIを専用ユーザーとして起動する | オンデマンドに向く。**推奨**。導入に管理者権限（1回・ユーザーGO） |
| C. `launchctl asuser` 等 | rootが要る | 実行係がrootでないので不可 |

**推奨はB（特権ヘルパー方式）**。標準的な「権限分離（privilege separation）」の形で、本人側は特権を持たず、ヘルパーが最小限の仕事（依頼の検証と、専用ユーザーでの起動）だけをする。特権の委譲は無制限にせず、「この署名付き依頼が来たときに、この固定版のCLIを、この作業フォルダで起動する」だけに限定する。

### Bの依頼の検証（ヘルパーが起動前に確かめること）
- 依頼が本人側の実行係の鍵で署名されている（既存のECDSAの鍵の仕組みを流用）。
- 依頼の中身（固定版のdigest、作業フォルダ、許可path、base HEAD、承認番号）が、#323の本文の正規の値と一致する。
- 起動は1回だけ（既存のCLAIM・at-most-onceを流用）。
- どれか欠ければ起動しない（fail-closed）。

## 4. 作業の受け渡し（本人 ⇄ 専用ユーザー）

- **受け渡し用の共有フォルダ**を2つ用意する（ACLで向きを固定）。
  - 入力 `handoff/in`：本人が書き、専用ユーザーが読む。署名付きTASK（NORM-1 hash・許可path・base HEAD）を置く。
  - 出力 `handoff/out`：専用ユーザーが書き、本人が読む。ローカルREPORT・diff・テスト結果を置く。
- 専用ユーザーは、作業フォルダ（base_shaの使い捨てクローン）を**自分のホームの下**に作る。本人のリポジトリやHOMEには、所有権がないので書けない。
- 受け渡しの原子性：書き終えてから名前を付け替える（途中の状態を相手に読ませない）。
- 後始末：ランごとに作業フォルダを消す。HALT時はfail-closed。
- path traversal・symlinkの持ち出しは、共有フォルダのACLと、専用ユーザーが本人側に所有権を持たないことで二重に防ぐ。

## 5. Claude認証（A1 の実機結果で確定したこと）

**ここがこの方式の成否を分ける最大の論点。** 第33TASKレビューの注記 A1 を実機で確認した結果（REPORT 6515195835）、認証の実体が分かった:

- Claude CLI の OAuth トークンは **HOME 内のファイルには無い**（`~/.claude/.credentials.json` は存在せず、`~/.claude.json` は口座メタ `oauthAccount` だけ）。**トークンは macOS のログインキーチェーン**（service "Claude Code-credentials"）にある。
- 使い捨ての空 HOME では `auth status` が `loggedIn:false / authMethod:none`。本物の `~/.claude.json` を丸ごとコピーしても false。**無人の子プロセス＋別HOMEの文脈では、ログインキーチェーンのトークンが取り出されなかった。**

A1 の本質は「使い捨て HOME」固有ではなく、**非対話で起動したプロセスがログインキーチェーンに届くか**という問題。これは専用ユーザー方式にもそのまま当てはまる（場所が本人のキーチェーンから専用ユーザーのキーチェーンに移るだけ）。したがって:

- **A案（採用方針）：専用ユーザー自身を Claude に1回ログインさせ、そのログインキーチェーンを使う。**
  - 専用ユーザーが**自分で**対話ログインする（本人の認証情報はコピーしない・できない。キーチェーンは本人のものと別）。トークンは専用ユーザーのログインキーチェーンに入る。
  - **要となる前提：ヘルパー/launchd が専用ユーザーとして CLI を起動する時点で、そのログインキーチェーンが開いていること。** GUI ログインしていないユーザーの login キーチェーンは既定で施錠。対策候補 = (i) 専用ユーザーをファストユーザースイッチで GUI ログインさせ維持し、CLI はそのセッションの LaunchAgent として動かす、(ii) 起動直前に `security unlock-keychain` で開ける（専用ユーザーのパスワードの扱い＝secret 管理の論点）、(iii) 専用の別キーチェーンを用意して開ける。
  - 失効時の再ログイン手順を決める。
- **B案：トークン（setup-token）利用** — **現行ルールで新規発行は禁止**。使うならルール変更がユーザー判断で要る。

**最初の実機ゲート（他の実装より前）：専用ユーザーとして非対話で起動したプロセスが、そのユーザーのログインキーチェーンのトークンを取り出せるか（課金なしの `auth status` だけで確認、ユーザーGO後）。** ここが通らなければ、ヘルパーや ACL を作っても自動化は成立しない。本人の認証状態と専用ユーザーの認証状態は混同しない。

### 最初のゲート：2026-10-30 **通過（PASS）**
専用ユーザー `_kaburun`（非管理者・UID 503）を作成し、そのユーザー自身で1回ログイン。`_kaburun` の GUI セッション（ファストユーザースイッチで維持）内で、**バックグラウンドの LaunchAgent（`ProcessType=Background`）が `auth status` を実行 → `loggedIn:true / authMethod:claude.ai`**。同一セッションの直接実行も true。`subscriptionType:max`・`configDirectory=/Users/_kaburun/.claude`（本人とは別HOME）。→ **非対話エージェントでも、専用ユーザーが GUI ログイン中ならそのログインキーチェーンの token に届く**ことを実機で確認（A1 の本人・使い捨てHOME失敗と対照的）。課金なし（モデル未呼び出し）。
- **確定した運用上の制約（A案の前提）**: `_kaburun` が **GUI ログイン中**であること。ログアウト・再起動・シャットダウンでログインキーチェーンが施錠され止まる → 再ログインが必要。**(a) スリープ/画面ロックで自動施錠されないか → 2026-10-30 確認済み（施錠されない）**: `_kaburun` の 60 秒間隔 LaunchAgent で `auth status` を約46分監視（32サンプル）、スリープ→復帰を2回挟んでも**全サンプル `loggedIn:true`（false 0件）**、復帰直後も true。→ ログイン維持中はロック/スリープで施錠されず認証を取り続ける。idle の長時間（数時間〜日）自動ロックは未検証だが、46分＋スリープで無施錠なら既定どおり未設定とみられる。必要なら起動直前 `security unlock-keychain` を保険にできる。
- **インストール場所の論点**: 今回のゲートは本人の `claude`（`/Users/yuya/.local/bin/claude`、world 実行可）をフルパスで借りた。本番では `_kaburun` 専用に Claude を入れる（本人ホーム依存を切る）か、共有の実行場所に置くかを決める。
- **(b) 同一 Max アカウントの同時実モデル呼び出し → 2026-10-30 確認済み（制限なし）**: `_kaburun` から `claude -p`（小プロンプト）を2本同時実行（＋ yuya デスクトップ・セッション稼働中）、2本とも exit=0・出力 OK・約3秒で完了、rate/seat/429 等のエラーなし。→ 小規模の同時利用はアカウントで弾かれない。※大量・持続負荷や多数並列は未検証。

## 6. 本人への通知

- 通知は**本人UIDの通知役**が出す（Mac通知は本人のGUIセッションでしか出せないため。専用ユーザーからは本人画面に通知できない）。
- 通知する場面：承認待ち、ログイン切れ、HALT、ラン終了（成功・失敗）。
- 重複防止：同じ事象は1回だけ。
- 必要なときだけ#323にコメント（本TASKでは投稿しない。REPORTは既存契約の1件のみ）。

## 7. デスクトップ版への引き継ぎ

- 引き継ぎの正本は、ローカルREPORTと、#323の最新のTASK/REPORT/ACCEPT。
- 同じ会話の再開ではなく、REPORTを読んで続きから進める形（CLIの会話記録は専用ユーザー側にあり、デスクトップ版からは開かない）。

## 8. 採用・不採用の理由と、代替案との比較

- **採用理由**：隔離をソフトで自作する（＝反復して詰まっていた部分）を、OSのユーザー分離に置き換えられる。本人のHOME・鍵・他slotに、権限で最初から届かない。
- **不採用になりうる点／弱点**：
  - 別ユーザーでの起動に特権ヘルパーの導入（管理者・1回）が要る。
  - 認証（§5）が未解決。ログイン維持かトークンかで、運用かルール変更のどちらかが要る。
- **代替案（クラウド/GitHub Actions）**：使い捨ての隔離環境が最初から用意されているため、専用ユーザーの導入も特権ヘルパーも要らない。トークン（Actionsの場合）か、クラウドセッションの起動方法が論点になる。本方式より導入が軽い可能性があり、別途比較の価値がある（この文書の範囲外）。

## 9. 権限表（届く／届かない）

| 対象 | 本人UID | 専用ユーザー | 備考 |
|---|---|---|---|
| 本人の `~/.claude`・キーチェーン | 読み書き | **不可** | 別ユーザーの所有物 |
| 他slotの作業フォルダ | 読み書き | **不可** | 同上 |
| 本人のリポジトリ | 読み書き | **不可** | 受け渡しは共有フォルダ経由のみ |
| 専用ユーザーのホーム内の作業フォルダ | 読み（出力の回収） | 読み書き | ランごとに使い捨て |
| 共有 `handoff/in` | 書き | 読み | 署名付きTASK |
| 共有 `handoff/out` | 読み | 書き | REPORT・diff・テスト結果 |

## 10. 実装ステップ（案。各ステップは別途GO）

1. 設計の確定（本文書）とレビュー。
2. **【最初の実機ゲート】認証（§5）の成立確認。→ 2026-10-30 通過済み（§5 の結果を参照）。** 専用ユーザー `_kaburun` を1回ログインさせ、GUI ログイン中に非対話の LaunchAgent が `auth status` で `loggedIn:true` を取得。残りは §5 の「要追加確認」（キーチェーン自動施錠・同時実モデル呼び出しの制限・インストール場所）。
3. 特権ヘルパーの最小実装（署名検証と、専用ユーザーでの固定版CLI起動だけ）。静的検証のみ。
4. 受け渡しフォルダとACLの設計を、偽の2ユーザー相当で机上検証。
5. 本人への通知役の実装。
6. 専用ユーザーの作成・ヘルパー導入・ACL設定（**管理者権限・ユーザーGO**）。
7. 隔離の最小検証（本人のHOME・他slotに書けないこと、受け渡しが成り立つこと、HALTで止まること）。
8. 実機1回の限定コード編集（**別途GO・承認番号は未使用のもの**）。

## 11. 別途GOが必要な作業（この文書では一切行わない）

専用ユーザーの作成、特権ヘルパーの導入、sudoers/ACL/権限変更、LaunchDaemon/Agentの登録・bootout/bootstrap、CLIのログイン・認証状態の確認、token/Keychain/secretの操作、実Claudeのコード編集・課金実行、ポリシー実write、production/DB/Auth/Edge、SNS、外部APIの実write、merge/deploy。

## 12. 失敗時のロールバック

- 特権ヘルパーは `launchctl bootout` で停止・除去（導入前の状態に戻す）。
- 専用ユーザーは、使わなくなれば正規の方法で削除（管理者）。
- 受け渡しフォルダは削除。
- どの段階でも、本人側の既存の読み取り専用の自動実行（第25TASクの形）は独立して動く。

## 13. 確認項目（見積りではなくチェックリスト）

- [ ] 別ユーザーでの起動は、特権ヘルパー（B）で、署名付き依頼の検証つきに限定されているか。
- [ ] 専用ユーザーは非管理者・sudoなしか。
- [ ] 専用ユーザーが本人のHOME・鍵・リポジトリ・他slotに所有権を持たないか。
- [ ] 受け渡しは共有フォルダ経由だけで、原子的で、後始末されるか。
- [ ] 認証方式が決まり、課金なしの確認だけが先行しているか。
- [ ] 【最初のゲート】専用ユーザーとして非対話で起動したプロセスが、そのユーザーのログインキーチェーンのトークンを取り出せることを、他の実装より前に確認したか（A1 の知見）。
- [ ] 通知が本人UIDから、必要な4場面で、重複なく出るか。
- [ ] sandbox-execが二重目として残っているか。
- [ ] すべての特権操作・実機操作が、別途GO待ちとして明記されているか。

## 14. 実装設計 v2（2026-10-30 のゲート結果を踏まえた確定方針）

認証ゲート・(a)スリープ/ロック・(b)同時実モデル呼び出しが全て実機で通過したので、方式を次に確定する。

### 14.1 認証とHOMEの扱い（第33TASKからの方針転換）
- 認証は _kaburun の**ログインキーチェーン**にあり、_kaburun が GUI ログイン中なら背景エージェントからでも取れる（実証済み）。HOME 内のファイルには無い。
- よって CLI は **_kaburun の実HOME（/Users/_kaburun）** で動かす。第33TASKの「使い捨てHOME」は A1 で認証不可だったので**不採用**。yuya との分離は HOME の使い捨てではなく**OSのユーザー所有権**で担保する。
- 限定コード編集の sandbox-exec は二重目として維持。ただし書き込み許可を「**_kaburun の ~/.claude（認証・セッションに必要）**＋承認ファイル＋作業フォルダ＋ランの一時」に変える（本物=_kaburun の ~/.claude を許可する点が第33TASKと逆。yuya の資産は所有権で届かない）。

### 14.2 起動方式（キーチェーンに届く形に限定）
- root→setuid の特権ヘルパーで別ユーザー起動すると GUI セッション外になり、ログインキーチェーンに届かない（A1 と同型で失敗）。→ **不採用**。
- 代わりに **_kaburun の GUI セッション内に常駐する「ジョブ実行エージェント」**（gui/503 の LaunchAgent）を置く。これが署名付きジョブを拾って CLI を起動するので、CLI は _kaburun のセッションを継ぎキーチェーンに届く（(a)(b) で実証した形そのもの）。
- 実行時に root は不要。必要な特権は**一度きりの設定**（ユーザー作成=済、エージェント登録、ACL付き受け渡しフォルダ作成）だけ。

### 14.3 受け渡しとジョブ検証
- ACLで向きを固定した共有フォルダ: handoff/in（yuya→_kaburun）・handoff/out（_kaburun→yuya）。
- yuya側ランナーが #323 本文の正規値から**署名付きジョブ**（既存ECDSA鍵）を in に置く。エージェントは起動前に: 署名検証／固定版CLIの digest 一致／作業フォルダ・許可path・base HEAD・承認番号が本文と一致／起動は at-most-once（既存CLAIM）を確認。どれか欠ければ起動しない（fail-closed）。
- 出力（ローカルREPORT・diff・テスト結果）は out へ。差分はリポジトリ/GitHub に戻さない（従来どおり）。

### 14.4 (c) CLI の設置場所 → 決定: _kaburun 専用インストール
- 本人の /Users/yuya/.local/bin/claude の借用は yuya のホーム権限・更新に依存し分離も弱い。→ **_kaburun の自分のホームに固定版を入れる**（版ピン。ランナーの cli_realpath / cli_version を _kaburun の実体に向ける）。更新は別管理。

### 14.5 ランナーのコード変更（実装時・別途GO）
- edit の home を「使い捨て」から **_kaburun の実HOME**に戻す（adapter / real_claude / claude_cli_plan / stub / code_edit）。
- cli_profile の許可を 14.1 に合わせ更新（_kaburun ~/.claude を許可、yuya 側は所有権で不可）。
- cli_realpath を _kaburun の固定版に。
- 第33TASKの差し戻しを含むので、実装時にテスト（test_task30_home_postrun 等）を張り替える。

### 14.6 一度きりの特権作業（各ユーザーGO）
_kaburun 作成（済）／ジョブ実行エージェント登録（gui/503）／ACL付き handoff フォルダ作成／_kaburun への Claude 固定版インストールとログイン（ログイン=済、再ログイン手順も決める）。sudoers 変更なし・_kaburun は非管理者のまま。

### 14.7 残り・リスク
- 大量/持続負荷・多数並列の同時利用は未検証。
- _kaburun の GUI ログイン維持（ファストユーザースイッチ）が前提＝再起動後は要再ログイン。自動再ログインの可否はセキュリティと両睨みで要検討。
- 通知（§6）: 承認待ち・ログイン切れ・HALT・ラン終了は本人UIDの通知役が出す。

### 14.8 次のビルド手順（各別途GO）
1. ランナーのコード変更（14.5・テスト込み・静的検証）。2. ジョブ実行エージェントの最小実装（署名検証＋CLI起動だけ）。3. ACL付き handoff の机上検証（偽の2ユーザー相当）。4. エージェント登録＋ACL作成（GO）。5. 隔離の最小検証（yuya の資産に届かない・受け渡し成立・HALT で止まる）。6. 実機1回の限定編集（GO・未使用の承認番号）。

### 14.9 v2 レビュー指摘への対応（2026-10-30・REPORT 6523744098）
- **指摘1（読み取り分離・最重要）**: yuya への書き込みは OS 所有権で堅いが、staff 共有＋0755/0644 で _kaburun は yuya の repos・settings.json 等を**読める**（CLI はネットワーク持ち＝外部送信の経路になりうる。ただし ~/.claude.json は 0600 で機微は保護）。対応:
  - **ソースは handoff 経由にする**。現状の `git clone --shared <source_repo>` は source_repo が yuya の repo だと _kaburun が yuya のホームを読む必要がある。v2 では base_sha のソースを yuya 側が handoff/in に用意し（bundle 等）、_kaburun は yuya のホームを一切読まない。→ source preparer の実装変更（ジョブ実行エージェント実装時に対応）。
  - **/Users/yuya を 0700 に締める**（_kaburun の侵入を遮断。staff 共有のため 0750 では不足）。上のソース handoff 化が先（さもないと --shared が壊れる）。一度きりの setup・ユーザー判断（管理者不要・自分のホームの chmod）。
  - 最低限、yuya の world/グループ可読ファイルに秘密を置かない。
- **指摘2（contained）: 対応済み** — `~/.claude/.config.json` を HOME_DENY_LITERALS に追加（テスト・変異つき）。deny-list は本質的に whack-a-mole なので、指摘3のドライラン後に tight allow-list への移行を再検討。
- **指摘3（liveness・要GO）**: 実 `-p` 限定編集の1回ドライランで、CLI が許可集合（~/.claude の許可部分）だけで動くか確認。その結果で ~/.claude の許可/拒否を最終確定。

### 14.10 ジョブ実行エージェントの受け口（実装・TASK 35）
14.8 の手順2「ジョブ実行エージェントの最小実装」の、**検証と CLAIM の中核**を実装した（起動は別段）。

- **GO への source_bundle 配線（指摘1のコード側）**: REAL_CLAUDE_GO に任意欄 `source_bundle`（絶対パス）を追加。
  あれば `RealClaudeAdapter.source_preparer()` が `BundleSourcePreparer` を選び、yuya の repo を一切読まずに
  handoff の自己完結 bundle からソースを用意する。無ければ従来どおり `GitSourcePreparer`（同一ユーザー方式）。
  `go_problem` は `source_bundle` だけを任意の追加欄として許し、それ以外の未知欄は従来どおり拒否する。
- **handoff.py（_kaburun 側の受け口）**: `HandoffInbox(in_dir, claims_dir, verifier)` が `accept(filename)` で
  ジョブ1件を fail-closed に受理する。
  - **信頼の土台は署名**。ジョブは JSON 1ファイルで、`sig` を除いた canonical バイトに人（human）の鍵で署名
    （chainlog と同じ canonical）。`role` は検証に使う鍵を選ぶので load-bearing（許可する役割は human のみ）。
    handoff/in のファイルは yuya 所有なので uid 所有では信用しない。
  - **多層目の構造チェック**: in は正規の絶対パスのフォルダでグループ／他人が書けないこと、ジョブファイルは
    O_NOFOLLOW・通常ファイル・ハードリンクなし・他者書き込み不可、ファイル名は basename のみ、1 MiB 上限。
    in は ACL で yuya=書き／_kaburun=読みに固定する前提（_kaburun は in に書けない＝自分で仕込めない）。
  - **GO と要求の一致**: approval_id・task_sha256・本文ハッシュ（body_sha256＝prompt の SHA-256）が一致すること、
    ジョブと GO の両方が期限内であること。
  - **CLAIM（at-most-once）**: _kaburun 所有の claims フォルダに `claims/<job_id>.claim` を
    `O_CREAT|O_EXCL|O_NOFOLLOW` で作る。成功＝今 CLAIM。既にあれば二重＝受けない（O_EXCL が直列化点・GO の
    max_runs=1 と対）。**検証を通してから CLAIM**し、一度 CLAIM したら以降が失敗しても再実行しない。
  - 起動はしない。受理結果（GO・要求・ソースの選び方 bundle/git）を返すだけ。実 CLI の起動は GO ゲートの別段。
- テスト: test_task35_handoff（正常系3・拒否系18）、test_task34 の GO 配線5。変異7件（署名・役割・一致・期限・
  CLAIM・source_bundle 検査・アダプタ選択）すべて正しい理由で fail。
- **残り（別段・要GO）**: ① stub/agent 側を source preparer 選択に実結線し、bundle を使うラン全体の E2E（代役で）。
  ② gui/503 の LaunchAgent から HandoffInbox を回す常駐ループ（in を監視・受理したら既存のスタブ起動に渡す）。
  ③ 実 `-p` の1回ドライラン（指摘3）。②③は一度きりの特権作業・実機のため各別途GO。

## 15. ジョブ実行エージェントの常駐ループ（設計・TASK 36）
§14.8 手順2 の残り「gui/503 の常駐ループ」の設計。中核（検証・CLAIM = handoff.py、ソース準備 = BundleSourcePreparer、
実行プレーン = agent.Agent / stub）は実装・テスト済み。本節は、それらを _kaburun の GUI セッションで回す常駐の形と、
yuya（制御）と _kaburun（実行）の役割分担・受け渡し・HALT・認証・障害時の扱いを決める。実装は別TASK、特権作業は各別途GO。

### 15.1 方式の確定（Variant B＝実行プレーンの分離）
2つの案があった。**(A)** CLI の子だけ _kaburun、スタブ・監視・finalize は yuya。**(B)** 受理・スタブ起動・監視まで
_kaburun の実行プレーンで回し、yuya とは署名付きジョブ＋ACL 受け渡しだけでつながる。
- 既存コードは (B) を前提に積んである（agent.py の冒頭「実行プレーン（専用ユーザー側）」、handoff.py の受け口、
  BundleSourcePreparer の bundle 受け渡し）。(B) の方が隔離が強い（yuya の資産に実行プレーンが触れない）。**(B) を採る。**
- 役割分担:
  - **yuya（制御プレーン・本人UID）**: Issue #323 の読取り、Phase2 TASK の検証、人の REAL_CLAUDE_GO の承認、
    base_sha のソースを bundle 化、**署名付きジョブ**（GO＋request＋human 署名）を handoff/in に置く、
    実行後の out/ を回収して finalize・REPORT 生成・通知。GitHub 認証と human 鍵は yuya 側だけが持つ。
  - **_kaburun（実行プレーン・専用UID）**: handoff/in を監視し、handoff.HandoffInbox.accept で検証＋at-most-once
    CLAIM、CLI のログイン前チェック、実行プレーン Agent でスタブを起動（スタブが bundle から作業フォルダを用意し、
    sandbox-exec で CLI を1回起動・監視）、結果（diff・テスト結果・端末状態）を handoff/out に書く。実 CLI の
    ログインキーチェーンは _kaburun の GUI セッションのものを使う。

### 15.2 受け渡しフォルダ（ACL で向きを固定）
`handoff/`（setup で作る。一度きり・要GO）:
- `in/`   : yuya=書き／_kaburun=読み。署名付きジョブ（§14.10 の形）と、その bundle。
- `out/`  : _kaburun=書き／yuya=読み。ラン結果（diff・テスト結果・端末状態・ローカル REPORT 下書き）。
- `claims/`: _kaburun 所有。at-most-once の claim マーカー（handoff.py）。
- `flags/`: yuya=書き／_kaburun=読み。HALT・STOP の合図（UID をまたぐので signal ではなくフラグ）。
ACL は `chmod +a` で付け、POSIX ビットは group/other 不可。_kaburun は in/ に書けない＝ジョブを自作できない。
in/ のファイルは yuya 所有なので、信頼の土台は**署名**（handoff.py はファイル所有では信用しない）。

### 15.3 常駐の形（LaunchAgent gui/503）
- _kaburun の `~/Library/LaunchAgents/` に plist を置き、`launchctl bootstrap gui/503`（_kaburun の GUI セッション）で
  登録。`ProcessType=Background`、`KeepAlive`（異常終了のみ再起動）、`RunAtLoad`。固定版（release.py）から起動し、
  起動直前ごとに固定版を検証（autorun の release_check と同じ。合わなければハードHALT）。
- GUI ログインが前提（ログインキーチェーンが開く条件。A1・ゲートで実測済み）。再起動後は _kaburun の再ログインが要る
  （ファストユーザースイッチ）。ログインしていなければ CLI は「Not logged in」で止まる＝害なく止まる側。
- 1周期 = flags 確認 → in/ を走査 → 1件受理できたら実行 → out/ へ結果 → 記録。同時に動くランは1本まで
  （実行中は新規受理しない。既存の registry.non_terminal で判定）。周期間隔は autorun の MIN_LIVE_INTERVAL 相当。

### 15.4 1周期の処理（loop.step 相当・fail-closed）
1. **HALT/STOP**: flags/ の HALT・STOP、実行プレーンの HALT_AGENT のいずれかがあれば、受理も起動もしない。
2. **受理**: in/ の候補1件を `HandoffInbox.accept(filename)`。ok でなければ記録して次へ（CLAIM しない）。
   ok なら at-most-once CLAIM 済み（二重起動しない）。
3. **ログイン前チェック**: `real_claude.auth_status(go.cli_realpath, go.home)` がログイン済みか（モデルを呼ばない）。
   未ログインなら起動せず、out/ に「login 切れ」を書いて停止し、yuya 側の通知役に知らせる（§6）。承認は消費済み
   （CLAIM 済み）だが実行はしない＝再実行もしない（fail-closed）。※ここは「CLAIM 前にログイン確認」に変える案も要検討
   （承認を無駄に消費しないため。15.7 の open question）。
4. **起動**: 実行プレーン Agent にジョブの request を渡してスタブを起動（agent.handle_request_file 相当）。スタブが
   bundle から作業フォルダを用意（source_bundle→BundleSourcePreparer）、sandbox-exec で CLI を1回起動し監視。
5. **終了待ち・結果**: 端末状態・diff・テスト結果・ローカル REPORT 下書きを out/ に書く（本文・秘密・メール不可）。
6. **記録**: autorun.log と同じ方針で、決定・理由・run_id・status だけを _kaburun 側ログに1行JSONで残す。

### 15.5 HALT を UID 越しに効かせる
yuya は _kaburun のプロセスに直接シグナルを送れない。so:
- yuya が `flags/HALT`（署名付き）を置く → 常駐は周期の頭と起動直前に読む → あれば起動しない／実行中なら既存の
  ハードHALT 経路（S1/S2 の監視が期限・HALT で子を止める）に委ねる。
- 緊急停止は二重: ①flags/HALT（次の周期・起動直前で効く）②`launchctl bootout gui/503/<label>`（yuya は不可、_kaburun
  か管理者。即時だが実行中の子は S1/S2 が別途止める）。実行中の子そのものは sandbox＋S1/S2 の期限で必ず止まる。

### 15.6 非特権 vs 一度きりの特権（GO）
- **非特権（別TASKで実装・テスト可）**: 常駐ループ本体（flags確認→accept→auth前チェック→Agent起動→out記録）。
  スタブ起動は代役で差し替え可能にして E2E テストする（実 CLI もログインキーチェーンも使わない）。
- **一度きりの特権（各別途GO・yuya/管理者が実行）**: handoff/ の作成と ACL 付与、LaunchAgent の登録（bootstrap）、
  _kaburun への固定版 CLI の配置と初回ログイン。sudoers 変更なし・_kaburun は非管理者のまま。

### 15.7 未解決（実装前に決める）
1. **request の署名境界**: Agent は request を runner/agent 鍵で独立検証する。ジョブに載せる request を誰がどの鍵で
   署名するか（yuya 側 control.try_claim で署名して渡す／_kaburun 側 runner 鍵で作る）を決める。control 側 CLAIM
   （ledger）と handoff 側 claim マーカーの二重 CLAIM の関係も整理する。
2. **共有する状態の所有権**: registry・logs（署名チェーン）を _kaburun が書くなら、その置き場の所有権と、yuya が
   finalize で読む経路を決める（out/ 経由にするか、ACL 共有にするか）。finalize は human/runner 鍵＝yuya 側なので、
   実行プレーンが書いた端末状態を yuya がどう受け取り署名するかが要点。
3. **auth 前チェックの位置**（15.4-3 の CLAIM 前／後）。
4. **ログイン維持**（再起動後の再ログイン・自動再ログインの可否）はセキュリティと両睨みで要検討。
5. 実 -p の1回ドライラン（指摘3）後に、~/.claude の許可/拒否を最終確定。

### 15.8 ループ本体の実装（TASK 37）
§15.4 の1周期を g10runner/resident.py に実装した（非特権・代役で E2E 可）。実 CLI もログインキーチェーンも使わない。
- `ResidentLoop(inbox, flags_dir, out_dir, cli_realpath, home, dispatch, auth_check, now, log_path)`。
  flags_dir は source dir（yuya 書き・group/other 不可）、out_dir は _kaburun 所有として検査（handoff.py と同じ規則）。
- `step()` の順序（fail-closed）: ① flags/HALT・STOP があれば止める（**認証確認すらしない**）→ ② 固定版 CLI で
  `auth_check`、未ログインなら accept 前に止める（**承認を消費しない**＝§15.7 Q3 の決定）→ ③ in/ の候補を名前順で
  1件 `HandoffInbox.accept`（検証＋at-most-once CLAIM）→ ④ `dispatch(decision)`（実行プレーンへ。注入）→
  ⑤ 結果を out/ に書く（本文・秘密・メール不可）→ ⑥ 記録。dispatch が例外でも「このジョブは終わり」として扱い、
  CLAIM 済みなので次周期で再実行しない。
- `run(max_cycles, interval, sleep)`: 常駐。HALT/STOP では起動しないが周回は続く（フラグが消えれば再開。恒久停止は
  launchctl bootout）。1インスタンス＋同期 dispatch なのでランは常に1本。
- **§15.7 Q1/Q2（request の署名境界・共有状態の所有権）は `dispatch` シームの内側に切り出した**。本体はそれに依存
  しないので、この2点の決定は dispatch の実結線（次段）まで保留できる。テストは代役の dispatch を注入して本体を固定。
- テスト: test_task37_resident（12）。変異2件（HALT が起動を止めない／未ログインでも起動する）を追加しすべて killed。
- 残り（次段）: `dispatch` の実結線＝ジョブの request を実行プレーン Agent が検証できる形にして
  agent.handle_request_file → スタブ起動 → 終端待ちにつなぐ（Q1/Q2 をここで決める）。その後に一度きりの特権 setup。

### 15.9 dispatch の実結線（TASK 38）＋ Q1/Q2 の決定
§15.8 の `dispatch` シームを実行プレーンに結線した（g10runner/resident.Dispatcher）。

- **Q1（request の署名境界・二重CLAIM）決定**:
  - yuya（制御）が `control.try_claim` を回し、runner 署名つきの request 封筒 `{"request":..., "sig":<runner>}` と
    ledger CLAIM を作る（GitHub 取得・witness・CONFIRM/ENVELOPE・policy・runner 鍵は yuya 側だけ）。
  - その封筒を handoff ジョブの `request_doc` に載せ、ジョブ全体を human 署名して in/ に置く（handoff.py を更新:
    ジョブは `request` でなく `request_doc`＝封筒を運ぶ。handoff は封筒を不透明に運び、改ざんはジョブの human 署名で
    防ぎ、GO との一致だけ見る。封筒の中身＝runner 署名・結合・権限は Agent が独立検証）。
  - _kaburun（実行）の Dispatcher は封筒をそのまま実行プレーンの request_file に置き、`agent.handle_request_file`
    でスタブを起動して終端まで待つ。
  - **CLAIM は3層で、それぞれ別の再送面を塞ぐ（冗長ではない）**: ①制御 ledger（approval ごと・try_claim）
    ②handoff の claim マーカー（受け取りごと・_kaburun）③Agent の used ログ ACCEPTED（request/approval/run ごと）。
- **Q2（共有状態の所有権・finalize への受け渡し）決定（方針。finalize 改修は次段）**:
  - 実行プレーンの used ログ・registry・run_dir は _kaburun が所有する場所に置く。結果（端末状態・diff・ローカル
    REPORT 下書き）は handoff/out に出す。
  - yuya の `finalize`（human/runner 鍵）は out/ から終端を受け取って署名・REPORT 化する。**この finalize の out/
    経由への改修は次段**（本TASKの E2E はモックの同一レイアウトで、Dispatcher が終端状態を返し、yuya 側 finalize が
    同じレイアウトを読む形で ended_checks_passed を確認している）。
- **Dispatcher**: `Dispatcher(agent, layout, wait_seconds)(decision)` = 封筒を request_file に atomic 書き込み →
  handle_request_file → stub.wait → registry が終端になるまで待ち、`{run_id, status, used_states}` を返す。
  not_accepted（署名・結合・権限・CLAIM で弾かれ）も status で返す。
- テスト: test_task38_dispatch（3・E2E）: ①human 署名ジョブ＋runner 署名 request＋source_bundle で、**元 repo を消しても**
  ResidentLoop→Dispatcher→Agent→スタブ→代役CLI→終端 ended_checks_passed・CLI 1回・out/ 記録、②配送中に request を
  改ざん→handoff の human 署名で skip（起動せず CLAIM せず）、③同じジョブは claim 済みで再実行しない。
  handoff の request_doc 封筒チェックに変異1件（envelope 未検証）を追加し killed。
- 残り: Q2 の finalize を out/ 経由にする改修、その後に一度きりの特権 setup（ACL・LaunchAgent・固定版CLI、各別途GO）、
  実 -p の1回ドライラン（指摘3・要GO）。
