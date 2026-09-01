import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
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
