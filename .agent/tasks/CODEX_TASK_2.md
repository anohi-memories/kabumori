# Codex Task 2

- task_id: social-mobile-app-phase15-conversational-proxy-ai-and-history-learning-candidate-20260922
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Luna
- purpose: Phase14 C2 PASS済みのtenant-safe content settings基盤を前提に、一般ユーザーが「自分の代打AI」と会話して投稿スタイルを覚えさせ、その内容を安全に永続化できるsource candidateを作る。過去X投稿学習は明示同意付きの取得・分析設計/候補まで進めるが、production X API call・live publishはまだ行わない。

## Product goal

主役は設定フォームではなく **「あなたの投稿AI / 代打AI」**。

ユーザー体験:
1. ユーザーがAIと自然に会話する
2. AIが「どういう投稿をしたいか」「どんな口調か」「何を避けたいか」を理解する
3. AIが理解内容を分かりやすく提示する
4. ユーザーが「それでOK」「そこは違う」と会話で修正する
5. 確認された内容だけpersona/content settingsへ保存する
6. 以後のpreview生成で同じAIがその学習内容を使う

最終的なニュアンスは「設定したAI」ではなく、
**自分を理解したAIが、自分の代打としてSNS投稿を考えてくれる**。

## Mandatory fresh start

H2開始時:
1. `git fetch origin main`
2. fresh `origin/main`
3. `.agent/ORCHESTRATION.md`
4. `.agent/CURRENT_STATE.md`
5. this TASK
6. `.agent/CODEX_REPORT_2.md`
7. 他3slot overlap確認

latest TASK statusだけを開始判断に使う。
H1/G1/G2と同じfile/migration/RPC/function/workflowを触る可能性があればSTOP。

## Model policy

- **Lunaで開始・継続**
- Solは、Auth/RLS/persona persistence/X OAuth token boundaryなどの具体的security blockerが出てLunaで安全に解決できない場合のみ
- UI/通常実装/テストだけでSolへ上げない

## Scope A — Phase14 contract integration

Phase14で確定したcanonical persistenceを維持:
- `social_mobile_content_settings.settings`
- `persona_profile` = bounded derived style signals only
- `persona_provenance`
- `persona_confirmed`
- `persona_last_analyzed_at`
- `persona_last_analyzed_count`

Application-side `source` / `confirmed` は dedicated DB columns から明示的にmapする。
`persona_profile` 内へ contradictory metadata を二重保存しない。

Phase14 migrationはsource candidateのまま。production applyはこのPhaseでは禁止。

## Scope B — conversational AI service candidate

現在のdeterministic `content-settings-conversation.ts` を、将来LLMで会話できる境界へ整理/実装する。

必要なcontract:
- current persisted settings/personaをinputとして渡せる
- user utteranceを受ける
- assistant reply
- proposed settings delta
- proposed persona delta
- follow-up questions
- provenance
- confidence/uncertainty where useful
- requiresConfirmation
- explicit history-learning intent
- publish permission change = always false

AI出力はuntrustedとしてvalidateする。
AIが勝手に:
- publish enable
- account selection変更
- OAuth
- scheduler/Cron
- X post
を実行できないようにする。

Source candidateでは実OpenAIを使うなら dedicated preview-style no-side-effect pathに限定。
Production deploy/invokeはまだ禁止。

## Scope C — conversation persistence model

ユーザーとの会話をどこまで保存するか決める。

優先方針:
- 永続化の正本は confirmed structured settings/persona
- 生の会話全文を無期限保存する前提にしない
- 必要なら短期/限定の conversation summary / last-turn context を別責務で持つ
- sensitive data / tokens / credentialsを保存しない

実装候補として:
- confirmed proposalだけ settings/persona へcommit
- unconfirmed proposalはclient local stateまたはbounded pending state
- user correctionが最新提案をoverrideできる
- 「保存する」前にAIが理解内容を日本語で要約する

tenant ownership/RLSをPhase14より弱めない。

## Scope D — mobile UX

`あなたの投稿AI` を主画面として改善。

最低限:
- AIの吹き出し
- ユーザー入力
- 現在AIが理解している内容の短いsummary
- 提案内容の確認
- 「これで覚えて」/確認相当
- 修正会話
- 「過去の投稿を見て覚えて」intent
- history learningは確認画面を挟む
- 通常settings formは詳細設定/手動編集の補助位置

禁止UX:
- 自動投稿ON
- 今すぐ投稿
- publish enable toggle
- X historyを無断で読む動作

raw backend/OpenAI errorを画面へそのまま出さない。

## Scope E — past X post learning candidate

ユーザーが明示的に:
- 「過去の投稿を読んで」
- 「最近の自分っぽくして」
等と依頼した時だけ開始可能な設計。

### Audit

既存OAuth:
- current scopes
- token storage path
- authenticated user's X identity binding

X APIについてsource/docs/official evidenceで確認:
- authenticated user's own posts endpoint
- required scope(s)
- pagination
- max-results/rate-limit considerations
- excludes/retweets/repliesの扱い
- practical analysis count

外部仕様が必要なら最新X公式ドキュメントを参照し、ReportにURL/確認日を残す。

### Candidate architecture

history fetcher / analyzerをpublish pathから完全分離。

必須guard:
- authenticated owner
- selected workspace ownership
- exactly one identity-verified connected X account
- explicit user confirmation immediately before fetch
- bound max posts/pages
- no other account's history
- no raw token to mobile/client
- no automatic background fetch

取得した投稿からderive候補:
- tone
- sentence length
- punctuation/emoji
- recurring vocabulary
- topic signals
- hashtag habits
- CTA style
- opening/closing patterns

保存:
- raw post bodyを恒久保存しない
- confirmed derived persona + count/time/provenanceのみを基本
- temporary analysis payloadが必要ならprocess lifetime限定/明確なretention boundary

### This Phase boundary

Phase15では **production X API history call禁止**。
テスト fixture/mocked X responseでcandidateを証明する。
OAuth scope expansion/Portal changeも禁止。

## Scope F — preview integration

confirmed persona/settingsがpreview generationへ入ることを証明。

- unconfirmed personaはgenerationへ使わない
- corrected latest confirmed personaが使われる
- past-post-derived personaは `persona_confirmed=true` の時だけ反映
- settings/personaからpublish pathへ遷移しない
- existing `social_mobile_user_v1` guard維持

## Tests

最低限:
- conversation -> proposed structured changes
- proposal is not persisted before confirmation
- confirmation persists safe settings/persona candidate
- correction overrides prior proposal
- canonical DB columns -> application persona mapping
- persona_profile metadata duplicationなし
- unconfirmed persona not used in generation
- confirmed persona used in preview guidance
- explicit consent required for history-learning
- mocked history fetch only after consent
- cross-tenant/account request denied
- max page/post bound
- raw historical posts not persisted by candidate
- publish permission cannot be changed via conversation/history
- no X publish/media/schedule/Vault mutation path
- raw errors hidden in mobile UI

Run:
- relevant Deno tests
- social-mobile typecheck
- lint
- Expo export
- `git diff --check`

可能ならPhase14 disposable DB contractを使ってpersona mapping/write candidateもtest。
productionは使わない。

## Production boundary

Phase15は **source candidate only**。

Forbidden:
- Phase14 migration production apply
- production DB/RLS/ACL/settings/persona write
- production Edge Function deploy
- production OpenAI invoke
- production X history API call
- OAuth scope/Portal change
- Vault read/write
- X post/media/repost
- `publish_enabled=true`
- Cron/scheduler
- scheduled_posts
- app-wide data-source switch
- migration-history repair/reconcile
- blind db push

Production mutation = 0.

## Completion / C2

完了時:
- status -> `review_required`
- next_owner -> `chatgpt`
- `.agent/CODEX_REPORT_2.md` に:
  1. conversational AI architecture
  2. persistence/confirmation model
  3. canonical persona mapping
  4. past-X-history API audit
  5. changed files
  6. tenant/account isolation proof
  7. consent/retention boundaries
  8. preview integration
  9. tests
  10. production mutation=0
  11. remaining risks
  12. next rollout proposal
- commit/push
- fresh origin/main check
- STOP for C2
