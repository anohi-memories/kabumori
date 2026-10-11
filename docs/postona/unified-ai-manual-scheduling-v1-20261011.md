# POSTONA AI自動・手動予約 統合スケジューラ V1 — 保存と投稿の将来仕様（2026-10-11、G3）

- 今回の実装は **ローカルのプレビューだけ**（投稿予定タブ + 計画ロジック `apps/social-mobile/src/domain/schedule-planner.ts`）。
  - DB への書き込み・予約の作成・X への投稿・同意の付与は一切しない。
  - 画面には「プレビュー／未予約・投稿されません」と「再起動すると消える」を表示する。
- この文書は、プレビューを実際の「予約」と「投稿」につなぐときの仕様。**実際のクラウド保存と投稿は BLOCKED**（§8 の条件がそろうまで）。新しい migration は今回作らない。

## 1. 正本（source of truth）

- 予約の正本は、**サーバー側の新しい表**（例: `public.social_post_plans`）にする。端末の状態は、どれも表示用の写しとして扱う。
- 今の `scheduled_posts` は、AI ラボ・かぶモリ用の **ブランド単位** の待ち行列。
  - **アカウントとの結びつきが無く**（`social_account_id` が無い）、`unique (schedule_date, post_type, slot_no)` の制約もある。
  - 利用者が書いた本文、プレビューの元の計画、取り消しの状態は入らない。
  - → 手動の予約をそのまま入れない。新しい表で計画を持ち、実行の時点で「1 件の投稿の実行」を作る形にする。
- 案（列）:
  - `id uuid`、`brand_id text`（所有のワークスペース）、`social_account_id text`（**必須**、プラットフォームのアカウントに結びつける）、`platform text`
  - `origin`（`user_authored` / `ai_generated`）、`mode`（4 種類）、`batch_id uuid`、`seed bigint`、`revision int`
  - `text text`（手動のみ。AI は NULL）、`scheduled_at timestamptz`、`fixed boolean`
  - `state`（`planned` / `cancelled` / `claimed` / `published` / `failed`）
  - 同意の記録（§3）、`created_by uuid`、`created_at`、`updated_at`（版数）、`idempotency_key text unique`

## 2. 所有と権限（サーバーで判定する）

- 書き込みは、本人の JWT で呼ぶ **専用の RPC だけ**（表への直接の INSERT / UPDATE は渡さない）。
  - RPC の中で、`auth.uid()` がワークスペースの owner であること（`brand_memberships.role = 'owner'`）を確認する。
  - アカウントが **そのワークスペースの、本人確認済みの X アカウント**（G4 の本人証明）であることも確認する。
  - クライアントが送る `brand_id` / `social_account_id` は「選んだ値」としてだけ使い、権限の根拠にしない。
- 必ず確認すること:
  - **G5 の `x_autopost` 利用権が active**（予約の作成、実行の取得、X への投稿直前の 3 か所）
  - アカウントが削除中でないこと
  - G5 の T13 書き込みガード
- service_role を広げない。RLS を外さない。G4 / G5 のゲートを迂回する経路を作らない。

## 3. 同意（AI と手動は別の同意）

- **AI 相談の「これで覚えて」は、自動投稿の同意ではない。** 保存されるのは内容の好みとペルソナだけ。
- AI 自動投稿の条件（すべて必要）:
  - owner が設定画面で `approvalMode='auto_post_preference'` を選んでいる
  - 本人確認済みのアカウント、運用側の投稿権限（`x_account_publish_authority` の期間）、G5 の利用権
- 手動予約の条件: **予約ごとの明示の同意**（例: 「この内容・この日時で投稿する」を予約ごとに確認した記録 `manual_consent_at` と、そのときの本文のハッシュ）。
  - AI の包括的な同意は不要だが、G5 の利用権・所有・アカウントの正当性・プランの上限・取り消し・有効期限・プロバイダーの安全・監査は、AI と同じく必要。
- 手動の投稿は **AI の生成を通らない**（本文をそのまま使う）。ただし、**投稿の許可（§2）は必ず通る**。

## 4. 文字数とメディア（プラットフォームごと）

- 手動の本文: X の重み付きの文字数（全角は 2、URL は 23）で、標準アカウントは 280。Premium の上限はアカウントの属性で切り替える（将来）。
- AI 自動投稿: 今のサーバー側の方針（POSTONA の自動投稿は 140 コードポイント）は **AI の自動投稿だけ** のもの。X 全体の上限として手動にあてはめない。
- メディア・Threads・Instagram は別の検証規則（G4 / H1 の担当）。V1 は X のテキストだけ。

## 5. 実行と重複の防止

- 予約の作成は冪等にする（`idempotency_key` = 端末の batch id + 何件目か）。同じまとまりの再送は同じ行になる。
- 実行は、既存の `claim_due_post` と同じく `for update skip locked` で 1 件ずつ取得し、`state` を `planned → claimed` に版数つきで変える。
  - 取得のときに、取り消し・利用権・同意・所有をもう一度確認する。
- 取り消しと投稿の競合:
  - 取り消しは `state='planned'` の行だけを `cancelled` にする（版数つき）。
  - 取得のあとは取り消せない（「投稿中」と表示する）。
  - X への投稿の直前に、もう一度 `state='claimed'`、同意、権限を確認する（PR #41 の 2 回確認と同じ）。
- 重複:
  - 同じアカウントで、同じ本文が一定時間内にあるものは拒否（`published_content_fingerprints` を使う）。
  - 同じ時刻（最小間隔の中）の予約は、作成のときに拒否する（計画ロジックと同じ規則をサーバーでもう一度確認する）。
- 再抽選・競合の解消・並べ替え:
  - 端末の操作の結果を、サーバーに「この版から、この版へ」として送る。
  - 日時を指定した予約（`fixed`）はサーバーでも動かさない。
  - 再抽選で変わるのは、まだ取り消されていない柔軟な予約の**時刻だけ**。本文・並び順・ID・所有は変えず、取り消した予約は戻さない（端末のプレビューも同じ規則）。置き直せないときは、何も変えずにエラーにする。

## 5.1 現在の予約（`scheduled_posts`）の表示

- 本番の行は、アカウントとの結びつきが無い（ブランド単位）。画面は、これを選択中のアカウントの投稿として扱わない。
  - 「投稿先アカウント未特定／ブランド単位」として別に表示し、アカウントごとの競合の確認や再配置には入れない。
  - 別のブランドの予約は、そのワークスペースには出さない。
- AI の頻度と、所有者の同意の状態は、読み取ったブランドに結びつけて扱う。ワークスペースが変わったら引き継がず、読めないときは「初期設定／確認できません」と表示する。

## 6. プランの上限・巻き戻し・監査

- プランの上限（月の投稿数など）は、予約の作成と実行の両方でサーバーが数える。上限を超える作成は、はっきりエラーにする。
- 巻き戻し: 予約の表は計画だけを持つので、問題があれば `planned` をまとめて `cancelled` にできる（運用側の RPC、監査つき）。投稿済みの X の投稿は消さない。
- 監査: 作成・変更・取り消し・同意・実行・結果を、利用者の ID と版数とともに記録する（本文そのものは記録しない。ハッシュだけ）。

## 7. まだ配線しない、型だけの書き込み境界

将来のクライアントは、次の型の境界だけを通して保存する（**今回は実装しない。エンドポイントも無い**）:

```ts
/** Future, NOT wired: every call is refused until §8 is complete. */
type SavePlanRequest = {
  brandId: string;            // selector only; ownership is decided server-side
  socialAccountId: string;    // must be the workspace's own verified X account (G4)
  batch: { id: string; mode: ScheduleMode; seed: number; revision: number };
  posts: { localId: string; origin: 'user_authored'; text: string; scheduledAt: string; fixed: boolean;
           manualConsent: { confirmedAt: string; textSha256: string } }[];
  idempotencyKey: string;
};
type SavePlanResult =
  | { ok: true; planIds: string[] }
  | { ok: false; code: 'NOT_AVAILABLE' | 'ENTITLEMENT_INACTIVE' | 'ACCOUNT_NOT_VERIFIED' | 'CONSENT_MISSING'
      | 'SLOT_CONFLICT' | 'QUOTA_EXCEEDED' | 'STALE_REVISION' };
// V1: the only implementation returns { ok: false, code: 'NOT_AVAILABLE' } and the UI offers no save button.
```

- AI 自動の枠は、この境界では送らない。AI の自動投稿は、§3 の同意と運用側の権限で、サーバーが計画を作る。

## 8. 公開の条件（すべてそろうまで BLOCKED）

1. G5: `x_autopost` 利用権の確認関数、削除順の契約、T13 の書き込みガード（本番に適用済み）
2. G4: X アカウントの本人証明と、ワークスペースの作り方
3. G3: §1〜§7 の migration・RPC・Edge のソース（レビュー済み）。PR #127 の Stage 3B 3 本との順番も含む
4. G3 + G4 + G5 をまとめた、独立のセキュリティレビュー（Sol 高）を 1 回
5. ユーザーが承認した、本番への適用と限定パイロット（専用のテスト用アカウント 1 件、短い期間）

## 9. 守るもの

本番の `stock-x-autopost` の予定、AI ラボ・かぶモリの X 自動投稿、その Cron・Vault・秘密情報・過去の投稿、G5 の一時的な写真用 Supabase、H1 / G4 のブランチ。今回はどれも変更していない。
