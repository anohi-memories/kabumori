// Mocked fetch/begin callbacks are async by contract even when they do not await.
// deno-lint-ignore-file require-await
import assert from "node:assert/strict";
import test from "node:test";
import { XAccountCredential } from "./x_v2_claim_credentials.ts";
import {
  createV2StepLedgerClient,
  nextGreetingAction,
  nextThreadAction,
  runProviderStepOnceV2,
  StepLedgerError,
  type BeginAction,
  type StepRecord,
} from "./x_v2_multistep.ts";

const SECRET = "tok_SECRET_multistep";
const credential = new XAccountCredential({ socialAccountId: "acct_a", brandId: "brand_a", platformUserId: "x_a" }, SECRET);

function step(no: number, kind: StepRecord["step_kind"], outcome: StepRecord["outcome"], id: string | null,
  parent: string | null = null, input: string | null = null, phase: StepRecord["phase"] = "finished"): StepRecord {
  return { step_no: no, step_kind: kind, parent_provider_object_id: parent, input_provider_object_id: input, phase, outcome, provider_object_id: id };
}
const ok = (no: number, kind: StepRecord["step_kind"], id: string, parent: string | null = null, input: string | null = null) =>
  step(no, kind, "provider_object_confirmed", id, parent, input);

test("thread: next action walks root then chained replies, then completes with every id", () => {
  assert.deepEqual(nextThreadAction(3, []), { action: "begin", stepNo: 1, stepKind: "create_post", parentProviderObjectId: null, inputProviderObjectId: null });
  assert.deepEqual(nextThreadAction(3, [ok(1, "create_post", "a")]),
    { action: "begin", stepNo: 2, stepKind: "create_reply", parentProviderObjectId: "a", inputProviderObjectId: null });
  assert.deepEqual(nextThreadAction(3, [ok(2, "create_reply", "b", "a"), ok(1, "create_post", "a")]),
    { action: "begin", stepNo: 3, stepKind: "create_reply", parentProviderObjectId: "b", inputProviderObjectId: null });
  assert.deepEqual(nextThreadAction(2, [ok(1, "create_post", "a"), ok(2, "create_reply", "b", "a")]), { action: "complete", xPostIds: ["a", "b"] });
  assert.deepEqual(nextThreadAction(1, [ok(1, "create_post", "a")]), { action: "complete", xPostIds: ["a"] });
});

test("thread: in-flight, uncertain, rejected, gaps, wrong parents and extras block; nothing is re-sent", () => {
  const cases: Array<[number, StepRecord[], string]> = [
    [2, [step(1, "create_post", null, null, null, null, "provider_started")], "STEP_IN_FLIGHT_OUTCOME_UNKNOWN"],
    [2, [step(1, "create_post", "x_outcome_uncertain", null)], "STEP_OUTCOME_UNCERTAIN"],
    [2, [step(1, "create_post", "x_rejected", null)], "STEP_REJECTED"],
    [3, [ok(1, "create_post", "a"), step(2, "create_reply", "x_outcome_uncertain", null, "a")], "STEP_OUTCOME_UNCERTAIN"],
    [3, [ok(1, "create_post", "a"), ok(3, "create_reply", "c", "a")], "THREAD_STEPS_INCONSISTENT"],
    [2, [ok(1, "create_post", "a"), ok(2, "create_reply", "b", "WRONG")], "THREAD_STEPS_INCONSISTENT"],
    [2, [ok(1, "create_reply", "a", "p")], "THREAD_STEPS_INCONSISTENT"],
    [1, [ok(1, "create_post", "a"), ok(2, "create_reply", "b", "a")], "THREAD_STEPS_INCONSISTENT"],
    [4, [], "THREAD_PLAN_INVALID"],
    [0, [], "THREAD_PLAN_INVALID"],
  ];
  for (const [expected, steps, code] of cases) assert.deepEqual(nextThreadAction(expected, steps), { action: "blocked", code }, code);
});

test("greeting: media first, create must consume exactly the confirmed media id", () => {
  assert.deepEqual(nextGreetingAction([]), { action: "begin", stepNo: 1, stepKind: "media_upload", parentProviderObjectId: null, inputProviderObjectId: null });
  assert.deepEqual(nextGreetingAction([ok(1, "media_upload", "m1")]),
    { action: "begin", stepNo: 2, stepKind: "create_post", parentProviderObjectId: null, inputProviderObjectId: "m1" });
  assert.deepEqual(nextGreetingAction([ok(1, "media_upload", "m1"), ok(2, "create_post", "x1", null, "m1")]), { action: "complete", xPostIds: ["x1"] });
  assert.deepEqual(nextGreetingAction([step(1, "media_upload", "x_outcome_uncertain", null)]), { action: "blocked", code: "STEP_OUTCOME_UNCERTAIN" });
  assert.deepEqual(nextGreetingAction([ok(1, "media_upload", "m1"), step(2, "create_post", "x_outcome_uncertain", null, null, "m1")]),
    { action: "blocked", code: "STEP_OUTCOME_UNCERTAIN" });
  assert.deepEqual(nextGreetingAction([ok(1, "media_upload", "m1"), ok(2, "create_post", "x1", null, "m_other")]), { action: "blocked", code: "GREETING_STEPS_INCONSISTENT" });
  assert.deepEqual(nextGreetingAction([ok(1, "create_post", "x1")]), { action: "blocked", code: "GREETING_STEPS_INCONSISTENT" });
  assert.deepEqual(nextGreetingAction([ok(2, "create_post", "x1", null, "m1")]), { action: "blocked", code: "GREETING_STEPS_INCONSISTENT" });
});

function scripted(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; auth: string | null; redirect: RequestRedirect | undefined; body: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get("Authorization"), redirect: init?.redirect, body: init?.body });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}
const replyAction: BeginAction = { action: "begin", stepNo: 2, stepKind: "create_reply", parentProviderObjectId: "a", inputProviderObjectId: null };
const mediaAction: BeginAction = { action: "begin", stepNo: 1, stepKind: "media_upload", parentProviderObjectId: null, inputProviderObjectId: null };
const createWithMedia: BeginAction = { action: "begin", stepNo: 2, stepKind: "create_post", parentProviderObjectId: null, inputProviderObjectId: "m1" };

test("one step = durable begin then exactly one request with the exact credential", async () => {
  const x = scripted([Response.json({ data: { id: "b" } }, { status: 201 })]);
  const order: string[] = [];
  const outcome = await runProviderStepOnceV2({
    credential, action: replyAction, request: { kind: "create_reply", text: "part 2", parentId: "a" },
    beginStep: async (a) => { order.push(`begin:${a.stepNo}`); },
  }, { fetchImpl: async (i, n) => { order.push("request"); return x.fetchImpl(i, n); } });
  assert.deepEqual(outcome, { kind: "provider_object_confirmed", objectId: "b", httpStatus: 201, requests: 1 });
  assert.deepEqual(order, ["begin:2", "request"]);
  assert.equal(x.calls.length, 1);
  assert.equal(x.calls[0].auth, `Bearer ${SECRET}`);
  assert.equal(x.calls[0].redirect, "manual");
  assert.deepEqual(JSON.parse(String(x.calls[0].body)), { text: "part 2", reply: { in_reply_to_tweet_id: "a" } });
});

test("greeting create sends exactly the planned media id; media upload is multipart", async () => {
  const x = scripted([Response.json({ data: { id: "m1" } }), Response.json({ data: { id: "x1" } }, { status: 201 })]);
  const media = await runProviderStepOnceV2({
    credential, action: mediaAction,
    request: { kind: "media_upload", bytes: new Uint8Array([1, 2, 3]), contentType: "image/png", filename: "d.png", mediaCategory: "tweet_image" },
    beginStep: async () => {},
  }, { fetchImpl: x.fetchImpl });
  assert.equal(media.kind, "provider_object_confirmed");
  assert.ok(x.calls[0].url.endsWith("/2/media/upload") && x.calls[0].body instanceof FormData);
  const create = await runProviderStepOnceV2({
    credential, action: createWithMedia, request: { kind: "create_post", text: "おはよう", mediaId: "m1", madeWithAi: true },
    beginStep: async () => {},
  }, { fetchImpl: x.fetchImpl });
  assert.deepEqual(create, { kind: "provider_object_confirmed", objectId: "x1", httpStatus: 201, requests: 1 });
  assert.deepEqual(JSON.parse(String(x.calls[1].body)), { text: "おはよう", made_with_ai: true, media: { media_ids: ["m1"] } });
});

test("a request that does not match the planned action is never begun or sent", async () => {
  const bad: Array<[BeginAction, Parameters<typeof runProviderStepOnceV2>[0]["request"]]> = [
    [replyAction, { kind: "create_reply", text: "x", parentId: "WRONG" }],
    [replyAction, { kind: "create_post", text: "x" }],
    [createWithMedia, { kind: "create_post", text: "x", mediaId: "m_other" }],
    [createWithMedia, { kind: "create_post", text: "x" }],
    [replyAction, { kind: "create_reply", text: "  ", parentId: "a" }],
    [mediaAction, { kind: "media_upload", bytes: new Uint8Array(), contentType: "image/png", filename: "d.png", mediaCategory: "tweet_image" }],
  ];
  for (const [action, request] of bad) {
    let begun = false;
    const x = scripted([]);
    const outcome = await runProviderStepOnceV2({ credential, action, request, beginStep: async () => { begun = true; } }, { fetchImpl: x.fetchImpl });
    assert.deepEqual(outcome, { kind: "not_started", code: "STEP_REQUEST_DOES_NOT_MATCH_ACTION", requests: 0 });
    assert.equal(begun, false);
    assert.equal(x.calls.length, 0);
  }
});

test("begin failure sends nothing; outcomes are classified without retry", async () => {
  const x0 = scripted([]);
  assert.deepEqual(await runProviderStepOnceV2({ credential, action: replyAction, request: { kind: "create_reply", text: "x", parentId: "a" },
    beginStep: async () => { throw new Error("PROVIDER_STEP_ALREADY_STARTED"); } }, { fetchImpl: x0.fetchImpl }),
    { kind: "not_started", code: "STEP_BEGIN_NOT_RECORDED", requests: 0 });
  assert.equal(x0.calls.length, 0);
  const cases: Array<[Response | Error, string, string, number | null]> = [
    [new TypeError("reset"), "x_outcome_uncertain", "X_STEP_NETWORK_UNCERTAIN", null],
    [Response.json({}, { status: 503 }), "x_outcome_uncertain", "X_STEP_HTTP_503", 503],
    [new Response(null, { status: 307, headers: { Location: "https://example.invalid" } }), "x_outcome_uncertain", "X_STEP_HTTP_307", 307],
    [Response.json({ data: {} }, { status: 201 }), "x_outcome_uncertain", "X_STEP_RESPONSE_MISSING_ID", 201],
    [Response.json({}, { status: 401 }), "x_rejected", "X_STEP_REJECTED_401", 401],
    [Response.json({}, { status: 403 }), "x_rejected", "X_STEP_REJECTED_403", 403],
  ];
  for (const [response, kind, code, httpStatus] of cases) {
    const x = scripted([response]);
    const outcome = await runProviderStepOnceV2({ credential, action: replyAction, request: { kind: "create_reply", text: "x", parentId: "a" },
      beginStep: async () => {} }, { fetchImpl: x.fetchImpl });
    assert.deepEqual(outcome, { kind, code, httpStatus, requests: 1 }, code);
    assert.equal(x.calls.length, 1, code);
    assert.ok(!JSON.stringify(outcome).includes(SECRET));
  }
});

test("ledger client: service-role RPC shapes, manual redirects, fixed error codes", async () => {
  const sent: Array<{ url: string; method: string; body: unknown; redirect: RequestRedirect | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    sent.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, redirect: init?.redirect });
    if (String(input).includes("complete_tip_post_v2")) return Response.json({ message: `THREAD_STEPS_NOT_COMPLETE` }, { status: 400 });
    if (String(input).includes("plan_provider_steps_v2")) return Response.json({ message: `boom ${SECRET}` }, { status: 500 });
    if (String(input).includes("/rest/v1/post_provider_steps_v2?")) return Response.json([ok(1, "create_post", "a")]);
    return Response.json("finished");
  };
  const client = createV2StepLedgerClient({ supabaseUrl: "https://e.supabase.co/", serviceRoleKey: "srk", fetchImpl });
  await client.beginPlannedStep("att", "tok", replyAction);
  await client.finishStep("att", "tok", 2, { kind: "x_outcome_uncertain", code: "X_STEP_HTTP_503", httpStatus: 503, requests: 1 });
  await client.finishStep("att", "tok", 1, { kind: "provider_object_confirmed", objectId: "a", httpStatus: 201, requests: 1 });
  assert.deepEqual(await client.listSteps("att"), [ok(1, "create_post", "a")]);
  await assert.rejects(client.completeTip({ attemptId: "att", claimToken: "tok", socialAccountId: "acct_a", brandId: "brand_a", tipId: "t" }),
    (e: unknown) => e instanceof StepLedgerError && e.code === "THREAD_STEPS_NOT_COMPLETE");
  await assert.rejects(client.plan("att", "tok", "tip_thread", 2),
    (e: unknown) => e instanceof StepLedgerError && e.code === "STEP_LEDGER_UNAVAILABLE" && !e.message.includes(SECRET));
  await assert.rejects(client.finishStep("att", "tok", 1, { kind: "not_started", code: "X", requests: 0 }),
    (e: unknown) => e instanceof StepLedgerError && e.code === "STEP_NOT_STARTED_NOTHING_TO_FINISH");
  assert.deepEqual(sent[0], {
    url: "https://e.supabase.co/rest/v1/rpc/begin_planned_provider_step_v2", method: "POST", redirect: "manual",
    body: { p_attempt_id: "att", p_claim_token: "tok", p_step_no: 2, p_step_kind: "create_reply", p_parent_provider_object_id: "a", p_input_provider_object_id: null },
  });
  assert.deepEqual(sent[1].body, { p_attempt_id: "att", p_claim_token: "tok", p_step_no: 2, p_outcome: "x_outcome_uncertain", p_provider_object_id: null, p_error_code: "X_STEP_HTTP_503" });
  assert.deepEqual(sent[2].body, { p_attempt_id: "att", p_claim_token: "tok", p_step_no: 1, p_outcome: "provider_object_confirmed", p_provider_object_id: "a", p_error_code: null });
  assert.ok(sent[3].url.includes("attempt_id=eq.att") && sent[3].url.includes("order=step_no.asc"));
  assert.ok(sent.every((s) => s.redirect === "manual"));
});

test("helper source never refreshes, loops over steps, reads env or logs", async () => {
  const source = (await Deno.readTextFile(new URL("./x_v2_multistep.ts", import.meta.url))).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, "");
  assert.doesNotMatch(source, /oauth2\/token|refresh|oauth_token_store|requestXWithAuthRefresh|postToX|Deno\.env|console\.|brand_id=|limit=1/u);
  assert.doesNotMatch(source, /while\s*\(/u);
  assert.equal((source.match(/fetchImpl\(built\.url/gu) ?? []).length, 1);
});
