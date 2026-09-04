import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MORNING_GREETING_MAX_CHARACTERS,
  MORNING_GREETING_MIN_CHARACTERS,
  MORNING_GREETING_TARGET_MAX_CHARACTERS,
  MORNING_GREETING_TARGET_MAX_EMOJI,
  MORNING_GREETING_TARGET_MIN_CHARACTERS,
  MORNING_GREETING_TARGET_MIN_EMOJI,
  MorningGreetingLengthInvalidError,
  buildMorningGreetingLengthFailureDiagnostics,
  buildMorningGreetingRequest,
  generateMorningGreeting,
  isVerifiedMajorTheme,
  selectMorningGreetingTheme,
  validateMorningGreetingOutput,
} from "./morning_greeting_logic.ts";

const VALID_TEXT = "おはようございます☀️ 朝の支度をひとつずつ整える時間って、気持ちの切り替えにもなりますね。急がず、自分のペースで始めていけたら十分です。今日も小さな発見を楽しみながら、無理のない一日にしていきましょう🌱";

function outputFor(date: string, text = VALID_TEXT) {
  const theme = selectMorningGreetingTheme(date);
  return {
    theme_type: theme.theme_type,
    theme_name: theme.theme_name,
    visual_theme: theme.visual_theme,
    generated_text: text,
  };
}

test("September 1 selects Disaster Prevention Day", () => {
  const theme = selectMorningGreetingTheme("2026-09-01");
  assert.equal(theme.theme_type, "special_day");
  assert.equal(theme.theme_name, "防災の日");
  assert.equal(theme.confidence, "high");
});

test("December 25 selects Christmas", () => {
  assert.equal(selectMorningGreetingTheme("2026-12-25").theme_name, "クリスマス");
});

test("January 1 selects New Year's Day", () => {
  assert.equal(selectMorningGreetingTheme("2027-01-01").theme_name, "元日");
});

test("an ordinary date does not invent a commemorative day", () => {
  const theme = selectMorningGreetingTheme("2026-09-02");
  assert.equal(theme.theme_type, "generic");
  assert.equal(theme.theme_name, null);
  assert.match(buildMorningGreetingRequest("2026-09-02").body.instructions as string, /今日は○○の日.*禁止/u);
});

test("minor commemorative candidates are not accepted", () => {
  assert.equal(isVerifiedMajorTheme("2026-04-10", "駅弁の日"), false);
});

test("nonexistent commemorative days are not accepted", () => {
  assert.equal(isVerifiedMajorTheme("2026-09-02", "架空の投資記念日"), false);
});

test("generated text is constrained to the intended length", () => {
  const theme = selectMorningGreetingTheme("2026-09-02");
  const validated = validateMorningGreetingOutput(outputFor("2026-09-02"), theme);
  const length = Array.from(validated.generated_text).length;
  assert.ok(length >= 100 && length <= 180, `length=${length}`);
});

test("every selected theme has a visual theme for the later image step", () => {
  for (const date of ["2026-09-01", "2026-12-25", "2027-01-01", "2026-09-02"]) {
    assert.ok(selectMorningGreetingTheme(date).visual_theme.length > 0);
  }
});

test("a selected major theme must appear in the generated text", () => {
  const theme = selectMorningGreetingTheme("2026-09-01");
  assert.throws(
    () => validateMorningGreetingOutput(outputFor("2026-09-01"), theme),
    /MORNING_GREETING_THEME_MISSING/,
  );
});

test("fabricated personal experience is rejected", () => {
  const theme = selectMorningGreetingTheme("2026-09-02");
  const fabricated = VALID_TEXT.replace(
    "朝の支度をひとつずつ整える時間って",
    "私も今朝は近所のお店で朝ごはんを買いました。朝の時間って",
  );
  assert.throws(
    () => validateMorningGreetingOutput(outputFor("2026-09-02", fabricated), theme),
    /MORNING_GREETING_FABRICATED_EXPERIENCE/,
  );
});

test("Luna request uses strict structured output without web tools", async () => {
  let requestBody: Record<string, unknown> | null = null;
  const mockFetch: typeof fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(outputFor("2026-09-02")) }] }],
      usage: { input_tokens: 321, output_tokens: 123 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const result = await generateMorningGreeting("test-key", "2026-09-02", mockFetch);
  assert.equal(result.model, "gpt-5.6-luna");
  assert.equal(result.input_tokens, 321);
  assert.equal(result.output_tokens, 123);
  assert.equal(requestBody?.model, "gpt-5.6-luna");
  assert.equal(requestBody?.tools, undefined);
  const format = (requestBody?.text as { format?: { strict?: unknown } }).format;
  assert.equal(format?.strict, true);
});

test("morning_greeting remains excluded from the X dispatcher claim", () => {
  const migration = readFileSync(fileURLToPath(new URL(
    "../../migrations/20260901044548_add_morning_greeting_schedule.sql",
    import.meta.url,
  )), "utf8");
  assert.match(migration, /and post_type <> 'morning_greeting'/);
});

// --- length-invalid retry ---------------------------------------------------------------------------

const DATE = "2026-09-02"; // generic theme, no theme_name to worry about

// Builds text of an exact code-point length that otherwise satisfies every other validator rule
// (salutation present, no fabricated experience/weather/advice/day, no link or tag, 0 emoji).
function textOfLength(n: number): string {
  const base = "おはようございます。";
  const filler = "今日も心地よい一日になりますように。ゆっくり深呼吸してから始めましょう。";
  let text = base;
  while (Array.from(text).length < n) text += filler;
  return Array.from(text).slice(0, n).join("");
}

function sequencedGreetingFetch(texts: string[]): { fetch: typeof fetch; callCount: () => number } {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    const text = texts[Math.min(calls, texts.length - 1)];
    calls += 1;
    return new Response(JSON.stringify({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(outputFor(DATE, text)) }] }],
      usage: { input_tokens: 10, output_tokens: 10 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { fetch: fetchImpl, callCount: () => calls };
}

test("1: a first attempt inside range succeeds without retrying", async () => {
  const { fetch: mockFetch, callCount } = sequencedGreetingFetch([textOfLength(120)]);
  const result = await generateMorningGreeting("test-key", DATE, mockFetch);
  assert.equal(result.retry_count, 0);
  assert.equal(callCount(), 1);
  assert.equal(Array.from(result.generated_text).length, 120);
});

test("2+3: a too-short first attempt retries once and a valid retry succeeds", async () => {
  const { fetch: mockFetch, callCount } = sequencedGreetingFetch([textOfLength(99), textOfLength(120)]);
  const result = await generateMorningGreeting("test-key", DATE, mockFetch);
  assert.equal(result.retry_count, 1);
  assert.equal(callCount(), 2);
  assert.equal(Array.from(result.generated_text).length, 120);
});

test("4+5: a too-long first attempt retries once and a valid retry succeeds", async () => {
  const { fetch: mockFetch, callCount } = sequencedGreetingFetch([textOfLength(181), textOfLength(150)]);
  const result = await generateMorningGreeting("test-key", DATE, mockFetch);
  assert.equal(result.retry_count, 1);
  assert.equal(callCount(), 2);
  assert.equal(Array.from(result.generated_text).length, 150);
});

test("6: still too short after the retry safely stops with TEXT_LENGTH_INVALID, carrying stage=retry diagnostics", async () => {
  const { fetch: mockFetch, callCount } = sequencedGreetingFetch([textOfLength(99), textOfLength(50)]);
  await assert.rejects(
    () => generateMorningGreeting("test-key", DATE, mockFetch),
    (error: unknown) => {
      assert.ok(error instanceof MorningGreetingLengthInvalidError);
      assert.equal(error.message, "MORNING_GREETING_TEXT_LENGTH_INVALID");
      assert.equal(error.retryCount, 1);
      assert.equal(error.firstLength, 99);
      assert.equal(error.retryLength, 50);
      assert.equal(error.stage, "retry");
      return true;
    },
  );
  assert.equal(callCount(), 2);
});

test("7: still too long after the retry safely stops with TEXT_LENGTH_INVALID, carrying stage=retry diagnostics", async () => {
  const { fetch: mockFetch, callCount } = sequencedGreetingFetch([textOfLength(181), textOfLength(200)]);
  await assert.rejects(
    () => generateMorningGreeting("test-key", DATE, mockFetch),
    (error: unknown) => {
      assert.ok(error instanceof MorningGreetingLengthInvalidError);
      assert.equal(error.retryCount, 1);
      assert.equal(error.firstLength, 181);
      assert.equal(error.retryLength, 200);
      assert.equal(error.stage, "retry");
      return true;
    },
  );
  assert.equal(callCount(), 2);
});

test("8: retry never happens more than once, even after a second length failure", async () => {
  const { fetch: mockFetch, callCount } = sequencedGreetingFetch([
    textOfLength(50), textOfLength(50), textOfLength(120),
  ]);
  await assert.rejects(() => generateMorningGreeting("test-key", DATE, mockFetch));
  assert.equal(callCount(), 2, "a third call would mean an unbounded retry loop");
});

test("9: a non-length failure on the first attempt is not retried", async () => {
  // In-range length but no salutation, so this fails MORNING_GREETING_SALUTATION_MISSING specifically —
  // not a length issue, so it must not trigger the length-retry path at all.
  const noSalutation120 = (() => {
    const base = "こんにちは、良い一日をお過ごしください。";
    const filler = "今日も心地よい一日になりますように。ゆっくり深呼吸してから始めましょう。";
    let text = base;
    while (Array.from(text).length < 120) text += filler;
    return Array.from(text).slice(0, 120).join("");
  })();
  const { fetch: mockFetch, callCount } = sequencedGreetingFetch([
    noSalutation120,
    textOfLength(120),
  ]);
  await assert.rejects(
    () => generateMorningGreeting("test-key", DATE, mockFetch),
    (error: unknown) => {
      assert.match((error as Error).message, /MORNING_GREETING_SALUTATION_MISSING/);
      // A non-length failure must never be reported as (or carry the diagnostics of) a length failure.
      assert.ok(!(error instanceof MorningGreetingLengthInvalidError));
      return true;
    },
  );
  assert.equal(callCount(), 1, "no retry should have been attempted for a non-length failure");
});

// --- failure-path length diagnostics (retry_count / first_length / retry_length / length_failure_stage) -----

test("diagnostics 1: buildMorningGreetingLengthFailureDiagnostics with only a first attempt reports stage=first, retry_count=0, retry_length=null", () => {
  const diagnostics = buildMorningGreetingLengthFailureDiagnostics({ generated_text: textOfLength(50) });
  assert.equal(diagnostics.retryCount, 0);
  assert.equal(diagnostics.firstLength, 50);
  assert.equal(diagnostics.retryLength, null);
  assert.equal(diagnostics.stage, "first");
});

test("diagnostics 2: buildMorningGreetingLengthFailureDiagnostics with both attempts reports stage=retry, retry_count=1", () => {
  const diagnostics = buildMorningGreetingLengthFailureDiagnostics(
    { generated_text: textOfLength(99) },
    { generated_text: textOfLength(200) },
  );
  assert.equal(diagnostics.retryCount, 1);
  assert.equal(diagnostics.firstLength, 99);
  assert.equal(diagnostics.retryLength, 200);
  assert.equal(diagnostics.stage, "retry");
});

test("11: the enforced validator range is unchanged at 100-180", () => {
  assert.equal(MORNING_GREETING_MIN_CHARACTERS, 100);
  assert.equal(MORNING_GREETING_MAX_CHARACTERS, 180);
});

test("12: the generation target is narrower, at 110-160, and stated in the prompt", () => {
  assert.equal(MORNING_GREETING_TARGET_MIN_CHARACTERS, 110);
  assert.equal(MORNING_GREETING_TARGET_MAX_CHARACTERS, 160);
  const instructions = buildMorningGreetingRequest(DATE).body.instructions as string;
  assert.match(instructions, /110.*160/u);
});

test("13: the prompt states a 1-3 emoji target", () => {
  assert.equal(MORNING_GREETING_TARGET_MIN_EMOJI, 1);
  assert.equal(MORNING_GREETING_TARGET_MAX_EMOJI, 3);
  const instructions = buildMorningGreetingRequest(DATE).body.instructions as string;
  assert.match(instructions, /絵文字は1〜3個程度/u);
});
