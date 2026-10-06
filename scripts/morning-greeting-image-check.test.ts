import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  formatMorningGreetingImageCheckFailure,
  MORNING_GREETING_IMAGE_CHECK_LIST_PAGE_SIZE,
  MorningGreetingImageCheckError,
  runMorningGreetingImageCheck,
} from "./morning-greeting-image-check.ts";
import { OPENAI_MORNING_GREETING_IMAGE_ENDPOINT } from
  "../supabase/functions/x-test-post/morning_greeting_image_logic.ts";

const SUPABASE_URL = "https://example.supabase.co";
const SERVICE_ROLE_KEY = "service-role-secret-do-not-log";
const ACTIVE_WINDOW = [{ is_active: true, start_time: "06:30:00", timezone: "Asia/Tokyo" }];

type Call = { url: URL; method: string; body: Record<string, unknown> | null };

function storageEntry(name: string, createdAt: string | null): Record<string, unknown> {
  return { name, id: crypto.randomUUID(), created_at: createdAt, updated_at: createdAt, metadata: {} };
}

// A read-only fake of the two endpoints the check may touch. Any other URL (OpenAI, Storage upload/
// download, X, scheduler) fails the test, which is how "the check never generates or writes" is proven.
function fakeSupabase(options: {
  windows?: unknown;
  windowStatus?: number;
  listPages?: unknown[];
  listStatus?: number;
  calls?: Call[];
}): typeof fetch {
  let listPage = 0;
  return async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    options.calls?.push({ url, method, body });
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.apikey, SERVICE_ROLE_KEY);
    assert.notEqual(String(input), OPENAI_MORNING_GREETING_IMAGE_ENDPOINT);
    assert.equal(headers["x-upsert"], undefined);
    if (url.pathname === "/rest/v1/posting_windows" && method === "GET") {
      return Response.json(options.windows ?? ACTIVE_WINDOW, { status: options.windowStatus ?? 200 });
    }
    if (url.pathname === "/storage/v1/object/list/morning-greeting-assets" && method === "POST") {
      if (options.listStatus) return new Response("error", { status: options.listStatus });
      const page = options.listPages?.[listPage] ?? [];
      listPage += 1;
      return Response.json(page);
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };
}

async function expectCheckError(
  promise: Promise<unknown>,
  code: string,
): Promise<MorningGreetingImageCheckError> {
  let caught: unknown;
  await assert.rejects(promise, (error: unknown) => {
    caught = error;
    return error instanceof MorningGreetingImageCheckError && error.message === code;
  });
  return caught as MorningGreetingImageCheckError;
}

test("image stored before the posting window opened passes, using only the two read endpoints", async () => {
  const calls: Call[] = [];
  const result = await runMorningGreetingImageCheck({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    date: "2026-09-17",
    fetchImpl: fakeSupabase({
      calls,
      // 2026-09-17 05:44 JST, the real on-time pattern before GitHub's scheduler started drifting.
      listPages: [[storageEntry("2026-09-17.png", "2026-09-16T20:44:01.123Z")]],
    }),
  });
  assert.deepEqual(result, {
    success: true,
    result: "on_time",
    date_jst: "2026-09-17",
    image_created_at: "2026-09-16T20:44:01.123Z",
    deadline: "2026-09-16T21:30:00.000Z",
  });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url.pathname}`), [
    "GET /rest/v1/posting_windows",
    "POST /storage/v1/object/list/morning-greeting-assets",
  ]);
  const windowQuery = calls[0].url.searchParams;
  assert.equal(windowQuery.get("brand_id"), "eq.kabumori");
  assert.equal(windowQuery.get("post_type"), "eq.morning_greeting");
  assert.equal(windowQuery.get("select"), "is_active,start_time,timezone");
  assert.deepEqual(calls[1].body, {
    prefix: "generated",
    search: "2026-09-17.png",
    limit: MORNING_GREETING_IMAGE_CHECK_LIST_PAGE_SIZE,
    offset: 0,
    sortBy: { column: "name", order: "asc" },
  });
});

test("missing image fails with MORNING_GREETING_IMAGE_MISSING and the window deadline", async () => {
  const error = await expectCheckError(
    runMorningGreetingImageCheck({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      date: "2026-10-07",
      fetchImpl: fakeSupabase({ listPages: [[]] }),
    }),
    "MORNING_GREETING_IMAGE_MISSING",
  );
  assert.equal(error.dateJst, "2026-10-07");
  assert.equal(error.deadline, "2026-10-06T21:30:00.000Z");
  assert.equal(error.imageCreatedAt, null);
});

// The failure this check exists for: on 2026-10-06 the image landed at 10:25 JST, after the 06:43 post.
// A check run that GitHub itself delays until after 10:25 must still fail, not see the image and pass.
test("image stored after the posting window opened fails with MORNING_GREETING_IMAGE_LATE, whenever the check runs", async () => {
  const error = await expectCheckError(
    runMorningGreetingImageCheck({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      date: "2026-10-06",
      fetchImpl: fakeSupabase({ listPages: [[storageEntry("2026-10-06.png", "2026-10-06T01:25:14.954+00:00")]] }),
    }),
    "MORNING_GREETING_IMAGE_LATE",
  );
  assert.equal(error.imageCreatedAt, "2026-10-06T01:25:14.954Z");
  assert.equal(error.deadline, "2026-10-05T21:30:00.000Z");
});

test("deadline boundary: stored exactly at the window start is late, 1 ms before is on time", async () => {
  await expectCheckError(
    runMorningGreetingImageCheck({
      supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, date: "2026-10-07",
      fetchImpl: fakeSupabase({ listPages: [[storageEntry("2026-10-07.png", "2026-10-06T21:30:00.000Z")]] }),
    }),
    "MORNING_GREETING_IMAGE_LATE",
  );
  const result = await runMorningGreetingImageCheck({
    supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, date: "2026-10-07",
    fetchImpl: fakeSupabase({ listPages: [[storageEntry("2026-10-07.png", "2026-10-06T21:29:59.999Z")]] }),
  });
  assert.equal(result.result, "on_time");
});

test("greeting turned off in admin: passes as disabled without reading Storage", async () => {
  const calls: Call[] = [];
  const result = await runMorningGreetingImageCheck({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    date: "2026-09-20",
    fetchImpl: fakeSupabase({
      calls,
      windows: [{ is_active: false, start_time: "06:30:00", timezone: "Asia/Tokyo" }],
    }),
  });
  assert.deepEqual(result, { success: true, result: "disabled", date_jst: "2026-09-20" });
  assert.equal(calls.length, 1);
});

test("scheduled run (blank target_date) checks the JST calendar date it runs on; explicit target_date wins", async () => {
  const calls: Call[] = [];
  const fetchImpl = fakeSupabase({
    calls,
    listPages: [
      [storageEntry("2026-10-07.png", "2026-10-06T15:19:00Z")],
      [storageEntry("2026-10-05.png", "2026-10-04T15:19:00Z")],
    ],
  });
  // 21:07 UTC on 10/6 = 06:07 JST on 10/7 (the primary check trigger).
  const scheduled = await runMorningGreetingImageCheck({
    supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, date: "",
    now: new Date("2026-10-06T21:07:00Z"), fetchImpl,
  });
  assert.equal(scheduled.date_jst, "2026-10-07");
  const manual = await runMorningGreetingImageCheck({
    supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, date: "2026-10-05",
    now: new Date("2026-10-06T21:07:00Z"), fetchImpl,
  });
  assert.equal(manual.date_jst, "2026-10-05");
  assert.deepEqual(calls.filter((call) => call.body).map((call) => call.body?.search), [
    "2026-10-07.png",
    "2026-10-05.png",
  ]);
});

test("invalid target_date is refused with a fixed code", async () => {
  await expectCheckError(
    runMorningGreetingImageCheck({
      supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, date: "2026-02-30",
      fetchImpl: fakeSupabase({}),
    }),
    "MORNING_GREETING_DATE_INVALID",
  );
});

test("only the exact file name counts: similar names in the listing do not satisfy the check", async () => {
  await expectCheckError(
    runMorningGreetingImageCheck({
      supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, date: "2026-10-07",
      fetchImpl: fakeSupabase({
        listPages: [[
          storageEntry("2026-10-07.png.bak", "2026-10-06T15:19:00Z"),
          storageEntry("2026-10-07-old.png", "2026-10-06T15:19:00Z"),
        ]],
      }),
    }),
    "MORNING_GREETING_IMAGE_MISSING",
  );
});

test("a full listing page is followed to the next page, so a server ignoring `search` cannot hide the image", async () => {
  const calls: Call[] = [];
  const fullPage = Array.from({ length: MORNING_GREETING_IMAGE_CHECK_LIST_PAGE_SIZE }, (_, index) =>
    storageEntry(`2026-0${index % 9 + 1}-01-${index}.png`, "2026-01-01T00:00:00Z")
  );
  const result = await runMorningGreetingImageCheck({
    supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, date: "2026-10-07",
    fetchImpl: fakeSupabase({ calls, listPages: [fullPage, [storageEntry("2026-10-07.png", "2026-10-06T15:19:00Z")]] }),
  });
  assert.equal(result.result, "on_time");
  assert.deepEqual(calls.filter((call) => call.body).map((call) => call.body?.offset), [0, 100]);
});

test("an endless listing fails closed instead of looping or passing", async () => {
  const fullPage = Array.from({ length: MORNING_GREETING_IMAGE_CHECK_LIST_PAGE_SIZE }, (_, index) =>
    storageEntry(`other-${index}.png`, "2026-01-01T00:00:00Z")
  );
  await expectCheckError(
    runMorningGreetingImageCheck({
      supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, date: "2026-10-07",
      fetchImpl: fakeSupabase({ listPages: Array.from({ length: 50 }, () => fullPage) }),
    }),
    "MORNING_GREETING_IMAGE_CHECK_LIST_TOO_LARGE",
  );
});

test("Storage read failures and unexpected shapes fail the check, never pass it", async () => {
  const base = { supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, date: "2026-10-07" };
  await expectCheckError(
    runMorningGreetingImageCheck({ ...base, fetchImpl: fakeSupabase({ listStatus: 500 }) }),
    "MORNING_GREETING_IMAGE_CHECK_READ_FAILED:500",
  );
  await expectCheckError(
    runMorningGreetingImageCheck({ ...base, fetchImpl: fakeSupabase({ listPages: [{ message: "not a list" }] }) }),
    "MORNING_GREETING_IMAGE_CHECK_RESPONSE_MALFORMED",
  );
  await expectCheckError(
    runMorningGreetingImageCheck({ ...base, fetchImpl: fakeSupabase({ listPages: [[storageEntry("2026-10-07.png", null)]] }) }),
    "MORNING_GREETING_IMAGE_CHECK_RESPONSE_MALFORMED",
  );
  await expectCheckError(
    runMorningGreetingImageCheck({
      ...base,
      fetchImpl: async (input, init) => {
        if (new URL(String(input)).pathname.startsWith("/storage/")) throw new Error(`down ${SERVICE_ROLE_KEY}`);
        return fakeSupabase({})(input, init);
      },
    }),
    "MORNING_GREETING_IMAGE_CHECK_READ_FAILED:network",
  );
});

test("posting window problems fail with fixed codes instead of guessing a deadline", async () => {
  const base = { supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, date: "2026-10-07" };
  await expectCheckError(
    runMorningGreetingImageCheck({ ...base, fetchImpl: fakeSupabase({ windows: [] }) }),
    "MORNING_GREETING_WINDOW_NOT_FOUND",
  );
  await expectCheckError(
    runMorningGreetingImageCheck({ ...base, fetchImpl: fakeSupabase({ windowStatus: 503 }) }),
    "MORNING_GREETING_WINDOW_READ_FAILED:503",
  );
  await expectCheckError(
    runMorningGreetingImageCheck({
      ...base,
      fetchImpl: fakeSupabase({
        windows: [
          { is_active: true, start_time: "06:30:00", timezone: "Asia/Tokyo" },
          { is_active: false, start_time: "06:30:00", timezone: "Asia/Tokyo" },
        ],
      }),
    }),
    "MORNING_GREETING_WINDOW_AMBIGUOUS",
  );
  for (const start_time of ["6:30", "25:00:00", null]) {
    await expectCheckError(
      runMorningGreetingImageCheck({
        ...base,
        fetchImpl: fakeSupabase({ windows: [{ is_active: true, start_time, timezone: "Asia/Tokyo" }] }),
      }),
      "MORNING_GREETING_WINDOW_RESPONSE_MALFORMED",
    );
  }
  await expectCheckError(
    runMorningGreetingImageCheck({
      ...base,
      fetchImpl: fakeSupabase({ windows: [{ is_active: true, start_time: "06:30:00", timezone: "UTC" }] }),
    }),
    "MORNING_GREETING_WINDOW_TIMEZONE_UNSUPPORTED",
  );
});

test("several window rows: the earliest start is the deadline", async () => {
  await expectCheckError(
    runMorningGreetingImageCheck({
      supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, date: "2026-10-07",
      fetchImpl: fakeSupabase({
        windows: [
          { is_active: true, start_time: "07:00:00", timezone: "Asia/Tokyo" },
          { is_active: true, start_time: "06:15:00", timezone: "Asia/Tokyo" },
        ],
        // 06:20 JST: before 07:00 but after 06:15.
        listPages: [[storageEntry("2026-10-07.png", "2026-10-06T21:20:00Z")]],
      }),
    }),
    "MORNING_GREETING_IMAGE_LATE",
  );
});

test("failure output is fixed text: code, date and timestamps only -- never the key, URL or an exception message", () => {
  const cases: unknown[] = [
    new MorningGreetingImageCheckError("MORNING_GREETING_IMAGE_MISSING", {
      dateJst: "2026-10-07", deadline: "2026-10-06T21:30:00.000Z",
    }),
    new MorningGreetingImageCheckError("MORNING_GREETING_IMAGE_LATE", {
      dateJst: "2026-10-06", imageCreatedAt: "2026-10-06T01:25:14.954Z", deadline: "2026-10-05T21:30:00.000Z",
    }),
    new Error(`fetch failed for ${SUPABASE_URL} with ${SERVICE_ROLE_KEY}`),
    `${SERVICE_ROLE_KEY}`,
  ];
  const outputs = cases.map((error) => formatMorningGreetingImageCheckFailure(error));
  for (const { annotation, json } of outputs) {
    assert.match(annotation, /^::error title=Morning greeting image check::MORNING_GREETING_[A-Z_]+/u);
    assert.doesNotMatch(annotation + json, new RegExp(`${SERVICE_ROLE_KEY}|example\\.supabase\\.co|fetch failed`, "u"));
  }
  assert.match(outputs[0].annotation, /gh workflow run morning-greeting-image\.yml -f target_date=2026-10-07/u);
  assert.match(outputs[1].annotation, /stored after the posting window opened/u);
  assert.deepEqual(JSON.parse(outputs[1].json), {
    success: false,
    error: "MORNING_GREETING_IMAGE_LATE",
    date_jst: "2026-10-06",
    image_created_at: "2026-10-06T01:25:14.954Z",
    deadline: "2026-10-05T21:30:00.000Z",
  });
  assert.equal(JSON.parse(outputs[2].json).error, "MORNING_GREETING_IMAGE_CHECK_UNEXPECTED");
});

// End to end through main(): a failing check must exit non-zero (that is what turns the GitHub run red
// and sends the failed-run notification) and must not print the key even when the request itself fails.
test("main() exits 1 with a GitHub error annotation and no secret in output", () => {
  const script = fileURLToPath(new URL("./morning-greeting-image-check.ts", import.meta.url));
  const missingEnv = spawnSync(process.execPath, ["--experimental-strip-types", script], {
    env: { PATH: process.env.PATH ?? "" },
    encoding: "utf8",
  });
  assert.equal(missingEnv.status, 1);
  assert.match(missingEnv.stdout, /::error title=Morning greeting image check::MORNING_GREETING_ENV_MISSING:SUPABASE_URL/u);

  // Port 9 on loopback refuses the connection: a real network failure without leaving this machine.
  const unreachable = spawnSync(process.execPath, ["--experimental-strip-types", script], {
    env: {
      PATH: process.env.PATH ?? "",
      SUPABASE_URL: "http://127.0.0.1:9",
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
      MORNING_GREETING_DATE: "2026-10-07",
    },
    encoding: "utf8",
  });
  assert.equal(unreachable.status, 1);
  assert.match(unreachable.stdout, /MORNING_GREETING_WINDOW_READ_FAILED:network \(date 2026-10-07\)/u);
  assert.doesNotMatch(unreachable.stdout + unreachable.stderr, new RegExp(`${SERVICE_ROLE_KEY}|127\\.0\\.0\\.1`, "u"));
});

function parseDailyCron(expression: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/u.exec(expression);
  assert.ok(match, `expected a daily "M H * * *" cron, got ${expression}`);
  return { minute: Number(match[1]), hour: Number(match[2]) };
}

test("check workflow: 06:07 JST primary between the last generation wake-up and the window, 09:47 JST backup, read-only secrets, own concurrency group", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/morning-greeting-image-check.yml", import.meta.url),
    "utf8",
  );
  const generator = await readFile(
    new URL("../.github/workflows/morning-greeting-image.yml", import.meta.url),
    "utf8",
  );
  const toJstMinutes = (expression: string) => {
    const { hour, minute } = parseDailyCron(expression);
    assert.ok(minute >= 5 && minute <= 55, `${expression} is too close to the top of the hour`);
    return ((hour + 9) % 24) * 60 + minute;
  };
  const checkMinutes = [...workflow.matchAll(/^\s*-\s*cron:\s*"([^"]+)"/gmu)].map((match) => toJstMinutes(match[1]));
  const generatorMinutes = [...generator.matchAll(/^\s*-\s*cron:\s*"([^"]+)"/gmu)].map((match) => toJstMinutes(match[1]));
  assert.deepEqual(checkMinutes, [6 * 60 + 7, 9 * 60 + 47]);
  assert.ok(checkMinutes[0] > Math.max(...generatorMinutes));
  assert.ok(checkMinutes[0] < 6 * 60 + 30);

  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /MORNING_GREETING_DATE: \$\{\{ inputs\.target_date \}\}/u);
  assert.match(workflow, /^permissions:\n\s+contents: read$/mu);
  assert.match(workflow, /^concurrency:\n\s+group: morning-greeting-image-check\n\s+cancel-in-progress: false$/mu);
  assert.match(workflow, /node --experimental-strip-types scripts\/morning-greeting-image-check\.ts/u);
  assert.deepEqual(
    [...workflow.matchAll(/\$\{\{ secrets\.([A-Z_]+) \}\}/gu)].map((match) => match[1]),
    ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
  );
  assert.doesNotMatch(workflow, /OPENAI|X_API|scheduled_posts|morning-greeting-image\.ts/u);
});
