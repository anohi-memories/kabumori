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

