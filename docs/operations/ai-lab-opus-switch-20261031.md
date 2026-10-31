# 会社員AIラボ：Opus 5.5切替候補

対象TASK: `ai-lab-opus-switch-source-20261031` / H5 / Codex Sol（高）/ 返却先は依頼元チャット / C5。

## 動作

`x-test-post`の`ai_salaryman_lab` scheduled `brand_post`だけ、既存の共通AI Providerを介して`claude-opus-5-5`へ送る。ほかのbrand、POSTONAの生成、かぶモリの経路は既定のOpenAIのまま。モデルの選択はサーバーの固定コードで、リクエスト本文から指定できない。

通常投稿は1話題・気づき1つ、200〜300字程度を目安にし、説明の言い換え反復、毎回の教訓的な締め、未提供の近況や属性の説明反復を抑える。必要な事実が多い場合の長文は可能。10枠中7通常・3交流、交流120字/4行、X標準投票2〜4択・各25字・24時間は維持する。

`generateBrandPost`にはサーバー専用のtext provider portを追加した。注入しなければ既存のOpenAIリクエストと費用計算は不変。共通の人格・投稿可否・文字数チェックを通した後のportであり、provider側でもAI Labとbrand_post以外を送信前に拒む。

## 接続・失敗時

- 既存のAnthropic SDK/adapter/execute/JSON検証/費用計算を再利用。SDKは既存の`0.132.1`固定。
- AI Lab専用server secretは`AI_LAB_TEXT_API_KEY`。既存の共通`ANTHROPIC_API_KEY`へfallbackせず、値を上書きしない。
- Opus固定、effort low、transportは1回のみ。拒否・途中切れ・不正JSON・通信結果不明時は生成失敗として停止し、OpenAIへfallbackしない。
- 1dispatchで同じInMemoryBudgetGuardを共有し、content再生成を含め3回・0.45 USD・1回0.15 USD以下に制限する。これは1実行の上限であり、本番月次台帳やAnthropicのクレジット残高の管理ではない。
- Vault・claim・X結果不明時の保護・fingerprint・完了手順は変更しない。
- Provider隔離テストは`x-test-post/index.ts`から専用wrapperへの1importだけを許可し、他の入口・直接SDK/キー読取・広いimportを拒否する負例を維持。

## 検証

- 関連brand 7suite＋共通provider回帰: 252 PASS。
- 本番v147へ今回差分だけを重ねたartifact: 対応する5suite 64 PASS。
- 変更moduleと新testの型/lint/format、diff検査PASS。
- entry全体の型検査は既存6件のエラーが残る。今回差分による新規エラーはなく、全体型PASSとはしない。
- 実API非公開検証2回: 通常294字、投票101字/4行/4択、両方guard PASS。modelは両方Opus5.5。費用見積合計0.028152 USD、retry0。キーalias追加前の接続で実施。aliasの別名解決とfallback拒否はdeny-netで検証済み。
- 日付固定の既存cross-brandテスト1件は、古いdiary日付を24hの最近fingerprintに使っていたため、fingerprint時刻だけ現在時刻へ修正した。productionのguardは変更しない。

## 反映前の確認

このsource TASKではmerge/deploy/本番secret追加/実SNS投稿は実施しない。依頼元へ具体的PRと以下の範囲を示して承認を確認する。

1. このPRをmainへmerge。
2. すでに試作に成功した600権限の既存キーを、`AI_LAB_TEXT_API_KEY`へ登録。新しいAPIキーを作らず、値を表示・Git保存・ログ出力しない。共通キーは維持。既存の同名設定があれば上書きせず再照合。
3. `stock-x-autopost` / `wsmznyzcvmuitkglfeuj` / `x-test-post`へ限定artifactを反映。現在本番のsource/バージョンと競合を直前再照合し、無関係main差分を含めない。`verify_jwt:false`は元設定を維持。
4. 設定追加は他functionのversion metadataにも影響する可能性があるため、短いmutation window内で直列実施し、コードと設定名/hashだけをread-back。キー値を読み戻さない。
5. 実投稿を追加せず、次の既存予約投稿の結果で本番接続・Opus使用・完了を確認する。API無料クレジットはユーザー確認済みだが、今回のusage見積を請求額や残高と同一視しない。

## artifact / rollback

依頼元workspaceの`artifacts/ai-lab-opus-switch-20261031/`に本番v147の`baseline.json`、今回差分の`release-artifact.json`、`manifest.json`、非公開試作文を保存。全66fileのうち元47fileはbyte不変、既存変更はentry/generator/engagementの3file、新規16fileはProvider依存15fileと既存X refreshのtype-only依存1file。後者はget-edge-functionの取得sourceに欠けていた既存import先をmainの無変更sourceで補ったもので、新しいruntime callerは追加しない。APIキー値は含めない。

反映失敗時は、承認範囲内の復旧としてv147 baselineへ戻しread-backする。新設secretの撤去は他の利用がないことを確認してから。既存共通secret・他slot設定・旧履歴は変更しない。
