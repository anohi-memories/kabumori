// Topic taxonomy and entity dictionaries for the discovery observer.
//
// Independent of breaking_market's topic rotation (which is not changed). Rules are keyword/regex
// only; a topic is a hint for routing and statistics, not an importance judgement.
import type { EntityMention, Topic } from "./types.ts";

type Rule = { topic: Topic; ja: RegExp | null; en: RegExp[] };

/**
 * Proper nouns and acronyms (written with a leading capital: Fed, SEC, EU, AI, Brent) match
 * case-sensitively, otherwise "fed", "sec" or "ai" in ordinary text become hits. Lower-case
 * common words match case-insensitively so Title Case headlines still hit.
 */
function isProperNoun(term: string): boolean {
  return /^[A-Z0-9]/.test(term);
}

/** English terms on word boundaries. */
export function wordPatterns(terms: readonly string[]): RegExp[] {
  const acronyms = terms.filter(isProperNoun);
  const words = terms.filter((term) => !isProperNoun(term));
  const out: RegExp[] = [];
  if (words.length) out.push(new RegExp(`\\b(?:${words.join("|")})\\b`, "i"));
  if (acronyms.length) out.push(new RegExp(`\\b(?:${acronyms.join("|")})(?![A-Za-z])`));
  return out;
}

function en(...terms: string[]): RegExp[] {
  return wordPatterns(terms);
}
function ja(...terms: string[]): RegExp {
  return new RegExp(terms.join("|"));
}

export const TOPIC_RULES: readonly Rule[] = [
  {
    topic: "monetary_policy",
    ja: ja("金融政策", "政策金利", "利上げ", "利下げ", "金融政策決定会合", "日銀総裁", "量的", "国債買い入れ"),
    en: en("monetary policy", "FOMC", "rate hike", "rate cut", "policy rate", "federal funds", "Governing Council", "quantitative"),
  },
  {
    topic: "rates",
    ja: ja("金利", "国債利回り", "長期金利", "国債入札", "国債発行"),
    en: en("yields?", "Treasury auction", "interest rates?", "bond market"),
  },
  {
    topic: "fx",
    ja: ja("為替", "円安", "円高", "ドル円", "為替介入", "外国為替"),
    en: en("yen", "dollar index", "currency", "foreign exchange", "FX intervention", "exchange rates?"),
  },
  {
    topic: "oil",
    ja: ja("原油", "石油", "ＷＴＩ", "WTI", "ブレント", "OPEC", "製油所", "パイプライン", "タンカー"),
    en: en("oil", "crude", "WTI", "Brent", "OPEC", "refiner(?:y|ies)", "pipeline", "tankers?", "petroleum"),
  },
  {
    topic: "energy",
    ja: ja("エネルギー", "電力", "LNG", "天然ガス", "石炭", "原発", "原子力", "再生可能"),
    en: en("energy", "electricity", "power grid", "LNG", "natural gas", "coal", "nuclear", "renewables?", "utilit(?:y|ies)"),
  },
  {
    topic: "war",
    ja: ja("ミサイル", "攻撃", "空爆", "侵攻", "戦闘", "戦争", "軍事衝突", "ドローン攻撃", "停戦"),
    en: en("missiles?", "airstrikes?", "invasion", "war", "military strike", "drone attack", "shelling", "ceasefire", "troops"),
  },
  {
    topic: "geopolitics",
    ja: ja("外交", "首脳会談", "安全保障", "領土", "地政学", "緊張", "北朝鮮", "台湾海峡"),
    en: en("diplomatic", "summit", "security council", "geopolitical", "tensions", "bilateral", "foreign minister", "Secretary of State"),
  },
  {
    topic: "sanctions",
    ja: ja("制裁", "資産凍結", "エンティティー?リスト"),
    // "designation" alone also hits airspace/port designations (live run 2026-09-28): not used.
    en: en("sanctions?", "OFAC", "asset freeze", "Entity List", "SDN list", "blocked persons"),
  },
  {
    topic: "tariffs",
    ja: ja("関税", "通商", "輸出規制", "輸入規制", "貿易協定", "セーフガード"),
    en: en("tariffs?", "duties", "trade agreement", "export controls?", "import ban", "Section 301", "Section 232", "trade representative"),
  },
  {
    topic: "semiconductor",
    ja: ja("半導体", "ウエハー?", "露光装置", "メモリ", "DRAM", "NAND", "ファウンドリ", "チップ"),
    en: en("semiconductors?", "chips?", "chipmakers?", "wafers?", "foundry", "DRAM", "NAND", "lithography", "TSMC", "Nvidia", "ASML"),
  },
  {
    topic: "ai",
    ja: ja("生成AI", "人工知能", "AI(?![A-Za-z])", "データセンター", "大規模言語モデル"),
    en: en("artificial intelligence", "AI", "generative", "data centers?", "large language models?", "LLM"),
  },
  {
    topic: "regulation",
    ja: ja("規制", "行政処分", "業務改善命令", "業務停止", "指針", "法案", "改正", "告示", "パブリックコメント", "監督"),
    en: en("regulation", "rule", "proposed rule", "final rule", "enforcement", "penalt(?:y|ies)", "directive", "guidance", "supervisory"),
  },
  {
    topic: "disaster",
    ja: ja("地震", "震度", "津波", "噴火", "台風", "豪雨", "特別警報", "洪水", "土砂災害", "大雨"),
    en: en("earthquake", "magnitude", "tsunami", "eruption", "typhoon", "hurricane", "floods?", "wildfire"),
  },
  {
    topic: "cyber",
    ja: ja("サイバー攻撃", "不正アクセス", "ランサムウェア", "情報漏え?洩?い", "システム障害"),
    en: en("cyberattack", "cyber attack", "ransomware", "data breach", "hack(?:ed|ers?)", "outage"),
  },
  {
    topic: "mna",
    ja: ja("買収", "合併", "TOB", "公開買付", "株式取得", "経営統合", "子会社化", "大量保有", "事業譲渡"),
    en: en("acquisition", "acquire", "merger", "takeover", "tender offer", "buyout", "stake"),
  },
  {
    topic: "earnings",
    ja: ja("決算", "業績", "純利益", "営業利益", "売上高", "上方修正", "下方修正", "増配", "減配", "配当"),
    en: en("earnings", "quarterly results", "revenue", "net income", "guidance", "dividend", "profit warning"),
  },
  {
    topic: "product",
    ja: ja("新製品", "発売", "新サービス", "提供開始", "新商品", "発表会"),
    en: en("launch(?:es|ed)?", "unveil(?:s|ed)?", "new product", "rollout", "releases? (?:a|its) new"),
  },
  {
    topic: "lawsuit",
    ja: ja("訴訟", "提訴", "判決", "賠償", "差し止め", "起訴", "逮捕"),
    en: en("lawsuit", "sued", "sues", "court ruling", "verdict", "indict(?:ed|ment)", "settlement", "antitrust"),
  },
  {
    topic: "recall",
    ja: ja("リコール", "自主回収", "回収", "改善対策", "製品事故"),
    en: en("recalls?", "safety defect"),
  },
  {
    topic: "supply_chain",
    ja: ja("供給網", "サプライチェーン", "操業停止", "生産停止", "稼働停止", "出荷停止", "工場火災", "物流", "港湾", "品不足", "部品不足"),
    en: en("supply chain", "shortages?", "production halt", "halts? (?:output|production)", "suspends? production", "plant shutdown",
      "(?:plant|factory) fire", "fire at (?:a|its) (?:plant|factory)", "shipping disruption", "port closure", "logistics"),
  },
  {
    topic: "fiscal",
    ja: ja("予算", "財政", "税制", "補正予算", "国債発行計画", "歳出"),
    en: en("budget", "fiscal", "tax", "debt ceiling", "appropriations"),
  },
  {
    topic: "macro_data",
    ja: ja("GDP", "国内総生産", "景気動向指数", "消費者物価", "CPI", "雇用統計", "機械受注", "鉱工業生産", "日銀短観", "貿易統計"),
    en: en("GDP", "gross domestic product", "CPI", "inflation", "payrolls", "unemployment rate", "PCE", "retail sales", "trade balance"),
  },
];

/** Topics derived from text. "AI" and "chip" false positives are accepted: topics are hints only. */
export function classifyTopics(text: string, defaults: readonly Topic[] = []): Topic[] {
  const normalized = text.normalize("NFKC");
  const found = new Set<Topic>(defaults);
  for (const rule of TOPIC_RULES) {
    if ((rule.ja && rule.ja.test(normalized)) || rule.en.some((pattern) => pattern.test(normalized))) found.add(rule.topic);
  }
  if (found.has("oil")) found.add("energy");
  if (found.has("war")) found.add("geopolitics");
  return [...found];
}

type EntityDef = { kind: EntityMention["kind"]; value: string; patterns: RegExp[] };

function entity(kind: EntityMention["kind"], value: string, jaTerms: string[], enTerms: string[]): EntityDef {
  const patterns = wordPatterns(enTerms);
  if (jaTerms.length) patterns.push(new RegExp(jaTerms.join("|")));
  return { kind, value, patterns };
}

export const ENTITY_DICTIONARY: readonly EntityDef[] = [
  entity("country_or_region", "US", ["米国", "アメリカ", "米政府"], ["United States", "U\\.S\\.", "Washington"]),
  entity("country_or_region", "China", ["中国", "中国政府"], ["China", "Chinese", "Beijing"]),
  entity("country_or_region", "Japan", ["日本"], ["Japan", "Japanese", "Tokyo"]),
  entity("country_or_region", "Taiwan", ["台湾"], ["Taiwan"]),
  entity("country_or_region", "Russia", ["ロシア"], ["Russia", "Russian", "Moscow", "Kremlin"]),
  entity("country_or_region", "Ukraine", ["ウクライナ"], ["Ukraine", "Ukrainian", "Kyiv"]),
  entity("country_or_region", "Iran", ["イラン"], ["Iran", "Iranian", "Tehran"]),
  entity("country_or_region", "Israel", ["イスラエル"], ["Israel", "Israeli"]),
  entity("country_or_region", "North Korea", ["北朝鮮"], ["North Korea", "DPRK", "Pyongyang"]),
  entity("country_or_region", "Middle East", ["中東"], ["Middle East", "Gulf states"]),
  entity("country_or_region", "EU", ["欧州連合"], ["European Union", "EU", "Brussels"]),
  entity("institution", "Federal Reserve", ["FRB", "米連邦準備制度"], ["Federal Reserve", "Fed", "FOMC"]),
  entity("institution", "Bank of Japan", ["日銀", "日本銀行"], ["Bank of Japan", "BOJ"]),
  entity("institution", "ECB", ["欧州中央銀行"], ["ECB", "European Central Bank"]),
  entity("institution", "OPEC", ["石油輸出国機構"], ["OPEC"]),
  entity("institution", "SEC", ["米証券取引委員会"], ["SEC", "Securities and Exchange Commission"]),
  entity("institution", "US Treasury", ["米財務省"], ["Treasury Department", "Department of the Treasury", "OFAC"]),
  entity("institution", "Ministry of Finance Japan", ["財務省"], []),
  entity("institution", "FSA Japan", ["金融庁"], []),
  entity("institution", "White House", ["ホワイトハウス"], ["White House"]),
  entity("chokepoint", "Strait of Hormuz", ["ホルムズ"], ["Hormuz"]),
  entity("chokepoint", "Red Sea / Bab el-Mandeb", ["紅海", "バブ・?エル・?マンデブ"], ["Red Sea", "Bab el-Mandeb", "Houthis?"]),
  entity("chokepoint", "Suez Canal", ["スエズ"], ["Suez"]),
  entity("chokepoint", "Taiwan Strait", ["台湾海峡"], ["Taiwan Strait"]),
  entity("chokepoint", "Panama Canal", ["パナマ運河"], ["Panama Canal"]),
  entity("chokepoint", "Strait of Malacca", ["マラッカ"], ["Malacca"]),
  entity("commodity", "crude oil", ["原油"], ["crude", "WTI", "Brent"]),
  entity("commodity", "LNG / natural gas", ["LNG", "天然ガス"], ["LNG", "natural gas"]),
  // "金" alone is far too generic in Japanese; only price/market phrasing counts.
  entity("commodity", "gold", ["金価格", "金相場", "金先物"], ["gold price", "gold futures", "bullion"]),
  entity("commodity", "copper", ["銅価格", "銅相場"], ["copper"]),
  entity("commodity", "rare earths", ["レアアース"], ["rare earths?"]),
];

export function extractEntities(text: string): EntityMention[] {
  const normalized = text.normalize("NFKC");
  const seen = new Set<string>();
  const out: EntityMention[] = [];
  for (const def of ENTITY_DICTIONARY) {
    const key = `${def.kind}:${def.value}`;
    if (!seen.has(key) && def.patterns.some((pattern) => pattern.test(normalized))) {
      seen.add(key);
      out.push({ kind: def.kind, value: def.value });
    }
  }
  return out;
}
