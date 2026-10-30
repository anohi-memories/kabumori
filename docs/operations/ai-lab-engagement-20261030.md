# 会社員AIラボ：交流形式を約3割へ

H5第7TASK `ai-lab-conversation-mix-30pct-20261030`。管理・返却先は会社員AIラボ自動投稿設定変更の本チャット、完了コードC5。ユーザーが2026-10-30に方針と管理先を承認。推薦モデル：Codex Luna（高）。

## 挙動

既存のAI Lab `brand_post` 予約行数のローテーションを再利用し、10連続枠中7枠は従来の生成指示をそのまま使う。残り3枠は、経験を聞く質問、意見募集、本文中の2〜4択を1枠ずつ指定する。0始まりのindexの末尾が2、5、8の枠を使い、生成のやり直し中は形式を固定する。通常枠への追加指示はない。

確保済みの題材を保ちながら、読者が一言でも返せる具体的な問いを一つに絞る。自分語りの末尾への定型質問の追加、反応の強要・煽り、未提供の本人経験・進捗・実績の捏造を避ける。選択肢は投稿本文で表現する。実X poll APIは使わない。

題材の「開発日記約7割・振り返り約3割」は別軸であり、既存の題材選定・人格・文字数・ハッシュタグ方針は変更しない。配信時刻・回数、DB/schema/RPC、認証・Vault、topic claim、dedupe、配信・確定・冪等性の境界も変更しない。

## 比率の範囲

3/10は連続する予約枠の比率。候補不足・失敗・見送り・同時刻の予約や履歴削除などにより、実際に公開された投稿の比率とは異なる場合がある。既存count取得に失敗すると既存の予約時刻ベースfallbackを使うため、そこでは概算となる。実本文が問いとして自然かどうかは生成モデルに依存し、本文の機械的な質問判定・再生成条件は追加しない。

## 検証

- Deno 2.9.6 / TypeScript 6.0.3。
- 関係7スイート：118 PASS / 0 FAIL。`--deny-net`で実API・実SNSに接続せず、生成requestと配信callbackはfixtureで検証。既存workflow validatorのみNode子プロセスを実行。
- 新規5テスト：周期境界を跨ぐ7:3、3形式の分散、不正indexの通常枠へのfallback、通常promptの完全一致、交流指示と既存人格の保持、seed保持、retry feedbackと形式固定、他brandの拒否、実dispatcherの拒否→再生成→一度だけのmock配信を確認。
- 新helperとテストの型チェック・lint・format、`git diff --check`はPASS。
- `x-test-post/index.ts`全体の型チェックはFAIL。独立した変更前main `0ac6265998594d0b4104cda3e8ca642ac728cd55`でも同じ6箇所の問題を再現：`x_oauth2_post.ts`とindexのBufferSource、`morning_greeting_image_logic.ts`のBlobPart/BodyInit、`morning_greeting_logic.ts`のretry_count不足、`morning_lane_response_logic.ts`のtimestamp_precision。今回の変更箇所に新しい型エラーはない。全体チェック成功とは扱わない。
- 初回テストのfixture handle不一致を修正。既存のimport分離テストは、新AI Lab専用adapterを許可リストへ追加。既存のDeno依存テストはNode単独では実行できないため、最終判定にはDenoを使用。
- 実生成の文章品質、実際の公開比率、本番動作は未検証。課金API・production DB・SNS実投稿は未実施。

```sh
deno test --no-check --allow-read --allow-env --allow-run=node --deny-net \
  supabase/functions/_shared/brand/ai_lab_engagement_test.ts \
  supabase/functions/_shared/brand/ai_lab_scheduled_brand_post_test.ts \
  supabase/functions/_shared/brand/ai_lab_topic_dedup_test.ts \
  supabase/functions/_shared/brand/ai_lab_event_dedupe_test.ts \
  supabase/functions/_shared/brand/cross_brand_dedupe_test.ts \
  supabase/functions/_shared/brand/brand_post_generator_test.ts \
  supabase/functions/_shared/brand/brand_profiles_test.ts
deno check --node-modules-dir=none --cached-only \
  supabase/functions/_shared/brand/ai_lab_engagement.ts \
  supabase/functions/_shared/brand/ai_lab_engagement_test.ts
deno lint supabase/functions/_shared/brand/ai_lab_engagement{,_test}.ts
deno fmt --check supabase/functions/_shared/brand/ai_lab_engagement{,_test}.ts
git diff --check
```

## 本番反映

本TASKの範囲はsource/test candidateまで。merge/deploy前には、本チャットで対象PR/HEADと`x-test-post`への限定反映を明示承認し、freshなmain/本番配置差分、他slotの同じEdgeへの変更・mutation window、既存6型エラーのrelease判断を確認する。共有のEdge全体が配備されるため、無関係な未merge PRを含めない。承認された実write直前にwindowを開き、配置version/sourceのread-back後に閉じる。手動の試験投稿や課金生成は別途明示された場合のみ実施する。

rollbackは、この変更の導入直前に確認・保存した`x-test-post`配備version/sourceへの復帰を、同じ承認と競合確認の下で行う。mainの状態を現在の配備sourceと同一だと推測しない。
