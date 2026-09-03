import {
  evaluateMorningFacts,
  mentionsUnavailableNikkeiFutures,
  normalizeMorningMetric,
  parseMarketNumber,
  resolveMorningReferenceContext,
  resolveMorningReferenceTime,
  resolveMorningRunMode,
  validateMorningReportFormat,
  type MorningRunMode,
  type NormalizedMorningMetric,
} from "./morning_report_logic.ts";
import { getExpectedUsSessionDate } from "./us_session_date_logic.ts";
import {
  evaluateCloseFacts,
  normalizeCloseMetric,
  resolveCloseRunMode,
  validateCloseReportFormat,
  type CloseRunMode,
  type NormalizedCloseMetric,
  type RawMarketMetric,
} from "./close_report_logic.ts";
import {
  evaluateUsPremarketFacts,
  normalizeUsPremarketMetric,
  resolveUsPremarketRunMode,
  type RawUsPremarketMetric,
  type UsPremarketMetric,
  type UsPremarketRunMode,
} from "./us_premarket_logic.ts";
import {
  isInteractionTopicAllowed,
  resolveJpxTradingDay,
  validateInteractionDraft,
  type JpxTradingDayState,
} from "./interaction_quality_logic.ts";
import {
  TIP_VOICE_RULES,
  tipGenerationRules,
  tipVoiceEvaluationRules,
} from "./tip_voice_logic.ts";
import { KABUMORI_VOICE as SHARED_KABUMORI_VOICE } from "../_shared/kabumori_voice.ts";
import {
  collectVoiceResponseDiagnostics,
  parseVoiceEvaluationOutput,
  VoiceEvaluationOutputError,
  voiceEvaluationFailureNotes,
  type VoiceResponseDiagnostics,
} from "./voice_evaluation_logic.ts";
import {
  classifyMaterialFreshness,
  classifyOptionalMaterialForInclusion,
  hasIndependentCausalSupport,
  hasStrongCausalAssertion,
  independentPublisherCount,
  publisherKey,
  resolveConditionalMaterialType,
  type ReportMaterialType,
} from "./report_material_logic.ts";
import {
  MAX_MORNING_SEARCH_CALLS,
  buildMorningSupplementContext,
  capCandidatePool,
  evaluateMorningSearchBudget,
  inspectMorningWebSearchCalls,
  morningCandidateExtractionInstructions,
  selectMorningCandidates,
  supplementReasons,
  type CheckedMorningCandidate,
  type MorningCandidateDecision,
  type MorningLaneSearchDiagnostics,
  type MorningSearchLane,
  type MorningSupplementContext,
} from "./morning_candidate_logic.ts";
import {
  MorningLaneResponseError,
  attachMorningLaneFailureContext,
  parseMorningLaneResponse,
  type MorningLanePacket,
  type MorningLaneResponseDiagnostics,
} from "./morning_lane_response_logic.ts";
import {
  MORNING_REPORT_MAX_ATTEMPTS,
  computeMorningReportRetryTime,
  reconcileStaleMorningReportRuns,
  shouldRetryMorningReport,
} from "./morning_report_retry_logic.ts";
import {
  MORNING_GREETING_IMAGE_TEST_MODE,
  MorningGreetingImageTestError,
  runMorningGreetingImageTest,
} from "./morning_greeting_image_logic.ts";
import {
  MORNING_GREETING_PAYLOAD_TEST_MODE,
  MorningGreetingPayloadDryRunError,
  runMorningGreetingPayloadDryRun,
} from "./morning_greeting_payload_logic.ts";
import {
  MORNING_GREETING_MANUAL_PUBLISH_MODE,
  MorningGreetingManualPublishError,
  runMorningGreetingManualPublish,
} from "./morning_greeting_publish_logic.ts";
export {
  generateMorningGreeting,
  selectMorningGreetingTheme,
} from "./morning_greeting_logic.ts";
export {
  buildMorningGreetingImageGenerationContext,
  fetchYumeCanonicalReference,
  resolveYumeCanonicalReference,
} from "./yume_reference_logic.ts";
export {
  buildMorningGreetingImagePrompt,
  generateMorningGreetingImageWithOpenAi,
  runMorningGreetingImageTest,
} from "./morning_greeting_image_logic.ts";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const X_API_URL = "https://api.x.com/2/tweets";
const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const TIP_COOLDOWN_HOURS = 24;

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

type Tip = {
  id: string;
  title: string;
  category: string | null;
  base_text: string | null;
  image_url: string | null;
  last_used_at: string | null;
  use_count: number;
  difficulty: "初級" | "中級" | "実践";
};

type XPostResult = { id: string; text: string; response: unknown };
type XTokenState = { accessToken: string; refreshToken: string };
type XAuthContext = {
  tokens: XTokenState;
  clientId: string;
  clientSecret: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  refreshExecuted: boolean;
};

type InteractionTopic = {
  id: string;
  title: string;
  question_format: string;
  prompt_hint: string;
  last_used_at: string | null;
  use_count: number;
};

type MarketContext = { summary: string; source_label: string | null };
type GeneratedInteractionPost = {
  text: string;
  pollOptions: string[] | null;
  voiceEvaluation: VoiceEvaluation;
};

type UsefulTip = {
  id: string;
  title: string;
  category: string;
  topic_description: string;
  source_hint: string | null;
};

type UsefulTipDraft = {
  text: string;
  sourceUrls: string[];
  factCheckStatus: "passed" | "failed";
  factCheckNotes: string[];
  model: "gpt-5.6-luna" | "gpt-5.6-sol";
  escalatedToSol: boolean;
  inputTokens: number;
  outputTokens: number;
  apiCostUsd: number;
};

type ParsedUsefulTipOutput = {
  fact_check_status: "passed" | "failed";
  fact_check_notes: string[];
  needs_sol: boolean;
  source_urls: string[];
  text: string;
};

class UsefulTipOutputError extends Error {
  readonly parseAttemptCount: number;

  constructor(message: string, parseAttemptCount: number) {
    super(message);
    this.name = "UsefulTipOutputError";
    this.parseAttemptCount = parseAttemptCount;
  }
}

type MorningMetric = NormalizedMorningMetric;

type MorningPoint = {
  title: string;
  what_happened: string;
  japan_relevance: string;
  affected_sectors: string[];
  what_to_watch: string;
  source_url?: string;
  timestamp?: string;
  material_type?: ReportMaterialType;
  causal_claim_strength?: "none" | "qualified" | "strong";
  supporting_source_urls?: string[];
  publisher?: string;
  timestamp_precision?: "date" | "datetime";
  japan_relevance_level?: "high" | "medium" | "low";
  market_impact?: "high" | "medium" | "low";
  importance_class?: "major" | "standard" | "administrative";
  lane?: MorningSearchLane;
};

type MorningConditionalFactor = {
  category: "fx" | "rates" | "oil" | "china" | "geopolitics" | "economic_indicator" | "central_bank" | "crypto" | "other";
  headline: string;
  value: string;
  japan_relevance: string;
  timestamp: string;
  source_url: string;
  material_type?: ReportMaterialType;
};

type MorningReportDraft = {
  text: string;
  targetTradingDate: string;
  isJpxBusinessDay: boolean;
  usSessionDate: string;
  importantPoints: MorningPoint[];
  usIndices: { dow: MorningMetric; sp500: MorningMetric; nasdaq: MorningMetric };
  semiconductor: { sox: MorningMetric; leaders: MorningMetric[] };
  nikkeiFutures: MorningMetric;
  nikkeiFuturesAvailable: boolean;
  conditionalFactors: MorningConditionalFactor[];
  sourceUrls: string[];
  marketDataTimestamp: string;
  factCheckStatus: "passed" | "failed";
  factCheckNotes: string[];
  model: "gpt-5.6-luna";
  inputTokens: number;
  outputTokens: number;
  webSearchCalls: number;
  retrievalDiagnostics: MorningRetrievalDiagnostics;
  apiCostUsd: number;
  runMode: MorningRunMode;
};

type MorningRetrievalDiagnostics = {
  searchCalls: number;
  laneApiCallCount: number;
  totalSearchQueryCount: number;
  lanes: Array<{
    lane: MorningSearchLane;
    candidateCount: number;
    aiReturnedCandidateCount: number;
    mechanicallyCheckedCandidateCount: number;
    qualifiedCandidateCount: number;
    sourceCount: number;
    webSearchCallItemCount: number;
    actionTypes: string[];
    searchQueryCount: number;
    response: MorningLaneResponseDiagnostics;
  }>;
  candidateCount: number;
  candidates: Array<{
    title: string;
    publisher: string;
    sourceUrl: string;
    category: ReportMaterialType;
    lane: MorningSearchLane;
    timestamp: string;
    timestampPrecision: "date" | "datetime";
    freshness: string;
    score: number;
    rank: number | null;
    selected: boolean;
    reasons: string[];
  }>;
  finalPublisherCount: number;
  supplementUsed: boolean;
  supplementReasons: string[];
  supplementContext: MorningSupplementContext | null;
  futureOptionalFilteredCount: number;
  unknownTimestampOptionalFilteredCount: number;
};

type CloseTheme = {
  name: string;
  direction: "strong" | "weak";
  explanation: string;
  timestamp: string;
  source_url: string;
};

type CloseCarryover = {
  item: string;
  connection_to_today: string;
  timestamp: string;
  source_url: string;
  material_type?: ReportMaterialType;
};

type CloseReportDraft = {
  text: string;
  tradingDate: string;
  importantPoints: MorningPoint[];
  nikkei: NormalizedCloseMetric;
  topix: NormalizedCloseMetric;
  growth250: NormalizedCloseMetric | null;
  strongThemes: CloseTheme[];
  weakThemes: CloseTheme[];
  nikkeiFutures1545: NormalizedCloseMetric | null;
  conditionalFactors: MorningConditionalFactor[];
  carryovers: CloseCarryover[];
  sourceUrls: string[];
  marketDataTimestamp: string;
  factCheckStatus: "passed" | "failed";
  factCheckNotes: string[];
  model: "gpt-5.6-luna";
  inputTokens: number;
  outputTokens: number;
  webSearchCalls: number;
  apiCostUsd: number;
  runMode: CloseRunMode;
};

type UsPremarketReportDraft = {
  text: string;
  reportDate: string;
  isUsMarketOpen: boolean;
  importantPoints: MorningPoint[];
  futures: { sp500: UsPremarketMetric; nasdaq100: UsPremarketMetric; dow: UsPremarketMetric };
  semiconductorSignal: UsPremarketMetric | null;
  premarketMovers: UsPremarketMetric[];
  conditionalFactors: MorningConditionalFactor[];
  sourceUrls: string[];
  marketDataTimestamp: string;
  factCheckStatus: "passed" | "failed";
  factCheckNotes: string[];
  model: "gpt-5.6-luna" | "gpt-5.6-sol";
  escalatedToSol: boolean;
  inputTokens: number;
  outputTokens: number;
  webSearchCalls: number;
  apiCostUsd: number;
  runMode: UsPremarketRunMode;
};

type VoiceEvaluation = {
  factCheckStatus: "passed" | "needs_review";
  factualConcerns: string[];
  humanLikeness: number;
  aiArticleLikeness: number;
  emojiCount: number;
  emojiNaturalness: number;
  naturalWithoutEmoji: boolean;
  passed: boolean;
  notes: string[];
  inputTokens: number;
  outputTokens: number;
  apiCostUsd: number;
  responseDiagnostics: VoiceResponseDiagnostics | null;
};

type KabumoriPostType =
  | "tip" | "useful_tip" | "interaction" | "morning" | "morning_report" | "close_report" | "us_premarket_report"
  | "market_close" | "us_premarket" | "breaking_news";

const KABUMORI_VOICE = SHARED_KABUMORI_VOICE;

const KABUMORI_TYPE_VOICE: Record<KabumoriPostType, string[]> = {
  tip: [...TIP_VOICE_RULES],
  useful_tip: [
    "知って得する株の豆知識です。証券会社FAQではなく、制度を調べていて見つけた実務的な話を友達へ共有する感じにしてください。",
    "正式名称、条件、例外、証券会社差は正確に残します。",
    "絵文字は2〜5個を目安に、発見感や注意点が伝わる場所へ自然に入れてください。制度の正確さを邪魔する使い方はしません。",
  ],
  interaction: [
    "交流投稿です。質問調査ではなく、株の話をしている人がフォロワーへ雑談を始める文章にしてください。全投稿でいちばんくだけた自然な会話にします。",
    "答え方を指導せず、アンケート操作も説明しません。",
    "絵文字は2〜5個を目安に、感情や話しかける間合いが自然に伝わるように使ってください。",
  ],
  morning: [
    "朝刊です。金融ニュース番組ではなく、朝に本人が相場の数字を見ながら、そのまま投稿している感じにしてください。",
    "『〜が想定されます』『〜を注視しましょう』は使わず、難しい相場用語は初心者にも伝わる短い言葉にします。",
    "絵文字は2〜4個を目安に、朝の挨拶、市場の強弱、今日気になる材料に合うものを使ってください。",
  ],
  morning_report: [
    "かぶモリ朝刊です。株好きの個人が、前夜から今朝の重要な流れを見ながら、今日の日本株で何が大事かを分かりやすく共有してください。ニュース番組や証券会社レポートの読み上げにはしません。",
    "タイトル直後に『📌 今日の注目ポイント』を重要度順で必ず3件置きます。その後で海外市場の流れ、各ポイントの理由、日本株との関係、影響しそうな業種や今日見る場所を説明してください。",
    "具体的な指数値の羅列はせず、検証済みの方向感、ニュース、政策、金利・為替の影響、AI・半導体、国内材料を重要度に応じて選びます。すべてを毎日詰め込みません。",
    "同じ材料を冒頭、本文、締めで言い換えて繰り返しません。最後は売買指示ではなく、相場を理解するための観察点を『💬 今日のひとこと』として一つだけ添えます。",
    "絵文字は2〜4個を目安に、朝の挨拶や各セクションの視認性を助ける場所へ自然に使ってください。",
  ],
  close_report: [
    "かぶモリ大引け後レポートです。株好きの個人が、一日の日本株を一緒に振り返るように自然に話してください。ニュース記事や証券会社レポートの読み上げにはしません。",
    "タイトル直後に『📌 今日の3ポイント』を重要度順で必ず3件置きます。その後で市場全体の流れ、各ポイントの理由、強弱テーマ、明日へ続く材料を整理してください。",
    "根拠の弱い因果は断定せず、『意識された可能性があります』『重しになったようです』など事実の確度に合わせます。",
    "短い段落と改行を使い、スマホで読みやすくします。文字数や絵文字数を合わせるための水増しはしません。",
  ],
  market_close: [
    "大引け後の投稿です。レポートを読み上げるのではなく、一日相場を見ていた本人の自然な感想が少し伝わる文章にしてください。",
    "数字だけを並べず、強かった所と重かった所を話し、必要なら明日気になる材料で自然に終えます。",
    "絵文字は2〜4個を目安に、その日の強弱や感想へ自然に添えてください。",
  ],
  us_premarket: [
    "米国市場前チェックです。夜に本人が市場を見ながら、先物・金利・為替・主要銘柄を自分の言葉で短く投稿する感じにしてください。",
    "絵文字は2〜4個を目安に、夜の空気や市場の強弱へ自然に添えてください。",
  ],
  us_premarket_report: [
    "米国市場前チェックです。株好きの個人が寄り付き前の最新データを見ながら、今夜の重要材料と翌日の日本株へのつながりを自然に共有してください。証券会社レポートの読み上げにはしません。",
    "冒頭は数値一覧にせず、重要度順の材料を2〜3個だけ提示します。先物、半導体、値動きの大きい主要株、必要な日の金利・為替・指標を短い段落で整理してください。",
    "『初心者向けに言うと』『これ、けっこう迷いません？』は使いません。無理に結論を作らず、翌日の日本株で影響を受けそうな業種やテーマを短く添えて自然に終えます。",
    "絵文字は内容と読みやすさに合う範囲で自然に使い、数を合わせるためには足しません。",
  ],
  breaking_news: [
    "重要ニュース・速報です。キャラクター性より正確性、速報性、誤解のなさを優先しつつ、無機質になりすぎない自然な口調にしてください。",
    "重大ニュースでは絵文字を無理に使わず、0〜2個。",
  ],
};

function kabumoriVoice(postType: KabumoriPostType, variationKey: string): string[] {
  const seed = Array.from(variationKey).reduce(
    (total, character) => (total * 31 + (character.codePointAt(0) ?? 0)) >>> 0, 0,
  );
  const openingDirections = postType === "interaction"
    ? [
      "前置きなしで、聞きたいことをそのまま尋ねる",
      "よくある投資場面を一言置いてから尋ねる",
      "多くの人が迷いやすい場面へ自然に触れてから尋ねる",
      "『これ、けっこう迷いません？』のような雑談から入る",
      "初心者にも身近な短い問いから入る",
    ]
    : [
      "よくある動きや疑問をぽつりと話す", "数字や事実をそのまま置いてから話す",
      "素朴な疑問から入る", "よくある勘違いへ自然に触れる",
      "『これ知ってました？』から会話を始める", "前置きなしで本題から入る",
    ];
  const closingDirections = [
    "まとめず本文の流れのまま終える", "短い感想だけ残す", "気になる点で自然に止める",
    "条件や例外を一言だけ添えて終える", "会話の余韻を残して終える",
  ];
  return [
    ...KABUMORI_VOICE,
    ...KABUMORI_TYPE_VOICE[postType],
    `今回の冒頭の方向性: ${openingDirections[seed % openingDirections.length]}`,
    `今回の締めの方向性: ${closingDirections[(seed >>> 3) % closingDirections.length]}`,
  ];
}

type ScheduledPost = {
  id: string;
  post_type: string;
  slot_no: number;
  scheduled_for: string;
  attempt_count: number;
  target_difficulty: Tip["difficulty"] | null;
  target_question_format: string | null;
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "UNEXPECTED_ERROR";
  return /^[A-Z0-9_:-]+$/.test(message) ? message.slice(0, 160) : "UNEXPECTED_ERROR";
}

function extractOutputText(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) return null;

  const text = output.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const content = (item as { content?: unknown }).content;
    return Array.isArray(content) ? content : [];
  }).filter((item) =>
    typeof item === "object" && item !== null &&
    (item as { type?: unknown }).type === "output_text" &&
    typeof (item as { text?: unknown }).text === "string"
  ).map((item) => (item as { text: string }).text).join("").trim();

  return text.length > 0 ? text : null;
}

function supabaseHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

const OFFICIAL_SOURCE_DOMAINS = [
  "nta.go.jp", "fsa.go.jp", "jpx.co.jp", "jsda.or.jp", "go.jp",
  "sec.gov", "irs.gov", "nyse.com", "nasdaq.com",
  "sbisec.co.jp", "rakuten-sec.co.jp", "monex.co.jp",
  "matsui.co.jp", "daiwa.jp", "nomura.co.jp",
];

const MORNING_SOURCE_DOMAINS = [
  "jpx.co.jp", "tdnet.info", "boj.or.jp", "mof.go.jp", "cao.go.jp", "stat.go.jp",
  "federalreserve.gov", "treasury.gov", "bls.gov", "bea.gov", "eia.gov",
  "nasdaq.com", "nyse.com", "spglobal.com", "cmegroup.com",
  "reuters.com", "bloomberg.com", "nikkei.com",
  "apnews.com", "finance.yahoo.com", "investing.com",
  "nvidia.com", "amd.com", "intel.com", "apple.com", "microsoft.com",
  "amazon.com", "aboutamazon.com", "meta.com", "about.fb.com", "abc.xyz", "tesla.com",
];

function isAllowedOfficialUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return OFFICIAL_SOURCE_DOMAINS.some((domain) =>
      host === domain || host.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

function canonicalizeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

function removeInlineCitations(text: string): string {
  return text
    .replace(/\s*\(\[[^\]]+\]\(https?:\/\/[^)]+\)\)/g, "")
    .replace(/\s*\[[^\]]+\]\(https?:\/\/[^)]+\)/g, "")
    .trim();
}

function collectWebSourceUrls(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectWebSourceUrls(item, found);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (key === "url" && typeof child === "string" && isAllowedOfficialUrl(child)) {
        found.add(child);
      } else {
        collectWebSourceUrls(child, found);
      }
    }
  }
  return found;
}

function isAllowedMorningUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return MORNING_SOURCE_DOMAINS.some((domain) =>
      host === domain || host.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

function collectMorningWebSourceUrls(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectMorningWebSourceUrls(item, found);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (key === "url" && typeof child === "string" && isAllowedMorningUrl(child)) {
        found.add(child);
      } else {
        collectMorningWebSourceUrls(child, found);
      }
    }
  }
  return found;
}

function countWebSearchCalls(response: unknown): number {
  if (typeof response !== "object" || response === null) return 0;
  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) return 0;
  return output.filter((item) =>
    typeof item === "object" && item !== null &&
    (item as { type?: unknown }).type === "web_search_call"
  ).length;
}

function getUsage(response: unknown): { input: number; output: number } {
  if (typeof response !== "object" || response === null) return { input: 0, output: 0 };
  const usage = (response as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return { input: 0, output: 0 };
  const input = (usage as { input_tokens?: unknown }).input_tokens;
  const output = (usage as { output_tokens?: unknown }).output_tokens;
  return {
    input: typeof input === "number" ? input : 0,
    output: typeof output === "number" ? output : 0,
  };
}

function isParsedUsefulTipOutput(value: unknown): value is ParsedUsefulTipOutput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.fact_check_status === "passed" || candidate.fact_check_status === "failed") &&
    Array.isArray(candidate.fact_check_notes) &&
    candidate.fact_check_notes.length >= 1 &&
    candidate.fact_check_notes.length <= 8 &&
    candidate.fact_check_notes.every((item) => typeof item === "string") &&
    typeof candidate.needs_sol === "boolean" &&
    Array.isArray(candidate.source_urls) &&
    candidate.source_urls.length <= 8 &&
    candidate.source_urls.every((item) => typeof item === "string") &&
    typeof candidate.text === "string"
  );
}

export function parseUsefulTipOutput(
  rawOutput: string,
): { value: ParsedUsefulTipOutput; parseAttemptCount: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    const fenced = rawOutput.match(/^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*\s*$/iu);
    if (!fenced) {
      throw new UsefulTipOutputError("USEFUL_TIP_JSON_PARSE_FAILED", 1);
    }
    try {
      parsed = JSON.parse(fenced[1]);
    } catch {
      throw new UsefulTipOutputError("USEFUL_TIP_JSON_PARSE_FAILED", 2);
    }
    if (!isParsedUsefulTipOutput(parsed)) {
      throw new UsefulTipOutputError("USEFUL_TIP_SCHEMA_INVALID", 2);
    }
    return { value: parsed, parseAttemptCount: 2 };
  }
  if (!isParsedUsefulTipOutput(parsed)) {
    throw new UsefulTipOutputError("USEFUL_TIP_SCHEMA_INVALID", 1);
  }
  return { value: parsed, parseAttemptCount: 1 };
}

export function isUsefulTipOutputTruncated(response: unknown): boolean {
  if (typeof response !== "object" || response === null) return false;
  const status = (response as { status?: unknown }).status;
  const details = (response as { incomplete_details?: unknown }).incomplete_details;
  return status === "incomplete" && typeof details === "object" && details !== null &&
    (details as { reason?: unknown }).reason === "max_output_tokens";
}

function modelCostUsd(model: UsefulTipDraft["model"], input: number, output: number): number {
  const rates = model === "gpt-5.6-sol"
    ? { input: 5, output: 30 }
    : { input: 0.2, output: 1.2 };
  return Number(((input * rates.input + output * rates.output) / 1_000_000).toFixed(6));
}

function morningApiCostUsd(input: number, output: number, webSearchCalls: number): number {
  const tokenCost = (input * 0.2 + output * 1.2) / 1_000_000;
  const searchCost = webSearchCalls * 0.01;
  return Number((tokenCost + searchCost).toFixed(6));
}

async function fetchOpenAiWithSingleRetry(
  request: () => Promise<Response>,
): Promise<Response> {
  let response = await request();
  if (response.status === 429 || response.status === 503) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    response = await request();
  }
  return response;
}

async function selectUsefulTipsByTitles(
  supabaseUrl: string,
  serviceRoleKey: string,
  titles: string[],
): Promise<UsefulTip[]> {
  const params = new URLSearchParams({
    select: "id,title,category,topic_description,source_hint",
    is_active: "eq.true",
    title: `in.(${titles.map((title) => `"${title.replaceAll('"', '\\"')}"`).join(",")})`,
    order: "created_at.asc",
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/useful_tips?${params}`, {
    headers: supabaseHeaders(serviceRoleKey),
  });
  if (!response.ok) throw new Error("USEFUL_TIP_SELECT_FAILED");
  return await response.json() as UsefulTip[];
}

async function createUsefulTipDraft(
  openAiApiKey: string,
  tip: UsefulTip,
  model: UsefulTipDraft["model"] = "gpt-5.6-luna",
): Promise<UsefulTipDraft & { needsSol: boolean }> {
  const voiceKey = `${tip.id}:${new Date().toISOString().slice(0, 10)}`;
  const response = await fetchOpenAiWithSingleRetry(() => fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${openAiApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      store: false,
      max_output_tokens: 2400,
      tools: [{
        type: "web_search",
        filters: { allowed_domains: OFFICIAL_SOURCE_DOMAINS },
        search_context_size: "high",
        user_location: { type: "approximate", country: "JP", timezone: "Asia/Tokyo" },
      }],
      tool_choice: "required",
      include: ["web_search_call.action.sources"],
      instructions: [
        ...kabumoriVoice("useful_tip", voiceKey),
        "あなたは日本の株式制度を扱う慎重なファクトチェッカーでもあります。",
        "必ずWeb検索を行い、官公庁・取引所・業界団体・企業IR・証券会社公式ヘルプだけを根拠にしてください。学習済み知識だけで補完しないでください。",
        "税金・NISA・信用取引・貸株・優待・配当は、『必ず』『全員』『必須』などで一般化しないでください。申告要否や結論が条件で変わる場合は、『課税対象となる利益がある場合は原則として』など、条件と例外を本文に明記してください。",
        "証券会社固有の仕様は一般化せず、会社によって異なると明記してください。公式情報が不足・矛盾・古い場合はfact_check_statusをfailedにしてください。",
        "本文は350〜700文字を目安、最大900文字。制度解説に必要な事実は保ちつつ、証券会社FAQのような『導入→説明→注意→助言』の固定構成にはしないでください。",
        "事実、気づき、短い疑問、一般的な感想のどこから話し始めても構いません。理由、例、条件、注意点の順番も毎回変え、まとめを作らず自然に終えて構いません。",
        "『これ知ってました？』のような会話の入りは使えますが、毎回同じフックにしません。制度を教える先生ではなく、調べて分かったことを自分のXで共有する人として書いてください。",
        "1投稿1テーマを守り、テーマの判断に必要でない周辺制度や別商品の補足は追加しないでください。正確性に必要な条件・例外・証券会社差は削らないでください。",
        "テーマがNISA配当金の受取方法の場合は、国内上場株式の配当の受取方法だけに絞り、投資信託の分配金や別商品の扱いを補足しないでください。",
        "『確認しておくと安心です』『見ておきたいところですね』『まずは確認しましょう』のようなFAQ的な助言で締めないでください。本文で自然に終了、短い注意、一般的な感想のいずれかにします。『みんなはどう？』『保存して』などの反応要求も入れません。",
        "税率・手数料・日数・上限・制度上の金額は公式情報で確認できた場合だけ使ってください。計算例を使う場合は算式と結果を再確認してください。",
        "複数公式ソースの矛盾、複雑な税務、条件依存、断定過多、数値疑義があればneeds_solをtrueにしてください。",
        "source_urlsには実際に確認した公式ページだけを入れてください。",
        "本文textにはURL、出典名、Markdownリンク、引用記号を入れず、出典はsource_urlsだけへ分離してください。",
      ].join("\n"),
      input: [
        `テーマ: ${tip.title}`,
        `カテゴリ: ${tip.category}`,
        `説明: ${tip.topic_description}`,
        `確認候補URL: ${tip.source_hint || "なし。優先順位に従い公式情報を検索すること"}`,
        `確認日時: ${new Date().toISOString()}`,
      ].join("\n"),
      text: { format: { type: "json_schema", name: "useful_tip_verification", strict: true, schema: {
        type: "object",
        properties: {
          fact_check_status: { type: "string", enum: ["passed", "failed"] },
          fact_check_notes: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
          needs_sol: { type: "boolean" },
          source_urls: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 8 },
          text: { type: "string" },
        },
        required: ["fact_check_status", "fact_check_notes", "needs_sol", "source_urls", "text"],
        additionalProperties: false,
      } } },
    }),
  }));
  if (!response.ok) throw new Error(`USEFUL_TIP_OPENAI_FAILED:${response.status}`);
  const raw = await response.json();
  const output = extractOutputText(raw);
  if (isUsefulTipOutputTruncated(raw)) {
    console.warn("Useful tip output rejected", {
      rawOutputLength: output ? Array.from(output).length : 0,
      parseAttemptCount: 0,
      errorCategory: "USEFUL_TIP_OUTPUT_TRUNCATED",
    });
    throw new Error("USEFUL_TIP_OUTPUT_TRUNCATED");
  }
  if (!output) throw new Error("USEFUL_TIP_EMPTY_OUTPUT");
  let parsedResult: { value: ParsedUsefulTipOutput; parseAttemptCount: number };
  try {
    parsedResult = parseUsefulTipOutput(output);
  } catch (error) {
    const category = error instanceof Error ? error.message : "USEFUL_TIP_JSON_PARSE_FAILED";
    console.warn("Useful tip output rejected", {
      rawOutputLength: Array.from(output).length,
      parseAttemptCount: error instanceof UsefulTipOutputError ? error.parseAttemptCount : 0,
      errorCategory: category,
    });
    throw error;
  }
  const parsed = parsedResult.value;
  const actualSources = collectWebSourceUrls(raw);
  const actualCanonical = new Set(
    Array.from(actualSources).map(canonicalizeUrl).filter((url): url is string => url !== null),
  );
  const sourceUrls = parsed.source_urls.filter((url) => {
    const canonical = canonicalizeUrl(url);
    return isAllowedOfficialUrl(url) && canonical !== null && actualCanonical.has(canonical);
  }).slice(0, 8);
  const status = parsed.fact_check_status === "passed" && sourceUrls.length > 0 ? "passed" : "failed";
  const usage = getUsage(raw);
  return {
    text: status === "passed" ? removeInlineCitations(parsed.text) : "",
    sourceUrls,
    factCheckStatus: status,
    factCheckNotes: parsed.fact_check_notes,
    model,
    escalatedToSol: model === "gpt-5.6-sol",
    inputTokens: usage.input,
    outputTokens: usage.output,
    apiCostUsd: modelCostUsd(model, usage.input, usage.output),
    needsSol: parsed.needs_sol,
  };
}

async function saveUsefulTipVerification(
  supabaseUrl: string, serviceRoleKey: string, tip: UsefulTip, draft: UsefulTipDraft,
): Promise<void> {
  const response = await fetch(`${supabaseUrl}/rest/v1/useful_tip_verifications`, {
    method: "POST",
    headers: { ...supabaseHeaders(serviceRoleKey), Prefer: "return=minimal" },
    body: JSON.stringify({
      useful_tip_id: tip.id, source_urls: draft.sourceUrls, verified_at: new Date().toISOString(),
      model: draft.model, escalated_to_sol: draft.escalatedToSol,
      input_tokens: draft.inputTokens, output_tokens: draft.outputTokens,
      api_cost_usd: draft.apiCostUsd, fact_check_status: draft.factCheckStatus,
      generated_text: draft.text || null,
      error_code: draft.factCheckStatus === "failed" ? draft.factCheckNotes.join(" | ").slice(0, 1000) : null,
    }),
  });
  if (!response.ok) throw new Error("USEFUL_TIP_VERIFICATION_SAVE_FAILED");
}

async function selectUsefulTip(
  supabaseUrl: string, serviceRoleKey: string,
): Promise<UsefulTip | null> {
  const cutoff = new Date(Date.now() - 150 * 24 * 60 * 60 * 1000).toISOString();
  const params = new URLSearchParams({
    select: "id,title,category,topic_description,source_hint",
    is_active: "eq.true",
    or: `(last_used_at.is.null,last_used_at.lt.${cutoff})`,
    order: "last_used_at.asc.nullsfirst,use_count.asc,created_at.asc",
    limit: "1",
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/useful_tips?${params}`, {
    headers: supabaseHeaders(serviceRoleKey),
  });
  if (!response.ok) throw new Error("USEFUL_TIP_SELECT_FAILED");
  const tips = await response.json() as UsefulTip[];
  return tips[0] ?? null;
}

async function generateVerifiedUsefulTip(
  openAiApiKey: string, tip: UsefulTip,
): Promise<UsefulTipDraft> {
  const luna = await createUsefulTipDraft(openAiApiKey, tip);
  if (!luna.needsSol && luna.factCheckStatus === "passed") return luna;
  const sol = await createUsefulTipDraft(openAiApiKey, tip, "gpt-5.6-sol");
  return {
    ...sol,
    escalatedToSol: true,
    inputTokens: luna.inputTokens + sol.inputTokens,
    outputTokens: luna.outputTokens + sol.outputTokens,
    apiCostUsd: Number((luna.apiCostUsd + sol.apiCostUsd).toFixed(6)),
  };
}

async function selectTip(
  supabaseUrl: string,
  serviceRoleKey: string,
  difficulty?: Tip["difficulty"] | null,
): Promise<Tip | null> {
  const cutoff = new Date(
    Date.now() - TIP_COOLDOWN_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const params = new URLSearchParams({
    select: "id,title,category,base_text,image_url,last_used_at,use_count,difficulty",
    is_active: "eq.true",
    or: `(last_used_at.is.null,last_used_at.lt.${cutoff})`,
    order: "last_used_at.asc.nullsfirst,use_count.asc,created_at.asc",
    limit: "1",
  });
  if (difficulty) params.set("difficulty", `eq.${difficulty}`);

  const response = await fetch(
    `${supabaseUrl}/rest/v1/tips?${params.toString()}`,
    { headers: supabaseHeaders(serviceRoleKey) },
  );
  if (!response.ok) {
    console.error("Failed to select a tip", { status: response.status });
    throw new Error("TIP_SELECT_FAILED");
  }
  const tips = await response.json() as Tip[];
  return tips[0] ?? null;
}

async function selectTipForPreview(
  supabaseUrl: string, serviceRoleKey: string, difficulty?: Tip["difficulty"],
): Promise<Tip | null> {
  const params = new URLSearchParams({
    select: "id,title,category,base_text,image_url,last_used_at,use_count,difficulty",
    is_active: "eq.true",
    order: "created_at.asc",
    limit: "1",
  });
  if (difficulty) params.set("difficulty", `eq.${difficulty}`);
  const response = await fetch(`${supabaseUrl}/rest/v1/tips?${params}`, {
    headers: supabaseHeaders(serviceRoleKey),
  });
  if (!response.ok) throw new Error("TIP_PREVIEW_SELECT_FAILED");
  const tips = await response.json() as Tip[];
  return tips[0] ?? null;
}

async function selectInteractionTopic(
  supabaseUrl: string,
  serviceRoleKey: string,
  tradingDay: JpxTradingDayState,
  targetQuestionFormat?: string | null,
): Promise<InteractionTopic | null> {
  const headers = supabaseHeaders(serviceRoleKey);
  const recentParams = new URLSearchParams({
    select: "question_format",
    is_active: "eq.true",
    last_used_at: "not.is.null",
    order: "last_used_at.desc",
    limit: "1",
  });
  const recentResponse = await fetch(
    `${supabaseUrl}/rest/v1/interaction_topics?${recentParams}`,
    { headers },
  );
  if (!recentResponse.ok) throw new Error("INTERACTION_RECENT_SELECT_FAILED");
  const recent = await recentResponse.json() as Array<{ question_format: string }>;

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const params = new URLSearchParams({
    select: "id,title,question_format,prompt_hint,last_used_at,use_count",
    is_active: "eq.true",
    or: `(last_used_at.is.null,last_used_at.lt.${cutoff})`,
    order: "last_used_at.asc.nullsfirst,use_count.asc,created_at.asc",
    limit: "60",
  });
  if (targetQuestionFormat) {
    params.set("question_format", `eq.${targetQuestionFormat}`);
  } else if (recent[0]?.question_format) {
    params.set("question_format", `neq.${recent[0].question_format}`);
  }
  const response = await fetch(
    `${supabaseUrl}/rest/v1/interaction_topics?${params}`,
    { headers },
  );
  if (!response.ok) throw new Error("INTERACTION_TOPIC_SELECT_FAILED");
  const topics = await response.json() as InteractionTopic[];
  return topics.find((topic) =>
    isInteractionTopicAllowed(topic.title, topic.prompt_hint, tradingDay.isTradingDay)
  ) ?? null;
}

async function getJpxTradingDay(
  supabaseUrl: string,
  serviceRoleKey: string,
  referenceTimeIso = new Date().toISOString(),
): Promise<JpxTradingDayState> {
  const preliminary = resolveJpxTradingDay(referenceTimeIso, new Set());
  if (preliminary.reason === "weekend") return preliminary;
  const params = new URLSearchParams({
    select: "holiday_date",
    market: "eq.JPX",
    holiday_date: `eq.${preliminary.date}`,
    limit: "1",
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/market_holidays?${params}`, {
    headers: supabaseHeaders(serviceRoleKey),
  });
  if (!response.ok) throw new Error("JPX_CALENDAR_SELECT_FAILED");
  const holidays = await response.json() as Array<{ holiday_date: string }>;
  return resolveJpxTradingDay(
    referenceTimeIso,
    new Set(holidays.map((holiday) => holiday.holiday_date)),
  );
}

async function selectMarketContext(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<MarketContext | null> {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const params = new URLSearchParams({
    select: "summary,source_label",
    context_date: `eq.${today}`,
    or: `(valid_until.is.null,valid_until.gt.${new Date().toISOString()})`,
    order: "created_at.desc",
    limit: "1",
  });
  const response = await fetch(
    `${supabaseUrl}/rest/v1/market_contexts?${params}`,
    { headers: supabaseHeaders(serviceRoleKey) },
  );
  if (!response.ok) throw new Error("MARKET_CONTEXT_SELECT_FAILED");
  const contexts = await response.json() as MarketContext[];
  return contexts[0] ?? null;
}

function xWeightedLength(text: string): number {
  return Array.from(text).reduce((length, character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const singleWeight =
      codePoint <= 0x10ff ||
      (codePoint >= 0x2000 && codePoint <= 0x200d) ||
      (codePoint >= 0x2010 && codePoint <= 0x201f) ||
      (codePoint >= 0x2032 && codePoint <= 0x2037);
    return length + (singleWeight ? 1 : 2);
  }, 0);
}

async function generatePostParts(
  openAiApiKey: string,
  tip: Tip,
): Promise<string[]> {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.6-luna",
      store: false,
      max_output_tokens: 700,
      instructions: [
        ...kabumoriVoice("tip", `${tip.id}:${new Date().toISOString().slice(0, 10)}`),
        "postsの最初の投稿の1行目は、渡されたタイトルを一字一句変えずに置いてください。",
        "通常は分割せず、テーマの中心となる一つだけを1投稿にまとめてください。",
        "必要な本文が600文字を大きく超える場合に限り、postsを2〜3件に分けられます。2件目以降ではタイトルを繰り返さず、前の投稿から自然に続けてください。",
        "読みやすい位置で改行してください。投稿番号は付けないでください。",
        "X Premiumの長文投稿を前提とし、280文字や140文字へ収めるための短縮・分割はしないでください。",
        "難しい言葉の補足は、中心ポイントの理解に必要な場合だけ短く添えてください。",
        "ハッシュタグ、見出し、引用符、前置きは付けないでください。",
        ...tipGenerationRules(tip.difficulty),
      ].join("\n"),
      input: [
        `タイトル: ${tip.title}`,
        `難易度: ${tip.difficulty}`,
        `カテゴリー: ${tip.category?.trim() || "株式投資の基礎"}`,
        `解説の基礎情報: ${tip.base_text?.trim() || "補足情報なし"}`,
      ].join("\n"),
      text: {
        format: {
          type: "json_schema",
          name: "x_thread",
          strict: true,
          schema: {
            type: "object",
            properties: {
              posts: {
                type: "array",
                items: { type: "string" },
                minItems: 1,
                maxItems: 3,
              },
            },
            required: ["posts"],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  if (!response.ok) {
    console.error("OpenAI API request failed", { status: response.status });
    throw new Error("OPENAI_REQUEST_FAILED");
  }
  const generated = extractOutputText(await response.json());
  if (!generated) throw new Error("OPENAI_EMPTY_OUTPUT");

  let parsed: unknown;
  try {
    parsed = JSON.parse(generated);
  } catch {
    throw new Error("OPENAI_INVALID_STRUCTURED_OUTPUT");
  }
  const posts = typeof parsed === "object" && parsed !== null
    ? (parsed as { posts?: unknown }).posts
    : null;
  if (!Array.isArray(posts) || !posts.every((post) => typeof post === "string")) {
    throw new Error("OPENAI_INVALID_POSTS");
  }
  const trimmedPosts = posts.map((post) => post.trim());
  if (![1, 2, 3].includes(trimmedPosts.length)) {
    throw new Error("OPENAI_INVALID_POST_COUNT");
  }
  if (!trimmedPosts[0]?.startsWith(tip.title)) {
    throw new Error("OPENAI_TITLE_MISSING");
  }
  if (trimmedPosts.some((post) => post.length === 0)) throw new Error("OPENAI_EMPTY_POST");
  const totalCharacters = Array.from(trimmedPosts.join("\n")).length;
  if (trimmedPosts.length > 1 && totalCharacters <= 600) {
    throw new Error("UNNECESSARY_THREAD_SPLIT");
  }
  return trimmedPosts;
}

async function generateInteractionPostOnce(
  openAiApiKey: string,
  topic: InteractionTopic,
  marketContext: MarketContext | null,
  tradingDay: JpxTradingDayState,
  variationKey: string,
): Promise<Omit<GeneratedInteractionPost, "voiceEvaluation">> {
  const styleNumber = Array.from(variationKey).reduce(
    (total, character) => (total * 31 + (character.codePointAt(0) ?? 0)) >>> 0,
    0,
  );
  const closingStyles = [
    "理由や経験が気になることを、会話の流れで一文だけ添える",
    "一般的な感想を短く述べて自然に締め、追加の呼びかけは入れない",
    "そのときどう考えたかを、かしこまらず一文だけ尋ねる",
    "本文が自然に完結するなら、closingは空文字にする",
    "相手の使い方や感じ方を押しつけずに一文だけ尋ねる",
  ];
  const closingHint = closingStyles[(styleNumber >>> 3) % closingStyles.length];
  const usePoll = topic.question_format === "choice" ||
    (topic.question_format === "market_sentiment" && styleNumber % 2 === 0);
  const responseMode = usePoll ? "poll" : "free_response";
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.6-luna",
      store: false,
      max_output_tokens: 900,
      instructions: [
        ...kabumoriVoice("interaction", variationKey),
        "フォロワーと株の雑談を始めるX投稿を1件作ってください。質問票や聞き取り調査の文章にはしません。",
        "1投稿1テーマ、中心となる質問は原則1つだけです。同じ質問を言い換えて繰り返しません。",
        "質問のあとに長い解説や、きれいな結論・総括を足しません。返信しやすい会話のきっかけを最優先にしてください。",
        "『判断材料』『時間軸』『〜を軸に』など解説記事らしい言葉を重ねず、人がXで普通に話しかける軽さにしてください。",
        "『最初に何これ？ってなった言葉、あります？😂』のように、友達との会話で実際に口にできる聞き方を優先してください。",
        "『実際につまずいた言葉を具体例つきで教えてください』のように答え方を指定する質問は禁止です。",
        "経験を尋ねるテーマで『これ知ってました？』から始めないでください。知識クイズではなく、経験の雑談として直接尋ねます。",
        "『これ気になりますよね』『みんなはどうしてる？』『どっち派？』のような話しかけ方は、文脈に合う場合だけ自然に使えます。毎回使う必要はありません。",
        "openingの質問文だけを読んでも、何について答える質問かが初心者に1〜2秒で分かる表現にしてください。",
        "『どっち派？』と聞く場合は、何の行動・判断・投資場面についての2択なのかを質問文に明記してください。",
        "銘柄分析の順番、投資スタイル、保有判断など、質問の対象や場面を曖昧にしないでください。",
        "専門用語が必要な場合は、質問文の流れを壊さない短い補足を添えてください。",
        "選択肢を読まないと質問の意味が分からないopeningは禁止です。",
        "pollの各選択肢はopeningへの直接の回答になり、対象・意味・時間軸を完全に一致させてください。",
        "良い質問例は『銘柄を選ぶとき、みんなは何を一番重視しますか？👀📈』です。",
        "決算跨ぎを扱う場合は『決算発表をまたいで株を持つこと、ありますか？👀』のように具体的に聞いてください。",
        "返信やコメントを促す場合は、会話の流れに合う柔らかな一文を全体で最大1文だけ入れてください。本文が自然に締まる場合は入れなくて構いません。",
        "modeがpollの場合だけ、optionsへ2〜4個の短い投票選択肢を入れてください。各選択肢は25文字以内です。",
        "modeがfree_responseの場合は選択肢を作らず、optionsを空配列にしてください。自由に経験や考えを書ける問いかけにしてください。",
        "各選択肢に番号は付けず、選択肢の本文だけをoptionsへ入れてください。",
        "pollでは本文に選択肢を書き直さず、投票操作やXのアンケート機能の使い方も説明しないでください。『まずはワンタップで』『気軽に投票して』などの操作を促す表現は禁止です。",
        "openingは自然な会話文にしてください。closingは必要な場合だけ使い、不要なら空文字にしてください。",
        "自分の一般的な感想や考えを、押しつけない形で1文だけ添えても構いません。ただし架空の保有・売買・損失経験は作りません。",
        "機械的なCTAを避け、普通の会話として自然に読めることを優先してください。『みんなならどう見る？』『みんなはどの頻度派？』などの定型句を締めに毎回付けないでください。",
        "毎回同じ絵文字、語尾、冒頭、締め方にならないよう表現を変えてください。文章として自然に完結している場合は、そのまま終えて構いません。",
        "特定銘柄の売買を推奨せず、断定的な投資助言もしないでください。",
        "ハッシュタグは付けないでください。読みやすい位置で改行してください。",
        "日本語中心で100〜180文字を基本目安にします。短く自然なら100文字未満でもよく、文字数や絵文字数を満たすために水増ししません。",
        tradingDay.isTradingDay
          ? "今日はJPX取引日です。テーマに必要な場合だけ当日の相場へ触れて構いません。"
          : "今日は日本株の休場日です。『今日の相場』『今日の値動き』『今日の日経』『今日強かった・弱かった』『今日の取引・引け』など、当日に日本株市場が開いていた前提の表現は絶対に使わないでください。次の取引日、投資スタイル、決算、銘柄選び、NISAなど休場日でも成立する話題にしてください。",
        "JSONのmode、opening、options、personal_note、closingフィールドだけを返してください。",
      ].join("\n"),
      input: [
        `テーマ: ${topic.title}`,
        `質問形式: ${topic.question_format}`,
        `出力モード: ${responseMode}`,
        `作成のヒント: ${topic.prompt_hint}`,
        `今回の締め方の方向性: ${closingHint}`,
        `JPX営業日判定: ${tradingDay.isTradingDay ? "取引日" : `休場日（${tradingDay.reason}）`} / ${tradingDay.date}`,
        marketContext
          ? `本日の相場材料（事実の断定や追加推測は禁止）: ${marketContext.summary}`
          : "本日の相場材料: なし。汎用的な質問として作成する。",
      ].join("\n"),
      text: {
        format: {
          type: "json_schema",
          name: "interaction_post",
          strict: true,
          schema: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["poll", "free_response"] },
              opening: { type: "string" },
              options: {
                type: "array",
                items: { type: "string", maxLength: 25 },
                minItems: 0,
                maxItems: 4,
              },
              personal_note: { type: "string" },
              closing: { type: "string" },
            },
            required: ["mode", "opening", "options", "personal_note", "closing"],
            additionalProperties: false,
          },
        },
      },
    }),
  });
  if (!response.ok) {
    console.error("OpenAI interaction generation failed", { status: response.status });
    throw new Error("OPENAI_INTERACTION_REQUEST_FAILED");
  }
  const output = extractOutputText(await response.json());
  if (!output) throw new Error("OPENAI_INTERACTION_EMPTY_OUTPUT");
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("OPENAI_INTERACTION_INVALID_OUTPUT");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("OPENAI_INTERACTION_INVALID_POST");
  }
  const structured = parsed as {
    mode?: unknown;
    opening?: unknown;
    options?: unknown;
    personal_note?: unknown;
    closing?: unknown;
  };
  if (
    structured.mode !== responseMode ||
    typeof structured.opening !== "string" ||
    !Array.isArray(structured.options) ||
    !structured.options.every((option) => typeof option === "string") ||
    (usePoll && ![2, 3, 4].includes(structured.options.length)) ||
    (!usePoll && structured.options.length !== 0) ||
    typeof structured.personal_note !== "string" ||
    typeof structured.closing !== "string"
  ) {
    throw new Error("OPENAI_INTERACTION_INVALID_POST");
  }
  const pollOptions = structured.options.map((option) => option.trim());
  if (usePoll && pollOptions.some((option) =>
    option.length === 0 || Array.from(option).length > 25
  )) {
    throw new Error("OPENAI_INTERACTION_INVALID_POLL_OPTIONS");
  }
  const sections = [
    structured.opening.trim(),
    structured.personal_note.trim(),
    structured.closing.trim(),
  ].filter(Boolean);
  const trimmed = sections.join("\n\n");
  return { text: trimmed, pollOptions: usePoll ? pollOptions : null };
}

async function generateInteractionPost(
  openAiApiKey: string,
  topic: InteractionTopic,
  marketContext: MarketContext | null,
  tradingDay: JpxTradingDayState,
  variationKey: string,
): Promise<GeneratedInteractionPost> {
  let lastEvaluation: VoiceEvaluation | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const draft = await generateInteractionPostOnce(
      openAiApiKey, topic, marketContext, tradingDay, `${variationKey}:${attempt}`,
    );
    const mechanicalCheck = validateInteractionDraft(draft.text, tradingDay);
    if (!mechanicalCheck.passed) {
      console.warn("Interaction mechanical quality check failed", {
        reasons: mechanicalCheck.reasons,
        tradingDate: tradingDay.date,
        isTradingDay: tradingDay.isTradingDay,
      });
      continue;
    }
    const factBasis = [
      `テーマ: ${topic.title}`,
      `形式: ${topic.question_format}`,
      `ヒント: ${topic.prompt_hint}`,
      `投票選択肢: ${(draft.pollOptions || []).join(" / ")}`,
      `JPX営業日判定: ${tradingDay.isTradingDay ? "取引日" : "休場日"} (${tradingDay.date})`,
      marketContext ? `相場材料: ${marketContext.summary}` : "相場材料: なし",
    ].join("\n");
    const voiceEvaluation = await evaluateKabumoriVoice(
      openAiApiKey, "interaction", draft.text, factBasis,
    );
    if (voiceEvaluation.passed) return { ...draft, voiceEvaluation };
    lastEvaluation = voiceEvaluation;
  }
  console.error("Interaction voice quality check failed", {
    humanLikeness: lastEvaluation?.humanLikeness,
    aiArticleLikeness: lastEvaluation?.aiArticleLikeness,
  });
  throw new Error(lastEvaluation ? "INTERACTION_VOICE_QUALITY_FAILED" : "INTERACTION_MECHANICAL_GUARD_FAILED");
}

const MORNING_METRIC_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string" },
    value: { type: "string" },
    previous_close: { type: "string" },
    change: { type: "string" },
    change_percent: { type: "string" },
    timestamp: { type: "string" },
    source_url: { type: "string" },
  },
  required: ["label", "value", "previous_close", "change", "change_percent", "timestamp", "source_url"],
  additionalProperties: false,
};

const REPORT_MATERIAL_TYPE_SCHEMA = {
  type: "string",
  enum: [
    "realtime_market", "market_session", "central_bank_policy", "economic_indicator",
    "corporate", "geopolitics", "other",
  ],
};

const REPORT_POINT_PROPERTIES = {
  title: { type: "string" },
  what_happened: { type: "string" },
  japan_relevance: { type: "string" },
  affected_sectors: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 },
  what_to_watch: { type: "string" },
  source_url: { type: "string" },
  timestamp: { type: "string" },
  material_type: REPORT_MATERIAL_TYPE_SCHEMA,
  causal_claim_strength: { type: "string", enum: ["none", "qualified", "strong"] },
  supporting_source_urls: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 3 },
};

const REPORT_POINT_REQUIRED = [
  "title", "what_happened", "japan_relevance", "affected_sectors", "what_to_watch",
  "source_url", "timestamp", "material_type", "causal_claim_strength", "supporting_source_urls",
];

const MORNING_CANDIDATE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    publisher: { type: "string" },
    source_url: { type: "string" },
    supporting_source_urls: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 3 },
    timestamp: { type: "string" },
    timestamp_precision: { type: "string", enum: ["date", "datetime"] },
    material_type: REPORT_MATERIAL_TYPE_SCHEMA,
    japan_relevance: { type: "string" },
    japan_relevance_level: { type: "string", enum: ["high", "medium", "low"] },
    market_impact: { type: "string", enum: ["high", "medium", "low"] },
    importance_class: { type: "string", enum: ["major", "standard", "administrative"] },
    causal_claim_strength: { type: "string", enum: ["none", "qualified", "strong"] },
    affected_sectors: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 },
    what_to_watch: { type: "string" },
  },
  required: [
    "title", "summary", "publisher", "source_url", "supporting_source_urls", "timestamp",
    "timestamp_precision", "material_type", "japan_relevance", "japan_relevance_level",
    "market_impact", "importance_class", "causal_claim_strength", "affected_sectors", "what_to_watch",
  ],
  additionalProperties: false,
};

function morningFactBasis(draft: MorningReportDraft): string {
  return JSON.stringify({
    targetTradingDate: draft.targetTradingDate,
    isJpxBusinessDay: draft.isJpxBusinessDay,
    usSessionDate: draft.usSessionDate,
    importantPoints: draft.importantPoints,
    conditionalFactors: draft.conditionalFactors,
    marketDataTimestamp: draft.marketDataTimestamp,
    sourceUrls: draft.sourceUrls,
  });
}

async function generateMorningReport(
  openAiApiKey: string,
  referenceTimeIso: string,
  tradingDay: JpxTradingDayState,
  expectedUsSessionDate: string,
): Promise<MorningReportDraft> {
  const reference = resolveMorningReferenceContext(referenceTimeIso, tradingDay);
  const runMode = resolveMorningRunMode(referenceTimeIso);
  type LaneCollection = {
    packet: MorningLanePacket;
    raw: unknown;
    actualSources: Set<string>;
    searchCalls: number;
    inputTokens: number;
    outputTokens: number;
    responseDiagnostics: MorningLaneResponseDiagnostics;
  };
  const collectLane = async (
    lane: MorningSearchLane,
    supplementNeeds: string[] = [],
    supplementContext: MorningSupplementContext | null = null,
  ): Promise<LaneCollection> => {
    if (laneApiCallCount >= MAX_MORNING_SEARCH_CALLS) {
      throw new Error("MORNING_REPORT_SEARCH_BUDGET_EXCEEDED");
    }
    laneApiCallCount += 1;
    const extractionInstructions = morningCandidateExtractionInstructions(lane, supplementNeeds);
    const maxCandidates = lane === "lane_c_supplement" ? 2 : 3;
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${openAiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-luna", store: false, reasoning: { effort: "low" },
        max_output_tokens: 3000, max_tool_calls: 1,
        tools: [{
          type: "web_search", filters: { allowed_domains: MORNING_SOURCE_DOMAINS },
          search_context_size: "low",
          user_location: { type: "approximate", country: "JP", timezone: "Asia/Tokyo" },
        }],
        tool_choice: "required",
        include: ["web_search_call.action.sources"],
        instructions: [
          "あなたは朝刊の事実収集担当です。指定された検索Laneだけを1回検索し、投稿文ではなく候補JSONを返します。推測や候補数合わせのための捏造は禁止です。",
          ...extractionInstructions,
          "市場影響と日本株との関係をそれぞれhigh/medium/low、材料重要度をmajor/standard/administrativeで保守的に分類します。一次情報という理由だけで高評価にしません。",
          "単なる予定表、公表スケジュール、軽微な統計訂正、事務的更新はadministrativeまたはlowにします。決算、業績修正、M&A、TOB、自社株買い、大型受注、重大政策は内容に応じてmajor候補です。",
          "timestampは確認できた精度のまま返し、時刻不明ならYYYY-MM-DDとします。00:00等を推測しません。古い材料を今朝発生したように表現しません。",
          "material_typeがmarket_sessionの候補は、必ずexpected US session dateと同じ日付の米国通常取引セッションを扱う材料にします。それ以外(central_bank_policy、economic_indicator、geopolitics等)は、expected US session dateと同日である必要はなく、内容として妥当な直近の日付であれば構いません。",
          "conditional_factorsへ入れてよいのはreference UTC以前に発生・公表済みで、source URLからtimestampまたは日付を具体的に確認できる材料だけです。",
          "未来の経済指標・決算・Fedや政策イベント、upcoming・scheduled・expected・due・公表予定・発表予定・今日発表予定の未発表材料、timestamp不明・date未確認の材料はconditional_factorsへ返しません。重要そうでも例外にしません。",
          "強い因果関係を断定する場合だけcausal_claim_strength=strongとし、独立報道2系統または一次情報＋信頼報道をsource_urlとsupporting_source_urlsへ入れます。裏取りできない場合はqualifiedにします。",
          "実際に検索結果で開いた許可ドメインのURLだけを返します。検索結果本文、APIキー、秘密値は返しません。日経先物や具体的市場数値は扱いません。",
          "reference date、target trading date、expected US session dateはコード側で確定済みです。変更・翌日補正・独自の判定をしません。候補全体でpublisherが偏らないようにします。",
        ].join("\n"),
        input: [
          `lane: ${lane}`,
          `reference UTC: ${reference.referenceUtc}`,
          `reference JST: ${reference.referenceJst}`,
          `target trading date: ${reference.targetTradingDate}`,
          `JPX trading day: ${reference.isTargetTradingDay}`,
          `expected US session date: ${expectedUsSessionDate}`,
          `run mode: ${runMode}`,
          ...(supplementContext ? [
            `Lane C supplement context: ${JSON.stringify(supplementContext)}`,
          ] : []),
        ].join("\n"),
        text: { format: { type: "json_schema", name: `morning_${lane}`, strict: true, schema: {
          type: "object",
          properties: {
            lane: { type: "string", enum: [lane] },
            candidates: { type: "array", minItems: 0, maxItems: maxCandidates, items: MORNING_CANDIDATE_SCHEMA },
            conditional_factors: {
              type: "array", minItems: 0, maxItems: 2,
              items: {
                type: "object",
                properties: {
                  category: { type: "string", enum: ["fx", "rates", "oil", "china", "geopolitics", "economic_indicator", "central_bank", "crypto", "other"] },
                  headline: { type: "string" }, value: { type: "string" }, japan_relevance: { type: "string" },
                  timestamp: { type: "string" }, source_url: { type: "string" }, material_type: REPORT_MATERIAL_TYPE_SCHEMA,
                },
                required: ["category", "headline", "value", "japan_relevance", "timestamp", "source_url", "material_type"],
                additionalProperties: false,
              },
            },
            source_urls: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 8 },
            fact_check_notes: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
          },
          required: ["lane", "candidates", "conditional_factors", "source_urls", "fact_check_notes"],
          additionalProperties: false,
        } } },
      }),
    });
    if (!response.ok) throw new Error(`MORNING_REPORT_${lane.toUpperCase()}_FAILED:${response.status}`);
    const raw = await response.json();
    const parsedLane = parseMorningLaneResponse(raw, lane);
    const packet = parsedLane.packet;
    const usage = getUsage(raw);
    const laneSearchDiagnostics = inspectMorningWebSearchCalls(raw, lane);
    const prospectiveBudget = evaluateMorningSearchBudget([...searchDiagnostics, laneSearchDiagnostics]);
    if (!prospectiveBudget.passed) {
      console.warn("Morning report search budget exceeded", {
        lane,
        laneApiCallCount,
        webSearchCallItemCount: laneSearchDiagnostics.webSearchCallItemCount,
        actionTypes: laneSearchDiagnostics.actionTypes,
        searchQueryCount: laneSearchDiagnostics.searchQueryCount,
        totalSearchQueryCount: prospectiveBudget.totalSearchQueryCount,
        reasons: prospectiveBudget.reasons,
      });
      throw new Error("MORNING_REPORT_SEARCH_BUDGET_EXCEEDED");
    }
    searchDiagnostics.push(laneSearchDiagnostics);
    return {
      packet, raw, actualSources: collectMorningWebSourceUrls(raw),
      searchCalls: laneSearchDiagnostics.searchQueryCount,
      inputTokens: usage.input, outputTokens: usage.output,
      responseDiagnostics: parsedLane.diagnostics,
    };
  };

  const collections: LaneCollection[] = [];
  const searchDiagnostics: MorningLaneSearchDiagnostics[] = [];
  let laneApiCallCount = 0;
  collections.push(await collectLane("lane_a_us_market"));
  collections.push(await collectLane("lane_b_macro_policy"));

  const checkedCandidates = (laneCollections: LaneCollection[]): CheckedMorningCandidate[] => {
    const sourceSets = new Map(laneCollections.map((collection) => [
      collection.packet.lane,
      new Set(Array.from(collection.actualSources).map(canonicalizeUrl).filter((url): url is string => url !== null)),
    ]));
    return capCandidatePool(laneCollections.flatMap((collection) =>
      collection.packet.candidates.map((candidate) => ({ ...candidate, lane: collection.packet.lane }))
    )).map((candidate) => {
      const actualCanonical = sourceSets.get(candidate.lane) ?? new Set<string>();
      const sourceVerified = (url: string): boolean => {
        const canonical = canonicalizeUrl(url);
        return Boolean(canonical && isAllowedMorningUrl(url) && actualCanonical.has(canonical));
      };
      const supportingSourceUrls = candidate.supporting_source_urls.filter(sourceVerified);
      const text = [candidate.title, candidate.summary, candidate.japan_relevance, candidate.what_to_watch].join("\n");
      const strongCausality = candidate.causal_claim_strength === "strong" || hasStrongCausalAssertion(text);
      return {
        ...candidate,
        supporting_source_urls: supportingSourceUrls,
        source_verified: sourceVerified(candidate.source_url),
        freshness: classifyMaterialFreshness({
          materialType: candidate.material_type,
          timestamp: candidate.timestamp,
          referenceIso: referenceTimeIso,
          targetTradingDate: reference.targetTradingDate,
          expectedSessionDate: expectedUsSessionDate,
        }),
        causal_support_passed: !strongCausality || hasIndependentCausalSupport(
          [candidate.source_url, ...supportingSourceUrls], MORNING_SOURCE_DOMAINS,
        ),
        content_allowed: !mentionsUnavailableNikkeiFutures(text),
        publisher_key: publisherKey(candidate.source_url, MORNING_SOURCE_DOMAINS),
      };
    });
  };

  let checked = checkedCandidates(collections);
  let selection = selectMorningCandidates(checked, MORNING_SOURCE_DOMAINS);
  const initialSupplementReasons = supplementReasons(
    selection,
    laneApiCallCount,
  );
  const initialSupplementContext = initialSupplementReasons.length > 0
    ? buildMorningSupplementContext(selection, initialSupplementReasons)
    : null;
  let supplementUsed = false;
  if (initialSupplementReasons.length > 0 && laneApiCallCount < MAX_MORNING_SEARCH_CALLS) {
    try {
      collections.push(await collectLane(
        "lane_c_supplement",
        initialSupplementReasons,
        initialSupplementContext,
      ));
    } catch (error) {
      throw attachMorningLaneFailureContext(error, {
        laneApiCallCount,
        completedLanes: collections.map((collection) => collection.packet.lane),
        laneCandidateCounts: collections.map((collection) => ({
          lane: collection.packet.lane,
          candidateCount: collection.packet.candidates.length,
        })),
        qualifiedCandidateCount: selection.qualifiedCount,
        publisherCount: selection.publisherCount,
        hasUsMarketOrSemiconductor: selection.hasUsMarketOrSemiconductor,
        supplementReasons: initialSupplementReasons,
      });
    }
    supplementUsed = true;
    checked = checkedCandidates(collections);
    selection = selectMorningCandidates(checked, MORNING_SOURCE_DOMAINS);
  }

  const finalSearchBudget = evaluateMorningSearchBudget(searchDiagnostics);
  if (!finalSearchBudget.passed || laneApiCallCount > MAX_MORNING_SEARCH_CALLS) {
    throw new Error("MORNING_REPORT_SEARCH_BUDGET_EXCEEDED");
  }
  const webSearchCalls = finalSearchBudget.totalSearchQueryCount;
  const usSessionDate = expectedUsSessionDate;
  const importantPoints: MorningPoint[] = selection.selected.map((candidate) => ({
    title: candidate.title,
    what_happened: candidate.summary,
    japan_relevance: candidate.japan_relevance,
    affected_sectors: candidate.affected_sectors,
    what_to_watch: candidate.what_to_watch,
    source_url: candidate.source_url,
    timestamp: candidate.timestamp,
    material_type: candidate.material_type,
    causal_claim_strength: candidate.causal_claim_strength,
    supporting_source_urls: candidate.supporting_source_urls,
    publisher: candidate.publisher_key ?? candidate.publisher,
    timestamp_precision: candidate.timestamp_precision,
    japan_relevance_level: candidate.japan_relevance_level,
    market_impact: candidate.market_impact,
    importance_class: candidate.importance_class,
    lane: candidate.lane,
  }));
  const sourceSets = new Map(collections.map((collection) => [
    collection.packet.lane,
    new Set(Array.from(collection.actualSources).map(canonicalizeUrl).filter((url): url is string => url !== null)),
  ]));
  const sourceVerifiedForLane = (lane: MorningSearchLane, url: string): boolean => {
    const canonical = canonicalizeUrl(url);
    return Boolean(canonical && isAllowedMorningUrl(url) && sourceSets.get(lane)?.has(canonical));
  };
  let unsafeOptionalMaterialCount = 0;
  let futureOptionalFilteredCount = 0;
  let unknownTimestampOptionalFilteredCount = 0;
  const conditionalFactors = collections.flatMap((collection) => collection.packet.conditional_factors.map((factor) => ({
    factor, lane: collection.packet.lane,
  }))).flatMap(({ factor, lane }) => {
    if (!sourceVerifiedForLane(lane, factor.source_url)) return [];
    const decision = classifyOptionalMaterialForInclusion({
      materialType: resolveConditionalMaterialType(factor.category, factor.material_type),
      timestamp: factor.timestamp,
      referenceIso: referenceTimeIso,
      targetTradingDate: reference.targetTradingDate,
      expectedSessionDate: usSessionDate,
      text: `${factor.headline}\n${factor.value}`,
    });
    if (decision.filteredReason === "future") futureOptionalFilteredCount += 1;
    if (decision.filteredReason === "unknown_timestamp") unknownTimestampOptionalFilteredCount += 1;
    return decision.include ? [factor] : [];
  });
  const sourceUrls = Array.from(new Set([
    ...importantPoints.flatMap((point) => [point.source_url ?? "", ...(point.supporting_source_urls ?? [])]),
    ...conditionalFactors.map((factor) => factor.source_url),
    ...collections.flatMap((collection) =>
      collection.packet.source_urls.filter((url) => sourceVerifiedForLane(collection.packet.lane, url))
    ),
  ].filter(Boolean))).slice(0, 16);
  const finalPublisherCount = independentPublisherCount(
    importantPoints.flatMap((point) => [point.source_url ?? "", ...(point.supporting_source_urls ?? [])]),
    MORNING_SOURCE_DOMAINS,
  );
  const selectedMajor = selection.selected.filter((candidate) => candidate.importance_class === "major");
  const factResult = evaluateMorningFacts({
    required: [], strictRequired: [], optional: [],
    verifiedImportantPointCount: importantPoints.length,
    trustedSourceCount: finalPublisherCount,
    importantNewsPresent: selectedMajor.length > 0,
    importantNewsVerified: selectedMajor.every((candidate) => candidate.source_verified),
    unsafeOptionalMaterialCount,
    mode: runMode,
  });
  const retrievalDiagnostics: MorningRetrievalDiagnostics = {
    searchCalls: webSearchCalls,
    laneApiCallCount,
    totalSearchQueryCount: finalSearchBudget.totalSearchQueryCount,
    lanes: collections.map((collection) => ({
      lane: collection.packet.lane,
      candidateCount: collection.packet.candidates.length,
      aiReturnedCandidateCount: collection.responseDiagnostics.candidateReturnedCount,
      mechanicallyCheckedCandidateCount: checked.filter((candidate) => candidate.lane === collection.packet.lane).length,
      qualifiedCandidateCount: selection.decisions.filter((decision) =>
        decision.candidate.lane === collection.packet.lane &&
        decision.reasons.every((reason) => reason === "SELECTED" || reason === "NOT_IN_TOP_THREE")
      ).length,
      sourceCount: collection.packet.source_urls.length,
      webSearchCallItemCount: searchDiagnostics.find((item) => item.lane === collection.packet.lane)
        ?.webSearchCallItemCount ?? 0,
      actionTypes: searchDiagnostics.find((item) => item.lane === collection.packet.lane)?.actionTypes ?? [],
      searchQueryCount: searchDiagnostics.find((item) => item.lane === collection.packet.lane)
        ?.searchQueryCount ?? 0,
      response: collection.responseDiagnostics,
    })),
    candidateCount: checked.length,
    candidates: selection.decisions.map((decision: MorningCandidateDecision) => ({
      title: decision.candidate.title,
      publisher: decision.candidate.publisher_key ?? decision.candidate.publisher,
      sourceUrl: decision.candidate.source_url,
      category: decision.candidate.material_type,
      lane: decision.candidate.lane,
      timestamp: decision.candidate.timestamp,
      timestampPrecision: decision.candidate.timestamp_precision,
      freshness: decision.candidate.freshness,
      score: decision.score,
      rank: decision.rank,
      selected: decision.selected,
      reasons: decision.reasons,
    })),
    finalPublisherCount,
    supplementUsed,
    supplementReasons: initialSupplementReasons,
    supplementContext: initialSupplementContext,
    futureOptionalFilteredCount,
    unknownTimestampOptionalFilteredCount,
  };
  const collectionInputTokens = collections.reduce((sum, collection) => sum + collection.inputTokens, 0);
  const collectionOutputTokens = collections.reduce((sum, collection) => sum + collection.outputTokens, 0);

  let text = "";
  let writingUsage = { input: 0, output: 0 };
  if (factResult.status === "passed") {
    const writingResponse = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${openAiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-luna", store: false, reasoning: { effort: "low" }, max_output_tokens: 1500,
        instructions: [
          ...kabumoriVoice("morning_report", `morning-report:${referenceTimeIso.slice(0, 10)}`),
          "入力の出典確認済み事実だけを使い、市場概況＋初心者にも分かる解説型の朝刊を1投稿で作成してください。数値・日時・固有名詞・因果関係を追加推測しません。",
          "先頭は必ず『【朝刊】きょうの日本株、ここをチェック☀️』、直後に『📌 今日の注目ポイント』と重要度順の箇条書き3件を置きます。続けて海外市場・前夜の重要な流れと、3ポイントをそれぞれ詳しく説明します。",
          "外部市場データ由来のDow、S&P500、Nasdaq、SOX、日経先物、TOPIX、為替、金利の具体値は書きません。入力で確認済みの方向感やニュースだけを使い、未確認の方向感も作りません。",
          "終盤に『⚠️ きょう注意したいこと』と『💬 今日のひとこと』をこの順で必ず入れます。売買指示はしません。",
          "500〜800文字は目安で、材料が少なければ400文字程度、必要なら800文字超も可。文字数合わせの水増しは禁止です。",
          "絵文字は0〜4個程度で、自然さを優先します。本文中にURL、ハッシュタグ、出典一覧は入れません。",
        ].join("\n"),
        input: JSON.stringify({
          targetTradingDate: reference.targetTradingDate,
          isJpxBusinessDay: reference.isTargetTradingDay,
          usSessionDate,
          importantPoints,
          conditionalFactors, runMode,
        }),
        text: { format: { type: "json_schema", name: "morning_report_text", strict: true, schema: {
          type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false,
        } } },
      }),
    });
    if (!writingResponse.ok) throw new Error(`MORNING_REPORT_WRITING_FAILED:${writingResponse.status}`);
    const writingRaw = await writingResponse.json();
    const writingOutput = extractOutputText(writingRaw);
    if (!writingOutput) throw new Error("MORNING_REPORT_WRITING_EMPTY");
    const parsedWriting = JSON.parse(writingOutput) as { text?: unknown };
    if (typeof parsedWriting.text !== "string" || !parsedWriting.text.trim()) throw new Error("MORNING_REPORT_WRITING_INVALID");
    text = removeInlineCitations(parsedWriting.text);
    if (!validateMorningReportFormat(text)) throw new Error("MORNING_REPORT_FORMAT_INVALID");
    writingUsage = getUsage(writingRaw);
  }

  const totalInput = collectionInputTokens + writingUsage.input;
  const totalOutput = collectionOutputTokens + writingUsage.output;
  const blankMetric = (label: string, kind: "us_close" | "nikkei_futures"): MorningMetric =>
    normalizeMorningMetric({
      label, value: "", previous_close: "", change: "", change_percent: "", timestamp: "", source_url: "",
    }, kind, referenceTimeIso, runMode);
  const usIndices = {
    dow: blankMetric("Dow Jones Industrial Average", "us_close"),
    sp500: blankMetric("S&P 500", "us_close"),
    nasdaq: blankMetric("Nasdaq Composite", "us_close"),
  };
  const semiconductor = { sox: blankMetric("PHLX Semiconductor Sector Index", "us_close"), leaders: [] };
  const nikkeiFutures = blankMetric("Nikkei 225 Futures", "nikkei_futures");
  const nikkeiFuturesAvailable = false;
  return {
    text,
    targetTradingDate: reference.targetTradingDate,
    isJpxBusinessDay: reference.isTargetTradingDay,
    usSessionDate,
    importantPoints,
    usIndices,
    semiconductor,
    nikkeiFutures,
    nikkeiFuturesAvailable,
    conditionalFactors,
    sourceUrls,
    marketDataTimestamp: referenceTimeIso,
    factCheckStatus: factResult.status,
    factCheckNotes: [
      ...collections.flatMap((collection) => collection.packet.fact_check_notes),
      ...factResult.notes,
    ],
    model: "gpt-5.6-luna",
    inputTokens: totalInput,
    outputTokens: totalOutput,
    webSearchCalls,
    retrievalDiagnostics,
    apiCostUsd: morningApiCostUsd(totalInput, totalOutput, webSearchCalls),
    runMode,
  };
}

type CloseMarketPacket = {
  trading_date: string;
  market_data_timestamp: string;
  important_points: MorningPoint[];
  nikkei: RawMarketMetric;
  topix: RawMarketMetric;
  growth250: RawMarketMetric;
  strong_themes: CloseTheme[];
  weak_themes: CloseTheme[];
  nikkei_futures_1545: RawMarketMetric;
  conditional_factors: MorningConditionalFactor[];
  carryovers: CloseCarryover[];
  source_urls: string[];
  date_consistency_passed: boolean;
  important_news_present: boolean;
  important_news_verified: boolean;
  future_information_absent: boolean;
  fact_check_notes: string[];
};

function closeFactBasis(draft: CloseReportDraft): string {
  return JSON.stringify({
    tradingDate: draft.tradingDate,
    importantPoints: draft.importantPoints,
    strongThemes: draft.strongThemes,
    weakThemes: draft.weakThemes,
    conditionalFactors: draft.conditionalFactors,
    carryovers: draft.carryovers,
    marketDataTimestamp: draft.marketDataTimestamp,
    sourceUrls: draft.sourceUrls,
  });
}

function morningRunMarketData(
  draft: MorningReportDraft,
  voiceEvaluation: VoiceEvaluation | null,
  voiceStatus: "pending" | "completed" | "failed",
  voiceFailure: VoiceEvaluationOutputError | null = null,
): Record<string, unknown> {
  return {
    targetTradingDate: draft.targetTradingDate,
    isJpxBusinessDay: draft.isJpxBusinessDay,
    usSessionDate: draft.usSessionDate,
    importantPoints: draft.importantPoints,
    usIndices: draft.usIndices,
    semiconductor: draft.semiconductor,
    nikkeiFutures: draft.nikkeiFutures,
    nikkeiFuturesAvailable: draft.nikkeiFuturesAvailable,
    conditionalFactors: draft.conditionalFactors,
    retrievalDiagnostics: draft.retrievalDiagnostics,
    runMode: draft.runMode,
    pipeline: {
      generation_status: "completed",
      format_check_status: "passed",
      voice_evaluation_status: voiceStatus,
    },
    ...(voiceEvaluation ? { voiceEvaluation } : {}),
    ...(voiceFailure ? {
      voiceEvaluationFailure: {
        code: voiceFailure.message,
        response: voiceFailure.responseDiagnostics,
        schema: voiceFailure.schemaDiagnostics,
      },
    } : {}),
  };
}

function closeRunMarketData(
  draft: CloseReportDraft,
  voiceEvaluation: VoiceEvaluation | null,
  voiceStatus: "pending" | "completed" | "failed",
  voiceFailure: VoiceEvaluationOutputError | null = null,
): Record<string, unknown> {
  return {
    tradingDate: draft.tradingDate,
    importantPoints: draft.importantPoints,
    nikkei: draft.nikkei,
    topix: draft.topix,
    growth250: draft.growth250,
    strongThemes: draft.strongThemes,
    weakThemes: draft.weakThemes,
    nikkeiFutures1545: draft.nikkeiFutures1545,
    conditionalFactors: draft.conditionalFactors,
    carryovers: draft.carryovers,
    runMode: draft.runMode,
    pipeline: {
      generation_status: "completed",
      format_check_status: "passed",
      voice_evaluation_status: voiceStatus,
    },
    ...(voiceEvaluation ? { voiceEvaluation } : {}),
    ...(voiceFailure ? {
      voiceEvaluationFailure: {
        code: voiceFailure.message,
        response: voiceFailure.responseDiagnostics,
        schema: voiceFailure.schemaDiagnostics,
      },
    } : {}),
  };
}

async function generateCloseReport(
  openAiApiKey: string,
  referenceTimeIso: string,
): Promise<CloseReportDraft> {
  const runMode = resolveCloseRunMode(referenceTimeIso);
  const collectionResponse = await fetchOpenAiWithSingleRetry(() => fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${openAiApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-luna", store: false, reasoning: { effort: "low" },
      max_output_tokens: 2800, max_tool_calls: 3,
      tools: [{
        type: "web_search",
        filters: { allowed_domains: MORNING_SOURCE_DOMAINS },
        search_context_size: "low",
        user_location: { type: "approximate", country: "JP", timezone: "Asia/Tokyo" },
      }],
      tool_choice: "required",
      include: ["web_search_call.action.sources"],
      instructions: [
        "あなたは大引けレポートの事実収集担当です。投稿文は書かず、今日の日本市場で重要だった流れ、背景、企業材料、明日への材料を必要最小限の検索でJSONへ整理してください。推測は禁止です。",
        "important_pointsは必ず3件とし、何が起きたか、なぜ重要か、日本株との関係、明日見る点をまとめ、各件に実際に開いて確認したsource_url、公開timestamp、material_typeを付けてください。3件全体で最低2つの独立publisherを確保し、可能なら一次・公式情報と信頼報道を組み合わせます。",
        "timestampは確認できた精度のまま返してください。時刻不明ならYYYY-MM-DDとし、00:00等を推測しません。今日の市場の流れはmarket_session、現在値ベースはrealtime_market、政策・経済指標・企業材料は対応するmaterial_typeを指定します。古い材料を今日発生したように扱いません。",
        "強い因果関係を断定する場合はcausal_claim_strength=strongとし、独立報道2系統または一次情報＋信頼報道をsource_urlとsupporting_source_urlsへ入れます。裏取りできなければ断定を避けてqualifiedにするか、その材料を使いません。",
        "日経平均、TOPIX、グロース指数、日経先物の具体値を集めるためだけの検索は不要です。偶然取得できた場合だけ各指標欄へ入れ、取得不能は空文字にします。数値不足は異常ではなく、数字を作りません。",
        "強かった・弱かった業種やテーマは、その日の値動きまたは材料を信頼できる出典で確認できるものだけ入れます。目立たない側は空配列で構いません。",
        "値動きの理由は確認できた事実と報道だけを使います。因果を確認できない場合は断定せず、important_pointsの説明で確度を弱めてください。",
        "ニュース・IRは参照時刻まで、通常運用では16:00 JSTまでに公開済みのものだけを使用します。future_information_absentで未来情報の非混入を確認してください。",
        "為替・金利・原油・地政学・中国・日銀・米国材料・経済指標は、今日の日本株を説明するために必要なものだけconditional_factorsへ入れます。",
        "明日への材料は今日の相場とつながり、参照時刻までに予定または事実を確認できるものを1〜3件にします。単なる一般的イベント一覧にしません。",
        "重要ニュース候補がなければimportant_news_present=false、important_news_verified=falseとし、候補がある場合だけ裏取り成否をimportant_news_verifiedへ入れてください。",
        "JPX、TDnet、公式IR、官公庁、日銀を優先し、次にReuters、Bloomberg、日経などを使います。実際に開いたURLだけsource_urlsへ入れてください。",
      ].join("\n"),
      input: [`参照時刻（UTC）: ${referenceTimeIso}`, "タイムゾーン: Asia/Tokyo", `実行区分: ${runMode}`].join("\n"),
      text: { format: { type: "json_schema", name: "close_market_packet", strict: true, schema: {
        type: "object",
        properties: {
          trading_date: { type: "string" },
          market_data_timestamp: { type: "string" },
          important_points: {
            type: "array", minItems: 3, maxItems: 3,
            items: {
              type: "object",
              properties: REPORT_POINT_PROPERTIES,
              required: REPORT_POINT_REQUIRED,
              additionalProperties: false,
            },
          },
          nikkei: MORNING_METRIC_SCHEMA,
          topix: MORNING_METRIC_SCHEMA,
          growth250: MORNING_METRIC_SCHEMA,
          strong_themes: {
            type: "array", minItems: 0, maxItems: 5,
            items: {
              type: "object", properties: {
                name: { type: "string" }, direction: { type: "string", enum: ["strong", "weak"] },
                explanation: { type: "string" }, timestamp: { type: "string" }, source_url: { type: "string" },
              }, required: ["name", "direction", "explanation", "timestamp", "source_url"], additionalProperties: false,
            },
          },
          weak_themes: {
            type: "array", minItems: 0, maxItems: 5,
            items: {
              type: "object", properties: {
                name: { type: "string" }, direction: { type: "string", enum: ["strong", "weak"] },
                explanation: { type: "string" }, timestamp: { type: "string" }, source_url: { type: "string" },
              }, required: ["name", "direction", "explanation", "timestamp", "source_url"], additionalProperties: false,
            },
          },
          nikkei_futures_1545: MORNING_METRIC_SCHEMA,
          conditional_factors: {
            type: "array", minItems: 0, maxItems: 5,
            items: {
              type: "object", properties: {
                category: { type: "string", enum: ["fx", "rates", "oil", "china", "geopolitics", "economic_indicator", "central_bank", "crypto", "other"] },
                headline: { type: "string" }, value: { type: "string" }, japan_relevance: { type: "string" },
                timestamp: { type: "string" }, source_url: { type: "string" }, material_type: REPORT_MATERIAL_TYPE_SCHEMA,
              }, required: ["category", "headline", "value", "japan_relevance", "timestamp", "source_url", "material_type"], additionalProperties: false,
            },
          },
          carryovers: {
            type: "array", minItems: 1, maxItems: 3,
            items: {
              type: "object", properties: {
                item: { type: "string" }, connection_to_today: { type: "string" },
                timestamp: { type: "string" }, source_url: { type: "string" }, material_type: REPORT_MATERIAL_TYPE_SCHEMA,
              }, required: ["item", "connection_to_today", "timestamp", "source_url", "material_type"], additionalProperties: false,
            },
          },
          source_urls: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 18 },
          date_consistency_passed: { type: "boolean" }, important_news_present: { type: "boolean" },
          important_news_verified: { type: "boolean" },
          future_information_absent: { type: "boolean" },
          fact_check_notes: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 10 },
        },
        required: [
          "trading_date", "market_data_timestamp", "important_points", "nikkei", "topix", "growth250",
          "strong_themes", "weak_themes", "nikkei_futures_1545", "conditional_factors", "carryovers",
          "source_urls", "date_consistency_passed", "important_news_present", "important_news_verified",
          "future_information_absent", "fact_check_notes",
        ],
        additionalProperties: false,
      } } },
    }),
  }));
  if (!collectionResponse.ok) throw new Error(`CLOSE_REPORT_COLLECTION_FAILED:${collectionResponse.status}`);
  const collectionRaw = await collectionResponse.json();
  const output = extractOutputText(collectionRaw);
  if (!output) throw new Error("CLOSE_REPORT_EMPTY_OUTPUT");
  let packet: CloseMarketPacket;
  try { packet = JSON.parse(output) as CloseMarketPacket; }
  catch { throw new Error("CLOSE_REPORT_INVALID_OUTPUT"); }

  const actualSources = collectMorningWebSourceUrls(collectionRaw);
  const actualCanonical = new Set(Array.from(actualSources).map(canonicalizeUrl).filter((url): url is string => url !== null));
  const sourceVerified = (url: string): boolean => {
    const canonical = canonicalizeUrl(url);
    return Boolean(canonical && isAllowedMorningUrl(url) && actualCanonical.has(canonical));
  };
  const importantPoints = packet.important_points.flatMap((point) => {
    const sourceUrl = point.source_url ?? "";
    const supportingSourceUrls = (point.supporting_source_urls ?? []).filter(sourceVerified);
    const pointText = [point.title, point.what_happened, point.japan_relevance, point.what_to_watch].join("\n");
    const freshness = classifyMaterialFreshness({
      materialType: point.material_type ?? "other",
      timestamp: point.timestamp ?? "",
      referenceIso: referenceTimeIso,
      targetTradingDate: packet.trading_date,
      expectedSessionDate: packet.trading_date,
    });
    const strongCausality = point.causal_claim_strength === "strong" || hasStrongCausalAssertion(pointText);
    const causalSupportPassed = !strongCausality || hasIndependentCausalSupport(
      [sourceUrl, ...supportingSourceUrls], MORNING_SOURCE_DOMAINS,
    );
    return sourceVerified(sourceUrl) && freshness === "usable" && causalSupportPassed
      ? [{ ...point, supporting_source_urls: supportingSourceUrls }]
      : [];
  });
  const verifiedMetric = (metric: RawMarketMetric): RawMarketMetric =>
    sourceVerified(metric.source_url) ? metric : { ...metric, source_url: "" };
  const nikkei = normalizeCloseMetric(verifiedMetric(packet.nikkei), "jpx_close", referenceTimeIso, runMode);
  const topix = normalizeCloseMetric(verifiedMetric(packet.topix), "jpx_close", referenceTimeIso, runMode);
  const growthRaw = verifiedMetric(packet.growth250);
  const growth250 = parseMarketNumber(growthRaw.value) === null
    ? null : normalizeCloseMetric(growthRaw, "jpx_close", referenceTimeIso, runMode);
  const futuresRaw = verifiedMetric(packet.nikkei_futures_1545);
  const nikkeiFutures1545 = parseMarketNumber(futuresRaw.value) === null
    ? null : normalizeCloseMetric(futuresRaw, "nikkei_futures_1545", referenceTimeIso, runMode);
  let unsafeOptionalMaterialCount = 0;
  const retainMaterial = (timestamp: string, materialType: ReportMaterialType): boolean => {
    const freshness = classifyMaterialFreshness({
      materialType, timestamp, referenceIso: referenceTimeIso,
      targetTradingDate: packet.trading_date, expectedSessionDate: packet.trading_date,
    });
    if (freshness === "future" || freshness === "invalid_timestamp") unsafeOptionalMaterialCount += 1;
    return freshness === "usable";
  };
  const conditionalFactors = packet.conditional_factors.filter((factor) =>
    sourceVerified(factor.source_url) && retainMaterial(
      factor.timestamp, resolveConditionalMaterialType(factor.category, factor.material_type),
    )
  );
  const strongThemes = packet.strong_themes.filter((theme) =>
    theme.direction === "strong" && sourceVerified(theme.source_url) &&
    retainMaterial(theme.timestamp, "market_session")
  );
  const weakThemes = packet.weak_themes.filter((theme) =>
    theme.direction === "weak" && sourceVerified(theme.source_url) &&
    retainMaterial(theme.timestamp, "market_session")
  );
  const carryovers = packet.carryovers.filter((item) =>
    sourceVerified(item.source_url) && retainMaterial(item.timestamp, item.material_type ?? "other")
  );
  const futureInformationAbsent = packet.future_information_absent && unsafeOptionalMaterialCount === 0;
  const sourceUrls = packet.source_urls.filter(sourceVerified).slice(0, 18);
  const usedFactSourceUrls = [
    ...importantPoints.flatMap((point) => [point.source_url ?? "", ...(point.supporting_source_urls ?? [])]),
    ...strongThemes.map((theme) => theme.source_url),
    ...weakThemes.map((theme) => theme.source_url),
    ...conditionalFactors.map((factor) => factor.source_url),
    ...carryovers.map((item) => item.source_url),
  ].filter(Boolean);
  const factResult = evaluateCloseFacts({
    requiredIndices: [], futures: null,
    optional: [],
    verifiedImportantPointCount: importantPoints.length,
    trustedSourceCount: independentPublisherCount(usedFactSourceUrls, MORNING_SOURCE_DOMAINS),
    dateConsistencyPassed: packet.date_consistency_passed,
    importantNewsPresent: packet.important_news_present,
    importantNewsVerified: packet.important_news_verified,
    futureInformationAbsent,
    unsafeOptionalMaterialCount,
    mode: runMode,
  });
  const collectionUsage = getUsage(collectionRaw);
  const webSearchCalls = countWebSearchCalls(collectionRaw);
  let text = "";
  let writingUsage = { input: 0, output: 0 };
  if (factResult.status === "passed") {
    const writingResponse = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${openAiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-luna", store: false, reasoning: { effort: "low" }, max_output_tokens: 1600,
        instructions: [
          ...kabumoriVoice("close_report", `close-report:${packet.trading_date}`),
          "入力の出典確認済み事実だけを使い、市場概況＋初心者にも分かる解説型の大引けレポートを1投稿で作成してください。数値・日時・因果関係を追加推測しません。",
          "先頭は必ず『【大引け】きょうの日本株まとめ🌙』、直後に『📌 今日の3ポイント』と重要度順の箇条書き3件を置きます。続けて市場全体の流れと、3ポイントをそれぞれ詳しく説明します。",
          "外部市場データ由来の日経平均、TOPIX、日経先物、為替、金利の具体値は書きません。入力で確認済みの方向感やニュースだけを使い、未確認の方向感も作りません。",
          "終盤に『🔎 強かった・弱かったテーマ』『👀 明日への注目点』『💬 今日のひとこと』をこの順で必ず入れます。市場解釈を事実として断定せず、売買指示はしません。",
          "500〜800文字は目安です。材料が少なければ短く、必要なら長くして構いません。文字数合わせの水増しは禁止です。",
          "因果の確度が弱い場合は断定を避けます。売買推奨、利益保証、URL、ハッシュタグは入れません。絵文字数は自然さを優先します。",
        ].join("\n"),
        input: JSON.stringify({
          tradingDate: packet.trading_date, importantPoints,
          strongThemes, weakThemes,
          conditionalFactors, carryovers, runMode,
        }),
        text: { format: { type: "json_schema", name: "close_report_text", strict: true, schema: {
          type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false,
        } } },
      }),
    });
    if (!writingResponse.ok) throw new Error(`CLOSE_REPORT_WRITING_FAILED:${writingResponse.status}`);
    const writingRaw = await writingResponse.json();
    const writingOutput = extractOutputText(writingRaw);
    if (!writingOutput) throw new Error("CLOSE_REPORT_WRITING_EMPTY");
    const parsed = JSON.parse(writingOutput) as { text?: unknown };
    if (typeof parsed.text !== "string" || !parsed.text.trim()) throw new Error("CLOSE_REPORT_WRITING_INVALID");
    text = removeInlineCitations(parsed.text);
    if (!validateCloseReportFormat(text)) throw new Error("CLOSE_REPORT_FORMAT_INVALID");
    writingUsage = getUsage(writingRaw);
  }
  const totalInput = collectionUsage.input + writingUsage.input;
  const totalOutput = collectionUsage.output + writingUsage.output;
  return {
    text, tradingDate: packet.trading_date, importantPoints,
    nikkei, topix, growth250, strongThemes, weakThemes, nikkeiFutures1545,
    conditionalFactors, carryovers, sourceUrls, marketDataTimestamp: packet.market_data_timestamp,
    factCheckStatus: factResult.status, factCheckNotes: [...packet.fact_check_notes, ...factResult.notes],
    model: "gpt-5.6-luna", inputTokens: totalInput, outputTokens: totalOutput,
    webSearchCalls, apiCostUsd: morningApiCostUsd(totalInput, totalOutput, webSearchCalls), runMode,
  };
}

type UsPremarketMarketPacket = {
  report_date: string;
  is_us_market_open: boolean;
  market_data_timestamp: string;
  important_points: MorningPoint[];
  futures: { sp500: RawUsPremarketMetric; nasdaq100: RawUsPremarketMetric; dow: RawUsPremarketMetric };
  semiconductor_signal: RawUsPremarketMetric;
  premarket_movers: RawUsPremarketMetric[];
  conditional_factors: MorningConditionalFactor[];
  source_urls: string[];
  date_consistency_passed: boolean;
  important_news_verified: boolean;
  requires_sol: boolean;
  fact_check_notes: string[];
};

function usPremarketFactBasis(draft: UsPremarketReportDraft): string {
  return JSON.stringify({
    reportDate: draft.reportDate,
    isUsMarketOpen: draft.isUsMarketOpen,
    importantPoints: draft.importantPoints,
    futures: draft.futures,
    semiconductorSignal: draft.semiconductorSignal,
    premarketMovers: draft.premarketMovers,
    conditionalFactors: draft.conditionalFactors,
    marketDataTimestamp: draft.marketDataTimestamp,
    sourceUrls: draft.sourceUrls,
  });
}

async function generateUsPremarketReport(
  openAiApiKey: string,
  referenceTimeIso: string,
): Promise<UsPremarketReportDraft> {
  const runMode = resolveUsPremarketRunMode(referenceTimeIso);
  const collectionResponse = await fetchOpenAiWithSingleRetry(() => fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${openAiApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-luna", store: false, reasoning: { effort: "low" },
      max_output_tokens: 2800, max_tool_calls: 4,
      tools: [{
        type: "web_search",
        filters: { allowed_domains: MORNING_SOURCE_DOMAINS },
        search_context_size: "low",
        user_location: { type: "approximate", country: "JP", timezone: "Asia/Tokyo" },
      }],
      tool_choice: "required",
      include: ["web_search_call.action.sources"],
      instructions: [
        "あなたは米国株寄り付き前の市場データ収集担当です。投稿文は書かず、検索で確認した必要最小限の事実だけをJSONへ整理してください。推測は禁止です。",
        "S&P500先物、Nasdaq100先物、Dow先物は参照時刻時点の最新値を取得し、value、previous_close、change、change_percent、ISO 8601 timestamp、source_urlを持たせます。取得不能は空文字にします。",
        "SOXの直近通常取引終値、半導体ETF、半導体主要株のプレマーケットのいずれかから、半導体の方向が分かる代表データをsemiconductor_signalへ1件入れてください。何の値かlabelで明示します。",
        "NVIDIA、AMD、Apple、Microsoft、Amazon、Meta、Alphabet、Teslaは確認しますが、本文候補にするのは材料または値動きが目立つ銘柄だけです。premarket_moversは最大5件、該当なしなら空配列です。",
        "米10年債、USD/JPY、原油、経済指標、FRB、政策、地政学、決算、AI・半導体ニュースは、その日の米国株に意味のあるものだけconditional_factorsへ入れます。毎日全部は入れません。",
        "重要ポイントは今夜の米国株への影響が大きい順に2〜3件とし、翌日の日本株への関係、影響業種、見る場所まで事実に沿って整理します。",
        "米国の取引日・休場日と夏時間・冬時間を取り違えません。重要ニュースは公式またはReuters、Bloombergなど信頼できる報道で裏取りします。未確認の重要ニュースがなく、使う重要材料を確認できた場合はimportant_news_verifiedをtrueにします。",
        "複数ソースの数値矛盾、日付矛盾は解釈で埋めずfact_check_notesへ記録します。複雑な政策・地政学・重要ニュースの解釈にSolが必要な場合だけrequires_solをtrueにします。",
        "CME、NASDAQ、NYSE、FRB、米官公庁、企業IRを優先し、次にReuters、Bloomberg、日経などを使います。実際に開いたURLだけsource_urlsへ入れてください。",
      ].join("\n"),
      input: [`参照時刻（UTC）: ${referenceTimeIso}`, "タイムゾーン: Asia/Tokyo / America/New_York", `実行区分: ${runMode}`].join("\n"),
      text: { format: { type: "json_schema", name: "us_premarket_market_packet", strict: true, schema: {
        type: "object",
        properties: {
          report_date: { type: "string" },
          is_us_market_open: { type: "boolean" },
          market_data_timestamp: { type: "string" },
          important_points: {
            type: "array", minItems: 2, maxItems: 3,
            items: { type: "object", properties: {
              title: { type: "string" }, what_happened: { type: "string" }, japan_relevance: { type: "string" },
              affected_sectors: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 },
              what_to_watch: { type: "string" },
            }, required: ["title", "what_happened", "japan_relevance", "affected_sectors", "what_to_watch"], additionalProperties: false },
          },
          futures: {
            type: "object", properties: {
              sp500: MORNING_METRIC_SCHEMA, nasdaq100: MORNING_METRIC_SCHEMA, dow: MORNING_METRIC_SCHEMA,
            }, required: ["sp500", "nasdaq100", "dow"], additionalProperties: false,
          },
          semiconductor_signal: MORNING_METRIC_SCHEMA,
          premarket_movers: { type: "array", items: MORNING_METRIC_SCHEMA, minItems: 0, maxItems: 5 },
          conditional_factors: {
            type: "array", minItems: 0, maxItems: 6,
            items: { type: "object", properties: {
              category: { type: "string", enum: ["fx", "rates", "oil", "china", "geopolitics", "economic_indicator", "central_bank", "crypto", "other"] },
              headline: { type: "string" }, value: { type: "string" }, japan_relevance: { type: "string" },
              timestamp: { type: "string" }, source_url: { type: "string" },
            }, required: ["category", "headline", "value", "japan_relevance", "timestamp", "source_url"], additionalProperties: false },
          },
          source_urls: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 18 },
          date_consistency_passed: { type: "boolean" },
          important_news_verified: { type: "boolean" },
          requires_sol: { type: "boolean" },
          fact_check_notes: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
        },
        required: [
          "report_date", "is_us_market_open", "market_data_timestamp", "important_points", "futures",
          "semiconductor_signal", "premarket_movers", "conditional_factors", "source_urls",
          "date_consistency_passed", "important_news_verified", "requires_sol", "fact_check_notes",
        ],
        additionalProperties: false,
      } } },
    }),
  }));
  if (!collectionResponse.ok) throw new Error(`US_PREMARKET_COLLECTION_FAILED:${collectionResponse.status}`);
  const collectionRaw = await collectionResponse.json();
  const output = extractOutputText(collectionRaw);
  if (!output) throw new Error("US_PREMARKET_EMPTY_OUTPUT");
  let packet: UsPremarketMarketPacket;
  try { packet = JSON.parse(output) as UsPremarketMarketPacket; }
  catch { throw new Error("US_PREMARKET_INVALID_OUTPUT"); }

  const actualSources = collectMorningWebSourceUrls(collectionRaw);
  const actualCanonical = new Set(Array.from(actualSources).map(canonicalizeUrl).filter((url): url is string => url !== null));
  const sourceVerified = (url: string): boolean => {
    const canonical = canonicalizeUrl(url);
    return Boolean(canonical && isAllowedMorningUrl(url) && actualCanonical.has(canonical));
  };
  const verifiedMetric = (metric: RawUsPremarketMetric): RawUsPremarketMetric =>
    sourceVerified(metric.source_url) ? metric : { ...metric, source_url: "" };
  const futures = {
    sp500: normalizeUsPremarketMetric(verifiedMetric(packet.futures.sp500), "futures", referenceTimeIso, runMode),
    nasdaq100: normalizeUsPremarketMetric(verifiedMetric(packet.futures.nasdaq100), "futures", referenceTimeIso, runMode),
    dow: normalizeUsPremarketMetric(verifiedMetric(packet.futures.dow), "futures", referenceTimeIso, runMode),
  };
  const semiconductorRaw = verifiedMetric(packet.semiconductor_signal);
  const semiconductorSignal = parseMarketNumber(semiconductorRaw.value) === null
    ? null : normalizeUsPremarketMetric(semiconductorRaw, "semiconductor_signal", referenceTimeIso, runMode);
  const premarketMovers = packet.premarket_movers
    .map(verifiedMetric)
    .filter((metric) => parseMarketNumber(metric.value) !== null && Boolean(metric.source_url))
    .map((metric) => normalizeUsPremarketMetric(metric, "premarket_stock", referenceTimeIso, runMode));
  const conditionalFactors = packet.conditional_factors.filter((factor) => sourceVerified(factor.source_url));
  const optionalMetrics = conditionalFactors.map((factor) => normalizeUsPremarketMetric({
    label: factor.headline, value: factor.value, previous_close: "", change: "", change_percent: "",
    timestamp: factor.timestamp, source_url: factor.source_url,
  }, "realtime_optional", referenceTimeIso, runMode));
  const sourceUrls = packet.source_urls.filter(sourceVerified).slice(0, 18);
  const factResult = evaluateUsPremarketFacts({
    requiredFutures: [futures.sp500, futures.nasdaq100, futures.dow],
    semiconductorSignal, movers: premarketMovers, optional: optionalMetrics,
    trustedSourceCount: new Set(sourceUrls.map((url) => new URL(url).hostname)).size,
    dateConsistencyPassed: packet.date_consistency_passed,
    importantNewsVerified: packet.important_news_verified,
    isUsMarketOpen: packet.is_us_market_open,
    mode: runMode,
  });
  if (!Number.isFinite(Date.parse(packet.market_data_timestamp))) {
    factResult.status = "failed";
    factResult.notes.push("市場データ基準時刻が不正");
  }
  const collectionUsage = getUsage(collectionRaw);
  const webSearchCalls = countWebSearchCalls(collectionRaw);
  let text = "";
  let writingUsage = { input: 0, output: 0 };
  const writingModel: UsPremarketReportDraft["model"] = packet.requires_sol ? "gpt-5.6-sol" : "gpt-5.6-luna";
  if (factResult.status === "passed") {
    const writingResponse = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${openAiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: writingModel, store: false, reasoning: { effort: "low" }, max_output_tokens: 1600,
        instructions: [
          ...kabumoriVoice("us_premarket_report", `us-premarket:${packet.report_date}`),
          "入力の検算済みデータだけを使い、米国市場前チェックをPremium向けの1投稿で作成してください。数値・日時・因果・固有名詞を追加推測しません。",
          "冒頭は『今夜の米国株、ここを見ておきたい』など自然な一言と、重要度順の材料2〜3個。数値一覧から始めません。",
          "その後、米3先物、半導体、目立つプレマーケット銘柄、入力にある条件付き材料だけを簡潔に説明します。全銘柄・全材料を機械的に並べません。",
          "最後に翌日の日本株で影響しそうな業種・テーマを短く入れます。売買推奨、利益保証、URL、ハッシュタグは入れません。",
          "短い段落と改行で読みやすくし、情報量を削るための無理な短文化も、文字数を埋めるための水増しもしません。",
        ].join("\n"),
        input: JSON.stringify({
          reportDate: packet.report_date, importantPoints: packet.important_points,
          futures, semiconductorSignal, premarketMovers, conditionalFactors, runMode,
        }),
        text: { format: { type: "json_schema", name: "us_premarket_report_text", strict: true, schema: {
          type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false,
        } } },
      }),
    });
    if (!writingResponse.ok) throw new Error(`US_PREMARKET_WRITING_FAILED:${writingResponse.status}`);
    const writingRaw = await writingResponse.json();
    const writingOutput = extractOutputText(writingRaw);
    if (!writingOutput) throw new Error("US_PREMARKET_WRITING_EMPTY");
    const parsed = JSON.parse(writingOutput) as { text?: unknown };
    if (typeof parsed.text !== "string" || !parsed.text.trim()) throw new Error("US_PREMARKET_WRITING_INVALID");
    text = removeInlineCitations(parsed.text);
    writingUsage = getUsage(writingRaw);
  }
  const totalInput = collectionUsage.input + writingUsage.input;
  const totalOutput = collectionUsage.output + writingUsage.output;
  const cost = Number((
    morningApiCostUsd(collectionUsage.input, collectionUsage.output, webSearchCalls) +
    modelCostUsd(writingModel, writingUsage.input, writingUsage.output)
  ).toFixed(6));
  return {
    text, reportDate: packet.report_date, isUsMarketOpen: packet.is_us_market_open,
    importantPoints: packet.important_points, futures, semiconductorSignal, premarketMovers,
    conditionalFactors, sourceUrls, marketDataTimestamp: packet.market_data_timestamp,
    factCheckStatus: factResult.status, factCheckNotes: [...packet.fact_check_notes, ...factResult.notes],
    model: writingModel, escalatedToSol: writingModel === "gpt-5.6-sol",
    inputTokens: totalInput, outputTokens: totalOutput, webSearchCalls,
    apiCostUsd: cost, runMode,
  };
}

async function createMorningReportRun(
  supabaseUrl: string,
  serviceRoleKey: string,
  scheduledAt: string,
  scheduledPostId: string | null,
): Promise<string> {
  const response = await fetch(`${supabaseUrl}/rest/v1/morning_report_runs`, {
    method: "POST",
    headers: { ...supabaseHeaders(serviceRoleKey), Prefer: "return=representation" },
    body: JSON.stringify({
      scheduled_post_id: scheduledPostId,
      scheduled_at: scheduledAt,
      status: "generating",
      model_used: "gpt-5.6-luna",
    }),
  });
  if (!response.ok) throw new Error("MORNING_REPORT_LOG_CREATE_FAILED");
  const rows = await response.json() as Array<{ id?: unknown }>;
  if (typeof rows[0]?.id !== "string") throw new Error("MORNING_REPORT_LOG_INVALID_RESPONSE");
  return rows[0].id;
}

async function updateMorningReportRun(
  supabaseUrl: string,
  serviceRoleKey: string,
  runId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${supabaseUrl}/rest/v1/morning_report_runs?id=eq.${encodeURIComponent(runId)}`, {
    method: "PATCH",
    headers: { ...supabaseHeaders(serviceRoleKey), Prefer: "return=minimal" },
    body: JSON.stringify(values),
  });
  if (!response.ok) throw new Error("MORNING_REPORT_LOG_UPDATE_FAILED");
}

async function createCloseReportRun(
  supabaseUrl: string,
  serviceRoleKey: string,
  scheduledAt: string,
  scheduledPostId: string | null,
): Promise<string> {
  const response = await fetch(`${supabaseUrl}/rest/v1/close_report_runs`, {
    method: "POST",
    headers: { ...supabaseHeaders(serviceRoleKey), Prefer: "return=representation" },
    body: JSON.stringify({
      scheduled_post_id: scheduledPostId,
      scheduled_at: scheduledAt,
      status: "generating",
      model_used: "gpt-5.6-luna",
    }),
  });
  if (!response.ok) throw new Error("CLOSE_REPORT_LOG_CREATE_FAILED");
  const rows = await response.json() as Array<{ id?: unknown }>;
  if (typeof rows[0]?.id !== "string") throw new Error("CLOSE_REPORT_LOG_INVALID_RESPONSE");
  return rows[0].id;
}

async function updateCloseReportRun(
  supabaseUrl: string,
  serviceRoleKey: string,
  runId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${supabaseUrl}/rest/v1/close_report_runs?id=eq.${encodeURIComponent(runId)}`, {
    method: "PATCH",
    headers: { ...supabaseHeaders(serviceRoleKey), Prefer: "return=minimal" },
    body: JSON.stringify(values),
  });
  if (!response.ok) throw new Error("CLOSE_REPORT_LOG_UPDATE_FAILED");
}

async function createUsPremarketReportRun(
  supabaseUrl: string,
  serviceRoleKey: string,
  scheduledAt: string,
  scheduledPostId: string | null,
): Promise<string> {
  const response = await fetch(`${supabaseUrl}/rest/v1/us_premarket_report_runs`, {
    method: "POST",
    headers: { ...supabaseHeaders(serviceRoleKey), Prefer: "return=representation" },
    body: JSON.stringify({
      scheduled_post_id: scheduledPostId,
      scheduled_at: scheduledAt,
      status: "generating",
      model_used: "gpt-5.6-luna",
    }),
  });
  if (!response.ok) throw new Error("US_PREMARKET_LOG_CREATE_FAILED");
  const rows = await response.json() as Array<{ id?: unknown }>;
  if (typeof rows[0]?.id !== "string") throw new Error("US_PREMARKET_LOG_INVALID_RESPONSE");
  return rows[0].id;
}

async function updateUsPremarketReportRun(
  supabaseUrl: string,
  serviceRoleKey: string,
  runId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${supabaseUrl}/rest/v1/us_premarket_report_runs?id=eq.${encodeURIComponent(runId)}`, {
    method: "PATCH",
    headers: { ...supabaseHeaders(serviceRoleKey), Prefer: "return=minimal" },
    body: JSON.stringify(values),
  });
  if (!response.ok) throw new Error("US_PREMARKET_LOG_UPDATE_FAILED");
}

async function generateFuturePostPreview(
  openAiApiKey: string,
  postType: "morning" | "market_close",
): Promise<string> {
  const sampleFacts = postType === "morning"
    ? [
      "文体確認用の架空データです。外部の事実を追加しないでください。",
      "昨夜の米国市場: ダウは前日比+0.3%、ナスダックは-0.4%",
      "ドル円: 1ドル149円80銭付近",
      "米10年国債利回り: 4.10%付近",
      "今朝の注目: 円相場、半導体株、寄り付き後の値動き",
    ]
    : [
      "文体確認用の架空データです。外部の事実を追加しないでください。",
      "日経平均: 前日比+0.7%",
      "TOPIX: 前日比+0.4%",
      "強かった業種: 半導体、銀行",
      "重かった分野: 新興グロース株",
      "明日の注目: 米国の雇用関連指標と為替の反応",
    ];
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${openAiApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-luna",
      store: false,
      max_output_tokens: 700,
      instructions: [
        ...kabumoriVoice(postType, `voice-preview:${postType}:${new Date().toISOString()}`),
        "渡された数値と事実だけを使い、存在しない理由、ニュース、銘柄名を足さないでください。",
        "文体比較用なので、本文中に『架空』『サンプル』『dry-run』とは書かないでください。",
        "日本語で180〜300文字程度。ハッシュタグや売買推奨は不要です。",
        "JSONのtextフィールドだけを返してください。",
      ].join("\n"),
      input: sampleFacts.join("\n"),
      text: { format: { type: "json_schema", name: "kabumori_voice_preview", strict: true, schema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      } } },
    }),
  });
  if (!response.ok) throw new Error(`VOICE_PREVIEW_OPENAI_FAILED:${response.status}`);
  const output = extractOutputText(await response.json());
  if (!output) throw new Error("VOICE_PREVIEW_EMPTY_OUTPUT");
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { throw new Error("VOICE_PREVIEW_INVALID_OUTPUT"); }
  const text = typeof parsed === "object" && parsed !== null
    ? (parsed as { text?: unknown }).text
    : null;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("VOICE_PREVIEW_INVALID_TEXT");
  }
  return text.trim();
}

async function evaluateKabumoriVoice(
  openAiApiKey: string,
  postType: KabumoriPostType,
  text: string,
  factBasis: string,
): Promise<VoiceEvaluation> {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${openAiApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-luna",
      store: false,
      max_output_tokens: 650,
      instructions: [
        "あなたはX投稿の厳しい編集者です。作者の意図ではなく、完成した本文だけを読んで判定してください。",
        "fact_basisと矛盾する事実、根拠のない数値・固有名詞・断定がなければfact_check_statusをpassedにします。制度テーマで確認不能な断定があればneeds_reviewです。",
        "human_likenessは、株が好きで詳しい20代の個人が普段のXで自然に話しているように見える度合いを1〜5で評価します。",
        "ai_article_likenessは、金融解説AI、証券会社FAQ、ニュース原稿、先生による指導に見える度合いを1〜5で評価します。低いほど良好です。",
        "emoji_countは本文中の絵文字数です。emoji_naturalnessは、内容、感情、位置、種類が自然で、親しみやすさや読みやすさを高めている度合いを1〜5で評価します。単なる装飾や不自然な連続は低くします。",
        "morning_report、close_report、us_premarket_reportの絵文字は0〜4個程度で自然なら問題ありません。interactionも文字数や絵文字数だけで不合格にしません。他タイプは既存の目安を自然さの参考にします。",
        "絵文字をすべて除いた本文を想像し、それでも普通の人の会話に見える場合だけnatural_without_emojiをtrueにします。",
        "入力に根拠がないのに『いま気になった』『今日は気になった』など現在の心境を作っている場合、または作者本人の架空の売買・保有・損失・利益経験を語っている場合はfact_check_statusをneeds_review、passedをfalseにしてください。一般的な感想や好みは違反ではありません。",
        ...tipVoiceEvaluationRules(postType),
        "passedは文章の自然さの評価です。fact_check_statusがpassed、人間らしさ4以上、AI記事感2以下、natural_without_emojiがtrueを基本にします。morning_report、close_report、us_premarket_reportでは文字数と絵文字数をpassed条件にしません。絵文字がある場合だけ自然さも評価してください。",
        "notesは短い日本語で、良い点または残る違和感を具体的に2〜4件返してください。本文の書き直しは返しません。",
      ].join("\n"),
      input: [
        `投稿タイプ: ${postType}`,
        `照合元:\n${factBasis}`,
        `評価対象:\n${text}`,
      ].join("\n\n"),
      text: { format: { type: "json_schema", name: "kabumori_voice_evaluation", strict: true, schema: {
        type: "object",
        properties: {
          fact_check_status: { type: "string", enum: ["passed", "needs_review"] },
          factual_concerns: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 5 },
          human_likeness: { type: "integer", minimum: 1, maximum: 5 },
          ai_article_likeness: { type: "integer", minimum: 1, maximum: 5 },
          emoji_count: { type: "integer", minimum: 0, maximum: 10 },
          emoji_naturalness: { type: "integer", minimum: 1, maximum: 5 },
          natural_without_emoji: { type: "boolean" },
          passed: { type: "boolean" },
          notes: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4 },
        },
        required: [
          "fact_check_status", "factual_concerns", "human_likeness",
          "ai_article_likeness", "emoji_count", "emoji_naturalness",
          "natural_without_emoji", "passed", "notes",
        ],
        additionalProperties: false,
      } } },
    }),
  });
  if (!response.ok) throw new Error(`VOICE_EVALUATION_OPENAI_FAILED:${response.status}`);
  const rawResponse = await response.json();
  const output = extractOutputText(rawResponse);
  const responseDiagnostics = collectVoiceResponseDiagnostics(rawResponse, output, response.status);
  let value;
  try {
    value = parseVoiceEvaluationOutput(output, responseDiagnostics);
  } catch (error) {
    if (error instanceof VoiceEvaluationOutputError) {
      console.error("Voice evaluation output rejected", {
        code: error.message,
        response: error.responseDiagnostics,
        schema: error.schemaDiagnostics,
      });
    }
    throw error;
  }
  const usage = getUsage(rawResponse);
  return {
    factCheckStatus: value.fact_check_status,
    factualConcerns: value.factual_concerns,
    humanLikeness: value.human_likeness,
    aiArticleLikeness: value.ai_article_likeness,
    emojiCount: value.emoji_count,
    emojiNaturalness: value.emoji_naturalness,
    naturalWithoutEmoji: value.natural_without_emoji,
    passed: value.passed,
    notes: value.notes,
    inputTokens: usage.input,
    outputTokens: usage.output,
    apiCostUsd: modelCostUsd("gpt-5.6-luna", usage.input, usage.output),
    responseDiagnostics,
  };
}

function skippedVoiceEvaluation(reason: string): VoiceEvaluation {
  return {
    factCheckStatus: "needs_review",
    factualConcerns: [],
    humanLikeness: 0,
    aiArticleLikeness: 0,
    emojiCount: 0,
    emojiNaturalness: 0,
    naturalWithoutEmoji: false,
    passed: false,
    notes: [reason],
    inputTokens: 0,
    outputTokens: 0,
    apiCostUsd: 0,
    responseDiagnostics: null,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function tokenEncryptionKey(clientSecret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(clientSecret),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptToken(
  token: string,
  key: CryptoKey,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(token),
  );
  return { ciphertext: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) };
}

async function decryptToken(
  ciphertext: string,
  iv: string,
  key: CryptoKey,
): Promise<string> {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) },
    key,
    base64ToBytes(ciphertext),
  );
  return new TextDecoder().decode(decrypted);
}

async function loadXTokens(
  supabaseUrl: string,
  serviceRoleKey: string,
  clientSecret: string,
  fallbackAccessToken: string,
  fallbackRefreshToken: string,
): Promise<XTokenState> {
  const params = new URLSearchParams({
    select: "access_token_ciphertext,access_token_iv,refresh_token_ciphertext,refresh_token_iv",
    provider: "eq.x",
    limit: "1",
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/oauth_token_store?${params}`, {
    headers: supabaseHeaders(serviceRoleKey),
  });
  if (!response.ok) throw new Error("OAUTH_TOKEN_STORE_READ_FAILED");
  const rows = await response.json() as Array<Record<string, string>>;
  if (!rows[0]) {
    return { accessToken: fallbackAccessToken, refreshToken: fallbackRefreshToken };
  }
  try {
    const key = await tokenEncryptionKey(clientSecret);
    return {
      accessToken: await decryptToken(
        rows[0].access_token_ciphertext,
        rows[0].access_token_iv,
        key,
      ),
      refreshToken: await decryptToken(
        rows[0].refresh_token_ciphertext,
        rows[0].refresh_token_iv,
        key,
      ),
    };
  } catch {
    console.error("Stored OAuth tokens could not be decrypted; using server secrets");
    return { accessToken: fallbackAccessToken, refreshToken: fallbackRefreshToken };
  }
}

async function saveXTokens(
  auth: XAuthContext,
  tokens: XTokenState,
  expiresIn: number | null,
): Promise<void> {
  const key = await tokenEncryptionKey(auth.clientSecret);
  const access = await encryptToken(tokens.accessToken, key);
  const refresh = await encryptToken(tokens.refreshToken, key);
  const response = await fetch(
    `${auth.supabaseUrl}/rest/v1/oauth_token_store?on_conflict=provider`,
    {
      method: "POST",
      headers: {
        ...supabaseHeaders(auth.serviceRoleKey),
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        provider: "x",
        access_token_ciphertext: access.ciphertext,
        access_token_iv: access.iv,
        refresh_token_ciphertext: refresh.ciphertext,
        refresh_token_iv: refresh.iv,
        expires_at: expiresIn
          ? new Date(Date.now() + expiresIn * 1000).toISOString()
          : null,
        updated_at: new Date().toISOString(),
      }),
    },
  );
  if (!response.ok) throw new Error("OAUTH_TOKEN_STORE_WRITE_FAILED");
}

async function refreshXTokens(auth: XAuthContext): Promise<void> {
  const credentials = btoa(`${auth.clientId}:${auth.clientSecret}`);
  const response = await fetch(X_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.tokens.refreshToken,
      client_id: auth.clientId,
    }),
  });
  if (!response.ok) {
    console.error("X OAuth token refresh failed", { status: response.status });
    throw new Error(`X_TOKEN_REFRESH_FAILED:${response.status}`);
  }
  const body = await response.json() as Record<string, unknown>;
  const accessToken = body.access_token;
  const rotatedRefreshToken = body.refresh_token;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new Error("X_TOKEN_REFRESH_INVALID_RESPONSE");
  }
  const tokens = {
    accessToken,
    refreshToken: typeof rotatedRefreshToken === "string" && rotatedRefreshToken
      ? rotatedRefreshToken
      : auth.tokens.refreshToken,
  };
  await saveXTokens(
    auth,
    tokens,
    typeof body.expires_in === "number" ? body.expires_in : null,
  );
  auth.tokens = tokens;
  auth.refreshExecuted = true;
}

async function requestXPost(
  accessToken: string,
  text: string,
  replyToId?: string,
  pollOptions?: string[] | null,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(X_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      ...(replyToId ? { reply: { in_reply_to_tweet_id: replyToId } } : {}),
      ...(pollOptions
        ? { poll: { options: pollOptions, duration_minutes: 1440 } }
        : {}),
    }),
  });
  const responseText = await response.text();
  let responseBody: unknown;
  try {
    responseBody = JSON.parse(responseText);
  } catch {
    responseBody = { error: "X API returned a non-JSON response" };
  }
  return { status: response.status, body: responseBody };
}

async function postToX(
  auth: XAuthContext,
  text: string,
  replyToId?: string,
  pollOptions?: string[] | null,
): Promise<unknown> {
  let result = await requestXPost(
    auth.tokens.accessToken,
    text,
    replyToId,
    pollOptions,
  );
  if (result.status === 401) {
    if (auth.refreshExecuted) throw new Error("X_REQUEST_FAILED:401");
    await refreshXTokens(auth);
    result = await requestXPost(
      auth.tokens.accessToken,
      text,
      replyToId,
      pollOptions,
    );
  }
  if (result.status < 200 || result.status >= 300) {
    console.error("X API request failed", { status: result.status });
    throw new Error(`X_REQUEST_FAILED:${result.status}`);
  }
  return result.body;
}

async function postThreadToX(
  auth: XAuthContext,
  posts: string[],
): Promise<XPostResult[]> {
  const results: XPostResult[] = [];
  let replyToId: string | undefined;
  for (const post of posts) {
    const response = await postToX(auth, post, replyToId);
    const id = getXPostId(response);
    if (!id) throw new Error("X_RESPONSE_MISSING_POST_ID");
    results.push({ id, text: post, response });
    replyToId = id;
  }
  return results;
}

async function callRpc(
  supabaseUrl: string,
  serviceRoleKey: string,
  functionName: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${functionName}`, {
    method: "POST",
    headers: supabaseHeaders(serviceRoleKey),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    console.error("Database RPC failed", {
      functionName,
      status: response.status,
    });
    throw new Error(`RPC_FAILED:${functionName}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function claimDuePost(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<ScheduledPost | null> {
  const result = await callRpc(
    supabaseUrl,
    serviceRoleKey,
    "claim_due_post",
    {},
  ) as ScheduledPost[];
  return result[0] ?? null;
}

function getXPostId(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const data = (result as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const id = (data as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST method required" }), {
      status: 405,
      headers: { ...jsonHeaders, Allow: "POST" },
    });
  }

  let scheduledPostId: string | null = null;
  let supabaseUrlForFailure: string | null = null;
  let serviceRoleKeyForFailure: string | null = null;

  try {
    let requestBody: { mode?: unknown; titles?: unknown; post_type?: unknown; reference_time_iso?: unknown } = {};
    try { requestBody = await req.json(); } catch { /* body is optional */ }
    const isUsefulTipDryRun = requestBody.mode === "useful_tip_dry_run";
    const isVoiceDryRun = requestBody.mode === "kabumori_voice_dry_run";
    const isMorningReportDryRun = requestBody.mode === "morning_report_dry_run";
    const isCloseReportDryRun = requestBody.mode === "close_report_dry_run";
    const isUsPremarketDryRun = requestBody.mode === "us_premarket_report_dry_run";
    const isMorningGreetingImageTest = requestBody.mode === MORNING_GREETING_IMAGE_TEST_MODE;
    const isMorningGreetingPayloadTest = requestBody.mode === MORNING_GREETING_PAYLOAD_TEST_MODE;
    const isMorningGreetingManualPublish = requestBody.mode === MORNING_GREETING_MANUAL_PUBLISH_MODE;
    const isAnyDryRun = isUsefulTipDryRun || isVoiceDryRun || isMorningReportDryRun ||
      isCloseReportDryRun || isUsPremarketDryRun || isMorningGreetingImageTest ||
      isMorningGreetingPayloadTest;
    const openAiApiKey = Deno.env.get("OPENAI_API_KEY");
    const xAccessToken = Deno.env.get("X_OAUTH2_ACCESS_TOKEN");
    const xRefreshToken = Deno.env.get("X_OAUTH2_REFRESH_TOKEN");
    const xClientId = Deno.env.get("X_CLIENT_ID");
    const xClientSecret = Deno.env.get("X_CLIENT_SECRET");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!openAiApiKey || !supabaseUrl || !serviceRoleKey || (!isAnyDryRun && (
      !xAccessToken || !xRefreshToken || !xClientId || !xClientSecret
    ))) {
      return jsonResponse({ error: "Required server secret is missing" }, 500);
    }

    supabaseUrlForFailure = supabaseUrl;
    serviceRoleKeyForFailure = serviceRoleKey;

    if (isMorningGreetingManualPublish) {
      if (req.headers.get("Authorization") !== `Bearer ${serviceRoleKey}`) {
        return jsonResponse({
          success: false,
          error: "MORNING_GREETING_MANUAL_PUBLISH_UNAUTHORIZED",
          x_api_called: 0,
          x_posted: false,
          retry_count: 0,
        }, 403);
      }
      const referenceTime = typeof requestBody.reference_time_iso === "string"
        ? new Date(requestBody.reference_time_iso)
        : new Date();
      try {
        const tokens = await loadXTokens(
          supabaseUrl,
          serviceRoleKey,
          xClientSecret!,
          xAccessToken!,
          xRefreshToken!,
        );
        const result = await runMorningGreetingManualPublish({
          supabaseUrl,
          serviceRoleKey,
          openAiApiKey,
          xAccessToken: tokens.accessToken,
          now: referenceTime,
        });
        return jsonResponse(result, result.skipped ? 200 : 201);
      } catch (error) {
        const publishError = error instanceof MorningGreetingManualPublishError ? error : null;
        return jsonResponse({
          success: false,
          date_jst: Number.isFinite(referenceTime.getTime())
            ? new Intl.DateTimeFormat("en-CA", {
              timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
            }).format(referenceTime)
            : null,
          error: safeErrorCode(error),
          image_upload_succeeded: publishError?.imageUploadSucceeded ?? false,
          x_api_called: publishError?.xApiCalled ?? 0,
          x_post_api_called: publishError?.xPostApiCalled ?? 0,
          x_posted: publishError?.xPosted ?? false,
          x_post_id: publishError?.xPostId ?? null,
          retry_count: 0,
        }, 422);
      }
    }

    if (isMorningGreetingPayloadTest) {
      const referenceTime = typeof requestBody.reference_time_iso === "string"
        ? new Date(requestBody.reference_time_iso)
        : new Date();
      try {
        const result = await runMorningGreetingPayloadDryRun({
          supabaseUrl,
          serviceRoleKey,
          openAiApiKey,
          now: referenceTime,
        });
        return jsonResponse(result, 200);
      } catch (error) {
        return jsonResponse({
          success: false,
          date_jst: Number.isFinite(referenceTime.getTime())
            ? new Intl.DateTimeFormat("en-CA", {
              timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
            }).format(referenceTime)
            : null,
          text: null,
          theme: null,
          theme_name: null,
          visual_theme: null,
          image_path: null,
          image_exists: error instanceof MorningGreetingPayloadDryRunError
            ? error.imageExists
            : false,
          theme_match: error instanceof MorningGreetingPayloadDryRunError
            ? error.themeMatch
            : false,
          payload_ready: false,
          openai_text_api_called: error instanceof MorningGreetingPayloadDryRunError
            ? error.openAiTextApiCalled
            : 0,
          retry_count: 0,
          x_api_called: 0,
          x_posted: false,
          error: safeErrorCode(error),
        }, 422);
      }
    }

    if (isMorningGreetingImageTest) {
      try {
        const result = await runMorningGreetingImageTest({
          supabaseUrl,
          serviceRoleKey,
          openAiApiKey,
        });
        return jsonResponse(result, 200);
      } catch (error) {
        return jsonResponse({
          success: false,
          output_storage_path: null,
          image_api_called: error instanceof MorningGreetingImageTestError
            ? error.imageApiCalled
            : 0,
          x_api_called: 0,
          scheduled_posts_changed: 0,
          retry_count: 0,
          error: error instanceof Error ? error.message : String(error),
        }, 500);
      }
    }

    if (isMorningReportDryRun) {
      const referenceTime = resolveMorningReferenceTime(
        requestBody.mode,
        requestBody.reference_time_iso,
        new Date().toISOString(),
      );
      const tradingDay = await getJpxTradingDay(supabaseUrl, serviceRoleKey, referenceTime);
      const expectedUsSessionDate = await getExpectedUsSessionDate(supabaseUrl, serviceRoleKey, referenceTime);
      const runId = await createMorningReportRun(
        supabaseUrl, serviceRoleKey, referenceTime, null,
      );
      let draft: MorningReportDraft | null = null;
      try {
        draft = await generateMorningReport(openAiApiKey, referenceTime, tradingDay, expectedUsSessionDate);
        if (draft.text) {
          await updateMorningReportRun(supabaseUrl, serviceRoleKey, runId, {
            generated_at: new Date().toISOString(), source_urls: draft.sourceUrls,
            market_data_timestamp: draft.marketDataTimestamp,
            input_tokens: draft.inputTokens, output_tokens: draft.outputTokens,
            web_search_calls: draft.webSearchCalls, api_cost_usd: draft.apiCostUsd,
            status: "generating", error: null, generated_text: draft.text,
            character_count: Array.from(draft.text).length,
            fact_check_status: "passed", fact_check_notes: draft.factCheckNotes,
            market_data: morningRunMarketData(draft, null, "pending"),
          });
        }
        const voiceEvaluation = draft.text
          ? await evaluateKabumoriVoice(openAiApiKey, "morning_report", draft.text, morningFactBasis(draft))
          : skippedVoiceEvaluation("Fact check不合格のため文体評価を未実施");
        const factCheckPassed = draft.factCheckStatus === "passed";
        const voicePassed = voiceEvaluation.passed;
        const wouldPublish = factCheckPassed && voicePassed;
        const totalInputTokens = draft.inputTokens + voiceEvaluation.inputTokens;
        const totalOutputTokens = draft.outputTokens + voiceEvaluation.outputTokens;
        const totalCost = Number((draft.apiCostUsd + voiceEvaluation.apiCostUsd).toFixed(6));
        const marketData = morningRunMarketData(draft, voiceEvaluation, "completed");
        // Voice FAIL alone does not fail the dry-run itself (it's a confirmation run, not a gate) — it is
        // only recorded via `error`/`wouldPublish` so it's visible without blocking the response.
        const dryRunError = !factCheckPassed
          ? "MORNING_REPORT_FACT_CHECK_FAILED"
          : !voicePassed
          ? "MORNING_REPORT_VOICE_CHECK_FAILED"
          : null;
        await updateMorningReportRun(supabaseUrl, serviceRoleKey, runId, {
          generated_at: new Date().toISOString(),
          source_urls: draft.sourceUrls,
          market_data_timestamp: draft.marketDataTimestamp,
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          web_search_calls: draft.webSearchCalls,
          api_cost_usd: totalCost,
          status: factCheckPassed ? "dry_run_succeeded" : "failed",
          error: dryRunError,
          generated_text: draft.text,
          character_count: Array.from(draft.text).length,
          fact_check_status: factCheckPassed ? "passed" : "failed",
          fact_check_notes: draft.factCheckNotes,
          market_data: marketData,
        });
        return jsonResponse({
          mode: "dry_run",
          published: false,
          postType: "morning_report",
          runId,
          generatedText: draft.text,
          importantPoints: draft.importantPoints,
          usIndices: draft.usIndices,
          semiconductor: draft.semiconductor,
          nikkeiFutures: draft.nikkeiFutures,
          nikkeiFuturesAvailable: draft.nikkeiFuturesAvailable,
          conditionalFactors: draft.conditionalFactors,
          retrievalDiagnostics: draft.retrievalDiagnostics,
          sourceUrls: draft.sourceUrls,
          marketDataTimestamp: draft.marketDataTimestamp,
          targetTradingDate: draft.targetTradingDate,
          isJpxBusinessDay: draft.isJpxBusinessDay,
          runMode: draft.runMode,
          characterCount: Array.from(draft.text).length,
          model: draft.model,
          tokenUsage: { input: totalInputTokens, output: totalOutputTokens },
          webSearchCalls: draft.webSearchCalls,
          apiCostUsd: totalCost,
          factCheck: {
            status: factCheckPassed ? "passed" : "failed",
            notes: draft.factCheckNotes,
          },
          voiceCheck: {
            status: voicePassed ? "passed" : "failed",
          },
          wouldPublish,
          voiceEvaluation,
        }, 200);
      } catch (error) {
        const code = safeErrorCode(error);
        const voiceFailure = error instanceof VoiceEvaluationOutputError ? error : null;
        const laneFailure = error instanceof MorningLaneResponseError ? error : null;
        try {
          await updateMorningReportRun(supabaseUrl, serviceRoleKey, runId, {
            generated_at: new Date().toISOString(), status: "failed", error: code,
            fact_check_status: voiceFailure && draft?.factCheckStatus === "passed" ? "passed" : "failed",
            fact_check_notes: voiceFailure && draft
              ? [...draft.factCheckNotes, ...voiceEvaluationFailureNotes(error)]
              : [code],
            ...(voiceFailure && draft ? {
              market_data: morningRunMarketData(draft, null, "failed", voiceFailure),
            } : {}),
            ...(laneFailure ? {
              market_data: {
                retrievalDiagnostics: laneFailure.context,
                laneResponseFailure: laneFailure.diagnostics,
              },
            } : {}),
          });
        } catch { console.error("Failed to record morning report dry-run failure"); }
        throw error;
      }
    }

    if (isCloseReportDryRun) {
      const referenceTime = new Date().toISOString();
      const runId = await createCloseReportRun(supabaseUrl, serviceRoleKey, referenceTime, null);
      let draft: CloseReportDraft | null = null;
      try {
        draft = await generateCloseReport(openAiApiKey, referenceTime);
        if (draft.text) {
          await updateCloseReportRun(supabaseUrl, serviceRoleKey, runId, {
            generated_at: new Date().toISOString(), source_urls: draft.sourceUrls,
            market_data_timestamp: draft.marketDataTimestamp,
            nikkei_data: draft.nikkei, topix_data: draft.topix,
            nikkei_futures_1545_data: draft.nikkeiFutures1545,
            input_tokens: draft.inputTokens, output_tokens: draft.outputTokens,
            web_search_calls: draft.webSearchCalls, api_cost_usd: draft.apiCostUsd,
            status: "generating", error: null, generated_text: draft.text,
            character_count: Array.from(draft.text).length,
            fact_check_status: "passed", fact_check_notes: draft.factCheckNotes,
            voice_evaluation: { status: "pending" },
            market_data: closeRunMarketData(draft, null, "pending"),
          });
        }
        const voiceEvaluation = draft.text
          ? await evaluateKabumoriVoice(openAiApiKey, "close_report", draft.text, closeFactBasis(draft))
          : skippedVoiceEvaluation("Fact check不合格のため文体評価を未実施");
        const factCheckPassed = draft.factCheckStatus === "passed";
        const totalInputTokens = draft.inputTokens + voiceEvaluation.inputTokens;
        const totalOutputTokens = draft.outputTokens + voiceEvaluation.outputTokens;
        const totalCost = Number((draft.apiCostUsd + voiceEvaluation.apiCostUsd).toFixed(6));
        const marketData = closeRunMarketData(draft, voiceEvaluation, "completed");
        await updateCloseReportRun(supabaseUrl, serviceRoleKey, runId, {
          generated_at: new Date().toISOString(), source_urls: draft.sourceUrls,
          market_data_timestamp: draft.marketDataTimestamp,
          nikkei_data: draft.nikkei, topix_data: draft.topix,
          nikkei_futures_1545_data: draft.nikkeiFutures1545,
          input_tokens: totalInputTokens, output_tokens: totalOutputTokens,
          web_search_calls: draft.webSearchCalls, api_cost_usd: totalCost,
          status: factCheckPassed ? "dry_run_succeeded" : "failed",
          error: factCheckPassed ? null : "CLOSE_REPORT_FACT_CHECK_FAILED",
          generated_text: draft.text, character_count: Array.from(draft.text).length,
          fact_check_status: factCheckPassed ? "passed" : "failed",
          fact_check_notes: draft.factCheckNotes, voice_evaluation: voiceEvaluation,
          market_data: marketData,
        });
        return jsonResponse({
          mode: "dry_run", published: false, postType: "close_report", runId,
          generatedText: draft.text, importantPoints: draft.importantPoints,
          nikkei: draft.nikkei, topix: draft.topix, growth250: draft.growth250,
          strongThemes: draft.strongThemes, weakThemes: draft.weakThemes,
          nikkeiFutures1545: draft.nikkeiFutures1545,
          conditionalFactors: draft.conditionalFactors, carryovers: draft.carryovers,
          sourceUrls: draft.sourceUrls, marketDataTimestamp: draft.marketDataTimestamp,
          tradingDate: draft.tradingDate, runMode: draft.runMode,
          characterCount: Array.from(draft.text).length, model: draft.model,
          tokenUsage: { input: totalInputTokens, output: totalOutputTokens },
          webSearchCalls: draft.webSearchCalls, apiCostUsd: totalCost,
          factCheck: { status: factCheckPassed ? "passed" : "failed", notes: draft.factCheckNotes },
          voiceEvaluation,
        }, 200);
      } catch (error) {
        const code = safeErrorCode(error);
        const voiceFailure = error instanceof VoiceEvaluationOutputError ? error : null;
        try {
          await updateCloseReportRun(supabaseUrl, serviceRoleKey, runId, {
            generated_at: new Date().toISOString(), status: "failed", error: code,
            fact_check_status: voiceFailure && draft?.factCheckStatus === "passed" ? "passed" : "failed",
            fact_check_notes: voiceFailure && draft
              ? [...draft.factCheckNotes, ...voiceEvaluationFailureNotes(error)]
              : [code],
            ...(voiceFailure && draft ? {
              voice_evaluation: {
                status: "failed", code,
                response: voiceFailure.responseDiagnostics,
                schema: voiceFailure.schemaDiagnostics,
              },
              market_data: closeRunMarketData(draft, null, "failed", voiceFailure),
            } : {}),
          });
        } catch { console.error("Failed to record close report dry-run failure"); }
        throw error;
      }
    }

    if (isUsPremarketDryRun) {
      const referenceTime = new Date().toISOString();
      const runId = await createUsPremarketReportRun(supabaseUrl, serviceRoleKey, referenceTime, null);
      try {
        const draft = await generateUsPremarketReport(openAiApiKey, referenceTime);
        const voiceEvaluation = draft.text
          ? await evaluateKabumoriVoice(openAiApiKey, "us_premarket_report", draft.text, usPremarketFactBasis(draft))
          : skippedVoiceEvaluation("Fact check不合格のため文体評価を未実施");
        const factCheckPassed = draft.factCheckStatus === "passed";
        const totalInputTokens = draft.inputTokens + voiceEvaluation.inputTokens;
        const totalOutputTokens = draft.outputTokens + voiceEvaluation.outputTokens;
        const totalCost = Number((draft.apiCostUsd + voiceEvaluation.apiCostUsd).toFixed(6));
        const marketData = {
          reportDate: draft.reportDate, isUsMarketOpen: draft.isUsMarketOpen,
          importantPoints: draft.importantPoints, futures: draft.futures,
          semiconductorSignal: draft.semiconductorSignal,
          premarketMovers: draft.premarketMovers,
          conditionalFactors: draft.conditionalFactors,
          runMode: draft.runMode,
        };
        await updateUsPremarketReportRun(supabaseUrl, serviceRoleKey, runId, {
          generated_at: new Date().toISOString(), source_urls: draft.sourceUrls,
          market_data_timestamp: Number.isFinite(Date.parse(draft.marketDataTimestamp)) ? draft.marketDataTimestamp : null,
          market_data: marketData,
          model_used: draft.model, input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens, web_search_calls: draft.webSearchCalls,
          api_cost_usd: totalCost,
          status: factCheckPassed ? "dry_run_succeeded" : "failed",
          error: factCheckPassed ? null : "US_PREMARKET_FACT_CHECK_FAILED",
          generated_text: draft.text, character_count: Array.from(draft.text).length,
          fact_check_status: factCheckPassed ? "passed" : "failed",
          fact_check_notes: draft.factCheckNotes, voice_evaluation: voiceEvaluation,
        });
        return jsonResponse({
          mode: "dry_run", published: false, postType: "us_premarket_report", runId,
          generatedText: draft.text, reportDate: draft.reportDate,
          isUsMarketOpen: draft.isUsMarketOpen, importantPoints: draft.importantPoints,
          futures: draft.futures, semiconductorSignal: draft.semiconductorSignal,
          premarketMovers: draft.premarketMovers, conditionalFactors: draft.conditionalFactors,
          sourceUrls: draft.sourceUrls, marketDataTimestamp: draft.marketDataTimestamp,
          runMode: draft.runMode, characterCount: Array.from(draft.text).length,
          model: draft.model, escalatedToSol: draft.escalatedToSol,
          tokenUsage: { input: totalInputTokens, output: totalOutputTokens },
          webSearchCalls: draft.webSearchCalls, apiCostUsd: totalCost,
          factCheck: { status: factCheckPassed ? "passed" : "failed", notes: draft.factCheckNotes },
          voiceEvaluation,
        }, 200);
      } catch (error) {
        const code = safeErrorCode(error);
        try {
          await updateUsPremarketReportRun(supabaseUrl, serviceRoleKey, runId, {
            generated_at: new Date().toISOString(), status: "failed", error: code,
            fact_check_status: "failed", fact_check_notes: [code],
          });
        } catch { console.error("Failed to record US premarket dry-run failure"); }
        throw error;
      }
    }

    if (isVoiceDryRun) {
      const postType = requestBody.post_type;
      const previewDifficulty = postType === "tip_beginner" ? "初級"
        : postType === "tip_intermediate" ? "中級"
        : postType === "tip_practical" ? "実践"
        : undefined;
      if (postType === "tip" || previewDifficulty) {
        const tip = await selectTipForPreview(supabaseUrl, serviceRoleKey, previewDifficulty);
        if (!tip) return jsonResponse({ error: "NO_TIP_FOR_PREVIEW" }, 404);
        const posts = await generatePostParts(openAiApiKey, tip);
        const text = posts.join("\n\n");
        const voiceEvaluation = await evaluateKabumoriVoice(
          openAiApiKey, "tip", text,
          [`タイトル: ${tip.title}`, `難易度: ${tip.difficulty}`, `基礎情報: ${tip.base_text || "なし"}`].join("\n"),
        );
        return jsonResponse({
          mode: "dry_run", published: false, postType, difficulty: tip.difficulty,
          title: tip.title, text, voiceEvaluation,
        }, 200);
      }
      if (postType === "interaction" || postType === "interaction_free" || postType === "interaction_poll") {
        const targetFormat = postType === "interaction_free" ? "experience"
          : postType === "interaction_poll" ? "choice"
          : undefined;
        const tradingDay = await getJpxTradingDay(supabaseUrl, serviceRoleKey);
        const topic = await selectInteractionTopic(supabaseUrl, serviceRoleKey, tradingDay, targetFormat);
        if (!topic) return jsonResponse({ error: "NO_INTERACTION_FOR_PREVIEW" }, 404);
        const draft = await generateInteractionPost(
          openAiApiKey,
          topic,
          null,
          tradingDay,
          `voice-preview:${crypto.randomUUID()}`,
        );
        return jsonResponse({
          mode: "dry_run", published: false, postType, title: topic.title,
          text: draft.text, pollOptions: draft.pollOptions,
          tradingDay, voiceEvaluation: draft.voiceEvaluation,
        }, 200);
      }
      if (postType === "useful_tip") {
        const topics = await selectUsefulTipsByTitles(supabaseUrl, serviceRoleKey, ["NISAで配当を非課税にするための受取方法"]);
        const topic = topics[0];
        if (!topic) return jsonResponse({ error: "NO_USEFUL_TIP_FOR_PREVIEW" }, 404);
        const draft = await generateVerifiedUsefulTip(openAiApiKey, topic);
        await saveUsefulTipVerification(supabaseUrl, serviceRoleKey, topic, draft);
        const voiceEvaluation = await evaluateKabumoriVoice(
          openAiApiKey, "useful_tip", draft.text,
          [`テーマ: ${topic.title}`, `説明: ${topic.topic_description}`, `公式情報による事前検証: ${draft.factCheckStatus}`, ...draft.factCheckNotes].join("\n"),
        );
        return jsonResponse({
          mode: "dry_run", published: false, postType, title: topic.title, text: draft.text,
          factCheck: draft.factCheckStatus, model: draft.model, escalatedToSol: draft.escalatedToSol,
          voiceEvaluation,
        }, 200);
      }
      if (postType === "morning" || postType === "market_close") {
        const text = await generateFuturePostPreview(openAiApiKey, postType);
        const factBasis = postType === "morning"
          ? "架空データ: ダウ+0.3%、ナスダック-0.4%、ドル円149円80銭付近、米10年債4.10%付近。注目は円相場、半導体、寄り付き後。"
          : "架空データ: 日経平均+0.7%、TOPIX+0.4%。半導体・銀行が強く、新興グロースが重い。明日の注目は米雇用関連指標と為替。";
        const voiceEvaluation = await evaluateKabumoriVoice(openAiApiKey, postType, text, factBasis);
        return jsonResponse({
          mode: "dry_run", published: false, postType, syntheticFacts: true,
          text, voiceEvaluation,
        }, 200);
      }
      return jsonResponse({ error: "UNSUPPORTED_VOICE_PREVIEW_TYPE" }, 400);
    }

    if (isUsefulTipDryRun) {
      const requestedTitles = Array.isArray(requestBody.titles)
        ? requestBody.titles.filter((title): title is string => typeof title === "string").slice(0, 3)
        : [];
      if (requestedTitles.length === 0) {
        return jsonResponse({ error: "DRY_RUN_TITLES_REQUIRED" }, 400);
      }
      const tips = await selectUsefulTipsByTitles(supabaseUrl, serviceRoleKey, requestedTitles);
      const results = [];
      for (const tip of tips) {
        try {
          const draft = await generateVerifiedUsefulTip(openAiApiKey, tip);
          await saveUsefulTipVerification(supabaseUrl, serviceRoleKey, tip, draft);
          results.push({
            topicId: tip.id,
            title: tip.title,
            sourceUrls: draft.sourceUrls,
            generatedText: draft.text,
            characterCount: Array.from(draft.text).length,
            factCheck: { status: draft.factCheckStatus, notes: draft.factCheckNotes },
            model: draft.model,
            escalatedToSol: draft.escalatedToSol,
            tokenUsage: { input: draft.inputTokens, output: draft.outputTokens },
            apiCostUsd: draft.apiCostUsd,
          });
        } catch (error) {
          results.push({
            topicId: tip.id,
            title: tip.title,
            sourceUrls: [],
            generatedText: "",
            characterCount: 0,
            factCheck: { status: "failed", notes: [safeErrorCode(error)] },
          });
        }
      }
      return jsonResponse({ mode: "dry_run", published: false, results }, 200);
    }

    const xAuth: XAuthContext = {
      tokens: await loadXTokens(
        supabaseUrl,
        serviceRoleKey,
        xClientSecret!,
        xAccessToken!,
        xRefreshToken!,
      ),
      clientId: xClientId!,
      clientSecret: xClientSecret!,
      supabaseUrl,
      serviceRoleKey,
      refreshExecuted: false,
    };

    try {
      await reconcileStaleMorningReportRuns({ supabaseUrl, serviceRoleKey });
    } catch {
      console.error("Failed to reconcile stale morning report runs");
    }

    const scheduledPost = await claimDuePost(supabaseUrl, serviceRoleKey);
    if (!scheduledPost) {
      return jsonResponse({ status: "idle", message: "No post is due" }, 200);
    }
    scheduledPostId = scheduledPost.id;

    if (scheduledPost.post_type === "morning_report") {
      let morningRunId: string | null = null;
      let draft: MorningReportDraft | null = null;
      let xPostAttempted = false;
      try {
        morningRunId = await createMorningReportRun(
          supabaseUrl, serviceRoleKey, scheduledPost.scheduled_for, scheduledPost.id,
        );
        const referenceTime = new Date().toISOString();
        const tradingDay = await getJpxTradingDay(supabaseUrl, serviceRoleKey, referenceTime);
        const expectedUsSessionDate = await getExpectedUsSessionDate(supabaseUrl, serviceRoleKey, referenceTime);
        draft = await generateMorningReport(openAiApiKey, referenceTime, tradingDay, expectedUsSessionDate);
        if (draft.text) {
          await updateMorningReportRun(supabaseUrl, serviceRoleKey, morningRunId, {
            generated_at: new Date().toISOString(), source_urls: draft.sourceUrls,
            market_data_timestamp: draft.marketDataTimestamp,
            input_tokens: draft.inputTokens, output_tokens: draft.outputTokens,
            web_search_calls: draft.webSearchCalls, api_cost_usd: draft.apiCostUsd,
            generated_text: draft.text, character_count: Array.from(draft.text).length,
            fact_check_status: "passed", fact_check_notes: draft.factCheckNotes,
            market_data: morningRunMarketData(draft, null, "pending"),
          });
        }
        const voiceEvaluation = draft.text
          ? await evaluateKabumoriVoice(openAiApiKey, "morning_report", draft.text, morningFactBasis(draft))
          : skippedVoiceEvaluation("Fact check不合格のため文体評価を未実施");
        if (draft.factCheckStatus !== "passed") throw new Error("MORNING_REPORT_FACT_CHECK_FAILED");
        const totalInputTokens = draft.inputTokens + voiceEvaluation.inputTokens;
        const totalOutputTokens = draft.outputTokens + voiceEvaluation.outputTokens;
        const totalCost = Number((draft.apiCostUsd + voiceEvaluation.apiCostUsd).toFixed(6));
        await updateMorningReportRun(supabaseUrl, serviceRoleKey, morningRunId, {
          generated_at: new Date().toISOString(),
          source_urls: draft.sourceUrls,
          market_data_timestamp: draft.marketDataTimestamp,
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          web_search_calls: draft.webSearchCalls,
          api_cost_usd: totalCost,
          generated_text: draft.text,
          character_count: Array.from(draft.text).length,
          fact_check_status: "passed",
          fact_check_notes: draft.factCheckNotes,
          market_data: morningRunMarketData(draft, voiceEvaluation, "completed"),
        });
        if (!voiceEvaluation.passed) throw new Error("MORNING_REPORT_VOICE_CHECK_FAILED");
        xPostAttempted = true;
        const xResult = await postToX(xAuth, draft.text);
        const xPostId = getXPostId(xResult);
        if (!xPostId) throw new Error("X_RESPONSE_MISSING_POST_ID");
        await callRpc(supabaseUrl, serviceRoleKey, "complete_morning_report_post", {
          p_scheduled_post_id: scheduledPost.id,
          p_morning_report_run_id: morningRunId,
          p_x_post_id: xPostId,
        });
        return jsonResponse({
          schedule: { id: scheduledPost.id, postType: "morning_report", scheduledFor: scheduledPost.scheduled_for },
          runId: morningRunId,
          generatedText: draft.text,
          sourceUrls: draft.sourceUrls,
          marketDataTimestamp: draft.marketDataTimestamp,
          model: draft.model,
          xPostId,
          refreshExecuted: xAuth.refreshExecuted,
        }, 201);
      } catch (error) {
        if (morningRunId) {
          const code = safeErrorCode(error);
          const voiceFailure = error instanceof VoiceEvaluationOutputError ? error : null;
          const laneFailure = error instanceof MorningLaneResponseError ? error : null;
          // Both a broken voice-evaluation call (VoiceEvaluationOutputError) and a completed evaluation
          // that judged the text unsafe (MORNING_REPORT_VOICE_CHECK_FAILED) are voice-layer outcomes, not
          // fact check failures — the underlying Fact Check result must not be overwritten by either.
          const isVoiceLayerFailure = Boolean(voiceFailure) || code === "MORNING_REPORT_VOICE_CHECK_FAILED";
          try {
            await updateMorningReportRun(supabaseUrl, serviceRoleKey, morningRunId, {
              generated_at: new Date().toISOString(), status: "failed", error: code,
              fact_check_status: isVoiceLayerFailure && draft?.factCheckStatus === "passed" ? "passed" : "failed",
              ...(voiceFailure && draft ? {
                fact_check_notes: [...draft.factCheckNotes, ...voiceEvaluationFailureNotes(error)],
                market_data: morningRunMarketData(draft, null, "failed", voiceFailure),
              } : {}),
              ...(laneFailure ? {
                fact_check_notes: [code],
                market_data: {
                  retrievalDiagnostics: laneFailure.context,
                  laneResponseFailure: laneFailure.diagnostics,
                },
              } : {}),
            });
          } catch { console.error("Failed to record morning report failure"); }
        }

        const retryDecision = shouldRetryMorningReport({
          error,
          postAttempted: xPostAttempted,
          attemptNumber: scheduledPost.attempt_count,
          maxAttempts: MORNING_REPORT_MAX_ATTEMPTS,
        });
        if (retryDecision.retryable) {
          const retryAt = computeMorningReportRetryTime(new Date(), scheduledPost.attempt_count);
          try {
            await callRpc(supabaseUrl, serviceRoleKey, "retry_scheduled_post", {
              p_scheduled_post_id: scheduledPost.id,
              p_retry_at: retryAt.toISOString(),
              p_message: `${retryDecision.reasonCode}:${safeErrorCode(error)}`,
            });
            return jsonResponse({
              status: "retry_scheduled",
              postType: "morning_report",
              scheduledPostId: scheduledPost.id,
              attemptNumber: scheduledPost.attempt_count,
              maxAttempts: MORNING_REPORT_MAX_ATTEMPTS,
              retryAt: retryAt.toISOString(),
              reasonCode: retryDecision.reasonCode,
            }, 200);
          } catch {
            console.error("Failed to schedule morning report retry");
            // Fall through: the outer catch marks the row failed instead of leaving it stuck running.
          }
        }
        throw error;
      }
    }

    if (scheduledPost.post_type === "close_report") {
      let closeRunId: string | null = null;
      let draft: CloseReportDraft | null = null;
      try {
        closeRunId = await createCloseReportRun(
          supabaseUrl, serviceRoleKey, scheduledPost.scheduled_for, scheduledPost.id,
        );
        draft = await generateCloseReport(openAiApiKey, new Date().toISOString());
        if (draft.text) {
          await updateCloseReportRun(supabaseUrl, serviceRoleKey, closeRunId, {
            generated_at: new Date().toISOString(), source_urls: draft.sourceUrls,
            market_data_timestamp: draft.marketDataTimestamp,
            nikkei_data: draft.nikkei, topix_data: draft.topix,
            nikkei_futures_1545_data: draft.nikkeiFutures1545,
            input_tokens: draft.inputTokens, output_tokens: draft.outputTokens,
            web_search_calls: draft.webSearchCalls, api_cost_usd: draft.apiCostUsd,
            generated_text: draft.text, character_count: Array.from(draft.text).length,
            fact_check_status: "passed", fact_check_notes: draft.factCheckNotes,
            voice_evaluation: { status: "pending" },
            market_data: closeRunMarketData(draft, null, "pending"),
          });
        }
        const voiceEvaluation = draft.text
          ? await evaluateKabumoriVoice(openAiApiKey, "close_report", draft.text, closeFactBasis(draft))
          : skippedVoiceEvaluation("Fact check不合格のため文体評価を未実施");
        if (draft.factCheckStatus !== "passed") throw new Error("CLOSE_REPORT_FACT_CHECK_FAILED");
        const totalInputTokens = draft.inputTokens + voiceEvaluation.inputTokens;
        const totalOutputTokens = draft.outputTokens + voiceEvaluation.outputTokens;
        const totalCost = Number((draft.apiCostUsd + voiceEvaluation.apiCostUsd).toFixed(6));
        await updateCloseReportRun(supabaseUrl, serviceRoleKey, closeRunId, {
          generated_at: new Date().toISOString(), source_urls: draft.sourceUrls,
          market_data_timestamp: draft.marketDataTimestamp,
          nikkei_data: draft.nikkei, topix_data: draft.topix,
          nikkei_futures_1545_data: draft.nikkeiFutures1545,
          input_tokens: totalInputTokens, output_tokens: totalOutputTokens,
          web_search_calls: draft.webSearchCalls, api_cost_usd: totalCost,
          generated_text: draft.text, character_count: Array.from(draft.text).length,
          fact_check_status: "passed", fact_check_notes: draft.factCheckNotes,
          voice_evaluation: voiceEvaluation,
          market_data: closeRunMarketData(draft, voiceEvaluation, "completed"),
        });
        const xResult = await postToX(xAuth, draft.text);
        const xPostId = getXPostId(xResult);
        if (!xPostId) throw new Error("X_RESPONSE_MISSING_POST_ID");
        await callRpc(supabaseUrl, serviceRoleKey, "complete_close_report_post", {
          p_scheduled_post_id: scheduledPost.id,
          p_close_report_run_id: closeRunId,
          p_x_post_id: xPostId,
        });
        return jsonResponse({
          schedule: { id: scheduledPost.id, postType: "close_report", scheduledFor: scheduledPost.scheduled_for },
          runId: closeRunId, generatedText: draft.text, sourceUrls: draft.sourceUrls,
          marketDataTimestamp: draft.marketDataTimestamp, model: draft.model,
          xPostId, refreshExecuted: xAuth.refreshExecuted,
        }, 201);
      } catch (error) {
        if (closeRunId) {
          const code = safeErrorCode(error);
          const voiceFailure = error instanceof VoiceEvaluationOutputError ? error : null;
          try {
            await updateCloseReportRun(supabaseUrl, serviceRoleKey, closeRunId, {
              generated_at: new Date().toISOString(), status: "failed", error: code,
              fact_check_status: voiceFailure && draft?.factCheckStatus === "passed" ? "passed" : "failed",
              ...(voiceFailure && draft ? {
                fact_check_notes: [...draft.factCheckNotes, ...voiceEvaluationFailureNotes(error)],
                voice_evaluation: {
                  status: "failed", code,
                  response: voiceFailure.responseDiagnostics,
                  schema: voiceFailure.schemaDiagnostics,
                },
                market_data: closeRunMarketData(draft, null, "failed", voiceFailure),
              } : {}),
            });
          } catch { console.error("Failed to record close report failure"); }
        }
        throw error;
      }
    }

    if (scheduledPost.post_type === "us_premarket_report") {
      let runId: string | null = null;
      try {
        runId = await createUsPremarketReportRun(
          supabaseUrl, serviceRoleKey, scheduledPost.scheduled_for, scheduledPost.id,
        );
        const draft = await generateUsPremarketReport(openAiApiKey, new Date().toISOString());
        const voiceEvaluation = draft.text
          ? await evaluateKabumoriVoice(openAiApiKey, "us_premarket_report", draft.text, usPremarketFactBasis(draft))
          : skippedVoiceEvaluation("Fact check不合格のため文体評価を未実施");
        if (draft.factCheckStatus !== "passed") throw new Error("US_PREMARKET_FACT_CHECK_FAILED");
        const totalInputTokens = draft.inputTokens + voiceEvaluation.inputTokens;
        const totalOutputTokens = draft.outputTokens + voiceEvaluation.outputTokens;
        const totalCost = Number((draft.apiCostUsd + voiceEvaluation.apiCostUsd).toFixed(6));
        await updateUsPremarketReportRun(supabaseUrl, serviceRoleKey, runId, {
          generated_at: new Date().toISOString(), source_urls: draft.sourceUrls,
          market_data_timestamp: Number.isFinite(Date.parse(draft.marketDataTimestamp)) ? draft.marketDataTimestamp : null,
          model_used: draft.model,
          input_tokens: totalInputTokens, output_tokens: totalOutputTokens,
          web_search_calls: draft.webSearchCalls, api_cost_usd: totalCost,
          generated_text: draft.text, character_count: Array.from(draft.text).length,
          fact_check_status: "passed", fact_check_notes: draft.factCheckNotes,
          voice_evaluation: voiceEvaluation,
          market_data: {
            reportDate: draft.reportDate, isUsMarketOpen: draft.isUsMarketOpen,
            importantPoints: draft.importantPoints, futures: draft.futures,
            semiconductorSignal: draft.semiconductorSignal,
            premarketMovers: draft.premarketMovers,
            conditionalFactors: draft.conditionalFactors, runMode: draft.runMode,
          },
        });
        const xResult = await postToX(xAuth, draft.text);
        const xPostId = getXPostId(xResult);
        if (!xPostId) throw new Error("X_RESPONSE_MISSING_POST_ID");
        await callRpc(supabaseUrl, serviceRoleKey, "complete_us_premarket_report_post", {
          p_scheduled_post_id: scheduledPost.id, p_run_id: runId, p_x_post_id: xPostId,
        });
        return jsonResponse({
          schedule: { id: scheduledPost.id, postType: "us_premarket_report", scheduledFor: scheduledPost.scheduled_for },
          runId, generatedText: draft.text, sourceUrls: draft.sourceUrls,
          marketDataTimestamp: draft.marketDataTimestamp, model: draft.model,
          xPostId, refreshExecuted: xAuth.refreshExecuted,
        }, 201);
      } catch (error) {
        if (runId) {
          const code = safeErrorCode(error);
          try {
            await updateUsPremarketReportRun(supabaseUrl, serviceRoleKey, runId, {
              generated_at: new Date().toISOString(), status: "failed", error: code,
              fact_check_status: "failed",
            });
          } catch { console.error("Failed to record US premarket report failure"); }
        }
        throw error;
      }
    }

    if (scheduledPost.post_type === "useful_tip") {
      const usefulTip = await selectUsefulTip(supabaseUrl, serviceRoleKey);
      if (!usefulTip) throw new Error("NO_ELIGIBLE_USEFUL_TIP");
      const draft = await generateVerifiedUsefulTip(openAiApiKey, usefulTip);
      await saveUsefulTipVerification(supabaseUrl, serviceRoleKey, usefulTip, draft);
      if (draft.factCheckStatus !== "passed" || !draft.text) {
        throw new Error("USEFUL_TIP_FACT_CHECK_FAILED");
      }
      const xResult = await postToX(xAuth, draft.text);
      const xPostId = getXPostId(xResult);
      if (!xPostId) throw new Error("X_RESPONSE_MISSING_POST_ID");
      await callRpc(supabaseUrl, serviceRoleKey, "complete_useful_tip_post", {
        p_scheduled_post_id: scheduledPost.id,
        p_useful_tip_id: usefulTip.id,
        p_x_post_id: xPostId,
        p_source_urls: draft.sourceUrls,
        p_model_used: draft.model,
        p_escalated: draft.escalatedToSol,
        p_input_tokens: draft.inputTokens,
        p_output_tokens: draft.outputTokens,
        p_api_cost: draft.apiCostUsd,
      });
      return jsonResponse({
        schedule: { id: scheduledPost.id, postType: "useful_tip", scheduledFor: scheduledPost.scheduled_for },
        usefulTip: { id: usefulTip.id, title: usefulTip.title },
        generatedText: draft.text,
        sourceUrls: draft.sourceUrls,
        model: draft.model,
        escalatedToSol: draft.escalatedToSol,
        xPostId,
        refreshExecuted: xAuth.refreshExecuted,
      }, 201);
    }

    if (scheduledPost.post_type === "interaction") {
      const tradingDay = await getJpxTradingDay(
        supabaseUrl,
        serviceRoleKey,
        scheduledPost.scheduled_for,
      );
      const topic = await selectInteractionTopic(
        supabaseUrl,
        serviceRoleKey,
        tradingDay,
        scheduledPost.target_question_format,
      );
      if (!topic) throw new Error("NO_ELIGIBLE_INTERACTION_TOPIC");
      const marketContext = tradingDay.isTradingDay
        ? await selectMarketContext(supabaseUrl, serviceRoleKey)
        : null;
      console.log("Selected interaction topic", { topicId: topic.id });
      const interactionPost = await generateInteractionPost(
        openAiApiKey,
        topic,
        marketContext,
        tradingDay,
        scheduledPost.id,
      );
      const xResult = await postToX(
        xAuth,
        interactionPost.text,
        undefined,
        interactionPost.pollOptions,
      );
      const xPostId = getXPostId(xResult);
      if (!xPostId) throw new Error("X_RESPONSE_MISSING_POST_ID");
      await callRpc(supabaseUrl, serviceRoleKey, "complete_interaction_post", {
        p_scheduled_post_id: scheduledPost.id,
        p_interaction_topic_id: topic.id,
        p_x_post_id: xPostId,
      });
      console.log("Interaction post created", { topicId: topic.id });
      return jsonResponse({
        schedule: {
          id: scheduledPost.id,
          postType: scheduledPost.post_type,
          slotNo: scheduledPost.slot_no,
          scheduledFor: scheduledPost.scheduled_for,
        },
        interactionTopic: {
          id: topic.id,
          title: topic.title,
          questionFormat: topic.question_format,
        },
        generatedText: interactionPost.text,
        pollCreated: interactionPost.pollOptions !== null,
        xPostId,
        refreshExecuted: xAuth.refreshExecuted,
      }, 201);
    }

    if (scheduledPost.post_type !== "tip") {
      throw new Error(`UNSUPPORTED_POST_TYPE:${scheduledPost.post_type}`);
    }

    const tip = await selectTip(
      supabaseUrl,
      serviceRoleKey,
      scheduledPost.target_difficulty,
    );
    if (!tip) {
      throw new Error(`NO_ELIGIBLE_TIP:${TIP_COOLDOWN_HOURS}H_COOLDOWN`);
    }

    console.log("Selected tip", { tipId: tip.id, title: tip.title });
    const postParts = await generatePostParts(openAiApiKey, tip);
    const xPosts = await postThreadToX(xAuth, postParts);
    const xPostId = xPosts[0].id;

    await callRpc(supabaseUrl, serviceRoleKey, "complete_tip_post", {
      p_scheduled_post_id: scheduledPost.id,
      p_tip_id: tip.id,
      p_x_post_id: xPostId,
    });
    console.log("Tip posted successfully", { tipId: tip.id });

    return jsonResponse(
      {
        schedule: {
          id: scheduledPost.id,
          postType: scheduledPost.post_type,
          slotNo: scheduledPost.slot_no,
          scheduledFor: scheduledPost.scheduled_for,
        },
        tip: { id: tip.id, title: tip.title, difficulty: tip.difficulty },
        generatedPosts: postParts,
        xPosts: xPosts.map(({ id, text }) => ({ id, text })),
        refreshExecuted: xAuth.refreshExecuted,
      },
      201,
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "UNEXPECTED_ERROR";
    console.error("x-test-post failed", { code });

    if (
      scheduledPostId && supabaseUrlForFailure && serviceRoleKeyForFailure &&
      !code.startsWith("RPC_FAILED:complete_tip_post") &&
      !code.startsWith("RPC_FAILED:complete_interaction_post") &&
      !code.startsWith("RPC_FAILED:complete_morning_report_post") &&
      !code.startsWith("RPC_FAILED:complete_us_premarket_report_post") &&
      // The X API call itself returned success but the response body had no post id — whether the post
      // exists is unknown, so this must not be recorded as a failure (which could otherwise invite a retry).
      code !== "X_RESPONSE_MISSING_POST_ID"
    ) {
      try {
        await callRpc(
          supabaseUrlForFailure,
          serviceRoleKeyForFailure,
          "fail_scheduled_post",
          { p_scheduled_post_id: scheduledPostId, p_message: code },
        );
      } catch {
        console.error("Failed to record scheduled post failure");
      }
    }
    return jsonResponse({ error: code }, 500);
  }
});
