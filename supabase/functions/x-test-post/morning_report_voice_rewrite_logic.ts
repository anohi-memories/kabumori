// A single, at-most-once, same-execution rewrite pass for morning_report: used only when generation,
// format validation, and fact check have all already passed, and the shared Voice evaluator
// (evaluateKabumoriVoice in index.ts) alone judged the text passed=false. This module only builds/parses
// the OpenAI request and provides deterministic, local re-checks on the candidate rewrite — the actual
// HTTP call and the second Voice evaluation (reusing the same shared evaluateKabumoriVoice used
// everywhere else) happen in index.ts, so there remains exactly one Voice-evaluation implementation.

export const MORNING_REPORT_VOICE_REWRITE_MODEL = "gpt-5.6-luna" as const;

export function buildMorningReportVoiceRewriteRequestBody(
  originalText: string,
  voiceNotes: string[],
): Record<string, unknown> {
  return {
    model: MORNING_REPORT_VOICE_REWRITE_MODEL,
    store: false,
    reasoning: { effort: "low" },
    max_output_tokens: 1500,
    instructions: [
      "あなたは朝刊本文の文体修正担当です。元の本文とVoice評価の指摘だけを見て、指摘された言い回しだけを直してください。",
      "新しい事実、数値、日時、固有名詞、因果関係を追加してはいけません。元の本文に書かれていない情報を書き加えません。",
      "見出し『【朝刊】きょうの日本株、ここをチェック☀️』、『📌 今日の注目ポイント』の3件の箇条書き、『⚠️ きょう注意したいこと』、『💬 今日のひとこと』という構成と順序を保ちます。",
      "URL、ハッシュタグは追加しません。売買指示、投資助言、断定的な価格予想は追加しません。",
      "実在した個人の経験・保有・売買・損益・感情を新たに作りません。",
      "指摘のない部分の言い回しはできる限り元の本文のまま保ちます。",
    ].join("\n"),
    input: JSON.stringify({ original_text: originalText, voice_notes: voiceNotes }),
    text: {
      format: {
        type: "json_schema",
        name: "morning_report_voice_rewrite",
        strict: true,
        schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    },
  };
}

export function parseMorningReportVoiceRewriteOutputText(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const output = (raw as { output?: unknown }).output;
  if (!Array.isArray(output)) return null;
  const contents = output.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const content = (item as { content?: unknown }).content;
    return Array.isArray(content) ? content : [];
  });
  const texts = contents.filter((item) =>
    typeof item === "object" && item !== null &&
    (item as { type?: unknown }).type === "output_text" &&
    typeof (item as { text?: unknown }).text === "string"
  ).map((item) => (item as { text: string }).text.trim()).filter(Boolean);
  if (texts.length !== 1) return null;
  try {
    const parsed = JSON.parse(texts[0]) as { text?: unknown };
    return typeof parsed.text === "string" && parsed.text.trim() ? parsed.text.trim() : null;
  } catch {
    return null;
  }
}

function extractDigitSequences(text: string): string[] {
  return text.match(/[0-9０-９]+(?:[.,．，][0-9０-９]+)*/gu) ?? [];
}

// Deterministic no-drift guard used in place of re-running the full multi-lane search/fact-check
// pipeline: the rewrite may only touch phrasing, never introduce a number or date not already present in
// the original (already fact-checked) text. Re-running the real fact checker here isn't feasible without
// repeating the whole search/candidate pipeline, which the "avoid repeating full generation in a loop"
// requirement explicitly rules out for this same-execution, at-most-once path.
export function morningReportVoiceRewritePreservesFacts(originalText: string, rewrittenText: string): boolean {
  const originalDigits = new Set(extractDigitSequences(originalText));
  return extractDigitSequences(rewrittenText).every((sequence) => originalDigits.has(sequence));
}

const REWRITE_URL_OR_HASHTAG_PATTERN = /https?:\/\/|#[^\s#]+/u;
const REWRITE_INVESTMENT_ADVICE_PATTERN =
  /絶対(?:に)?上がる|必ず上がる|買うべき|売るべき|今すぐ買|今すぐ売|買い時です|売り時です|儲かります|損はしません/u;
const REWRITE_FABRICATED_EXPERIENCE_PATTERN =
  /私(?:は|も)(?:今日|先ほど|さっき)?[^。!?！?\n]{0,20}(?:買いました|売りました|保有して|含み益|含み損|利益が出)/u;

// A deterministic, local safety net on the rewrite candidate — mirrors close_report's
// localCloseReportSafetyIssues pattern (fixed_hashtags_logic.ts's sibling file, close_report_logic.ts).
// The AI rewrite prompt already forbids all of this; this catches the clearest violations in code so a
// bad rewrite can never slip past an unlucky second Voice check alone.
export function morningReportVoiceRewriteSafetyIssues(text: string): string[] {
  const issues: string[] = [];
  if (REWRITE_URL_OR_HASHTAG_PATTERN.test(text)) issues.push("URL_OR_HASHTAG_DETECTED");
  if (REWRITE_INVESTMENT_ADVICE_PATTERN.test(text)) issues.push("INVESTMENT_ADVICE_DETECTED");
  if (REWRITE_FABRICATED_EXPERIENCE_PATTERN.test(text)) issues.push("FABRICATED_EXPERIENCE_DETECTED");
  return issues;
}
