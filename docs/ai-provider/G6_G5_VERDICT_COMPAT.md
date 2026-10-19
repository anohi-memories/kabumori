# G6-04 G6 の G5 判定の口 × G5 の最新ソース — 突き合わせと接続前のゲート（source-only）

- task_id: `common-ai-g6-g5-auth-verdict-integration-boundary-preflight-20261019`（Issue #321、G6-04）
- 作成: 2026-10-19。**本番 NO_GO・deploy しない・どこにもつながない**。
- G5 の根拠:
  - Draft PR #340 head `80b90bd9d4030873f876a1d3d60c621f9a6173a2`
    - `supabase/candidates/common_account_postona_authz/verdict.ts`（blob `e8ec7e716af2cbd760bf1b31970cbff0588e3812`）
    - `docs/common-account/g5-01-postona-entitlement-auth-boundary.md`
  - Issue #320 の REPORT 6265676739、今の G5 TASK `common-account-g5-postona-authorization-verdict-rpc-preflight-20261019`（ready）
- G6 の前提: PR #338（G6-03）。この PR はその上に積む。

## 0. まとめ

- G5 は G6 の判定の形（v1）を**そのまま採用**し、そのうえで細かい決まりを足していた（下の表）。
- **G5 の判定の RPC はまだ無い**。`public.common_account_authorization_verdict(p_app, p_feature, p_brand_id)` は G5 の文書 §6 の設計だけで、作るのは Codex Sol（高）のゲートの後の別 TASK。
- そこで G6 側は、次の 3 つをした。
  1. 見つかった食い違いを G6 の中だけで直した（§2）。
  2. その RPC を呼ぶ部品（`g5_rpc_transport.ts`）を、G5 の設計どおりに作った。**どこにもつないでいない**。
  3. RPC が無い今は、必ず送信 0 になることを示した。
- G5 の**実際のコード**を作業用のフォルダで動かし、G6 の口と突き合わせた（§3）。G5 が断るのに G6 が許すもの: **0**（直す前は 2）。

## 1. 突き合わせの表（G5 のソース × G6）

| 項目 | G5（PR #340 の行） | G6 の直す前（PR #336〜#338） | G6 の今（この PR） | 状態 |
| --- | --- | --- | --- | --- |
| 判定の形 | `WIRE_KEYS` 79 行、v1 | 同じ 10 キー | 同じ | 一致 |
| 許可の有効期間 | `ALLOW_TTL_MS = 60_000` 81 行、許可は `now + 60 s`（191 行）、拒否は `expires = issued`（115 行） | 最長 5 分まで受け付けた | **最長 60 秒**（`G5_ALLOW_TTL_MS`）。設定でも広げられない | 直した |
| 持ち主の世代 | `ownerEpochToken` 98 行 = `g5oe:<owner epoch>:<lifecycle_version>`。受け取り側は `^g5oe:[1-9]…:[1-9]…$`（244 行） | どんな記号でも受け付けた | **同じ形だけ**（違えば `unknown` / `OWNER_EPOCH_SHAPE`） | 直した |
| 許可に理由（reason）が付く | 受け取り側で拒否（230 行 `WIRE_REASON`） | 受け付けていた（**G6 の方が甘かった**、§3 で発見） | 拒否（`unknown` / `WIRE_REASON`） | 直した |
| 主体 | 利用者だけ（236 行）。運営の仕事には答えない（kabumori / miseiro は `FEATURE_NOT_ENABLED`、121 行） | system の許可も受け付けた | **G5 からの system の許可は拒否**（`SYSTEM_SUBJECT_NOT_FROM_G5`）。運営の仕事の口は別に設定するときだけ（`acceptSystemSubject: true`） | 直した |
| 世代（送る直前に比べる値） | `[user_id, session.ref, owner_epoch, 全部の利用権]`（255 行） | `[owner_epoch, session ref, プランに関わる利用権だけ]` | **G5 と同じ要素**（利用者・セッション・持ち主の世代・全部の利用権） | 直した |
| 再確認での本人 | RPC は主体を JWT（`auth.uid()` と `session_id`）だけから取る（文書 §6、111 行） | 再確認では JWT を G5 側に渡していなかった（このままでは G5 は再確認に答えられない） | **同じ JWT を、口の中にだけ持って渡す**（記録・ログ・世代には入れない） | 直した |
| 時刻 | RPC は時刻を返さない。Edge が付ける（文書 §6） | 時刻は G5 から来る前提 | 部品（transport）が付ける（許可は 60 秒、拒否は 0 秒）。時刻付きの答えは RPC の答えではないので受け付けない | 作った（つないでいない） |
| セッションの参照 | `sessionRef` 89 行 = `s:` ＋ 32 桁（ID そのものは送らない） | 記号の形なら受け付ける | 同じ（形は合う） | 一致 |
| ブランド ID | `BRAND_ID = ^[a-z][a-z0-9_-]{0,63}$`（78 行） | 呼び出し口のブランドは `^[a-z][a-z0-9_]{1,40}$`（`ai_calls.brand_ref` と同じ） | 変えない（G6 の方が狭い＝運べない ID は送らない。POSTONA の `u_` ＋ 24 桁は両方に入る） | G6 が厳しい |
| 機能 | `POSTONA_FEATURES` 24 行に consult / post_generation（owner・x_autopost） | 同じ名前 | 同じ | 一致 |
| 利用権 | `postona:x_autopost` だけを返す（35・179 行） | 同じ形、AI のプランの決まりは G6 | 同じ。利用権が無ければ G6 が `PLAN_NOT_ALLOWED`（G5 の受け取り側は形だけを見て許す） | G6 が厳しい |
| 判定の RPC | 設計だけ（文書 §6）。**まだ無い** | ― | `createG5RpcTransport`: `POST /rest/v1/rpc/common_account_authorization_verdict`、ヘッダに publishable の鍵と本人の JWT、本文は `{p_app, p_feature, p_brand_id}`。401/403 は拒否、404（RPC が無い）・5xx・つながらない・形が違う答えは「届かない」 | 作った（**つないでいない**） |

## 2. G6 で変えたこと（すべて G6 の持ち物）

- `supabase/ai_gateway/authority_port.ts`: 上の表の「直した」6 点。
  - `G5Transport.fetchRecheck(credential, scope, subject)` にして、再確認でも同じ JWT を渡す。
  - 許可の有効期間は最長 60 秒。
  - 持ち主の世代の形を確かめる。
  - 許可に理由が付いていたら拒否する。
  - system の主体は拒否する（明示した設定のときだけ受け付ける）。
  - 世代を G5 と同じ要素にする。
- `supabase/ai_gateway/g5_rpc_transport.ts`（新規）: G5 の設計どおりの RPC を呼ぶ部品。どこにもつないでいない。
- `supabase/ai_gateway/postona_consult_adapter.ts`: `G5_NOT_CONNECTED` は変えていない（今も既定）。
- テスト用の偽の G5（PR #336 / #338 のテスト）を、新しい形に合わせた。
  - 持ち主の世代を `g5oe:<n>:<n>` にした。
  - 再確認に JWT を渡す。
  - かぶモリの運営の仕事を通すテストには `acceptSystemSubject: true` を付けた（運営用の口の代わりであることを明示）。
- `supabase/tests/fixtures/g5_verdict_v1_rpc_samples.json`（新規）: **G5 の実際のコードが出した**判定の見本 20 件（時刻を除いた RPC の形）。出どころ（PR #340 の head と blob）を書いてある。G5 のコードそのものは入れていない。

## 3. G5 の実際のコードとの突き合わせ（作業用のフォルダだけ、commit していない）

G5 の `verdict.ts`（PR #340 head の blob `e8ec7e71…`）を作業用のフォルダに写して動かした。

- `decide()` で、許可 2 件と拒否 18 件の判定を作った（セッションの取り消しと期限切れ、退会中、凍結、未登録、準備中、停止、終了、所属していない、admin、owner が 2 人、世代が NULL、読めない、主体なし、kabumori・miseiro・知らない機能、など）。
  - 拒否 18 件は、すべて G6 でも同じ判定と同じ理由になった（G6 にプランが無い機能は、G5 に問い合わせずに `FEATURE_NOT_ENABLED`）。
- G5 の受け取り側（`acceptAllow`）と G6 の口に、同じ許可の判定とその改ざん 18 種類 × 2 機能 = 36 件を通した。
  - 結果は一致 34、**G6 が許して G5 が拒否 0**、G6 の方が厳しい 2（利用権が無いときはプランで拒否）。
  - **直す前は「G6 が許して G5 が拒否」が 2 件あった**（許可に理由が付いている場合）。§2 で直した。

## 4. 本番で相談機能をつなぐ前のゲート（共同。どれも未実施）

| # | 条件 | 担当 | 状態 |
| --- | --- | --- | --- |
| 1 | 相談機能の担当の確定と、`index.ts` を `handleConsultViaGateway` にすることへの同意 | 未確定（POSTONA） | 未 |
| 2 | G5 の判定の RPC の実装（§6）: STABLE・SECURITY DEFINER・`search_path = ''`・EXECUTE は authenticated だけ・主体は JWT だけ・1 文・時刻を返さない。ACL の隔離 PG の証明と Codex Sol（高） | G5 | 次の G5 TASK（ready）で設計中 |
| 3 | `g5_rpc_transport` を Edge に置くことと、共有 provider の `isolation_test.ts` の許可の一覧を広げること（Codex Sol（高）） | G6 | 未（G6-01 から STOP 中） |
| 4 | スマホのアプリが `Idempotency-Key` と `Content-Length` を付けること、新しいコードを扱うこと | G1 / G2 | 未 |
| 5 | AI のプラン（どの利用権で相談を使えるか）、運用の設定（版・モデル・上限） | 事業の判断 | 未決定（決まるまで使えない） |
| 6 | `ai_calls` の適用、台帳の枠の行、鍵、復旧の Cron、本物の OpenAI での答えの質 | G6＋承認 | 未 |
| 7 | 出し方: 最初は無効（`gateway: null`）。有効にするのは担当と承認がそろってから。同じ番号では送り直さない（`UNKNOWN` は送り直さない）。費用は台帳から読む | 全員 | 方針 |

## 5. 確かめたこと（すべて偽の部品か、隔離した DB での PASS）

| テスト | 数 | 中身 |
| --- | --- | --- |
| `common_ai_gateway_g5_compat_test.ts`（`--deny-net`） | 7 PASS | 見本の出どころ。G5 の見本 20 件が部品と口を通ったときの結果。要求の形（RPC・ヘッダ・本文。JWT 以外は送らない 7 通り）。答えの扱い（時刻・401/403・届かない 7 通り）。G5 の v1 に合わせた点（同じ JWT での再確認、60 秒、世代の形 3 通り、理由付きの許可、system、利用権と lifecycle の変化で世代が変わる）。**RPC が無い今の相談 → `CONSULT_AUTH_UNAVAILABLE`・送信 0・台帳と `ai_calls` も 0**。G5 の許可での相談の通し（判定と再確認が同じ JWT）。再確認で持ち主の世代が変わる・セッションが取り消される → 403・予約を返す・送信 0 |
| 既存（偽の G5 を新しい形に合わせた） | 10＋6＋8 PASS | PR #333 の実行用コード、G6-02 の E2E、G6-03 の相談 |
| 隔離 PG17（本物の台帳と `ai_calls` の SQL） | 4＋5 PASS | G6-03 の相談、G6-02 の E2E |

- わざと壊した写し: **16/16 を検出**（作業用のフォルダだけ）。内訳は、G6 の口 8、RPC の部品 8。最初は 1 通り見逃した（HTTP 500 なのに正しい形の本文）。テストを足して検出した。
- NOT_VERIFIED: G5 の RPC そのもの（存在しない）、本物の Supabase と managed の JWT・ロール・RLS、Edge での実行、本物の OpenAI、配置した相談機能。
