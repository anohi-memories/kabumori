# AI Lab A/B/C ローカル通し試験台（第56TASK・非通信）

状態: ソース・mock限定。実API呼び出し0、課金0、Keychain読み取り0、X実投稿0、本番write0、merge/deploy 0。

## 何を試したか
`runLiveCompare`（第54/55の全体停止・予算・価格ゲート）の `runOne` に、実の `createAiLabTextStages`（adapter/SDK/transport）と実の `prepareAiLabVoiceRewrite`（出典grounding・文体判定）を接続した。モデル応答は**すべて明示的なfixture**で、fetchはプロセス内mock。モデル確認と有料エンドポイント以外のURLは `RIG_NET_REFUSED`。試験台にはX投稿段がなく、X payloadは構造上0。

- 実装: `supabase/functions/_shared/ai_provider/ai_lab_live_compare_rig_test.ts`（isolation_test の制約で `_test.ts` 名）
- 試験: `ai_lab_live_compare_local_rig_test.ts`
- 方式: A Opus→Opus / B Sol→Sol / C Luna→Sol、題材 10/09・10/10 各1回・2段（計12呼び出し、モデル確認3回）
- 予算・価格確認はfixture（`approvalRef: fixture-only:…`）。**本物のユーザー承認ではない。** 上限は provider保証のハードキャップではない（`client_estimate_not_hard_cap` を維持）。

## 予想テスト結果（mock fixture、A/B/C共通の結果コード）
| 題材 | fixture | 結果コード |
|---|---|---|
| 10/09 | 許される言い換え（Task53の自由書き換え。「ようにしてる」は決めたことの設計として根拠あり） | `READY_FOR_X_DISPATCH:edited` |
| 10/10 | 下書きは通るが編集段が無変更（keep） | `HOLD:AI_LAB_VOICE_REWRITE_REVIEW_REQUIRED` |
| 10/10 | 編集段が語句を変える自由書き換え | `HOLD:AI_LAB_VOICE_REWRITE_REJECTED` |
| 両方 | 下書きが未実施を実施済みとする／虚構（苦情1000人等） | `HOLD:AI_LAB_SOURCE_GROUNDING_REJECTED`（編集段は呼ばれず有料1回で止まる） |
| 10/09 | 編集段が「本番に反映して全員で動いてる」を足す | `HOLD:`（READYにならない） |

`READY_FOR_X_DISPATCH` は「実パイプラインならXへ渡す段に進む」の意味で、**本人文体PASS・実際の人間らしさ・題材の面白さは未評価**。

## fail-closed の確認（mock）
OpenAI無料確認401→有料0で全体停止 / 有料401・500・通信失敗・usage欠落→即停止・再送0・他provider0 / 別モデル応答→`PAID_MODEL_SUBSTITUTED` / 予算未承認・価格未確認・価格期限切れ・計画モデル不一致・呼び出し上限不足→リクエスト0 / fixture応答なし→停止。

## 気づき
ゲートは送信済みの本文をrun間でも再送扱い（`RETRY_REFUSED`）にする。BとCは編集段が同じSolなので、同一fixtureの下書きだと本文が衝突して止まる。実モデルなら下書きが異なるため通常は起きないが、fixtureでは方式ごとに空白だけ違う下書きを使う。

## 未確認（今回の範囲外）
実モデルの利用可否、現行公式価格、ユーザーの新しい費用承認。HTTP 200が示すのはOpenAIキー認証のみ。後続のMac対話確認と本人の明示課金承認が揃うまで、有料API比較は開始しない。
