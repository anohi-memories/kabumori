// Classifies why an important-news candidate ended in generation_failed, from what production stored: the error code,
// the Fact/Voice status and the Fact/Voice issue texts. Pure and deterministic.
//
// A failure can have several causes (an identity doubt and an invented forecast in the same draft), so every matching
// cause is kept; `primary` is the first one in PRIORITY order and is what the counts use. The order puts the
// deterministic, mechanical causes first and the judgement-like ones last.
//
// This describes what production's own checks said. It does not decide whether a check was right: most of these are
// genuine catches of draft errors (see .agent/CODEX_REPORT_2.md, the 142-row analysis).

export type FailureCause =
  | "year_missing"          // MISSING_EXPLICIT_YEAR / a date whose year was dropped
  | "source_url"            // UNEXPECTED_SOURCE_URL
  | "identity"              // company or party identity not confirmed
  | "rounding"              // an amount was rounded or truncated
  | "numeric_other"         // a different amount, unit, currency, sign or metric
  | "approval_state"        // proposal written as settled, outcome or kind mix-up
  | "hedge_unsupported"     // a forecast, market reaction or claim not in the source
  | "omission"              // a material condition or fact was dropped
  | "factual_detail"        // a name, place, institution or attribution was wrong
  | "voice"                 // the Voice check failed (wording, tone, closing line)
  | "api"                   // invalid model output or an upstream error
  | "other";

export const PRIORITY: readonly FailureCause[] = [
  "year_missing", "source_url", "identity", "rounding", "numeric_other", "approval_state", "hedge_unsupported",
  "omission", "factual_detail", "voice", "api", "other",
];

export type GenerationFailureInput = {
  generationError: string;
  factStatus: string | null;
  voiceStatus: string | null;
  factIssues: string;
  voiceIssues: string;
  sourceName: string;
};

export type FailureClass = { causes: FailureCause[]; primary: FailureCause; stage: "fact" | "voice" | "api" | "local" | "other" };

const RULES: ReadonlyArray<readonly [FailureCause, RegExp]> = [
  ["year_missing", /MISSING_EXPLICIT_YEAR|年[^。]{0,16}(?:省略|欠落|落ち)|年の記載が(?:ない|欠)/],
  ["source_url", /UNEXPECTED_SOURCE_URL/],
  ["identity", /sameCompanyConfirmed|company_identity|company_name_mismatch|同一企業|同一性|企業名不一致|会社名不一致|企業名が(?:一致|異な)|primarySourceName|metadataName/],
  // Truncation or rounding of an amount, including the "cap reached" wording for an amount just below the cap.
  ["rounding", /切り捨て|切捨て|切り上げ|丸め|四捨五入|端数|概数|概算|小数|に達してい(?:ません|ない)|達したとの断定|上限を.{0,8}下回|[0-9,.]+(?:億|百万|万)円は約|ではなく[0-9,.]+(?:億|百万)/],
  // A different amount, unit, currency, sign, direction or metric. Needs a number or an explicit numeric term, so that a
  // bare mention of 配当 or 売上高 in a speculation issue is not counted as a numeric error.
  ["numeric_other", /[0-9０-９][0-9０-９,.，]*\s*(?:％|%|億|万|千|百万|円|ドル|ユーロ|株|倍|フィート|メートル|km|キロ|人|件)|桁|単位|通貨|符号|金額|数値|分母|算定対象|割合|(?:上方|下方)修正であり|(?:売上高|営業収益|営業利益|経常利益|純利益|当期純利益)[^。]{0,12}(?:ではなく|項目|区分|限定)/],
  ["approval_state", /承認|決議|可決|否決|議案|付議|上程|撤回|確定|未定|成立|発効/],
  ["hedge_unsupported", /元情報にない|推測|予測|論評|断定|憶測|見られそう|見込まれ|可能性|示唆|市場反応|因果|解釈|評価を追記|追記|事実を強め|強めている|確度|断定的|確定事項のように|ように断定/],
  ["omission", /欠落|省略|抜け|記載がない|記載されていない|言及がない|落ちて|欠けて/],
  ["factual_detail", /誤り|誤訳|相違|異なる|一致しない|不整合|取り違え|特定しすぎ|限定している|と表現|混同|地名|機関|別の|表記/],
];

const API_ERRORS = /INVALID_OUTPUT|TIMEOUT|RATE_LIMIT|HTTP_\d{3}|\b(?:429|500|502|503|504)\b|OPENAI/;

export function classifyGenerationFailure(input: GenerationFailureInput): FailureClass {
  const text = input.factIssues;
  const causes = new Set<FailureCause>();
  for (const [cause, pattern] of RULES) if (pattern.test(text)) causes.add(cause);
  const voiceFailed = input.voiceStatus === "failed" || /VOICE_FAILED/.test(input.generationError);
  if (voiceFailed) causes.add("voice");
  if (API_ERRORS.test(input.generationError) && !/FACT|VOICE/.test(input.generationError)) causes.add("api");
  if (causes.size === 0) causes.add("other");
  const ordered = PRIORITY.filter((cause) => causes.has(cause));
  let stage: FailureClass["stage"] = "other";
  if (input.generationError.includes("LOCAL_FACT")) stage = "local";
  else if (/FACT/.test(input.generationError) || input.factStatus === "failed") stage = "fact";
  else if (voiceFailed) stage = "voice";
  else if (causes.has("api")) stage = "api";
  return { causes: ordered, primary: ordered[0], stage };
}

/**
 * Which causes PR #116 (TDnet numeric faithfulness and Fact-retry guards, merged 2026-10-10) can be expected to reduce.
 * This is a reading of the PR's commit messages and tests, not a measurement: PR #116 was merged after the analysed window.
 *   - draft prompt: keep amounts to the source digits, no rewording below a cap, keep calculation bases,
 *     write pre-approval proposals as proposals, allow value-preserving unit conversion
 *   - Fact retry: pre-approval proposals may be restored; amount issues are no longer routed into the year retry
 *   - deterministic guards decide whether a retry is allowed (currency, sign, metric binding, states)
 * It does not touch: the year check itself, company identity, invented forecasts, omissions, Voice, or non-TDnet sources.
 */
export type Pr116Outlook = "expected_to_improve" | "partly" | "not_addressed";

export function pr116Outlook(primary: FailureCause, sourceName: string): Pr116Outlook {
  if (sourceName !== "tdnet") return "not_addressed";
  switch (primary) {
    case "rounding":
    case "approval_state":
      return "expected_to_improve";
    case "numeric_other":
    case "hedge_unsupported":
      return "partly";
    default:
      return "not_addressed";
  }
}
