import assert from "node:assert/strict";
import test from "node:test";
import {
  handlePublishSetting,
  MAX_BODY_BYTES,
  parsePublishSettingBody,
  parsePublishSettingText,
  type PublishSettingDecision,
  type PublishSettingDeps,
  type PublishSettingRequest,
} from "./logic.ts";

const USER = "user-1";
const TOKEN = "caller-jwt-secret-value";

type Harness = {
  deps: PublishSettingDeps;
  calls: string[];
  decided: Array<{ token: string; request: PublishSettingRequest }>;
};

/** `decision` is what the database function answers; a function sees the request. */
function harness(decision: PublishSettingDecision | ((request: PublishSettingRequest) => PublishSettingDecision)): Harness {
  const calls: string[] = [];
  const decided: Harness["decided"] = [];
  return {
    calls,
    decided,
    deps: {
      getUser(token) {
        calls.push("getUser");
        return Promise.resolve(token === TOKEN ? { id: USER } : null);
      },
      decide(token, request) {
        calls.push("decide");
        decided.push({ token, request });
        return Promise.resolve(typeof decision === "function" ? decision(request) : decision);
      },
    },
  };
}

function request(body: unknown, init: { method?: string; token?: string | null; contentType?: string; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": init.contentType ?? "application/json", ...(init.headers ?? {}) };
  if (init.token !== null) headers.Authorization = `Bearer ${init.token ?? TOKEN}`;
  return new Request("https://example.test/functions/v1/social-mobile-publish-setting", {
    method: init.method ?? "POST",
    headers,
    body: init.method === "GET" || init.method === "OPTIONS" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const toggle = (desired: boolean, expected: boolean, id = "acct-1") => ({
  social_account_id: id,
  desired_enabled: desired,
  expected_current_enabled: expected,
});

async function run(h: Harness, req: Request) {
  const response = await handlePublishSetting(req, h.deps);
  return { status: response.status, body: await response.json().catch(() => null) as Record<string, unknown> | null };
}

const UPDATED_ON: PublishSettingDecision = { status: "updated", publishEnabled: true };

// --- authentication / request validation ---------------------------------------------------------

test("unauthenticated requests are rejected before the database is asked anything", async () => {
  for (const token of [null, "", "not-a-known-token"]) {
    const h = harness(UPDATED_ON);
    const { status, body } = await run(h, request(toggle(true, false), { token }));
    assert.equal(status, 401, String(token));
    assert.equal(body?.error, "AUTH_REQUIRED");
    assert.ok(!h.calls.includes("decide"));
  }
});

test("only POST (and CORS preflight) is accepted", async () => {
  const h = harness(UPDATED_ON);
  assert.equal((await run(h, request(null, { method: "GET" }))).status, 405);
  assert.equal((await run(h, request(null, { method: "PUT" }))).status, 405);
  const preflight = await handlePublishSetting(request(null, { method: "OPTIONS", token: null }), h.deps);
  assert.equal(preflight.status, 204);
  assert.equal(h.calls.length, 0);
});

test("body validation: content type, JSON, exact three fields with exact types, no client brand or user id", async () => {
  const bad: unknown[] = [
    "not json",
    "",
    [],
    null,
    {},
    { social_account_id: "acct-1", desired_enabled: true },
    { ...toggle(true, false), brand_id: "brand-a" },
    { ...toggle(true, false), user_id: USER },
    { ...toggle(true, false), extra: 1 },
    { ...toggle(true, false), social_account_id: 5 },
    { ...toggle(true, false), social_account_id: "" },
    { ...toggle(true, false), social_account_id: "a/b" },
    { ...toggle(true, false), social_account_id: "x".repeat(101) },
    { ...toggle(true, false), desired_enabled: "true" },
    { ...toggle(true, false), expected_current_enabled: 0 },
    { ...toggle(true, false), expected_current_enabled: null },
  ];
  for (const body of bad) {
    const h = harness(UPDATED_ON);
    const { status, body: out } = await run(h, request(body));
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(out?.error, "REQUEST_INVALID");
    assert.ok(!h.calls.includes("decide"), JSON.stringify(body));
  }
  const h = harness(UPDATED_ON);
  assert.equal((await run(h, request(toggle(true, false), { contentType: "text/plain" }))).status, 400);
  assert.equal(h.decided.length, 0);
  assert.equal(parsePublishSettingBody(toggle(true, false)).socialAccountId, "acct-1");
});

test("raw JSON must be unambiguous: duplicate keys (in any spelling) and escapes are rejected, not last-wins", async () => {
  const ambiguous = [
    // JSON.parse would keep the LAST value: OFF then ON.
    '{"social_account_id":"acct-1","desired_enabled":false,"desired_enabled":true,"expected_current_enabled":false}',
    '{"social_account_id":"acct-1","desired_enabled":true,"expected_current_enabled":true,"expected_current_enabled":false}',
    '{"social_account_id":"other","social_account_id":"acct-1","desired_enabled":true,"expected_current_enabled":false}',
    // The same key spelled with an escape parses to the same property.
    '{"social_account_id":"acct-1","desired_enabled":false,"desired_enabl\\u0065d":true,"expected_current_enabled":false}',
    '{"social_account_id":"acct\\u002d1","desired_enabled":true,"expected_current_enabled":false}',
  ];
  for (const text of ambiguous) {
    assert.throws(() => parsePublishSettingText(text), /REQUEST_INVALID/u, text);
    const h = harness(UPDATED_ON);
    const { status } = await run(h, request(text));
    assert.equal(status, 400, text);
    assert.equal(h.decided.length, 0, text);
  }
  // Whitespace and key order are free.
  const spaced = '\n { "expected_current_enabled" : false ,\t"desired_enabled": true, "social_account_id" : "acct-1" } ';
  assert.deepEqual(parsePublishSettingText(spaced), { socialAccountId: "acct-1", desiredEnabled: true, expectedCurrentEnabled: false });
});

test("the body is capped in BYTES while it is read: an oversized stream is cancelled, not buffered", async () => {
  // Declared too long: refused before reading.
  const declared = harness(UPDATED_ON);
  const tooLong = await run(declared, request(toggle(true, false), { headers: { "Content-Length": String(MAX_BODY_BYTES + 1) } }));
  assert.equal(tooLong.status, 400);
  // No declared length: the stream is stopped as soon as the cap is crossed.
  let pulled = 0;
  let cancelled = false;
  const chunk = new TextEncoder().encode(" ".repeat(200));
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      if (pulled > 1000) controller.close();
      else controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  const h = harness(UPDATED_ON);
  const streamed = await handlePublishSetting(
    new Request("https://example.test/f", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: stream,
      // @ts-ignore Deno/undici need this for a streaming request body.
      duplex: "half",
    }),
    h.deps,
  );
  assert.equal(streamed.status, 400);
  assert.equal(cancelled, true, "the body stream was cancelled");
  assert.ok(pulled <= Math.ceil(MAX_BODY_BYTES / chunk.byteLength) + 2, `read ${pulled} chunks`);
  assert.equal(h.decided.length, 0);
  // Multi-byte characters count as bytes, not characters.
  const wide = harness(UPDATED_ON);
  const multibyte = await run(wide, request(JSON.stringify(toggle(true, false)) + "　".repeat(MAX_BODY_BYTES / 2)));
  assert.equal(multibyte.status, 400);
  // Invalid UTF-8 is refused.
  const broken = await handlePublishSetting(
    new Request("https://example.test/f", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
    }),
    harness(UPDATED_ON).deps,
  );
  assert.equal(broken.status, 400);
});

// --- one decision, made by the database for the caller's own token ---------------------------------

test("exactly one decision call, with the caller's token and the three request fields, and nothing read afterwards", async () => {
  const h = harness(UPDATED_ON);
  const { status, body } = await run(h, request(toggle(true, false)));
  assert.equal(status, 200);
  assert.deepEqual(body, { success: true, status: "updated", account: { id: "acct-1", publish_enabled: true } });
  assert.deepEqual(h.calls, ["getUser", "decide"]);
  assert.deepEqual(h.decided, [{
    token: TOKEN,
    request: { socialAccountId: "acct-1", desiredEnabled: true, expectedCurrentEnabled: false },
  }]);
});

test("the dependency surface has no privileged read or write this function could decide on by itself", () => {
  const h = harness(UPDATED_ON);
  assert.deepEqual(Object.keys(h.deps).sort(), ["decide", "getUser"]);
});

const MAPPING: Array<[PublishSettingDecision, number, Record<string, unknown>]> = [
  [{ status: "updated", publishEnabled: true }, 200, { success: true, status: "updated", account: { id: "acct-1", publish_enabled: true } }],
  [{ status: "unchanged", publishEnabled: true }, 200, { success: true, status: "unchanged", account: { id: "acct-1", publish_enabled: true } }],
  [{ status: "not_found" }, 404, { success: false, error: "ACCOUNT_NOT_FOUND" }],
  [{ status: "forbidden" }, 403, { success: false, error: "PUBLISH_CONTROL_FORBIDDEN" }],
  [{ status: "busy" }, 409, { success: false, error: "ACCOUNT_BUSY" }],
  [{ status: "auth_required" }, 401, { success: false, error: "AUTH_REQUIRED" }],
  [{ status: "invalid" }, 400, { success: false, error: "REQUEST_INVALID" }],
  [{ status: "blocked", reason: "PLATFORM_NOT_SUPPORTED" }, 409, { success: false, error: "PLATFORM_NOT_SUPPORTED" }],
  [{ status: "blocked", reason: "BRAND_INACTIVE" }, 409, { success: false, error: "BRAND_INACTIVE" }],
  [{ status: "blocked", reason: "BRAND_PUBLISHING_NOT_LIVE" }, 409, { success: false, error: "BRAND_PUBLISHING_NOT_LIVE" }],
  [{ status: "blocked", reason: "CONNECTION_NOT_VERIFIED" }, 409, { success: false, error: "CONNECTION_NOT_VERIFIED", reconnect_recommended: true }],
  [{ status: "blocked", reason: "CONNECTION_DEGRADED" }, 409, { success: false, error: "CONNECTION_DEGRADED", reconnect_recommended: true }],
  [{ status: "blocked", reason: "CREDENTIALS_MISSING" }, 409, { success: false, error: "CREDENTIALS_MISSING", reconnect_recommended: true }],
  [{ status: "blocked", reason: "CREDENTIALS_INVALID" }, 409, { success: false, error: "CREDENTIALS_INVALID", reconnect_recommended: true }],
];

test("every database answer maps to one bounded response for an ON request", async () => {
  for (const [decision, expectedStatus, expectedBody] of MAPPING) {
    const h = harness(decision);
    // "unchanged" for an ON request means it was already ON and the caller expected ON.
    const req = decision.status === "unchanged" ? toggle(true, true) : toggle(true, false);
    const { status, body } = await run(h, request(req));
    assert.equal(status, expectedStatus, JSON.stringify(decision));
    assert.deepEqual(body, expectedBody, JSON.stringify(decision));
    assert.equal(h.decided.length, 1);
  }
});

test("a missing account and a foreign account are the same response (the database answers not_found for both)", async () => {
  const a = await run(harness({ status: "not_found" }), request(toggle(true, false, "does-not-exist")));
  const b = await run(harness({ status: "not_found" }), request(toggle(false, true, "someone-elses")));
  assert.deepEqual(a, b);
  assert.deepEqual(a.body, { success: false, error: "ACCOUNT_NOT_FOUND" });
});

test("stale: the real state is reported only from the database's own (authorized) answer", async () => {
  const h = harness({ status: "stale", publishEnabled: true });
  const { status, body } = await run(h, request(toggle(true, false)));
  assert.equal(status, 409);
  assert.deepEqual(body, { success: false, error: "STALE_STATE", current_enabled: true });
});

test("success is never reported for a value the database did not confirm", async () => {
  // "updated" but with the opposite value, "unchanged" with a value that is not the requested one,
  // and "stale" that claims the expected value: all inconsistent, all unavailable.
  const cases: Array<[PublishSettingDecision, ReturnType<typeof toggle>]> = [
    [{ status: "updated", publishEnabled: false }, toggle(true, false)],
    [{ status: "unchanged", publishEnabled: false }, toggle(true, true)],
    [{ status: "updated", publishEnabled: true }, toggle(false, true)],
    [{ status: "stale", publishEnabled: false }, toggle(true, false)],
  ];
  for (const [decision, body] of cases) {
    const out = await run(harness(decision), request(body));
    assert.equal(out.status, 503, JSON.stringify(decision));
    assert.deepEqual(out.body, { success: false, error: "PUBLISH_SETTING_UNAVAILABLE" });
  }
});

test("an unknown database answer is unavailable, never success", async () => {
  const h = harness({ status: "something_new" } as unknown as PublishSettingDecision);
  const out = await run(h, request(toggle(true, false)));
  assert.equal(out.status, 503);
});

test("OFF: the same single decision call; the response confirms OFF", async () => {
  const h = harness({ status: "updated", publishEnabled: false });
  const { status, body } = await run(h, request(toggle(false, true)));
  assert.equal(status, 200);
  assert.deepEqual(body, { success: true, status: "updated", account: { id: "acct-1", publish_enabled: false } });
  assert.deepEqual(h.decided[0].request, { socialAccountId: "acct-1", desiredEnabled: false, expectedCurrentEnabled: true });
});

test("unexpected dependency failures become a bounded unavailable error with no internals", async () => {
  const h = harness(UPDATED_ON);
  h.deps.decide = () => Promise.reject(new Error("db host 10.0.0.1 password=hunter2"));
  const res = await handlePublishSetting(request(toggle(true, false)), h.deps);
  assert.equal(res.status, 503);
  const text = JSON.stringify(await res.json());
  assert.equal(text, JSON.stringify({ success: false, error: "PUBLISH_SETTING_UNAVAILABLE" }));
  assert.doesNotMatch(text, /hunter2|10\.0\.0\.1/u);
});

test("responses never echo the caller's token, and CORS headers allow only the needed methods", async () => {
  for (const [decision] of MAPPING) {
    const res = await handlePublishSetting(request(toggle(true, false)), harness(decision).deps);
    assert.doesNotMatch(JSON.stringify(await res.json()), /caller-jwt-secret-value|user-1/u);
    assert.equal(res.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
  }
});
