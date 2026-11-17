// Task40/41: synthetic (合成) diary topics shared by the topic audit and the provider contract tests. Test-only.
export type TopicQualityCase = {
  id: string;
  source: "合成" | "実記録";
  seed: string;
  postable: boolean;
  reasons?: readonly string[];
  note: string;
  /**
   * Task41: hand-written first-stage draft (no provider). Stiffer than the
   * preview and grounded in the seed; the preview is its rewrite.
   */
  draft?: string;
  /** Hand-written plain-register preview (no provider). Only for postable cases. */
  preview?: string;
  /** Task41: what each preview says differently from the seed, and why it is the same fact. */
  paraphrases?: readonly string[];
};

const facts = (...lines: string[]) => lines.join("\n");

export const SYNTHETIC: readonly TopicQualityCase[] = [
  {
    id: "S1 良い体験・画面にもボタンにも触れない",
    source: "合成",
    seed: facts(
      "できごと: 月末の家計の見直しで、毎月出ていく固定費を一覧にしてみた。",
      "決めたこと: 使っていないサブスクを1つだけ解約する。",
    ),
    postable: true,
    note: "可視語は無いが内部用語も認証語も無いので保留しない（面白さの証明ではない）",
    draft: "家計の見直しについてです。月末に、毎月出ていく固定費を一覧にしてみた。その結果として、使っていないサブスクを1つだけ解約することにしました。",
    preview: "月末に家計を見直して、毎月出ていく固定費を一覧にしてみた。使ってないサブスクを1つだけ解約することにした。",
    paraphrases: [
      "「解約する」（決めたこと）→「解約することにした」: 決めたことの言い直し。解約済みとは言わない",
      "Task40の「ひとつ」は題材の「1つだけ」から「だけ」が落ちていたので「1つだけ」に戻した",
    ],
  },
  {
    id: "S2 内部単語を含むが読者に価値がある",
    source: "合成",
    seed: facts(
      "できごと: 設定ファイルを間違えて消してしまった。",
      "詰まったこと: 環境ごと作り直すしかないと思ったが、バックアップから5分で戻せた。",
      "決めたこと: 消す前にバックアップを取る。",
    ),
    postable: true,
    note: "Task39では内部語2個で保留されていた。数字つきの結果があるため残す（旧規則の誤判定の修正）",
    draft: "設定ファイルを間違えて消してしまいました。環境ごと作り直すしかないと思ったが、結果としてはバックアップから5分で戻せた。今後は、消す前にバックアップを取ることにしました。",
    preview: "設定ファイルを間違えて消しちゃった。環境ごと作り直すしかないと思ったけど、バックアップから5分で戻せた。消す前にバックアップを取ることにした。",
    paraphrases: [
      "「消してしまった」→「消しちゃった」: 同じ出来事の話し言葉",
      "「取る」（決めたこと）→「取ることにした」: 決めたことの言い直し。Task40の「次から」は題材に無い時期の言い方なので外した",
      "Task40の「作り直しかと思った」は「環境ごと」「しかない」が落ちていたので題材どおりに戻した",
    ],
  },
  {
    id: "S3 弱いのに可視語が1つある",
    source: "合成",
    seed: facts(
      "できごと: 表示設定の連携処理を整えて、本番の環境の仕組みを進めた。",
      "決めたこと: 運用の判定は正本に寄せる。",
    ),
    postable: false,
    reasons: ["NO_READER_VISIBLE_EVENT", "INTERNAL_WORK_REPORT"],
    note: "「表示」1語だけの業務報告。Task39では通っていた誤受理を保留に直した",
  },
  {
    id: "S4 単なる完了報告",
    source: "合成",
    seed: facts("できごと: 通知画面の表示を確認した。"),
    postable: false,
    reasons: ["CONFIRMATION_ONLY"],
    note: "確認しただけで起きたことも決めたこともない",
  },
  {
    id: "S5 認証まわりの内輪話",
    source: "合成",
    seed: facts(
      "できごと: ログインの認証設定を確認した。",
      "詰まったこと: トークンの期限の扱いが環境ごとに違っていた。",
    ),
    postable: false,
    reasons: ["NO_READER_VISIBLE_EVENT", "INTERNAL_WORK_REPORT", "OPAQUE_ACCOUNT_DETAIL"],
    note: "読者に場面が浮かばない認証の事情（認証語は結果があっても保留のまま）",
  },
  {
    id: "S6 具体的な気づき",
    source: "合成",
    seed: facts(
      "できごと: 送信ボタンを押した直後にもう一度押せてしまい、同じ投稿が2件できていた。",
      "決めたこと: 押したらボタンを無効にする。",
    ),
    postable: true,
    note: "読者に見える場面と具体的な結果がある",
    draft: "送信ボタンを押した直後に、もう一度押せてしまう状態でした。その結果、同じ投稿が2件できていた。対策として、押したらボタンを無効にすることにした。",
    preview: "送信ボタンを押した直後にもう一回押せて、同じ投稿が2件できてた。押したらボタンを無効にすることにした。",
    paraphrases: [
      "「もう一度」→「もう一回」、「できていた」→「できてた」: 同じ数・同じ出来事の話し言葉",
      "「無効にする」（決めたこと）→「無効にすることにした」。Task40の「無効にするようにした」は実装済みとも読めるので外した",
    ],
  },
  {
    id: "S7 日常語の鍵が1つだけ",
    source: "合成",
    seed: facts("できごと: 家の鍵を玄関に置き忘れて、出社後に気づいた。", "決めたこと: 鞄の定位置を決める。"),
    postable: true,
    note: "「鍵」1語だけでは保留しない（旧規則の誤判定）。権限・鍵が2つ以上なら保留",
    draft: "家の鍵を玄関に置き忘れてしまい、出社後になってそのことに気づいた。再発防止として、鞄の定位置を決めることにしました。",
    preview: "家の鍵を玄関に置き忘れて、会社に着いてから気づいた。鞄の定位置を決めることにした。",
    paraphrases: [
      "「出社後」→「会社に着いてから」: 同じ時点の日常語",
      "「決める」（決めたこと）→「決めることにした」: 決めたことの言い直し。定位置を決め終えたとは言わない",
    ],
  },
];


/**
 * Task42: hand-written (合成・手書き) drafts and rewrites for the grounding gaps
 * Task41 left open. `id` is the SYNTHETIC case whose seed is the topic. None of
 * these is model output, and a pass is not the user's voice PASS.
 */
export type Task42Case = { id: string; text: string; why: string };

/** Legitimate first-stage drafts: same facts, the draft's own wording. */
export const TASK42_DRAFT_POSITIVES: readonly Task42Case[] = [
  { id: "S1", text: "月末に、毎月出ていく固定費を一覧にしてみた。使っていないサブスクを一つだけ解約することにした。", why: "1つ→一つ（同じ数）" },
  { id: "S1", text: "月末に、毎月出ていく固定費を一つ一つ一覧にしてみた。使っていないサブスクを1つだけ解約することにした。", why: "「一つ一つ」「一覧」は数ではない" },
  { id: "S2", text: "設定ファイルを間違えて消してしまったが、バックアップから五分で戻せた。それで十分だった。", why: "5分→五分、「十分」は慣用" },
  { id: "S6", text: "送信ボタンを押した直後にもう一度押せてしまい、同じ投稿が二件できていた。押したらボタンを無効にすることにした。", why: "2件→二件" },
  { id: "S7", text: "家の鍵を玄関に置き忘れて、出社後に気づいた。なので、鞄の定位置を決めることにした。", why: "つなぎの「なので」だけ" },
];

/** First-stage drafts that add what the topic does not say. */
export const TASK42_DRAFT_NEGATIVES: readonly Task42Case[] = [
  { id: "S7", text: "家の鍵を玄関に置き忘れて、出社後に気づいた。帰りに合鍵も作った。", why: "出来事（合鍵を作った）" },
  { id: "S1", text: "月末に、毎月出ていく固定費を一覧にしてみた。ついでに通帳も見直した。", why: "行動（通帳を見直した）" },
  { id: "S1", text: "月末に、毎月出ていく固定費を一覧にしてみた。夜は早く寝た。", why: "題材と無縁の出来事（夜は早く寝た）" },
  { id: "S7", text: "家の鍵を玄関に置き忘れて、出社後に気づいた。駅まで戻ったけど間に合わなかった。", why: "場所・行動（駅まで戻った）" },
  { id: "S1", text: "月末に、毎月出ていく固定費を一覧にしてみた。銀行のアプリで残高も確認した。", why: "物・行動（アプリで残高確認）" },
  { id: "S2", text: "設定ファイルを間違えて消してしまった。母が5分で戻してくれた。", why: "第三者（母）" },
  { id: "S2", text: "設定ファイルを間違えて消してしまった。チームのメンバーが5分で戻してくれた。", why: "第三者（メンバー）" },
  { id: "S6", text: "送信ボタンを押した直後にもう一度押せてしまい、同じ投稿が2件できていて焦った。", why: "感情（焦った）" },
  { id: "S7", text: "家の鍵を玄関に置き忘れて、出社後に気づいた。来週までに鞄の定位置を決める。", why: "予定（来週まで）" },
  { id: "S2", text: "設定ファイルを間違えて消してしまったが、バックアップから5分で戻せた。おかげで作業がはかどった。", why: "成果（はかどった）" },
  { id: "S7", text: "家の鍵を玄関に置き忘れて、出社後に気づいた。もう二度と忘れない。", why: "決意（二度と）" },
  { id: "S1", text: "使っていないサブスクを1つだけ解約することにした。サブスクの解約が一番の節約だと思う。", why: "理由のない断定（一番）" },
  { id: "S6", text: "会社のパソコンで送信ボタンを押した直後に、もう一度押せてしまった。", why: "物・場所（会社のパソコン）" },
  { id: "S7", text: "家の鍵を玄関に置き忘れて、車で出社した後に気づいた。", why: "物（車）" },
  { id: "S1", text: "使っていないサブスクをふたつ解約することにした。", why: "数量（1つ→ふたつ）" },
  { id: "S6", text: "送信ボタンを押した直後にもう一度押せてしまい、同じ投稿が三件できていた。", why: "数量（2件→三件）" },
];

/** Known gaps, kept visible: these still pass the draft stage. */
export const TASK42_DRAFT_KNOWN_GAPS: readonly Task42Case[] = [
  { id: "S2", text: "設定ファイルを間違えて消してしまったが、バックアップから十分で戻せた。", why: "「十分」は慣用と区別できず数として比べない（5分→十分）" },
  { id: "S7", text: "家の鍵を玄関に置き忘れて、出社後に気づいた。詳しく調べたら鍵は鞄の中にあった。", why: "題材の語だけで組んだ新しい出来事（鍵・鞄は題材にある）" },
  { id: "S6", text: "送信ボタンを押した直後にもう一度押せてしまい、くるまの中で同じ投稿が2件できていた。", why: "ひらがなだけの名詞（くるま）" },
];

/** Legitimate second-stage rewrites of each SYNTHETIC draft (besides `preview`). */
export const TASK42_REWRITE_POSITIVES: readonly Task42Case[] = [
  { id: "S1", text: "月末に家計を見直してみた。毎月出ていく固定費を一覧にして、使ってないサブスクを1つだけ解約することにした。", why: "語順の入れ替え" },
  { id: "S2", text: "設定ファイルを間違えて消しちゃって、環境ごと作り直すしかないと思ったけどバックアップから5分で戻せた。消す前にバックアップを取ることにした。", why: "二文を一文に" },
  { id: "S6", text: "送信ボタンを押した直後にもう一回押せちゃって、同じ投稿が2件できてた。押したらボタンを無効にすることにした。", why: "もう一度→もう一回（同じ数）" },
  { id: "S7", text: "家の鍵を玄関に置き忘れたのに気づいたのは会社に着いてから。鞄の定位置を決めることにした。", why: "倒置" },
  { id: "S7", text: "家の鍵を玄関に置き忘れて、会社に着いてから気づいた。なので鞄の定位置を決めることにした。", why: "つなぎの「なので」" },
];

/** Second-stage rewrites that add a short thing, place, person or count. */
export const TASK42_REWRITE_NEGATIVES: readonly Task42Case[] = [
  { id: "S7", text: "家の鍵を玄関に置き忘れて、駅で気づいた。鞄の定位置を決めることにした。", why: "場所（駅）" },
  { id: "S7", text: "家の鍵を玄関に置き忘れて、車の中で気づいた。鞄の定位置を決めることにした。", why: "物（車）" },
  { id: "S7", text: "家の鍵を玄関に置き忘れて、店で気づいた。鞄の定位置を決めることにした。", why: "場所（店）" },
  { id: "S7", text: "家の鍵を玄関に置き忘れて、母に言われて気づいた。鞄の定位置を決めることにした。", why: "人物（母）" },
  { id: "S6", text: "家で送信ボタンを押した直後にもう一回押せて、同じ投稿が2件できてた。押したらボタンを無効にすることにした。", why: "場所（家。S6の題材に無い）" },
  { id: "S1", text: "月末に家計を見直して、毎月出ていく固定費を一覧にしてみた。使ってないサブスクを1つだけ店で解約することにした。", why: "場所（店）" },
  { id: "S6", text: "送信ボタンを押した直後にもう二回押せて、同じ投稿が2件できてた。押したらボタンを無効にすることにした。", why: "数量（一度→二回）" },
  { id: "S7", text: "家の鍵を玄関に二回置き忘れて、会社に着いてから気づいた。鞄の定位置を決めることにした。", why: "数量（漢数字の二回）" },
  { id: "S7", text: "家の鍵をひとつ玄関に置き忘れて、会社に着いてから気づいた。鞄の定位置を決めることにした。", why: "数量（原案にも題材にも無い「ひとつ」）" },
  { id: "S2", text: "設定ファイルを間違えて消しちゃった。環境ごと作り直すしかないと思ったけど、バックアップから5分で戻せたのは特に助かった。消す前にバックアップを取ることにした。", why: "成果・気持ち（助かった）" },
];
