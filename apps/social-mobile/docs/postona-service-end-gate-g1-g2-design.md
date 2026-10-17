# POSTONA 利用終了の G1／G2 — 担当をまたぐ設計（F4・2026-10-16 JST）

TASK: `postona-f4-service-end-auth-gate-g1-g2-design-20261016`。設計と、まだ実装の無い受け入れテストだけを置く。ランタイムのソースは変えていない。F5 の利用登録の関門、H5 の本人確認、サーバーには触れていない。スイッチは OFF のまま、本番は NO_GO。

## 0. 結論

- **G2**（本人確認でアプリが作り直され、利用終了が終わらない）: 利用終了・共通ID管理の画面を、利用登録の関門の**外**に置く。関門はログインごとにアプリを作り直すので、その範囲から出す。本人確認で同じ人の新しいログインができても、画面は消えない。関門の審査済みの性質 S1（新しいログインは、自分の答えが出るまでアプリを開かない）は**そのまま**。
- **G1**（終了しても関門が「使える」のまま）: 画面は、送った利用終了に答えが返ったら、**その人だけ**を指す合図を1回出す。関門はその合図で、今のログインのトークンを使ってサーバーにもう一度聞く。合図そのものは、開ける・閉じるを決めない。決めるのは常にサーバーの答え。画面は関門の外にあるので、関門がアプリを閉じても、その人は自分の結果（Threads 側の許可が残る行、X の結果不明の件数）を見続けられる。
- 実装は F4（画面側の土台と画面）と F5（関門）に分ける。H5 にコードの変更は要らない（約束の確認だけ）。

## 1. 確かめた版

| 範囲 | 版 |
|---|---|
| 関門・画面・レイアウト・本人確認 | PR221 head `dcae62c6f61dc67372ea502a1cf5e7d1d598d852`（関門・画面・レイアウトは PR197 で変わった版） |
| サーバーの「最近の本人確認」 | F5 PR223 `28695586f63a30c739a44b829e79a7950932b5e7`（`supabase/functions/account-delete/lifecycle_logic.ts:207-210, 721`、`RECENT_AUTH_SECONDS = 600`。main と同じ値） |
| 関門の審査済みの性質 | `tests/service-enrollment.test.mjs` の S1「the app opened for login A1 closes for a new login A2 of the same person until A2's own answer」 |

## 2. G2 — いま何が起きるか

1. `/account-deletion` の「…で本人確認」が `confirmIdentity` を呼ぶ（`src/app/account-deletion.tsx:59-71`）。
2. その中の `reauthenticate` は、もう一度サインインする（`src/providers/auth-provider.tsx` の `reauthenticate`：メールは `signInWithPassword`、X・Google・Apple も新しいサインイン）。サーバーは「最近の本人確認」（`amr` が 600 秒以内）を求めるので、新しいログイン（新しい `session_id`）ができるのは正しい動き。
3. `onAuthStateChange` が新しいセッションを入れる。関門はログイン（`session_id`）単位なので（`service-enrollment-gate.tsx:58, 137`）、`loading` に戻り、アプリ全体（Stack とその中の `/account-deletion`）を外す。
4. `confirmIdentity` の続き（`setReauthed`／`loadPreview`）は、外れた画面に対して動くので何も残らない。新しいログインの答えが `ready` になると Stack は作り直され、最初の画面（ホーム）に戻る。
5. もう一度 `/account-deletion` を開くと、本人確認が済んでいないのでまた本人確認になる。**同じことが繰り返され、利用終了を送れない。**
6. 関門の未完了の画面に埋め込まれた削除画面（`deletionOpenFor`、`service-enrollment-gate.tsx:143-152`）は、関門が自分で描くので消えない。ただし、ふつうの入口（`login-methods` から `/account-deletion`）は上の流れになる。

## 3. G1 — いま何が起きるか

- 利用終了を送ると（`account-deletion.tsx:72-83`）、結果は画面に出る。
- 関門は、決まった答えを `reset()` まで使い続ける（`src/domain/service-enrollment.ts:245-293`）。これを触るものが無いので、次のログインまで `ready` のまま、POSTONA の画面が出続ける。
- サーバーの自動開始 `start_x_autopost_service` は、終了済みに対して `reenroll_required` を返す（自動では再開しない）。もう一度聞けば、正しく閉じる。
- 制約: 関門の中で閉じると、同じアプリの中にある結果の画面も一緒に消える。Threads 側の許可が残ることと、X の結果不明の件数は、本人が必ず見る必要がある。

## 4. 約束（契約）

**合図（G1）**

- 人ごとの数え上げ（`bump(userId)`）だけで、トークンも答えも運ばない。
- 画面は、利用終了の要求に答えが返ったとき、または送った後に例外になったときに、`pinned.userId` を1回だけ合図する。送る前には合図しない。
  - 送る前の拒否でもう一度聞いても、サーバーの答えは変わらない。そのため、答えの種類を画面で選り分けない。
- 関門は、自分が今表示している人への合図だけを受け取る。
  - 受け取ったら、手元の答えを捨てる（`reset`）。
  - 今のログインのトークンで、自動開始をもう一度聞く（再開ではない）。
  - 答えが来るまで、アプリは閉じたまま（安全側）。`active` なら開き、`reenroll_required` なら再登録の画面を出す（再登録は本人のクリックだけ）。
- 別の人への合図、サインアウトの後の合図、トークンの更新は、何もしない。
- 合図は、開ける・閉じるを自分では決めない。利用終了の結果を、使えるかどうかの根拠にもしない。

**画面の置き場所（G2）**

- 構成を `AuthProvider > SignedInApp > ServiceLifecycleProvider > [ ServiceEnrollmentGate(…アプリ…), ServiceLifecycleSurface ]` にする。
- surface は1人だけに開く（`openFor = userId`）。
  - その人の新しいログイン（本人確認）では開いたまま。
  - 別の人に変わったときやサインアウトでは、隠すだけでなく**閉じる**。
- 入口（`login-methods`、関門の未完了画面のリンク）は `open(userId)` を呼ぶ。関門の中にある別の写し（`<AccountDeletionScreen />`）と、ルート `/account-deletion` の中身は surface にまとめる（ルートは surface を開くだけにするか、無くす）。
- 本人確認をまたいだ続き。画面にすでにある守りがそのまま効き、新しい仕組みは足さない:
  - ログインが変わると、同意の入力と結果を消す（`renderBinding`）。
  - 本人確認済みの印は、`reauthenticate` が返した**新しいログイン**に固定する。
  - プレビューは本人確認の後に取り直し、新しいログインに結び付ける。古いプレビューは文脈が合わず、使い回せない（`LIFECYCLE_CHANGED`）。
  - 送るときのトークンは、その時点のセッションから読む。
  - 「最近の本人確認」の判定は、サーバーの 600 秒が正本。
- 二重の送信は、終了クライアントの `busy` と、使用済みプレビューで止まる（変更なし）。
- 別の人に見えないかは、PR217／221 の柵と surface の `openFor` で守る。
- 共通IDの完全削除は、今までどおり使えない（変更なし）。
- **S1 は変えない**: 関門の中のアプリは、新しいログインの答えが出るまで閉じたまま。

## 5. 選択肢の比較

| 案 | 中身 | 良い点 | 問題 | 判断 |
|---|---|---|---|---|
| **B（推奨）** | 利用終了の画面を関門の外の surface に置く。合図は人ごと。 | S1 を変えない。G1・G2 を形で解く。結果が関門の閉鎖で消えない。資格情報を保存しない。 | レイアウトの構成を変える（F5 の経路の約束に関わる）。入口を `open()` に変える。 | 採用 |
| A | 同じ人の新しいログインでは、アプリを外さず「操作できない状態」で残す（関門の変更）。 | 変更が小さい。 | 審査済みの S1（アプリを外す）を弱める。G1 の結果が関門の閉鎖で消える問題が残る。 | 予備 |
| C | 本人確認の記録（ID と時刻だけ、メモリのみ・1回限り）を F4 が持つ。画面を開き直したら戻す。 | 関門とレイアウトを変えない。 | ホームに戻されたら、本人が開き直す必要がある。本人確認に近い状態をクライアントに足す。G1 は解けない。 | 不採用 |
| E | 今のログインの認証時刻（`amr`）が 600 秒以内なら、本人確認済みとみなす。 | 状態を持たない。 | 画面の中での明示的な本人確認が無くなる。ロックされていない端末を、ログインの直後に他人が使えてしまう。 | 不採用 |

## 6. 担当への依頼

**F5（利用登録の関門）**

1. `useServiceLifecycleEpoch(userId)` を受け取る。
   - 値が変わったら `reset` して、今のログインでもう一度聞く。
   - 表示する答えに、どの合図の時点のものかの印（epoch）を付け、合わない答えは `loading` として扱う。
   - `retry`・`reenroll` の表示にも同じ印を付ける。
2. 関門の中の `<AccountDeletionScreen />` と `deletionOpenFor` を、`open(userId)` に置き換える。
3. 既存テストの直し:
   - `tests/service-enrollment.test.mjs` の関門の部品表に、新しいモジュールを足す（機械的な直し、19件）。
   - 経路の約束のテスト（`routing: …`）を、新しい構成に合わせる（意図した変更、1件）。
   - S1・R2・R4・S2 の意味は変えない。
4. 時期:
   - F5 Phase12 の審査が終わってから行う。
   - PR197 の関門の変更と衝突しないように、利用終了のスタック（PR221 以降）の上に積むか、そのスタックが入った後に行う。

**H5（本人確認）— コードの変更は不要。確認だけ**

- `reauthenticate` は同じ人であることを確かめ、新しいログインの正確な `{userId, sessionId}` を返す（新しいログインを作ってよい）。
- この約束を変える予定（たとえばログインを作らない本人確認にする）があるかを知らせてほしい。

**F4（自分）**

1. `src/features/service-lifecycle/service-lifecycle.tsx` を足す（Provider と、`useServiceLifecycle`／`useServiceLifecycleEpoch`。ID と数だけを持ち、トークンは持たない）。
2. `service-lifecycle-surface.tsx` を足す（`openFor` が今の人のときだけ描く。別の人やサインアウトでは閉じる）。
3. 画面で、送った後に `bump(pinned.userId)` を呼ぶ。
4. 入口（`login-methods`）を `open(userId)` に変える。
5. `_layout.tsx` の構成を変える（F5 の経路の約束に関わるので、F5 の確認を取る）。
6. 画面のテストの部品表に、新しいモジュールを足す（4件）。
7. `tests/pending/` の受け入れテストを、通常のテストに移す。

## 7. 順番と、本番までの関門

1. 統括がこの約束を承認する。F5 Phase12 の審査が終わるのを待つ（今は触らない）。
2. F4: provider、surface、画面の合図、入口、レイアウト。
   - この段階で G2 は解け、G1 の合図も出る。関門がまだ合図を受け取らないので、関門の古い `ready` は残る。サーバーの書き込みの guard が入るまでは、表示の問題として残る。
3. F5: 関門が合図を受け取る（G1 の完了）。関門の中の写しを無くす。
4. 実装の PR は、利用登録の関門と、本人確認をまたぐ画面という**新しい重要な境界**を変える。そのため、実装の PR には焦点を絞った独立レビューを1回入れる。この設計の文書には要らない。
5. 実機・管理された使い捨て環境で確かめる（未実施・別承認）。
   - 次の流れを確かめる: メール・X・Google・Apple の本人確認 → surface が残る → 利用終了 → 結果が見える → 関門がもう一度聞く → 再登録の画面。
   - 加えて、別の人とサインアウトの場面。
6. リリース:
   - F5 のサーバー（`account-delete`、セッションの柵の migration）を配備する。
   - 旧削除経路の封じ込めを読み戻す。
   - `POSTONA_END_SOURCE_ENABLED` は審査を経て入れる。

## 8. 受け入れテスト（`tests/pending/service-end-gate.pending.mjs`）

- `npm test`（`tests/*.test.mjs`）には含めない。実行するには `node --test tests/pending/service-end-gate.pending.mjs`。
- 中身は [SPEC] 5件と [CONTROL] 2件。
  - [SPEC]: 関門がもう一度聞くこと（2件）、レイアウトで surface が関門の外にあること、surface が同じ人の新しいログインで残り別の人で閉じること、画面が送った後にその人だけを1回合図すること。
  - [CONTROL]: 別の人への合図・トークンの更新では何も起きないこと、S1 が変わらないこと。
- **PR221 の現在のコードでは [SPEC] 5件が失敗し、[CONTROL] 2件が合格する**（修正前の再現）。
- 設計が満たせることを、捨てる試作（コミットしない）で確かめた。結果は次のとおり。
  - 受け入れテストは 7/7 合格。`tsc` と `expo lint` も合格。
  - 既存のテストでは、24件が失敗した（336件中 312件合格）。内訳は、テストの部品表に新しいモジュールが無いための失敗が23件（関門19件・画面4件）と、経路の約束の意図した変更が1件。どれも §6 の直しで対応する。
  - 試作は、関門・レイアウト・画面の3ファイルの変更（23行追加・26行削除）と、新しい2ファイル。

## 9. F4 の実装と、F5 への約束（2026-10-17 JST）

TASK: `postona-f4-service-lifecycle-provider-g1-g2-implementation-20261017`。この文書の PR230 head `e6725a165cd8f116a964926cdfceaa9334590491` の上に積む。F5 の関門（`src/features/service-enrollment/service-enrollment-gate.tsx`）とそのテスト、H5 の本人確認は変えていない。

**F5 が使う出口（正確な場所と型）** — `apps/social-mobile/src/features/service-lifecycle/service-lifecycle.tsx`（import は `@/features/service-lifecycle/service-lifecycle`）

```ts
export function ServiceLifecycleProvider({ children }: PropsWithChildren): JSX.Element;
export function useServiceLifecycleEpoch(userId: string | null): number;
export function useServiceLifecycle(): ServiceLifecycle;   // provider の外では例外
export type ServiceLifecycle = {
  readonly openFor: string | null;   // surface が開いている人。今サインインしている人以外にはならない
  open(userId: string): boolean;     // 今サインインしている人なら開いて true、それ以外は何もせず false
  close(): void;
  bump(userId: string): boolean;     // 今サインインしている人なら、その人の epoch を +1 して true、それ以外は false
};
```

- `useServiceLifecycleEpoch(userId)`:
  - 値: その人の数え上げ。最初の利用終了までは 0。`bump` のたびに +1。サインインしている間は減らない。`null` なら 0。provider の外でも 0 を返す。
  - 中身: 人の ID と数だけ。トークン、セッション、使えるかどうかの判定、プレビュー、同意は含まない。
- `bump` を呼ぶ場所と条件:
  - 呼ぶのは利用終了の画面だけ。
  - 条件は、サーバーの `ended`／`already_ended` の答えが、固定した人のそのログインに返ったとき（終了クライアントの柵が、そのときだけ `ok` を返す）。そのとき1回だけ呼ぶ。
  - 次の場合は呼ばない: `not_registered`、`RESULT_UNCONFIRMED`、拒否、`SESSION_CHANGED`、例外、プレビューだけのとき、本人確認だけのとき。
  - 人が切り替わった後に遅れて届いた `bump` は、provider が拒む。
- `open(userId)`:
  - F4 の入口（`login-methods`、初回案内）が使う。F5 の関門の「利用終了・共通IDの管理」も、関門の中の写しの代わりにこれを呼ぶ想定。
  - 別の人やサインアウトに変わったら、描画の時点で閉じる（戻ってきても開き直さない）。
- 置き場所: `_layout.tsx` で `<ServiceLifecycleProvider><ServiceEnrollmentGate>…</ServiceEnrollmentGate><ServiceLifecycleSurface /></ServiceLifecycleProvider>`。サインインの確認とパスワード回復の確認の後に置くので、サインアウトするとすべて外れる。
- surface（`service-lifecycle-surface.tsx`）:
  - 利用終了の画面を、関門の外の Modal に人ごとの `key` で描く。
  - 同じ人の新しいログイン（本人確認）では同じ画面が残る。画面は、古いログインの本人確認・同意・結果を捨て、プレビューを取り直す。
- F5 がつなぐのは1行だけ: F5 の `lifecycle-epoch.ts` から上の `useServiceLifecycleEpoch` をそのまま export する。F5 の関門側は、この PR を土台にして積む。

**F5 側に残ること**（`tests/pending/service-end-gate.pending.mjs` の [SPEC] 3件）

- 関門が合図でもう一度聞くこと（2件）。
- 関門の中の写しを `open()` に置き換えること（1件）。
- 関門のテストの部品表に、新しいモジュールを足すこと。
