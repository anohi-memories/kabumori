// Task60 (prototype, not wired into any post path): compare what the topic
// and a candidate post each say about the same event, by state, instead of
// adding one more pattern per counter-example to ai_lab_voice_rewrite.ts.
//
// Every mention of a tracked verb is read through its inflection and what
// follows it in the whole sentence, and put in one of five states:
//   DONE       確定実施   it happened / was done (「直した」「届いてはいた」)
//   DECIDED    決定・予定 decided, planned or built as a rule (「出すことにした」)
//   POSSIBLE   可能性・仮定 could happen / only under a condition (「届く可能性」)
//   PREVENTION 防止意図   kept from happening (「混ざらないよう直した」)
//   UNKNOWN    未確認・曖昧 hearsay, a question, a failed or unclear outcome
// A candidate may not claim a stronger state than the topic gives the same
// event. An inflection or a later clause the reader does not recognise is
// UNKNOWN and held; only quotes, indirect questions, nouns and plain noun
// modifiers count as no claim. No network, no model, no dictionary file.

export type ClaimState = "DONE" | "DECIDED" | "POSSIBLE" | "PREVENTION" | "UNKNOWN";
export type ClaimDecision = "PASS_CANDIDATE" | "HOLD" | "REJECT";

export const CLAIM_STATE_LABELS: Readonly<Record<ClaimState, string>> = {
  DONE: "確定実施",
  DECIDED: "決定・予定",
  POSSIBLE: "可能性・仮定",
  PREVENTION: "防止意図",
  UNKNOWN: "未確認・曖昧",
};

type Conj = "godan" | "ichidan" | "sahen";
interface Verb {
  stem: string;
  conj: Conj;
  row?: keyof typeof ROWS;
  /** The event the verb is compared as (everyday retellings share one). */
  event: string;
}

const ROWS = {
  ka: { a: "か", i: "き", u: "く", e: "け", o: "こ", onbin: "い", te: "て" },
  ga: { a: "が", i: "ぎ", u: "ぐ", e: "げ", o: "ご", onbin: "い", te: "で" },
  sa: { a: "さ", i: "し", u: "す", e: "せ", o: "そ", onbin: "し", te: "て" },
  ra: { a: "ら", i: "り", u: "る", e: "れ", o: "ろ", onbin: "っ", te: "て" },
  wa: { a: "わ", i: "い", u: "う", e: "え", o: "お", onbin: "っ", te: "て" },
} as const;

// Tracked events of the 10/09 and 10/10 topics and their everyday retellings.
// A verb outside this list is not judged here (see the docs for the limit).
const EVENTS: readonly Verb[] = [
  { stem: "混ざ", conj: "godan", row: "ra", event: "混ざる" },
  { stem: "届", conj: "godan", row: "ka", event: "届く" },
  { stem: "送", conj: "godan", row: "ra", event: "送る" },
  { stem: "表示", conj: "sahen", event: "表示する" },
  { stem: "出", conj: "godan", row: "sa", event: "表示する" },
  { stem: "出", conj: "ichidan", event: "表示する" },
  { stem: "見せ", conj: "ichidan", event: "表示する" },
  { stem: "確認", conj: "sahen", event: "確認する" },
  { stem: "確かめ", conj: "ichidan", event: "確認する" },
  { stem: "直", conj: "godan", row: "sa", event: "直す" },
  { stem: "修正", conj: "sahen", event: "直す" },
  { stem: "削除", conj: "sahen", event: "削除する" },
  { stem: "消え", conj: "ichidan", event: "削除する" },
  { stem: "消", conj: "godan", row: "sa", event: "削除する" },
  { stem: "分け", conj: "ichidan", event: "分ける" },
  { stem: "試作", conj: "sahen", event: "試作する" },
];
// Verbs that only state whether an event was kept from happening.
const PREVENTERS: readonly Verb[] = [
  { stem: "防", conj: "godan", row: "ga", event: "防ぐ" },
  { stem: "止め", conj: "ichidan", event: "止める" },
  { stem: "避け", conj: "ichidan", event: "避ける" },
];

type Cat =
  | "TE"
  | "TA"
  | "DICT"
  | "NEG"
  | "NEG_PAST"
  | "NEG_ZU"
  | "COND"
  | "VOL"
  | "RENYOU"
  | "DESIRE"
  | "NOUN_END"
  | "DONE_NOUN"
  | "NOUN";
interface Parsed {
  cat: Cat;
  end: number;
}

const KANJI = /[\p{Script=Han}\p{Script=Katakana}]/u;

function ending(text: string, at: number, table: readonly (readonly [string, Cat])[]) {
  for (const [kana, cat] of table) {
    if (text.startsWith(kana, at)) return { cat, end: at + kana.length };
  }
  return null;
}

const MASU: readonly (readonly [string, Cat])[] = [
  ["ませんでした", "NEG_PAST"],
  ["ません", "NEG"],
  ["ました", "TA"],
  ["まして", "TE"],
  ["ます", "DICT"],
];
const ICHIDAN: readonly (readonly [string, Cat])[] = [
  ["なかった", "NEG_PAST"],
  ["ない", "NEG"],
  ["なく", "NEG"],
  ["ず", "NEG_ZU"],
  ...MASU,
  ["たかった", "DESIRE"],
  ["たい", "DESIRE"],
  ["て", "TE"],
  ["た", "TA"],
  ["る", "DICT"],
  ["れば", "COND"],
  ["よう", "VOL"],
];

// strict: only an explicit ending counts (auxiliaries, potentials, one-kanji stems).
function ichidan(text: string, at: number, strict: boolean): Parsed | null {
  for (const link of ["られ", "させ", "きれ"]) {
    if (text.startsWith(link, at)) return ichidan(text, at + link.length, true);
  }
  if (text.startsWith("ちゃ", at) || text.startsWith("じゃ", at)) {
    return aux(text, { cat: "TE", end: at });
  }
  const hit = ending(text, at, ICHIDAN);
  if (hit) return hit.cat === "TE" ? aux(text, hit) : hit;
  if (strict) return null;
  if (text[at] === "、" || KANJI.test(text[at] ?? "")) return { cat: "RENYOU", end: at };
  return null;
}

function godan(text: string, at: number, row: keyof typeof ROWS, strict = false): Parsed | null {
  const r = ROWS[row];
  const ta = r.te === "て" ? "た" : "だ";
  if (text.startsWith(r.onbin + "ちゃ", at) || text.startsWith(r.onbin + "じゃ", at)) {
    return aux(text, { cat: "TE", end: at + 1 });
  }
  if (text.startsWith(r.onbin + r.te, at)) return aux(text, { cat: "TE", end: at + 2 });
  if (text.startsWith(r.onbin + ta, at)) return { cat: "TA", end: at + 2 };
  const c = text[at];
  if (c === r.a) {
    for (const link of ["れ", "せ"]) {
      if (text[at + 1] === link) return ichidan(text, at + 2, true);
    }
    return ending(text, at + 1, ICHIDAN.slice(0, 4));
  }
  if (c === r.i) {
    if (text.startsWith("きれ", at + 1)) return ichidan(text, at + 3, true);
    const hit = ending(text, at + 1, [...MASU, ["たかった", "DESIRE"], ["たい", "DESIRE"]]);
    if (hit) return hit;
    if (text[at + 1] === "、" || KANJI.test(text[at + 1] ?? "")) return { cat: "RENYOU", end: at + 1 };
    return strict ? null : { cat: "NOUN", end: at + 1 };
  }
  if (c === r.u) return { cat: "DICT", end: at + 1 };
  if (c === r.e) {
    if (text[at + 1] === "ば") return { cat: "COND", end: at + 2 };
    return ichidan(text, at + 1, true); // potential: 防げた・防げなかった
  }
  if (c === r.o && text[at + 1] === "う") return { cat: "VOL", end: at + 2 };
  return null;
}

const SAHEN: readonly (readonly [string, Cat])[] = [
  ["しなかった", "NEG_PAST"],
  ["しない", "NEG"],
  ["しなく", "NEG"],
  ["せず", "NEG_ZU"],
  ["したかった", "DESIRE"],
  ["したい", "DESIRE"],
  ["して", "TE"],
  ["した", "TA"],
  ["する", "DICT"],
  ["すれば", "COND"],
  ["しよう", "VOL"],
  ["し、", "RENYOU"],
];

function sahen(text: string, at: number): Parsed {
  for (const link of ["され", "させ", "しきれ"]) {
    if (text.startsWith(link, at)) return ichidan(text, at + link.length, true) ?? { cat: "NOUN", end: at };
  }
  if (text.startsWith("しちゃ", at)) return aux(text, { cat: "TE", end: at + 1 });
  if (text.startsWith("し", at)) {
    const masu = ending(text, at + 1, MASU);
    if (masu) return masu.cat === "TE" ? aux(text, masu) : masu;
  }
  const hit = ending(text, at, SAHEN);
  if (hit) return hit.cat === "TE" ? aux(text, hit) : hit;
  if (text.startsWith("済", at)) return { cat: "DONE_NOUN", end: at + 1 };
  if (/^[。！!]|^$/u.test(text.slice(at))) return { cat: "NOUN_END", end: at };
  return { cat: "NOUN", end: at };
}

// After a te-form: 「てしまう／ちゃう」 (completed), 「ている／てる」 and their past
// (state), optionally after 「は」「も」 (「混ざってはいた」「届いてもいた」).
function aux(text: string, te: Parsed): Parsed {
  let at = te.end;
  if (text[at] === "は" || text[at] === "も") at++;
  let next: Parsed | null = null;
  if (text.startsWith("しま", at)) next = godan(text, at + 2, "wa", true);
  else if (/^[ちじ]ゃ/u.test(text.slice(at))) next = godan(text, at + 2, "wa", true);
  else if (text[at] === "い") next = ichidan(text, at + 1, true);
  else if (/^[るたな]/u.test(text.slice(at))) next = ichidan(text, at, true);
  return next ?? te;
}

function parse(text: string, at: number, verb: Verb): Parsed | null {
  const from = at + verb.stem.length;
  if (verb.conj === "sahen") return sahen(text, from);
  if (verb.conj === "ichidan") return ichidan(text, from, [...verb.stem].length < 2);
  return godan(text, from, verb.row!);
}

// ---- reading what follows a mention ----

const MODAL =
  /^(?:可能性|恐れ|おそれ)(?:が|も)?(?:あ(?:る|った|ります|りました))?|^かもしれ(?:ない|なかった|ません|ませんでした)?|^かも|^ことが?あり[得え](?:る|た|ます|ました)?|^ことが?ありう(?:る)?|^かねな(?:い|かった)/u;
const MODAL_ANY = /可能性|恐れ|おそれ|かもしれ|かも[。、！!]|ことが?あり[得え]|ことが?ありう|かねな/u;
const CONDITION_ANY = /[うくすつぬむぶぐる]と(?!き|いう|ころ|か)|[えけせてねべめれげ]ば|たら|なら(?!な)/u;
const PREPARE = /^と(?:きに備えて|きのために)、/u;
const DECIDED_AFTER =
  /^(?:ことに|ように|ようにも|作りに|設計に|仕組みに)(?:し(?:た|ました|てる|ている|ています)(?![かいく])|する|します)|^予定/u;
const DECIDED_END =
  /(?:ことに|ように|ようにも|作りに|設計に|仕組みに)(?:し(?:た|ました|てる|ている|ています)|する|します)$|予定$/u;
const UNSURE = /^(?:らしい|らしかった|そう(?:だ|です)|みたい|よう(?:だ|で|に)|はず|つもり|っぽい)/u;
const PAST_END = /(?:(?<![まあ])た|(?<![うくすつぬむぶぐるのないけ])だ|でした)$/u;
const TRAILING = /(?:ん(?:だ|です))?(?:よね|よ|ね|な|わ)?[。！!…]*$/u;
const FAILED_PAST = /(?:なかった|ませんでした)$|失敗し(?:た|ました)/u;
const FAILED_CLAUSE =
  /(?:防|止め|避け|間に合|でき|備え)\p{Script=Hiragana}*?(?:なかった|ませんでした)$|失敗し(?:た|ました)$/u;
const BOUNDARY = /[。！？!?\n]|ので|けど|のに|(?<![てで])から(?!だ)|(?<=た|だ|ます|です)が、/u;

function stripQuotes(text: string) {
  return text.replace(/「[^」]*」|『[^』]*』/gu, (q) => "□".repeat(q.length));
}

function clauseEnd(text: string): string {
  const cut = text.search(BOUNDARY);
  return (cut < 0 ? text : text.slice(0, cut)).replace(TRAILING, "");
}

// What a te-form or a 連用形 link inherits when no tracked verb follows it in
// the same clause: the state of the clause's own final predicate.
function headState(rest: string): ClaimState {
  const seg = stripQuotes(rest);
  const cut = seg.search(BOUNDARY);
  const clause = cut < 0 ? seg : seg.slice(0, cut);
  if (CONDITION_ANY.test(clause) || MODAL_ANY.test(clause) || /と(?:きに備えて|きのために)/u.test(clause)) {
    return "POSSIBLE";
  }
  const end = clause.replace(TRAILING, "");
  if (DECIDED_END.test(end)) return "DECIDED";
  if (/(?:たかった|たい|つもり(?:だった)?|ようだった|らしい|みたい)$/u.test(end)) return "UNKNOWN";
  if (/(?:なかった|ませんでした)$/u.test(end)) return "UNKNOWN";
  if (PAST_END.test(end)) return "DONE";
  if (/(?:[うくすつぬむぶぐる]|ます|てる|ている)$/u.test(end)) return "DECIDED";
  return "UNKNOWN";
}

/**
 * Task59 review: after a possibility or prevention, every later clause of the
 * whole sentence is read (not only the first one). A failed prevention reports
 * the event; hearsay, an accident, a contrast or a past with its own subject may
 * report it.
 */
function laterOutcome(rest: string): { state: ClaimState; reason: string } | null {
  let unclear: { state: ClaimState; reason: string } | null = null;
  const hold = (reason: string) => {
    unclear ??= { state: "UNKNOWN", reason };
  };
  for (const raw of stripQuotes(rest).split(/、|ので|けど|のに|(?<![てで])から|が(?=、)/u)) {
    const clause = raw.replace(TRAILING, "").trim();
    if (!clause) continue;
    if (FAILED_CLAUSE.test(clause)) {
      return { state: "DONE", reason: `後続節「${clause}」で防止の失敗＝発生を述べている` };
    }
    if (/(?:防|止め|避け|間に合|でき)\p{Script=Hiragana}*?(?:ない|ません)$/u.test(clause)) {
      hold(`後続節「${clause}」が防げないことを述べている`);
      continue;
    }
    if (/らしい|らしかった|みたい|そうだ|そうです|っぽい|ようだ|ようでした|ように見え/u.test(clause)) {
      hold(`後続節「${clause}」が伝聞・推量で結果を述べている`);
      continue;
    }
    if (/(?:てしまっ|でしまっ|ちゃっ|じゃっ)/u.test(clause)) {
      hold(`後続節「${clause}」が「〜てしまった」で結果を述べている`);
      continue;
    }
    const past = PAST_END.test(clause);
    if (past && /結局|実際|実は|やっぱり/u.test(clause)) {
      hold(`後続節「${clause}」が逆接の過去で結果を述べている`);
      continue;
    }
    // Review 2/3 (6e6aeda9): a later past is safe only when it is plainly the
    // writer's response — an act on an object (「確認を足した」), a thought
    // (「と思った」) or a decision/design. Any other past (「効かなかった」「遅かった」
    // 「名前になった」「本当に起きた」「安心した」) may report the outcome and is held.
    // 「考える必要があった」 states a need, not an outcome.
    if (/(?:なかった|ませんでした)$/u.test(clause)) {
      hold(`後続節「${clause}」が否定の過去（防止の結果かもしれない）`);
      continue;
    }
    const response = /を/u.test(clause) || /(?:と|って)(?:思|考)/u.test(clause) || DECIDED_END.test(clause) ||
      /(?:必要|余地)があ(?:った|りました)$/u.test(clause);
    if ((past || /(?:かった|だった)$/u.test(clause)) && !response) {
      hold(`後続節「${clause}」が対応行動と言い切れない過去（結果かもしれない）`);
      continue;
    }
    if (/[てで][\p{Script=Han}\p{Script=Katakana}ー]+$/u.test(clause)) {
      hold(`後続節「${clause}」がて形＋体言止めで時制を決められない`);
      continue;
    }
  }
  return unclear;
}

interface Mention {
  verb: Verb;
  start: number;
  end: number;
  cat: Cat;
  quoted: boolean;
}

interface Read {
  state: ClaimState | null; // null = no claim (quoted, a noun, an indirect question)
  reason: string;
}

function framed(state: ClaimState, reason: string, rest: string): Read {
  const later = laterOutcome(rest);
  return later ? { state: later.state, reason: `${reason}／${later.reason}` } : { state, reason };
}

function preventerRead(rest: string): Read {
  const op = PREVENTERS.find((verb) => rest.startsWith(verb.stem));
  if (!op) {
    if (/^(?:まずい|困る|困り|嫌|怖い|面倒|大変)/u.test(rest)) {
      return { state: "POSSIBLE", reason: "「〜のは困る」型の一般論" };
    }
    return { state: "UNKNOWN", reason: "「〜のを」の後ろが防止の動詞ではない" };
  }
  const p = parse(rest, 0, op);
  if (!p) return { state: "UNKNOWN", reason: "防止の動詞の活用を読めない" };
  const after = rest.slice(p.end);
  const said = rest.slice(0, p.end);
  if (p.cat === "NEG" || p.cat === "NEG_PAST") {
    return { state: "DONE", reason: `「${said}」＝防げなかった（発生した）` };
  }
  if (p.cat === "TA") {
    if (/^(?:[。！!]|$|ので|から|けど|が、|ん(?:だ|です)|よ(?:ね|[。！!]|$))/u.test(after)) {
      return framed("PREVENTION", `「${said}」＝防止が完了`, after);
    }
    return framed("UNKNOWN", `「${said}${after.slice(0, 6)}」は防げたか言い切っていない`, after);
  }
  if (p.cat === "DICT") {
    if (/^ことに失敗/u.test(after) || FAILED_PAST.test(clauseEnd(after))) {
      return { state: "DONE", reason: `「${said}${after.slice(0, 8)}」＝防止に失敗（発生した）` };
    }
    if (DECIDED_AFTER.test(after)) return framed("PREVENTION", `「${said}」＋決定・作り`, after);
  }
  return framed("UNKNOWN", `「${said}${after.slice(0, 6)}」の防止の成否を読めない`, after);
}

function preventionHead(rest: string): Read {
  const head = rest.replace(/^に?(?:も|は)?/u, "");
  const seg = clauseEnd(head);
  if (/(?:なかった|ませんでした|できな)/u.test(seg)) {
    return { state: "DONE", reason: `防止の「${seg}」が失敗＝発生した` };
  }
  if (/(?:たかった|つもり|ようだ|らしい|はず|[？?])/u.test(seg)) {
    return { state: "UNKNOWN", reason: `防止の「${seg}」が言い切りでない` };
  }
  if (
    /(?:た|ました|する|します|してる|している|しています)$/u.test(seg) || /^する/u.test(head) ||
    /^[\p{Script=Han}]{1,4}$/u.test(seg)
  ) {
    const cut = stripQuotes(head).search(BOUNDARY);
    return framed("PREVENTION", `「〜ないよう${seg}」＝防止`, cut < 0 ? "" : head.slice(cut));
  }
  return { state: "UNKNOWN", reason: `防止の後ろ「${seg}」を読めない` };
}

function inherited(state: ClaimState | null): ClaimState {
  if (state === null) return "UNKNOWN";
  return state === "PREVENTION" ? "POSSIBLE" : state;
}

function readMention(m: Mention, sentence: string, link: (skip?: number) => Read): Read {
  if (m.quoted) return { state: null, reason: "「」内の引用" };
  const after = sentence.slice(m.end);
  const said = sentence.slice(m.start, m.end);
  switch (m.cat) {
    case "TA": {
      // 「出たらしい」 is hearsay, not 「出たら」.
      if (UNSURE.test(after)) return { state: "UNKNOWN", reason: `「${said}${after.slice(0, 4)}」＝伝聞・推量・つもり` };
      if (after.startsWith("ら")) return framed("POSSIBLE", `「${said}ら」＝仮定`, after.slice(1));
      if (after.startsWith("り")) return link();
      if (/^か(?![もら])/u.test(after)) {
        return /^か[。？?！!]?$/u.test(after)
          ? { state: "UNKNOWN", reason: `「${said}か」＝疑問` }
          : { state: null, reason: `「${said}か」＝間接疑問` };
      }
      if (/^(?:かも|可能性)/u.test(after)) return { state: "POSSIBLE", reason: `「${said}かも」` };
      if (/^(?:と|って)(?:言|伝|聞)/u.test(after)) return { state: "UNKNOWN", reason: `「${said}と言われた」＝伝聞` };
      if (/^(?:と|って)(?:表示|出|書)/u.test(after)) return { state: null, reason: "表示文言の引用" };
      if (/^、?(?:と|って)思/u.test(after) || /^[？?]/u.test(after)) {
        return { state: "UNKNOWN", reason: `「${said}${after.slice(0, 4)}」＝思い込み・疑問` };
      }
      return { state: "DONE", reason: `「${said}」＝過去の言い切り` };
    }
    case "TE": {
      if (/^は(?:いけな|だめ|まず)/u.test(after)) return { state: "POSSIBLE", reason: `「${said}はいけない」` };
      if (after.startsWith("は")) return { state: "UNKNOWN", reason: `「${said}は」を読めない` };
      if (after.startsWith("も")) return { state: "POSSIBLE", reason: `「${said}も」＝逆接の仮定` };
      if (/^(?:ほしくな|欲しくな)/u.test(after)) return { state: "POSSIBLE", reason: "願望" };
      // 「確認してから表示する」: the order of steps takes the head's state.
      return link(after.startsWith("から") ? 2 : 0);
    }
    case "DICT": {
      const modal = after.match(MODAL);
      if (modal) return framed("POSSIBLE", `「${said}${modal[0]}」＝可能性`, after.slice(modal[0].length));
      if (/^(?:とき|時|こと)(?:も|が)ある/u.test(after)) {
        return { state: "DONE", reason: `「${said}${after.slice(0, 5)}」＝実際に起きることがある` };
      }
      if (PREPARE.test(after)) {
        return framed("PREVENTION", `「${said}ときに備えて、」＝備え`, after.slice(after.indexOf("、") + 1));
      }
      if (/^(?:とき|時)/u.test(after)) return { state: "UNKNOWN", reason: `「${said}${after.slice(0, 6)}」は備えか発生か決められない` };
      const cond = after.match(/^(?:と(?!いう|か)|なら(?!な))/u);
      if (cond) return framed("POSSIBLE", `「${said}${cond[0]}」＝条件`, after.slice(cond[0].length));
      const nominal = after.match(/^(?:の[をもは]|ことを)/u);
      if (nominal) return preventerRead(after.slice(nominal[0].length));
      if (DECIDED_AFTER.test(after)) return { state: "DECIDED", reason: `「${said}${after.slice(0, 6)}」＝決定・作り` };
      if (/^(?:前に|まえに)/u.test(after)) return link();
      if (/^ことにな(?:った|りました)/u.test(after)) return { state: "DECIDED", reason: `「${said}ことになった」` };
      const reason = after.match(/^(?:ので|から|ため|けど|し(?=[、。])|ことにな(?:る|ります))/u);
      if (reason) {
        return framed("POSSIBLE", `「${said}${reason[0]}」＝非過去の理由`, after.slice(reason[0].length));
      }
      if (/^(?:ん(?:だ|です))?(?:よね|よ|ね)?[。！!]?$/u.test(after)) return { state: "DECIDED", reason: `「${said}」＝現在形の方針` };
      if (/^(?:の(?![をもは])|という)/u.test(after) || KANJI.test(after[0] ?? "")) {
        // Review 4: 「混ざる事態が起きた」「混ざるのが防げなかった」 are claims.
        const clause = clauseEnd(stripQuotes(after));
        if (FAILED_CLAUSE.test(clause)) return { state: "DONE", reason: `「${said}${clause}」＝防止の失敗` };
        if (/^(?:の|という|[\p{Script=Han}\p{Script=Katakana}ー]+)[がは]/u.test(after) && PAST_END.test(clause)) {
          return { state: "UNKNOWN", reason: `「${said}${clause}」＝修飾された名詞が主語の過去` };
        }
        return { state: null, reason: `「${said}」は名詞の修飾` };
      }
      return { state: "UNKNOWN", reason: `「${said}${after.slice(0, 4)}」を読めない` };
    }
    case "NEG": {
      const so = after.match(/^よう(?:に)?/u);
      if (so) return preventionHead(after.slice(so[0].length));
      if (/^(?:なっ|なり)/u.test(after) || /^(?:ん(?:だ|です))?(?:よね|よ)?[。！!]?$/u.test(after)) {
        return { state: "PREVENTION", reason: `「${said}」＝起きない状態` };
      }
      return { state: "UNKNOWN", reason: `「${said}${after.slice(0, 4)}」を読めない` };
    }
    case "NEG_ZU":
      return after.startsWith("に済")
        ? { state: "PREVENTION", reason: `「${said}に済んだ」` }
        : { state: "UNKNOWN", reason: `「${said}」＝否定の連用（行為の否定）` };
    case "NEG_PAST":
      return { state: "UNKNOWN", reason: `「${said}」＝出典に無い否定の過去` };
    case "COND":
      return framed("POSSIBLE", `「${said}」＝条件`, after);
    case "RENYOU":
      return link();
    case "NOUN_END":
    case "DONE_NOUN":
      return { state: "DONE", reason: `「${said}」＝体言止めの完了` };
    case "NOUN":
      return { state: null, reason: `「${said}」は名詞` };
    default:
      return { state: "UNKNOWN", reason: `「${said}」＝願望・意向` };
  }
}

function mentionsIn(sentence: string): Mention[] {
  const quotes: [number, number][] = [];
  for (const q of sentence.matchAll(/「[^」]*」|『[^』]*』/gu)) quotes.push([q.index!, q.index! + q[0].length]);
  const found: Mention[] = [];
  for (let at = 0; at < sentence.length; at++) {
    // Review 1 (6e6aeda9): a kanji right before the stem (「一度混ざった」「結局出た」)
    // is read, not skipped; a compound read as the event only holds more.
    for (const verb of EVENTS) {
      if (!sentence.startsWith(verb.stem, at)) continue;
      const p = parse(sentence, at, verb);
      if (!p) continue;
      found.push({
        verb,
        start: at,
        end: p.end,
        cat: p.cat,
        quoted: quotes.some(([a, b]) => at > a && at < b),
      });
      at = p.end - 1;
      break;
    }
  }
  return found;
}

export interface ClaimMention {
  event: string;
  span: string;
  state: ClaimState;
  reason: string;
  sentence: string;
}

/** Every claim-bearing mention of a tracked event, with its state and why. */
export function readClaims(text: string): ClaimMention[] {
  // Only the topic seed's own labels are removed (review 6: not any 「…：」).
  const body = text.replace(/^[ \t]*(?:できごと|詰まったこと|決めたこと|今回の切り口)[:：][ \t]*/gmu, "");
  const out: ClaimMention[] = [];
  for (const sentence of body.match(/[^。！？!?\n]+[。！？!?]*/gu) ?? []) {
    const mentions = mentionsIn(sentence);
    const reads: Read[] = new Array(mentions.length);
    for (let i = mentions.length - 1; i >= 0; i--) {
      const m = mentions[i];
      const link = (skip = 0): Read => {
        const rest = sentence.slice(m.end + skip);
        const limit = stripQuotes(rest).search(BOUNDARY);
        for (let j = i + 1; j < mentions.length; j++) {
          if (limit >= 0 && mentions[j].start - m.end - skip > limit) break;
          if (reads[j].state === null) continue;
          return { state: inherited(reads[j].state), reason: `つながる「${sentence.slice(mentions[j].start, mentions[j].end)}」に従う` };
        }
        return { state: headState(rest), reason: `つながる述語「${clauseEnd(stripQuotes(rest))}」に従う` };
      };
      reads[i] = readMention(m, sentence, link);
    }
    mentions.forEach((m, i) => {
      const { state, reason } = reads[i];
      if (state !== null) {
        out.push({ event: m.verb.event, span: sentence.slice(m.start, m.end), state, reason, sentence });
      }
    });
  }
  return out;
}

export interface ClaimJudgement {
  event: string;
  sourceState: ClaimState | "ABSENT";
  candidateState: ClaimState;
  decision: ClaimDecision;
  evidence: string;
  candidateSpan: string;
  reason: string;
}

const SOURCE_STRENGTH: readonly ClaimState[] = ["DONE", "DECIDED", "PREVENTION", "POSSIBLE", "UNKNOWN"];
const DECISION_RANK: Readonly<Record<ClaimDecision, number>> = { PASS_CANDIDATE: 0, HOLD: 1, REJECT: 2 };

function compare(candidate: ClaimState, source: ReadonlySet<ClaimState>): ClaimDecision {
  if (source.size === 0) return "HOLD";
  switch (candidate) {
    case "DONE":
      return source.has("DONE") ? "PASS_CANDIDATE" : "REJECT";
    case "DECIDED":
      return source.has("DONE") || source.has("DECIDED") ? "PASS_CANDIDATE" : "REJECT";
    case "PREVENTION":
      return source.has("PREVENTION") ? "PASS_CANDIDATE" : "HOLD";
    case "POSSIBLE":
      return "PASS_CANDIDATE";
    default:
      return "HOLD";
  }
}

/**
 * Compares the candidate's claims with the topic's, event by event. REJECT: a
 * clear overclaim (decided → done, possible or prevented → happened). HOLD:
 * unclear, or nothing the reader can check. PASS_CANDIDATE only says the event
 * states are kept; the other guards and the voice check still apply.
 */
export function judgeClaimStates(candidate: string, source: string) {
  const bySource = new Map<string, ClaimMention[]>();
  for (const m of readClaims(source)) bySource.set(m.event, [...(bySource.get(m.event) ?? []), m]);
  const worst = new Map<string, ClaimJudgement>();
  for (const m of readClaims(candidate)) {
    const src = bySource.get(m.event) ?? [];
    const states = new Set(src.map((s) => s.state));
    const strongest = SOURCE_STRENGTH.find((s) => states.has(s));
    const decision = compare(m.state, states);
    const judgement: ClaimJudgement = {
      event: m.event,
      sourceState: strongest ?? "ABSENT",
      candidateState: m.state,
      decision,
      evidence: src.find((s) => s.state === strongest)?.sentence ?? "",
      candidateSpan: m.sentence,
      reason: m.reason,
    };
    const prev = worst.get(m.event);
    if (!prev || DECISION_RANK[decision] > DECISION_RANK[prev.decision]) worst.set(m.event, judgement);
  }
  const judgements = [...worst.values()];
  const decision: ClaimDecision = judgements.length === 0
    ? "HOLD"
    : judgements.reduce<ClaimDecision>(
      (acc, j) => DECISION_RANK[j.decision] > DECISION_RANK[acc] ? j.decision : acc,
      "PASS_CANDIDATE",
    );
  return { decision, judgements };
}
