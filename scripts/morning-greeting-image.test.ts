import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildMorningGreetingGeneratedPath,
  checkMorningGreetingEnabled,
  MorningGreetingEnablementCheckError,
  MorningGreetingImageWorkflowError,
  resolveJstDate,
  runMorningGreetingImageJob,
  runMorningGreetingImageWorkflow,
} from "./morning-greeting-image.ts";
import { OPENAI_MORNING_GREETING_IMAGE_ENDPOINT } from
  "../supabase/functions/x-test-post/morning_greeting_image_logic.ts";
import { selectMorningGreetingTheme } from
  "../supabase/functions/x-test-post/morning_greeting_logic.ts";

const SUPABASE_URL = "https://example.supabase.co";

function pngResponse(): Response {
  return new Response(new Uint8Array([137, 80, 78, 71]), {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}

test("successful run fetches canonical, calls image edit once, and stores generated date path", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await runMorningGreetingImageWorkflow({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: "service-role-test",
    openAiApiKey: "openai-test",
    date: "2026-09-01",
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (calls.length === 1) {
        assert.match(url, /generated\/2026-09-01\.png$/u);
        assert.equal(init?.method, undefined);
        return new Response("missing", { status: 404 });
      }
      if (url.endsWith("canonical/yume-reference.png")) return pngResponse();
      if (url === OPENAI_MORNING_GREETING_IMAGE_ENDPOINT) {
        const form = init?.body as FormData;
        assert.equal(form.get("model"), "gpt-image-2");
        assert.ok(form.get("image") instanceof Blob);
        assert.match(String(form.get("prompt")), /warm brown eyes/u);
        assert.match(String(form.get("prompt")), /softly wavy brown hair with side-parted bangs/u);
        assert.match(String(form.get("prompt")), /防災/u);
        return new Response(JSON.stringify({ data: [{ b64_json: "iVBORw==" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      assert.match(url, /generated\/2026-09-01\.png$/u);
      assert.doesNotMatch(url, /canonical\/yume-reference\.png$/u);
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string, string>)["x-upsert"], "false");
      return new Response("stored", { status: 200 });
    },
  });
  assert.equal(result.skipped, false);
  assert.equal(result.output_storage_path,
    "storage://morning-greeting-assets/generated/2026-09-01.png");
  assert.equal(result.image_api_called, 1);
  assert.equal(result.retry_count, 0);
  assert.equal(result.x_api_called, 0);
  assert.equal(result.scheduled_posts_changed, 0);
  assert.deepEqual(result.theme, selectMorningGreetingTheme("2026-09-01"));
  assert.equal(calls.filter((call) => call.url === OPENAI_MORNING_GREETING_IMAGE_ENDPOINT).length, 1);
});

test("2026-09-02 image workflow uses the same generic theme as greeting text", async () => {
  let imagePrompt = "";
  const expectedTheme = selectMorningGreetingTheme("2026-09-02");
  const result = await runMorningGreetingImageWorkflow({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: "service-role-test",
    openAiApiKey: "openai-test",
    date: "2026-09-02",
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith("generated/2026-09-02.png")) {
        if (init?.method === "POST") return new Response("stored", { status: 200 });
        return new Response("missing", { status: 404 });
      }
      if (url.endsWith("canonical/yume-reference.png")) return pngResponse();
      if (url === OPENAI_MORNING_GREETING_IMAGE_ENDPOINT) {
        imagePrompt = String((init?.body as FormData).get("prompt"));
        return new Response(JSON.stringify({ data: [{ b64_json: "iVBORw==" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected mock URL: ${url}`);
    },
  });

  assert.equal(expectedTheme.theme_type, "generic");
  assert.equal(expectedTheme.theme_name, null);
  assert.deepEqual(result.theme, expectedTheme);
  assert.match(imagePrompt, new RegExp(expectedTheme.visual_theme, "u"));
  assert.doesNotMatch(imagePrompt, /防災の日|preparedness backpack|stored water/u);
});

test("canonical fetch failure stops before image API and upload", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () => runMorningGreetingImageWorkflow({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: "service-role-test",
      openAiApiKey: "openai-test",
      date: "2026-09-01",
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        return new Response("missing", { status: 404 });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof MorningGreetingImageWorkflowError);
      assert.equal(error.imageApiCalled, 0);
      assert.match(error.message, /YUME_CANONICAL_REFERENCE_NOT_FOUND/u);
      return true;
    },
  );
  assert.equal(calls.length, 2);
});

test("existing same-day object skips generation and performs no write", async () => {
  const calls: string[] = [];
  const result = await runMorningGreetingImageWorkflow({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: "service-role-test",
    openAiApiKey: "openai-test",
    date: "2026-09-01",
    fetchImpl: async (input) => {
      calls.push(String(input));
      return new Response(new Uint8Array([137]), { status: 200 });
    },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.image_api_called, 0);
  assert.equal(calls.length, 1);
});

test("Supabase 400 Object not found is treated as a missing same-day object", async () => {
  const calls: string[] = [];
  const result = await runMorningGreetingImageWorkflow({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: "service-role-test",
    openAiApiKey: "openai-test",
    date: "2026-09-01",
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (calls.length === 1) {
        return new Response(JSON.stringify({
          statusCode: "404",
          error: "not_found",
          message: "Object not found",
        }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("canonical/yume-reference.png")) return pngResponse();
      if (url === OPENAI_MORNING_GREETING_IMAGE_ENDPOINT) {
        return new Response(JSON.stringify({ data: [{ b64_json: "iVBORw==" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      assert.equal(init?.method, "POST");
      return new Response("stored", { status: 200 });
    },
  });
  assert.equal(result.skipped, false);
  assert.equal(result.image_api_called, 1);
  assert.equal(result.retry_count, 0);
  assert.equal(calls.filter((url) => url === OPENAI_MORNING_GREETING_IMAGE_ENDPOINT).length, 1);
});

test("unrelated Supabase 400 error stops safely before image generation", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () => runMorningGreetingImageWorkflow({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: "service-role-test",
      openAiApiKey: "openai-test",
      date: "2026-09-01",
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ message: "Invalid request" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof MorningGreetingImageWorkflowError);
      assert.equal(error.imageApiCalled, 0);
      assert.match(error.message, /OUTPUT_EXISTENCE_CHECK_FAILED:400/u);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("OpenAI failure is not retried and output is not uploaded", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () => runMorningGreetingImageWorkflow({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: "service-role-test",
      openAiApiKey: "openai-test",
      date: "2026-09-01",
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        if (calls.length === 1) return new Response("missing", { status: 404 });
        if (url.endsWith("canonical/yume-reference.png")) return pngResponse();
        return new Response("failed", { status: 500 });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof MorningGreetingImageWorkflowError);
      assert.equal(error.imageApiCalled, 1);
      assert.match(error.message, /OPENAI_FAILED:500/u);
      return true;
    },
  );
  assert.equal(calls.filter((url) => url === OPENAI_MORNING_GREETING_IMAGE_ENDPOINT).length, 1);
  assert.equal(calls.length, 3);
});

test("generated path is date-scoped and cannot overwrite canonical", () => {
  assert.equal(buildMorningGreetingGeneratedPath("2026-09-01"), "generated/2026-09-01.png");
  assert.throws(() => buildMorningGreetingGeneratedPath("2026-02-30"), /DATE_INVALID/u);
  assert.notEqual(buildMorningGreetingGeneratedPath("2026-09-01"), "canonical/yume-reference.png");
});

test("default date uses Asia Tokyo calendar date", () => {
  assert.equal(resolveJstDate(new Date("2026-08-31T23:30:00Z")), "2026-09-01");
});

async function workflowCronExpressions(file: string): Promise<string[]> {
  const workflow = await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
  return [...workflow.matchAll(/^\s*-\s*cron:\s*"([^"]+)"/gmu)].map((match) => match[1]);
}

// Daily "M H * * *" only; returns the UTC hour/minute it fires at.
function parseDailyCron(expression: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/u.exec(expression);
  assert.ok(match, `expected a daily "M H * * *" cron, got ${expression}`);
  return { minute: Number(match[1]), hour: Number(match[2]) };
}

const EARLIEST_POSTING_WINDOW_START_JST_MINUTES = 6 * 60 + 30; // posting_windows morning_greeting 06:30 JST

// Every scheduled wake-up fires on UTC day D-1 for JST posting day D. resolveJstDate() must land on D --
// not the UTC date the cron fired on -- both on time and when GitHub delays the run by hours, or the run
// would generate the wrong day's image.
test("generator schedule: >= 4 off-the-hour wake-ups, all after JST midnight and the last >= 60 min before the window, each resolving to the posting day even when delayed", async () => {
  const crons = await workflowCronExpressions("morning-greeting-image.yml");
  assert.deepEqual(crons, ["17 15 * * *", "47 17 * * *", "17 19 * * *", "17 20 * * *"]);
  assert.ok(crons.length >= 4);

  const jstMinutes = crons.map((expression) => {
    const { hour, minute } = parseDailyCron(expression);
    assert.ok(minute >= 5 && minute <= 55, `${expression} is too close to the top of the hour`);
    return ((hour + 9) % 24) * 60 + minute;
  });
  assert.deepEqual(jstMinutes, [17, 2 * 60 + 47, 4 * 60 + 17, 5 * 60 + 17]);
  assert.ok(Math.max(...jstMinutes) <= EARLIEST_POSTING_WINDOW_START_JST_MINUTES - 60);

  for (const expression of crons) {
    const { hour, minute } = parseDailyCron(expression);
    const firedAt = new Date(Date.UTC(2026, 9, 6, hour, minute));
    assert.equal(resolveJstDate(firedAt), "2026-10-07", `${expression} on time`);
    for (const delayHours of [1, 5, 9]) {
      const delayed = new Date(firedAt.getTime() + delayHours * 3_600_000);
      assert.equal(resolveJstDate(delayed), "2026-10-07", `${expression} delayed ${delayHours}h`);
    }
  }
});

test("each wake-up maps to the documented JST time (UTC+9, next calendar day)", () => {
  assert.equal(resolveJstDate(new Date("2026-10-06T15:17:00Z")), "2026-10-07"); // 00:17 JST
  assert.equal(resolveJstDate(new Date("2026-10-06T17:47:00Z")), "2026-10-07"); // 02:47 JST
  assert.equal(resolveJstDate(new Date("2026-10-06T19:17:00Z")), "2026-10-07"); // 04:17 JST
  assert.equal(resolveJstDate(new Date("2026-10-06T20:17:00Z")), "2026-10-07"); // 05:17 JST
});

// Several wake-ups per day must cost at most one OpenAI image call per JST date: the first run that finds
// no stored image generates and uploads it (x-upsert false); every later run that day sees it and skips.
test("idempotent across wake-ups: repeated runs for the same JST date call OpenAI once and upload once", async () => {
  const stored = new Set<string>();
  let openAiCalls = 0;
  let uploads = 0;
  const fakeSupabaseAndOpenAi: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === OPENAI_MORNING_GREETING_IMAGE_ENDPOINT) {
      openAiCalls += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: "iVBORw==" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("canonical/yume-reference.png")) return pngResponse();
    const generated = /generated\/(\d{4}-\d{2}-\d{2})\.png$/u.exec(url)?.[1];
    assert.ok(generated, `unexpected mock URL: ${url}`);
    if (init?.method === "POST") {
      assert.equal((init.headers as Record<string, string>)["x-upsert"], "false");
      if (stored.has(generated)) return new Response("Duplicate", { status: 409 });
      stored.add(generated);
      uploads += 1;
      return new Response("stored", { status: 200 });
    }
    return stored.has(generated)
      ? new Response(new Uint8Array([137]), { status: 206 })
      : new Response("missing", { status: 404 });
  };

  const results = [];
  for (let wakeUp = 0; wakeUp < 4; wakeUp += 1) {
    results.push(await runMorningGreetingImageWorkflow({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: "service-role-test",
      openAiApiKey: "openai-test",
      date: "",
      fetchImpl: fakeSupabaseAndOpenAi,
    }));
  }
  assert.deepEqual(results.map((result) => result.skipped), [false, true, true, true]);
  assert.deepEqual(results.map((result) => result.image_api_called), [1, 0, 0, 0]);
  assert.equal(openAiCalls, 1);
  assert.equal(uploads, 1);
  assert.deepEqual([...stored], [resolveJstDate()]);

  // An explicit target_date (the manual workflow_dispatch fallback) is generated independently of today.
  const manual = await runMorningGreetingImageWorkflow({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: "service-role-test",
    openAiApiKey: "openai-test",
    date: "2026-10-07",
    fetchImpl: fakeSupabaseAndOpenAi,
  });
  assert.equal(manual.output_storage_path, "storage://morning-greeting-assets/generated/2026-10-07.png");
  assert.ok(stored.has("2026-10-07"));
});

test("a JST date just before midnight and just after are on opposite sides of the UTC/JST boundary", () => {
  // 2026-09-05T14:59:59Z = 2026-09-05T23:59:59+09:00 (still 9/5 JST)
  assert.equal(resolveJstDate(new Date("2026-09-05T14:59:59Z")), "2026-09-05");
  // 2026-09-05T15:00:00Z = 2026-09-06T00:00:00+09:00 (now 9/6 JST)
  assert.equal(resolveJstDate(new Date("2026-09-05T15:00:00Z")), "2026-09-06");
});

test("workflow keeps workflow_dispatch (with target_date) and the serializing concurrency group, with staggered daily schedules, injecting only the required secrets", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/morning-greeting-image.yml", import.meta.url),
    "utf8",
  );
  // workflow_dispatch must still exist, unchanged, with its target_date input intact.
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /target_date:/u);
  assert.match(workflow, /MORNING_GREETING_DATE: \$\{\{ inputs\.target_date \}\}/u);
  // Scheduled wake-ups (exact set and JST mapping: see the generator schedule test above).
  assert.match(workflow, /^\s*schedule:/mu);
  assert.doesNotMatch(workflow, /cron:\s*"30 20 \* \* \*"/u);
  assert.match(workflow, /^concurrency:\n\s+group: morning-greeting-image\n\s+cancel-in-progress: false$/mu);
  assert.match(workflow, /OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/u);
  assert.match(workflow, /SUPABASE_URL: \$\{\{ secrets\.SUPABASE_URL \}\}/u);
  assert.match(workflow, /SUPABASE_SERVICE_ROLE_KEY: \$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}/u);
  assert.match(workflow, /timeout-minutes: 30/u);
  assert.match(workflow, /node --experimental-strip-types scripts\/morning-greeting-image\.ts/u);
  assert.doesNotMatch(workflow, /X_API|scheduled_posts|dispatcher/u);
});

test("an empty target_date input (as GitHub Actions passes for a schedule-triggered run) falls back to resolveJstDate, not a literal empty date", async () => {
  const calls: string[] = [];
  const result = await runMorningGreetingImageWorkflow({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: "service-role-test",
    openAiApiKey: "openai-test",
    date: "",
    fetchImpl: async (input) => {
      calls.push(String(input));
      return new Response(new Uint8Array([137]), { status: 200 });
    },
  });
  assert.equal(result.skipped, true);
  assert.ok(calls[0].includes(`generated/${resolveJstDate()}.png`));
});

function postingWindowsResponse(rows: Array<{ is_active: unknown }>): Response {
  return Response.json(rows);
}

test("checkMorningGreetingEnabled: a single active Kabumori morning_greeting row resolves enabled=true", async () => {
  let capturedUrl = "";
  const result = await checkMorningGreetingEnabled({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: "service-role-test",
    fetchImpl: async (input) => {
      capturedUrl = String(input);
      return postingWindowsResponse([{ is_active: true }]);
    },
  });
  assert.deepEqual(result, { enabled: true });
  const url = new URL(capturedUrl);
  assert.equal(url.pathname, "/rest/v1/posting_windows");
  assert.equal(url.searchParams.get("brand_id"), "eq.kabumori");
  assert.equal(url.searchParams.get("post_type"), "eq.morning_greeting");
  assert.equal(url.searchParams.get("select"), "is_active");
});

test("checkMorningGreetingEnabled: a single disabled Kabumori morning_greeting row resolves enabled=false", async () => {
  const result = await checkMorningGreetingEnabled({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: "service-role-test",
    fetchImpl: async () => postingWindowsResponse([{ is_active: false }]),
  });
  assert.deepEqual(result, { enabled: false });
});

test("checkMorningGreetingEnabled: a missing row (empty result) is unknown enablement, not a safe default -- throws rather than skipping or generating", async () => {
  await assert.rejects(
    () => checkMorningGreetingEnabled({
      supabaseUrl: SUPABASE_URL, serviceRoleKey: "k",
      fetchImpl: async () => postingWindowsResponse([]),
    }),
    (error: unknown) =>
      error instanceof MorningGreetingEnablementCheckError &&
      error.message === "MORNING_GREETING_ENABLEMENT_SETTING_NOT_FOUND",
  );
});

test("checkMorningGreetingEnabled: a non-2xx Supabase response throws a read-failed error", async () => {
  await assert.rejects(
    () => checkMorningGreetingEnabled({
      supabaseUrl: SUPABASE_URL, serviceRoleKey: "k",
      fetchImpl: async () => new Response("error", { status: 500 }),
    }),
    (error: unknown) =>
      error instanceof MorningGreetingEnablementCheckError &&
      error.message === "MORNING_GREETING_ENABLEMENT_READ_FAILED:500",
  );
});

test("checkMorningGreetingEnabled: a network failure throws a read-failed error", async () => {
  await assert.rejects(
    () => checkMorningGreetingEnabled({
      supabaseUrl: SUPABASE_URL, serviceRoleKey: "k",
      fetchImpl: async () => { throw new Error("network down"); },
    }),
    (error: unknown) =>
      error instanceof MorningGreetingEnablementCheckError &&
      error.message.startsWith("MORNING_GREETING_ENABLEMENT_READ_FAILED:"),
  );
});

test("checkMorningGreetingEnabled: a malformed response body (not JSON, or is_active not boolean) throws a malformed error", async () => {
  await assert.rejects(
    () => checkMorningGreetingEnabled({
      supabaseUrl: SUPABASE_URL, serviceRoleKey: "k",
      fetchImpl: async () => new Response("not json", { status: 200 }),
    }),
    (error: unknown) =>
      error instanceof MorningGreetingEnablementCheckError &&
      error.message === "MORNING_GREETING_ENABLEMENT_RESPONSE_MALFORMED",
  );
  await assert.rejects(
    () => checkMorningGreetingEnabled({
      supabaseUrl: SUPABASE_URL, serviceRoleKey: "k",
      fetchImpl: async () => postingWindowsResponse([{ is_active: "yes" }]),
    }),
    (error: unknown) =>
      error instanceof MorningGreetingEnablementCheckError &&
      error.message === "MORNING_GREETING_ENABLEMENT_RESPONSE_MALFORMED",
  );
});

test("checkMorningGreetingEnabled: an unrelated brand's row being active, while Kabumori's is disabled, must not affect the decision -- the query itself is scoped to brand_id=kabumori", async () => {
  // A correctly-filtering REST layer would never actually return another brand's row here; this proves
  // the query params sent are scoped so that could never happen, and that only the Kabumori row's value
  // (false) drives the result.
  const result = await checkMorningGreetingEnabled({
    supabaseUrl: SUPABASE_URL, serviceRoleKey: "k",
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get("brand_id"), "eq.kabumori");
      return postingWindowsResponse([{ is_active: false }]);
    },
  });
  assert.deepEqual(result, { enabled: false });
});

test("checkMorningGreetingEnabled: an unrelated post_type being active must not affect the decision -- the query itself is scoped to post_type=morning_greeting", async () => {
  const result = await checkMorningGreetingEnabled({
    supabaseUrl: SUPABASE_URL, serviceRoleKey: "k",
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get("post_type"), "eq.morning_greeting");
      return postingWindowsResponse([{ is_active: true }]);
    },
  });
  assert.deepEqual(result, { enabled: true });
});

test("checkMorningGreetingEnabled: multiple rows that agree resolve to that value, without inventing a majority/priority rule", async () => {
  const result = await checkMorningGreetingEnabled({
    supabaseUrl: SUPABASE_URL, serviceRoleKey: "k",
    fetchImpl: async () => postingWindowsResponse([{ is_active: true }, { is_active: true }]),
  });
  assert.deepEqual(result, { enabled: true });
});

test("main() calls the gated job (runMorningGreetingImageJob), never the raw generation workflow directly -- the gate cannot be bypassed by a future edit that skips it", async () => {
  const source = await readFile(new URL("./morning-greeting-image.ts", import.meta.url), "utf8");
  const mainBody = source.slice(source.indexOf("async function main("));
  assert.match(mainBody, /runMorningGreetingImageJob\(/u);
  assert.doesNotMatch(mainBody, /runMorningGreetingImageWorkflow\(/u);
});

test("runMorningGreetingImageJob: cost-safety invariant -- when disabled, zero network calls are made at all (OpenAI image call count = 0, Storage write count = 0), for a scheduled run and an explicit target_date alike", async () => {
  for (const date of [undefined, "2026-09-01"]) {
    let networkCalls = 0;
    const result = await runMorningGreetingImageJob({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: "service-role-test",
      openAiApiKey: "openai-test",
      date,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/v1/posting_windows") return postingWindowsResponse([{ is_active: false }]);
        networkCalls += 1;
        throw new Error(`unexpected network call after a disabled result: ${url}`);
      },
    });
    assert.deepEqual(result, { success: true, skipped: true, reason: "disabled", image_api_called: 0 });
    assert.equal(networkCalls, 0, `no OpenAI/Storage call may happen when disabled (date=${date})`);
  }
});

test("runMorningGreetingImageJob: when enabled, behaves exactly like the existing generation workflow (one enablement read, then unchanged ON-path behavior)", async () => {
  let enablementReads = 0;
  const result = await runMorningGreetingImageJob({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: "service-role-test",
    openAiApiKey: "openai-test",
    date: "2026-09-01",
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/rest/v1/posting_windows") {
        enablementReads += 1;
        return postingWindowsResponse([{ is_active: true }]);
      }
      if (url.pathname.endsWith("generated/2026-09-01.png") && init?.method !== "POST") {
        return new Response("missing", { status: 404 });
      }
      if (url.pathname.endsWith("canonical/yume-reference.png")) return pngResponse();
      if (String(input) === OPENAI_MORNING_GREETING_IMAGE_ENDPOINT) {
        return new Response(JSON.stringify({ data: [{ b64_json: "iVBORw==" }] }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response("stored", { status: 200 });
    },
  });
  assert.equal(enablementReads, 1);
  assert.equal(result.skipped, false);
  assert.equal(result.image_api_called, 1);
});

test("checkMorningGreetingEnabled: multiple rows that disagree are ambiguous -- throws rather than guessing", async () => {
  await assert.rejects(
    () => checkMorningGreetingEnabled({
      supabaseUrl: SUPABASE_URL, serviceRoleKey: "k",
      fetchImpl: async () => postingWindowsResponse([{ is_active: true }, { is_active: false }]),
    }),
    (error: unknown) =>
      error instanceof MorningGreetingEnablementCheckError &&
      error.message === "MORNING_GREETING_ENABLEMENT_AMBIGUOUS",
  );
});
