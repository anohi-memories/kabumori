# 会社員AIラボのClaude二段階生成候補

H5第15TASKで作った二段階生成に、第16TASK `ai-lab-h5-16-meaningful-human-voice-rewrite-20261112` で文章構成の編集を追加したソース候補。先行する [PR #603](https://github.com/anohi-memories/kabumori/pull/603) の原案生成アダプターを使う。

## 実行条件

`x-test-post` の `ai_salaryman_lab` / `brand_post` の予約投稿だけが対象。サーバーの `AI_LAB_CLAUDE_TWO_STAGE` が `enabled` のとき、原案と文体編集をそれぞれ Claude Opus 5.5 に依頼する。未設定や他の値なら、`main` と同じ OpenAI 原案生成を選ぶ。Claudeには既存候補と同じ専用キー名 `AI_LAB_TEXT_API_KEY` を使う。ONでキーが欠落していれば、その予約を送信前に止める。

原案の既存検査を通過した後、本文と投稿形式、原文に対応する編集候補を別のリクエストへ渡す。候補には、定型の導入・結びの省略、隣接する同一説明の整理、一人称や冗長な動詞句の簡潔化、接続句を使った文の分割、文間の改行、語尾の調整がある。URL、数字・日付、引用、英字識別子、タグ、メンションと重なる候補は生成しない。候補以外の文字は、固有名詞・主張・質問を含めて元の位置と文字列を維持する。繰り返しの整理は事実を示す保護文字列を含まない同一の説明文に限る。

Claudeは `decision`、`text`、編集IDと選択番号の配列 `edits` を返す。編集IDを昇順で検証して原案から本文を再構成し、返却本文と照合する。原文のままの `keep`、読点や改行だけの編集、安全な候補で改善できない `review` は送信前に保留する。禁止された「。笑」の修復は文のつなぎ直しとして扱う。最終稿も既存の内容・形式・重複・送信ガードを通し、投票選択肢は編集に渡さず既存24時間の投票に使う。

第18TASKではClaude原案の冒頭に具体的な話を置き、文を短くし、文字数を埋めるための説明や教訓での締めを避けるよう指示を追加した。第2段は因果や確信の度合いを保てる決まった文脈で、読点の多い文の分割や語彙の簡潔化を提案する。保存済みの合成原案では「文に見えて、結局」を「文に見える。で、結局」、「詳しい経緯は本文に」を「細かい話は本文に」に変える候補を検証した。これはローカルの選択例で、Claudeによる実リライトや本人の文体評価は別工程。

第17TASKのユーザー指定により、友達と話すくらいの会話調、必要なときだけ「私」、一文の読点は最大1個、句点直後の「笑」を避ける方針を第2段に伝える。「私は、」の読点を落とし、語り手が文頭で明確な一部の自己説明では「私、」の省略を許可する。意味が曖昧になりにくい接続箇所だけで読点の省略を提案する。「。笑」は笑いの印として単独で使われている場合に「笑」「😂」へつなぐ。「😊」は原案の明示的な肯定感情に対応する文末で選べる。追加の絵文字候補は1投稿に1個まで。

編集IDと本文を照合した後、`edited`・`keep` の両方に読点数、主語直後の読点、句点と「笑」の組み合わせなどの検査をかける。引用・URL・タグ・メンション・構造化データ内はこの検査の対象外。文の途中の改行では読点数をリセットしない。保護領域の境界が不明、または候補の適用後も本文が規則に合わない場合は送信前に保留する。

架空の例では「まぁエラーはしょっちゅう出るし、AIが意味わからんことする時もあるけど。笑」を「まぁエラーはしょっちゅう出るし、AIが意味わからんことする時もあるけど😂」へ、「私、プログラミングなんてほとんどわからないんですよ。」を「プログラミングなんてほとんどわからないんですよ。」へ編集する。候補で表現できない言い換えや、事実を入れ替える自由な文順変更は保留対象。会話調の自然さ、主語が必要か、実際の編集率は本人の確認が必要。

## 呼び出し上限

同じdispatchで原案の内容再生成を最大3回、編集を最大1回とする。合算の事前見積上限は $0.60、原案側は既存の $0.45、各回は $0.15。原案25秒・編集20秒で、4回すべてが上限に達する場合のプロバイダー待機は合計95秒。1呼び出しにつきHTTP試行は1回で、失敗や通信結果不明を再送しない。利用量を取得できない応答は上限見積で計上する。既存の [Claude Opus 5.5 モデル単価](https://platform.claude.com/docs/en/models/opus-5-5/overview) を使う。アカウント月次予算・クレジット・実請求・ホスト環境の処理時間は別途確認が必要。

## 後続の反映判断

現行本番のモデルと配信中の `x-test-post` の版、スケジュール呼出しの実タイムアウト、月次の予算枠、専用キー設定名を反映前に照合する。本人文体の適合は、別途承認された検証で原案・最終稿を比較して判断する。実際の切替、設定、デプロイは別の本番作業として承認を得る。候補を導入後、`main` の OpenAI 経路に戻す切替値はフラグ未設定または `enabled` 以外。現行本番がその経路と一致するかは事前の照合で確定する。

## 非投稿プレビュー（第30TASK）

`ai_lab_voice_pipeline_test.ts` の `preview:` テストは、ネットワーク・キー・X送信を使わず、保存済みの合成原案（326字）と通常・交流質問・体験型・投票の代表例について、原案と編集後の全文を同時に出力する。出力は「合成サンプル・ローカル決定的編集」と明記され、実Claudeの出力ではない。実行: `cd supabase/functions && deno test --no-config --no-check --allow-read --allow-env --allow-net=none _shared/ai_provider/ai_lab_voice_pipeline_test.ts`。

最終稿の検査に、教科書調の導入（「結論から言うと」「大切なのは」等）と「以上が今回の話です。」型の締めの残存を追加した。候補で取り除かれなかった場合は、読点超過・「私、」・「。笑」と同様に `AI_LAB_VOICE_STYLE_REJECTED` で送信前に止まる。実Claudeの第2段は、ユーザーが対象・回数・上限を直接承認するまで呼ばない（今回は未実施）。

### 回帰の実行方法（第30TASK差戻しで確認）

- **Deno 広域**:
  - コマンド: `cd supabase/functions && deno test --no-config --no-check --cached-only --deny-net --deny-write --allow-read --allow-env --allow-run=node _shared/ai_provider/ _shared/brand/`
  - `--allow-run=node` が必須。`brand/ai_lab_event_dedupe_test.ts` の「(1)(2)(3) H1 CI」は、GitHub Actions の日記検証スクリプトを `node` の子プロセスで動かす。この許可が無いと、Deno の `node:child_process` が「Command failed: node --experimental-strip-types --input-type=module」とだけ返して 1 件が落ちる（コードの不具合ではない）。
  - 許可する子プロセスは `node` だけで、通信は遮断したまま。
  - `--no-check`: 型検査は変更ファイルを `deno check --no-config <file>` で個別に行う。`brand/brand_post_generator_test.ts` に既存の型エラーがあり、広域の型検査はそこで止まるため。
- **Node**:
  - コマンド: `cd supabase/functions/_shared && node --experimental-strip-types --test brand/ai_lab_engagement_test.ts brand/ai_lab_event_dedupe_test.ts brand/ai_lab_topic_dedup_test.ts`
  - 変更モジュールに届く `node:test` の試験のうち、Node でそのまま動くのはこの 3 本。
  - 残りの `ai_lab_voice_pipeline_test.ts`・`ai_lab_post_test.ts`（`npm:` の読み込み）と、`isolation_test.ts`・`ai_lab_scheduled_brand_post_test.ts`・`social_ai_model_policy_test.ts`（`Deno` の API）は Node では読み込めない。Deno 側で確認する。
