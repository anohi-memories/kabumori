// 「AIに聞く」V1 Phase A: the screen and the three entry points are React Native, so their contract is pinned by
// reading the source as text (the behaviour is covered in ai-ask_test).
import assert from "node:assert/strict";
import test from "node:test";

import { MENU_ENTRIES } from "../../src/lib/menu-entries.ts";

const repoRoot = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, repoRoot));
const code = async (path: string) => (await read(path)).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

test("the three AI entry points still open /ai, and /ai is a registered root screen", async () => {
  const home = await code("src/components/home/home-ask-ai-entry.tsx");
  assert.ok(home.includes("router.push('/ai')"));
  const portfolio = await code("src/components/portfolio/portfolio-sections.tsx");
  assert.ok(portfolio.includes("router.push('/ai')"));
  assert.equal(MENU_ENTRIES.find((entry) => entry.id === "ai")?.href, "/ai");
  const root = await read("src/app/_layout.tsx");
  assert.ok(root.includes('<Stack.Screen name="ai" />'));
});

test("the entries stay honest in production: each says 準備中 (the screen is not live)", async () => {
  const home = await read("src/components/home/home-ask-ai-entry.tsx");
  assert.ok(home.includes("AIに聞いてみる（準備中）") && home.includes("準備中"));
  const portfolio = await read("src/components/portfolio/portfolio-sections.tsx");
  assert.ok(portfolio.includes("AIに聞く（準備中）"));
  assert.ok(MENU_ENTRIES.find((entry) => entry.id === "ai")!.description.includes("準備中"));
});

test("the screen has no server path: no Supabase, no fetch, no function call, no navigation", async () => {
  const screen = await code("src/app/ai.tsx");
  assert.ok(!/supabase|fetch\(|functions\.invoke|XMLHttpRequest|WebSocket|router\./.test(screen));
  assert.ok(!/service_role|SERVICE_ROLE|OPENAI|ANTHROPIC|api[_-]?key/i.test(screen));
});

test("the offline mock is reachable only under __DEV__ (no static import, never in a production bundle path)", async () => {
  const screen = await code("src/app/ai.tsx");
  assert.ok(screen.includes("const mock = __DEV__ ? (require('@/lib/ai-ask-mock') as typeof import('@/lib/ai-ask-mock')) : null;"));
  assert.equal((screen.match(/ai-ask-mock/g) ?? []).length, 2, "named only in the guarded require and its type");
  assert.ok(!/^import .*ai-ask-mock/m.test(screen), "no static import of the mock");
  // outside the mock, the only possible answer is 'unavailable'
  assert.ok(screen.includes("mock ? await mock.mockAsk(request) : { status: 'failed', code: 'unavailable' }"));
  // nothing else in src imports the mock
  for (const path of ["src/components/ai-ask/answer-card.tsx", "src/lib/ai-ask.ts"]) {
    assert.ok(!(await code(path)).includes("ai-ask-mock"), path);
  }
});

test("production shows no input, example chips or send button: they sit only in the non-'unavailable' branch", async () => {
  const screen = await code("src/app/ai.tsx");
  const unavailable = screen.indexOf("availability === 'unavailable' ? (");
  const otherwise = screen.indexOf(") : (", unavailable);
  assert.ok(unavailable > 0 && otherwise > unavailable);
  const productionBranch = screen.slice(unavailable, otherwise);
  assert.ok(!/TextInput|Pressable|onPress|質問を送る/.test(productionBranch), "the unavailable branch is read-only text");
  const interactive = screen.slice(otherwise);
  for (const needle of ["<TextInput", "質問を送る", "...ASK_EXAMPLES", 'accessibilityLabel="AIへの質問"']) {
    assert.ok(interactive.includes(needle), needle);
  }
  // the development-only reproduction chips come from the mock module, never from the shared example list
  assert.ok(interactive.includes("...(mock ? mock.MOCK_EXAMPLES : [])"));
  assert.ok(screen.includes("ASK_SERVER_ENABLED") && screen.includes("askAvailability({ dev: __DEV__, serverEnabled: ASK_SERVER_ENABLED })"));
});

test("the mounted flag is re-armed on every mount, so a remount can never leave the screen stuck on 'sending'", async () => {
  const screen = await code("src/app/ai.tsx");
  assert.ok(/useEffect\(\(\) => \{\s*alive\.current = true;\s*return \(\) => \{ alive\.current = false; \};\s*\}, \[\]\);/.test(screen));
  assert.ok(!screen.includes("useEffect(() => () => { alive.current = false; }, []);"), "the cleanup-only form is gone");
  // a response is applied only while mounted, for the request it answers
  assert.ok(screen.includes("if (alive.current) dispatch({ type: 'receive'"));
});

test("sending is guarded: not while unavailable, invalid, unfilled, ticker-less or already sending", async () => {
  const screen = await code("src/app/ai.tsx");
  assert.ok(screen.includes("const sendable = canSend(availability) && check.ok && !unfilled && tickerOk && !sending;"));
  assert.ok(screen.includes("if (!sendable) return;"));
  assert.ok(screen.includes("disabled={!sendable}") && screen.includes("accessibilityState={{ disabled: !sendable }}"));
  // a retry resends the stored request (same id), and only after a failure
  assert.ok(screen.includes("if (state.phase !== 'failed' || !state.request) return;"));
  assert.ok(screen.includes("dispatch({ type: 'retry' });"));
});

test("every state is shown: sending, answer, refusal, failure with a retry for transient ones", async () => {
  const screen = await code("src/app/ai.tsx");
  assert.ok(screen.includes("回答を作っています"));
  assert.ok(screen.includes("state.phase === 'answered' && state.response ? <AnswerCard answer={state.response} />"));
  assert.ok(screen.includes("REFUSAL_MESSAGE_JA[state.refusal]"));
  assert.ok(screen.includes("FAILURE_MESSAGE_JA[state.failure]") && screen.includes("isRetryable(state.failure)"));
  assert.ok(screen.includes("もう一度試す"));
  assert.ok(screen.includes("maxLength={ASK_QUESTION_MAX_CHARS + 20}") && screen.includes("{Array.from(state.draft).length}/{ASK_QUESTION_MAX_CHARS}"));
});

test("an answer is always shown with its time, sources, holdings use and the caution", async () => {
  const card = await code("src/components/ai-ask/answer-card.tsx");
  for (const needle of ["dataAsOfLabel(answer.dataAsOf)", "asOfLabel(source.asOf)", "sourcesSummary(answer.sources)", "ASK_DISCLAIMER_JA", "answer.usedHoldings"]) {
    assert.ok(card.includes(needle), needle);
  }
  assert.ok(!/router\.|supabase|fetch\(/.test(card));
});

test("accessibility: header role, labelled controls, 44pt tap targets and a live region for problems/failures", async () => {
  const screen = await code("src/app/ai.tsx");
  assert.ok(screen.includes('accessibilityRole="header"'));
  assert.ok(screen.includes('accessibilityLiveRegion="polite"'));
  assert.ok(screen.includes('accessibilityHint="入力欄に例を入れます。まだ送信されません"'));
  assert.equal((screen.match(/minHeight: 44/g) ?? []).length >= 3, true, "chips, examples and retry meet 44pt");
  assert.ok(screen.includes("minHeight: 52"), "the send button");
});

test("the bottom tabs and root layout are untouched by this feature", async () => {
  const tabs = await read("src/app/(tabs)/_layout.tsx");
  const labels = [...tabs.matchAll(/<NativeTabs\.Trigger\.Label>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(labels, ["ホーム", "銘柄", "ニュース", "レポート", "メニュー"]);
  assert.ok(!/ai-ask|'\/ai'/.test(tabs));
});
