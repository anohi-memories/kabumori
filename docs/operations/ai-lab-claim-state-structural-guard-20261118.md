# 第60TASK 出典の状態・節構造判定プロトタイプ（非課金・未結線）

- task_id: g6-ai-lab-claim-state-structural-guard-20261118-01
- 作成: 2026-11-18 JST（G6 AutoDev）
- 対象: `supabase/functions/_shared/brand/ai_lab_claim_state.ts`（新規）と `ai_lab_claim_state_test.ts`（新規）
- 積み先: PR #730 HEAD `e4f53fe4b4d19099a943c7eea0fe2ec3d95171ac` の上の独立Draft PR
- **本番の投稿経路には結線していない。** `ai_lab_voice_rewrite.ts`・runner・X投稿経路・Cron・Supabase には変更なし。
- 実API 0、課金 $0、Keychain read 0、X実投稿 0、外部依存の追加 0（正規表現と小さな語彙表だけ）。

## 1. なぜ作り直したか

第58〜59TASKの旧ガード（`ungroundedClaims` 内の `decisionTenseOverclaims` / `unsourcedOccurrences`）は、AutoReview #717 で反例が出るたびに正規表現の例外を足してきた。#717 最新（rv-g6-conservative-grounding-hold-e4f53fe4-20261118-02）は、節で区切る範囲・「ので、」の後ろ・「んだ、」・「たらしい」・て形の「は・も・から」・辞書形「混ざるのを防げなかった」が同じ系統で残っていると指摘した。さらに第59TASKの保守的HOLDで、正しい4文（仮定＋対策）も止まった。

本プロトタイプは、例外を足す代わりに **出典と候補を同じ読み方で「状態」に分類し、出来事ごとに比べる**。

## 2. 5つの状態

| 状態 | 意味 | 例 |
|---|---|---|
| DONE（確定実施） | 起きた・やった | 直した／確かめた／混ざってはいた／届いてから〜た／確認済み |
| DECIDED（決定・予定） | 決めた・作りにした・現在形の方針 | 出すことにした／確かめるようにした／表示する作りにしてる |
| POSSIBLE（可能性・仮定） | 起き得る・条件の中だけ | 届く可能性があった／混ざると／消えたら／届いても |
| PREVENTION（防止意図） | 起きないようにした | 混ざらないよう直した／混ざるのを防いだ／混ざるときに備えて、 |
| UNKNOWN（未確認・曖昧） | 伝聞・疑問・つもり・成否不明 | 出たらしい／防げた？／防いだつもり／〜てきて冷や汗。 |

「」内の引用（「削除しました」）、名詞の修飾（消す順番）、間接疑問（消えたか確認）は主張ではないので数えない。

## 3. 読み方（説明できる判断根拠）

1. **語彙表**: 10/09・10/10 の出典に出る出来事と、その日常語の言い換えだけを追う（混ざる／届く／送る／表示する=出す・出る・見せる／確認する=確かめる／直す=修正／削除する=消す・消える／分ける／試作する）。防止の動詞（防ぐ・止める・避ける）は出来事ではなく演算子として扱う。
2. **活用を読む**: 五段・一段・サ変の活用（未然・連用・終止・仮定・て形・た形・ます形・可能・受身）と、て形の補助（てしまう／ちゃう／ている／てる、間の「は・も」）を読み、カテゴリ（TA, TE, DICT, NEG …）を決める。辞書形「混ざるのを」も、て形「混ざってしまうのを」も同じ経路を通る（#717 指摘6）。
3. **後ろとのつながり**: て形・連用形・「〜てから」・「〜前に」は、同じ節で後ろに続く出来事か述語の状態を受け継ぐ（「届いて混ざった」→届くもDONE、「確かめてから出すようにしてる」→DECIDED）。受け継ぐとき PREVENTION は POSSIBLE に落とす（「届いて混ざるときに備えて」の届くは仮定）。
4. **文全体の後続節**（#717 指摘1〜3への構造的な対応）: 条件・可能性・防止が成立したら、節で切らず**文の残り全部**を節ごとに読む。防止の失敗（〜なかった、間に合わなかった、失敗した）は DONE、伝聞・推量、「〜てしまった／ちゃった」、逆接（結局・実際）の過去、を目的語の無い主語つき過去、て形＋体言止めは UNKNOWN。を＋動詞の過去（確認を足した）、思考（と思った）、決定・作り、非過去の評価（困る・まずい）は対応行動として出来事の状態を変えない。
5. **比べ方**（出来事ごと、出典は最も強い状態を根拠にする）:

| 候補の状態 | PASS候補になる条件 | それ以外 |
|---|---|---|
| DONE | 出典に DONE がある | REJECT |
| DECIDED | 出典に DONE か DECIDED がある | REJECT |
| PREVENTION | 出典に PREVENTION がある | HOLD（出典に無い対策） |
| POSSIBLE | 出典にその出来事がある | — |
| UNKNOWN | なし | HOLD |
| 出典に無い出来事 | なし | HOLD |

文書全体の判定は REJECT > HOLD > PASS_CANDIDATE の最悪値。追跡対象の出来事が一つも無ければ HOLD。PASS_CANDIDATE は「出来事の状態を保っている」という意味だけで、文体判定・他ガード・本人確認の代わりではない。

## 4. 計測（`ai_lab_claim_state_test.ts` の measure、テスト実行で出力）

対象61件（PASS すべき25件、止めるべき36件）。旧ガード = `ungroundedClaims` が1件でも返せば HOLD。

| 指標 | 新プロトタイプ | 旧ガード（PR #730 HEAD） |
|---|---|---|
| 危険な誤通過（止めるべきをPASS） | **0 / 36** | 13 / 36 |
| 誤停止（PASSすべきを停止） | 0 / 25 | 8 / 25 |
| 到達率（PASSすべきがPASS） | 25 / 25 = 100% | 17 / 25 = 68% |
| 第59TASKで止まった正例4文 | 4/4 PASS候補 | 4/4 HOLD（計測で再確認） |

旧ガードの誤通過13件: rewrite-1009, decided-to-done-1009, prevented-then-not, prepared-result-occurred, prepared-too-late, nda-comma-past, hearsay-after-condition, te-wa-ita, te-mo-ita, te-kara-past, dict-prevent-fail, fixed-then-wrong-name, invented-fix（#717 が静的にたどった誤通過を実行で確認）。
旧ガードの誤停止8件: prevent-decided, decided-casual, cond-polite-response, cond-result-measure, t59-thought, t59-kara, t59-tame, t59-node（旧ガードがどの検査で止めたかは区別していない。合否だけの比較）。

**注意: この数字は自作fixtureでの値で、汎化性能ではない。** fixtureは本TASKで設計と同時に作ったため、楽観側に偏る。

### fixture外の確認（テスト未収録、24文、2026-11-18 手元実行）
発生・失敗を述べる文（混ざってた／混ざってる／混ざりました／混ざっていました／届いちゃってた／届きました／後から届いたので／それでも混ざった／防げてなかった／防ぎきれなかった／混ざるのは防げなかった／思ったら実際に混ざっていた）はすべて REJECT。曖昧な文（防げずにいた／直したはずだった／したつもりだった／防いだ、はずだった／〜結局名前が違っていた）は HOLD。「混ざったかもしれない」「混ざったら困る」「届いても大丈夫なように直した」は PASS候補。未追跡語のみの「混入した」「混じった」「混ざる事態を防げなかった」は追跡対象が無いため HOLD（判定ではなく対象外による停止）。

### 変異テスト（9種、すべて検出）
後続節の UNKNOWN 無効化／DONE を常に PASS／DECIDED を常に PASS／防止の否定を成功扱い／伝聞判定なし／て形補助なし／継承で PREVENTION を落とさない／UNKNOWN を PASS／習慣的発生（ときもある）なし。初回は2種（後続節・DECIDED）が生き残り、それを検出する fixture（fixed-then-wrong-name, present-mixing）を足して全検出にした。

## 5. ケースごとの判断・根拠と旧ガードとの差分

| id | 候補（抜粋） | 対象 | 出典→候補 | 新判定 | 旧ガード | 根拠 |
|---|---|---|---|---|---|---|
| draft-1010 | （投稿全文） | 表示する | DECIDED→DECIDED | PASS_CANDIDATE | PASS | 「出すことにした。」＝決定・作り |
| rewrite-1010 | （投稿全文） | 確認する | DONE→DONE | PASS_CANDIDATE | PASS | 「確かめた」＝過去の言い切り |
| draft-1009 | （投稿全文） | 削除する | PREVENTION→POSSIBLE | PASS_CANDIDATE | PASS | 「消えたら」＝仮定 |
| rewrite-1009 | （投稿全文） | 分ける | DECIDED→DONE | REJECT | PASS | 「分けた」＝過去の言い切り |
| decided-to-done | だから今開いてる相談への返事か見てから画面に出した。 | 表示する | DECIDED→DONE | REJECT | HOLD | 「出した」＝過去の言い切り |
| decided-to-done-polite | 返事を画面に表示しました。 | 表示する | DECIDED→DONE | REJECT | HOLD | 「表示しました」＝過去の言い切り |
| decided-to-done-1009 | 結果を確かめてから「削除しました」と表示した。 | 表示する | DECIDED→DONE | REJECT | PASS | つながる「表示した」に従う |
| possible-to-happened | 古いAIの返事が後から届いて混ざった。 | 届く | POSSIBLE→DONE | REJECT | HOLD | つながる「混ざった」に従う |
| possible-to-happened-casual | 前の返事が後から届いたんだよね。 | 届く | POSSIBLE→DONE | REJECT | HOLD | 「届いた」＝過去の言い切り |
| prevented-polite-fail | 前の相談が混ざってしまうのを防げませんでした。 | 混ざる | PREVENTION→DONE | REJECT | HOLD | 「防げませんでした」＝防げなかった（発生した） |
| prevented-kirenai | 前の相談が混ざってしまうのを止めきれなかった。 | 混ざる | PREVENTION→DONE | REJECT | HOLD | 「止めきれなかった」＝防げなかった（発生した） |
| prevented-progressive-neg | 前の相談が混ざってしまうのを防いでいなかった。 | 混ざる | PREVENTION→DONE | REJECT | HOLD | 「防いでいなかった」＝防げなかった（発生した） |
| prevented-then-not | 前の相談が混ざってしまうのを防げたので、安心していたが、実際は防げていなかった。 | 混ざる | PREVENTION→DONE | REJECT | PASS | 「防げた」＝防止が完了／後続節「実際は防げていなかった」で防止の失敗＝発生を述べている |
| prevented-seemed-then-not | 前の相談が混ざってしまうのを防げたようだったが、実際は防げていなかった。 | 混ざる | PREVENTION→DONE | REJECT | HOLD | 「防げたようだったが」は防げたか言い切っていない／後続節「実際は防げていなかった」で防止の失敗＝発生を述べている |
| prepared-result-occurred | 後から届いて混ざるときに備えて、確認を足したが、結局前の返事が出ていた。 | 表示する | DECIDED→DONE | REJECT | PASS | 「出ていた」＝過去の言い切り |
| prepared-too-late | 後から届いて混ざるときに備えて、確認を足したが、間に合わなかった。 | 混ざる | PREVENTION→DONE | REJECT | PASS | つながる「混ざる」に従う |
| nda-comma-past | 後から届いて混ざるとまずいんだ、前に一度名前が違って出ちゃったから。 | 表示する | DECIDED→DONE | REJECT | PASS | 「出ちゃった」＝過去の言い切り |
| hearsay-after-condition | 後から届いて混ざると、前の返事が出たらしい。 | 表示する | DECIDED→UNKNOWN | HOLD | PASS | つながる「混ざる」に従う |
| te-wa-ita | 前の相談が混ざってはいた。 | 混ざる | PREVENTION→DONE | REJECT | PASS | 「混ざってはいた」＝過去の言い切り |
| te-mo-ita | 後から届いてもいた。 | 届く | POSSIBLE→DONE | REJECT | PASS | 「届いてもいた」＝過去の言い切り |
| te-kara-past | 古い返事が届いてから、名前が変わった。 | 届く | POSSIBLE→DONE | REJECT | PASS | つながる述語「、名前が変わった」に従う |
| dict-prevent-fail | 前の相談が混ざるのを防げなかった。 | 混ざる | PREVENTION→DONE | REJECT | PASS | 「防げなかった」＝防げなかった（発生した） |
| habitual-occurs | 後から届いて混ざるときもある。 | 混ざる | PREVENTION→DONE | REJECT | HOLD | つながる「混ざる」に従う |
| completive-casual | 前の相談が混ざっちゃった。 | 混ざる | PREVENTION→DONE | REJECT | HOLD | 「混ざっちゃった」＝過去の言い切り |
| prevent-fail-shiki | 前の相談が混ざってしまうのを防ぐことに失敗した。 | 混ざる | PREVENTION→DONE | REJECT | HOLD | 「防ぐことに失敗した。」＝防止に失敗（発生した） |
| prevent-could-not | 前の相談が混ざってしまわないようにできなかった。 | 混ざる | PREVENTION→DONE | REJECT | HOLD | 防止の「できなかった」が失敗＝発生した |
| prevent-wanted-late | 前の相談が混ざってしまうのを防ぐようにしたかったが、間に合わなかった。 | 混ざる | PREVENTION→DONE | REJECT | HOLD | 「防ぐようにしたか」の防止の成否を読めない／後続節「間に合わなかった」で防止の失敗＝発生を述べている |
| prevent-intent-only | 前の相談が混ざってしまうのを防いだつもりだった。 | 混ざる | PREVENTION→UNKNOWN | HOLD | HOLD | 「防いだつもりだった」は防げたか言い切っていない |
| prevent-seemed | 前の相談が混ざってしまうのを防いだように見えた。 | 混ざる | PREVENTION→UNKNOWN | HOLD | HOLD | 「防いだように見えた」は防げたか言い切っていない／後続節「ように見えた」が伝聞・推量で結果を述べている |
| prevent-thought | 前の相談が混ざってしまうのを防げた、と思っていた。 | 混ざる | PREVENTION→UNKNOWN | HOLD | HOLD | 「防げた、と思ってい」は防げたか言い切っていない |
| prevent-question | 前の相談が混ざってしまうのを防げた？ | 混ざる | PREVENTION→UNKNOWN | HOLD | HOLD | 「防げた？」は防げたか言い切っていない |
| prepare-not | 後から届いて混ざるときに備えていなかった。 | 混ざる | PREVENTION→UNKNOWN | HOLD | HOLD | つながる「混ざる」に従う |
| prepare-maybe | 後から届いて混ざるときのためか、確認が入っていた。 | 混ざる | PREVENTION→UNKNOWN | HOLD | HOLD | つながる「混ざる」に従う |
| condition-noun-end | 後から届いて混ざると、前の返事が出てきて冷や汗。 | 表示する | DECIDED→UNKNOWN | HOLD | HOLD | つながる述語「きて冷や汗」に従う |
| decided-1009-deleted | 片方のアプリのデータまで消してしまった。 | 削除する | PREVENTION→DONE | REJECT | HOLD | 「消してしまった」＝過去の言い切り |
| fixed-then-wrong-name | 前の相談が混ざってしまわないよう直したので、安心していたが、結局名前が違っていた。 | 混ざる | PREVENTION→UNKNOWN | HOLD | PASS | 「〜ないよう直した」＝防止／後続節「結局名前が違っていた」が逆接の過去で結果を述べている |
| present-mixing | 前の相談が混ざってる。 | 混ざる | PREVENTION→DECIDED | REJECT | HOLD | 「混ざってる」＝現在形の方針 |
| invented-fix | 後から届くのを防いだ。 | 届く | POSSIBLE→PREVENTION | HOLD | PASS | 「防いだ」＝防止が完了 |
| negated-check | 今開いてる相談かを確かめずに返事を画面に出すことにした。 | 確認する | DONE→UNKNOWN | HOLD | HOLD | 「確かめず」＝否定の連用（行為の否定） |
| fixed-polite | 前の相談が混ざらないよう直しました。 | 混ざる | PREVENTION→PREVENTION | PASS_CANDIDATE | PASS | 「〜ないよう直しました」＝防止 |
| fixed-casual | 前の相談が混ざらないように直したんだよね。 | 混ざる | PREVENTION→PREVENTION | PASS_CANDIDATE | PASS | 「〜ないよう直した」＝防止 |
| fixed-noun-end | 前の相談が混ざらないよう修正。 | 混ざる | PREVENTION→PREVENTION | PASS_CANDIDATE | PASS | 「〜ないよう修正」＝防止 |
| tested-noun-end | 順番を入れ替えたテストで確認済み。 | 確認する | DONE→DONE | PASS_CANDIDATE | PASS | 「確認済」＝体言止めの完了 |
| tested-done | 順番を入れ替えたテストでも確かめた。 | 確認する | DONE→DONE | PASS_CANDIDATE | PASS | 「確かめた」＝過去の言い切り |
| prevented-done | 前の相談が混ざってしまうのを防いだ。 | 混ざる | PREVENTION→PREVENTION | PASS_CANDIDATE | PASS | 「防いだ」＝防止が完了 |
| prevented-polite | 前の相談が混ざってしまうのを防げました。 | 混ざる | PREVENTION→PREVENTION | PASS_CANDIDATE | PASS | 「防げました」＝防止が完了 |
| prevented-relief | 前の相談が混ざってしまうのを防いだので、安心した。 | 混ざる | PREVENTION→PREVENTION | PASS_CANDIDATE | PASS | 「防いだ」＝防止が完了 |
| prevent-decided | 前の相談が混ざってしまうのを防ぐことにしました。 | 混ざる | PREVENTION→PREVENTION | PASS_CANDIDATE | HOLD | 「防ぐ」＋決定・作り |
| sent-twice-stopped | 同じ保存が二重に送られるのも止めた。 | 送る | PREVENTION→PREVENTION | PASS_CANDIDATE | PASS | 「止めた」＝防止が完了 |
| decided-casual | 返事を画面に出すことにしたんだ。 | 表示する | DECIDED→DECIDED | PASS_CANDIDATE | HOLD | 「出すことにしたん」＝決定・作り |
| possible-kept | 後から届いて、混ざるかもしれなかった。 | 届く | POSSIBLE→POSSIBLE | PASS_CANDIDATE | PASS | つながる「混ざる」に従う |
| prepared | 後から届いて混ざるときに備えて、確認を足した。 | 混ざる | PREVENTION→PREVENTION | PASS_CANDIDATE | PASS | 「混ざるときに備えて、」＝備え |
| prepared-for | 後から届いて混ざるときのために、確認を足した。 | 混ざる | PREVENTION→PREVENTION | PASS_CANDIDATE | PASS | 「混ざるときに備えて、」＝備え |
| cond-tame-decide | 後から届いて混ざると別の人の名前が出るため、確認を足すことにする。 | 混ざる | PREVENTION→POSSIBLE | PASS_CANDIDATE | PASS | 「混ざると」＝条件 |
| cond-aratamete | 後から届いて混ざると、あらためて確かめることになる。 | 混ざる | PREVENTION→POSSIBLE | PASS_CANDIDATE | PASS | 「混ざると」＝条件 |
| cond-polite-response | 後から届いて混ざると困りますので、確認を足しました。 | 混ざる | PREVENTION→POSSIBLE | PASS_CANDIDATE | HOLD | 「混ざると」＝条件 |
| cond-result-measure | 後から届いて混ざると前の返事が出てしまうので、順番を確かめるようにした。 | 表示する | DECIDED→POSSIBLE | PASS_CANDIDATE | HOLD | 「出てしまうので」＝非過去の理由 |
| t59-thought | 後から届いて混ざるとまずいと思った。 | 混ざる | PREVENTION→POSSIBLE | PASS_CANDIDATE | HOLD | 「混ざると」＝条件 |
| t59-kara | 後から届いて混ざると困るから、画面に出す前に確かめるようにした。 | 混ざる | PREVENTION→POSSIBLE | PASS_CANDIDATE | HOLD | 「混ざると」＝条件 |
| t59-tame | 後から届いて混ざると困るため、画面に出す前に確かめるようにした。 | 表示する | DECIDED→DECIDED | PASS_CANDIDATE | HOLD | つながる「確かめる」に従う |
| t59-node | 後から届いて混ざるとまずいので、順番を入れ替えたテストで確かめた。 | 確認する | DONE→DONE | PASS_CANDIDATE | HOLD | 「確かめた」＝過去の言い切り |

## 6. 利点と限界（正直な評価）

利点
- 反例ごとの例外ではなく、活用・つながり・文全体の後続節という同じ読み方で、出典と候補の両方を分類する。#717 の指摘1〜6は個別例外なしで全部止まる。
- 第59TASKで止めた仮定＋対策の正例4文を、「後ろの節が対応行動（を＋動詞・思考・決定）か結果（主語つき過去・てしまった・伝聞）か」という説明できる理由で戻せた。
- 判定ごとに根拠の文（evidence）と理由（reason）が出るので、人がHOLD/REJECTを確認しやすい。

限界
- **語彙表の外は見ない。** 追跡対象の無い文（「混入した」「サーバーが落ちた」）は、投稿全体に他の追跡対象があると本モジュールでは素通りする。語彙表は 10/09・10/10 用で、他の日の出典ではまず語彙表を広げる必要がある（または出典から動詞を抜く処理）。
- 形態素解析器ではない。活用表と語の並びで読んでいるので、複合動詞（防ぎきる以外）、使役受身、「てくる／ておく」、倒置、二重否定、長い連体修飾は UNKNOWN か誤読になり得る。誤読が PASS 側に出ないよう、読めないものは UNKNOWN（HOLD）に倒しているが、保証ではない。
- 後続節の「主語つき過去なら UNKNOWN」「を＋動詞なら対応行動」は経験則。「確認を足した」のような、出典に無い行為（名詞＋を＋一般動詞）は追跡していない（行為の捏造は別ガードの範囲）。
- 体験・感情（「焦った」「冷や汗」）や数量の捏造は本モジュールの範囲外。旧ガードの他の検査と組み合わせる前提。
- 「必要があった」を結果から外すなど、少数の文法的な除外は残る（理由はコメントに記載）。

## 7. 人が決めること（review_required）

1. 本番結線するか（旧 `decisionTenseOverclaims` / `unsourcedOccurrences` の置き換え、または併用）。結線・実モデル比較・有料APIは別TASKと本人承認が必要。
2. REWRITE_1009 の「はっきり分けた」（出典は「分け、…設計にした」）を、決定→実施として REJECT にする扱いでよいか。
3. 「確認を足した」のような出典に無い対応行動を PASS候補に残す扱いでよいか。
4. 語彙表の外の出来事を、HOLD（全体）にするか、別ガードに任せるか。
5. 旧PR #721〜#730 の共有ガード修正は本番適用しない（本TASKでは触っていない）。
