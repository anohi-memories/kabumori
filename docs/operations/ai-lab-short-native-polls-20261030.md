# 会社員AIラボ：短い交流投稿とネイティブ投票

H5第9TASK `ai-lab-short-engagement-native-polls-20261030`。推薦モデル：Codex Sol（高）。管理・返却先：本チャット、完了コードC5。

## 変更

交流枠（既存10枠中3枠）の本文を60〜100文字目安、ハッシュタグ込み最大120 Unicode codepoints、空行込み4行以内へ変更する。長い前置き・本人の体験説明を削り、問いを先に伝える。通常7枠は従来のrequest/prompt/長さを維持。端末・文字サイズ・X側UIで表示範囲が異なるため、あらゆる画面での一画面表示を保証するものではない。

選択肢枠（10枠中1枠）は、本文A/B/C形式からXのネイティブ投票へ。2〜4択、各1〜25文字、空白ラベル・改行/制御文字・前後空白・NFKC/case正規化後の重複を拒否し、既存のX送信処理の`poll.options`へ渡す。既存の投票期間1440分（24時間）を使う。質問本文と選択肢は同じ1回のPOST `/2/tweets`で作成する。

投票数・結果はX標準UIで確認する。独自のDB集計・dashboard・票数取得API呼出は追加しない。Xの投票では投票者個人を特定できない。

## 生成と送信前検証

共通generatorに任意の`outputSchema`を追加し、未指定時のrequest/promptを維持する。AI Labの選択肢枠だけstrict JSON schemaで`text`と`poll_options`を分け、JSON構造もローカルで検証する。公開するのは解析済みの`text`と検証済み投票ラベルであり、JSONは投稿しない。

新しいguardが短文の長さ・行数と投票内容を検証し、既存の内容再生成ループへ統合する。不正なJSON、長文、過剰改行、投票形式違反は同じ確保済みtopicと同じ形式で最大3回まで修正し、尽きたら送信せず既存claimを解除する。不完全/空/拒否/APIエラーは既存generatorの停止を維持。投票を本文だけの投稿へ置き換えるfallbackはしない。

送信直前にもguardを実行し、選択肢はprovider開始前にsnapshotする。既存のexact-account Vault、provider_started/ambiguous/settle、確定済みX投稿の再送防止、cross-brand fingerprint処理を維持。通常投稿のdispatch結果も従来の形を維持し、投票時だけ`pollCreated:true`が付く。本文以外の選択肢をfingerprintへ追加する変更は行わない。

## 検証

- Deno 2.9.6 / TypeScript 6.0.3。
- 関係7 suite：124 PASS / 0 FAIL（deny-net、provider/SNS fixture）。交流suiteは11件、境界・不正値の組合せも検証。
- strict schemaのrequest、seed/人格/通常request完全一致、3形式の7:3配分、120文字/4行、Unicode・CRLF、通常300文字許容、invalid mode、他brand拒否、本文と投票ラベルの分離、異常JSON/option数/空白/重複/制御文字/25字超、上限3回・no-X・claim解除、既存dispatcherのretryと一度だけの配信callbackを確認。
- 新helper/guard/test、変更したdispatchの型チェックPASS。新規/変更helperのlint・format PASS、diff-check PASS。
- entry全体は変更前と同じ6箇所の型エラーでFAIL。X復号のバイト配列2、画像のバイト配列2、挨拶retry_countの型1、朝刊timestamp_precisionの型1。今回の追加箇所の新規型エラーなし。これら6件は未修正。
- 実API生成・実native poll作成・票数取得・新たな実投稿・本番反映は第9TASKでは未実施。

## 反映時の注意

本番v146はmainと無関係な差分がある。反映時はfreshな本番sourceを基準に、今回の4変更source（engagement/generator/dispatch/entry）と新規guardだけの差分を適用し、他のsource/verify_jwt/Cron/Auth設定を維持する。main一括配備や旧TASKの実投稿1回承認の流用はしない。別の限定release TASK・対象変更のユーザー承認とpreflight/mutation window/read-backが必要。

## 公式仕様

- [X Manage Posts: Post with poll](https://docs.x.com/x-api/posts/manage-tweets/introduction#post-with-poll)
- [X Create or Edit Post](https://docs.x.com/x-api/posts/create-post)
- [X Polls help](https://help.x.com/en/using-x/x-polls)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)
