// Fake ledger / fake X callbacks are async by contract even when they do not await.
// deno-lint-ignore-file require-await
import assert from "node:assert/strict";
import test from "node:test";
import type { XClaimCredentialReader } from "../_shared/x_v2_claim_credentials.ts";
import type { BeginAction, StepOutcome, StepRecord } from "../_shared/x_v2_multistep.ts";
import {
  isV2DispatchGateOn,
  runV2DispatchOnce,
  V2_DISPATCH_GATE_ENV,
  V2_NON_RECLAIMABLE_CLASSES,
  type V2ClaimRow,
  type V2DispatchLedger,
  type V2DispatchPorts,
  type V2PreparedContent,
  type V2ResumableRow,
} from "./v2_dispatcher.ts";

// Real network is forbidden in this file: any global fetch call fails the test.
const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("REAL_FETCH_FORBIDDEN_IN_TESTS"); }) as typeof fetch;
addEventListener("unload", () => { globalThis.fetch = realFetch; });

const TODAY = "2026-09-25";
const ACCOUNTS: Record<string, { brand: string; token: string; xid: string }> = {
  acct_a: { brand: "brand_a", token: "tok_A_secret", xid: "x_a" },
  acct_b: { brand: "brand_b", token: "tok_B_secret", xid: "x_b" },
};

type Post = { id: string; brand: string; account: string; postType: string; scheduleDate: string; status: string };
type Attempt = {
  id: string; token: string; postId: string; brand: string; account: string; attemptNo: number;
  phase: "pre_x" | "provider_started" | "finished"; outcome: string | null; errorCode: string | null; xPostId: string | null;
};

/** In-memory mirror of the reviewed Phase1B..1H ledger rules. */
class FakeDb implements V2DispatchLedger {
  posts = new Map<string, Post>();
  attempts = new Map<string, Attempt>();
  plans = new Map<string, { kind: "tip_thread" | "morning_greeting_media_post"; expected: number }>();
  snapshots = new Map<string, unknown>();
  steps = new Map<string, StepRecord[]>();
  greetingClaims = new Map<string, { attemptId: string; status: string; xPostId: string | null }>();
  effects: Record<string, number> = {};
  failCompletion = new Set<string>();
  failMark = false;
  failSettle = false;
  failFinishOnce = false;
  calls: string[] = [];
  private seq = 0;

  addPost(p: Omit<Post, "status" | "scheduleDate"> & { scheduleDate?: string }): string {
    this.posts.set(p.id, { ...p, scheduleDate: p.scheduleDate ?? TODAY, status: "pending" });
    return p.id;
  }
  private attempt(a: string, t: string): Attempt {
    const at = this.attempts.get(a);
    if (!at || at.token !== t) throw new Error("X_COMPLETION_CLAIM_INVALID");
    return at;
  }
  private postOf(at: Attempt): Post { return this.posts.get(at.postId)!; }
  private row(at: Attempt): V2ClaimRow {
    const p = this.postOf(at);
    return { attemptId: at.id, claimToken: at.token, scheduledPostId: p.id, brandId: at.brand, socialAccountId: at.account, postType: p.postType };
  }
  private finish(at: Attempt, outcome: string, code: string | null, x: string | null, postStatus: string) {
    at.phase = "finished"; at.outcome = outcome; at.errorCode = code; at.xPostId = x;
    this.postOf(at).status = postStatus;
    if (outcome !== "completed" && outcome !== "x_confirmed_db_incomplete") {
      for (const c of this.greetingClaims.values()) if (c.attemptId === at.id && c.status === "publishing") c.status = "failed";
    }
  }
  resumable(at: Attempt): boolean {
    const plan = this.plans.get(at.id);
    const steps = this.steps.get(at.id) ?? [];
    return at.phase === "provider_started" && at.outcome === null && !!plan && this.snapshots.has(at.id) &&
      this.postOf(at).status === "running" &&
      steps.every((s) => s.phase === "finished" && s.outcome === "provider_object_confirmed") && steps.length <= plan.expected;
  }

  async listResumable(limit: number): Promise<V2ResumableRow[]> {
    this.calls.push("listResumable");
    return [...this.attempts.values()].filter((a) => this.resumable(a)).slice(0, limit).map((a) => ({
      ...this.row(a), planKind: this.plans.get(a.id)!.kind, expectedSteps: this.plans.get(a.id)!.expected,
    }));
  }
  async claim(): Promise<V2ClaimRow | null> {
    this.calls.push("claim");
    const post = [...this.posts.values()].find((p) => p.status === "pending");
    if (!post) return null;
    post.status = "running";
    const attemptNo = [...this.attempts.values()].filter((a) => a.postId === post.id).length + 1;
    const at: Attempt = {
      id: `att_${++this.seq}`, token: `ct_${this.seq}`, postId: post.id, brand: post.brand, account: post.account,
      attemptNo, phase: "pre_x", outcome: null, errorCode: null, xPostId: null,
    };
    this.attempts.set(at.id, at);
    return this.row(at);
  }
  async readScheduleDate(id: string) { return this.posts.get(id)?.scheduleDate ?? null; }
  async markProviderStarted(a: string, t: string) {
    this.calls.push("mark");
    if (this.failMark) throw new Error("RPC_UNAVAILABLE");
    const at = this.attempt(a, t);
    if (at.phase !== "pre_x") throw new Error("ATTEMPT_NOT_PRE_X");
    const type = this.postOf(at).postType;
    if ((type === "tip" || type === "morning_greeting") && (!this.plans.has(a) || !this.snapshots.has(a))) {
      throw new Error("PROVIDER_STEP_PLAN_REQUIRED");
    }
    at.phase = "provider_started";
  }
  async settlePreX(a: string, t: string, retryable: boolean, code: string) {
    this.calls.push(`settle:${retryable}:${code}`);
    if (this.failSettle) throw new Error("RPC_UNAVAILABLE");
    const at = this.attempt(a, t);
    if (at.phase !== "pre_x") throw new Error("ATTEMPT_NOT_PRE_X");
    const retry = retryable && at.attemptNo < 3;
    this.finish(at, retry ? "pre_x_retryable" : "pre_x_terminal", code, null, retry ? "pending" : "failed");
    return retry ? "pre_x_retryable" as const : "pre_x_terminal" as const;
  }
  private started(a: string, t: string): Attempt {
    const at = this.attempt(a, t);
    if (at.phase !== "provider_started" || at.outcome !== null) throw new Error("ATTEMPT_NOT_PROVIDER_STARTED");
    return at;
  }
  async recordRejected(a: string, t: string, code: string) {
    const at = this.started(a, t);
    if ((this.steps.get(a) ?? []).some((s) => s.step_kind !== "media_upload" && s.outcome === "provider_object_confirmed")) {
      throw new Error("X_REJECTED_AFTER_CONFIRMED_CREATE");
    }
    this.finish(at, "x_rejected", code, null, "failed");
  }
  async recordUncertain(a: string, t: string, code: string) { this.finish(this.started(a, t), "x_outcome_uncertain", code, null, "failed"); }
  async recordConfirmedIncomplete(a: string, t: string, x: string, code: string) {
    this.finish(this.started(a, t), "x_confirmed_db_incomplete", code, x, "failed");
  }
  private complete(a: string, t: string, claimType: string, x: string, effect: () => void): string {
    const at = this.attempt(a, t);
    if (this.postOf(at).postType !== claimType) throw new Error("X_COMPLETION_POST_TYPE_MISMATCH");
    if (at.outcome === "completed") {
      if (at.xPostId === x) return "already_completed";
      throw new Error("X_COMPLETION_CONFLICT");
    }
    const ok = (at.phase === "provider_started" && at.outcome === null) || (at.outcome === "x_confirmed_db_incomplete" && at.xPostId === x);
    if (!ok) throw new Error("ATTEMPT_NOT_CONFIRMABLE");
    if (this.failCompletion.has(at.postId)) {
      this.failCompletion.delete(at.postId);
      throw new Error("FORCED_COMPLETION_FAILURE");
    }
    effect();
    at.phase = "finished"; at.outcome = "completed"; at.xPostId = x; at.errorCode = null;
    this.postOf(at).status = "succeeded";
    this.effects[at.postId] = (this.effects[at.postId] ?? 0) + 1;
    return "completed";
  }
  async completeSingle(claim: V2ClaimRow, _content: Extract<V2PreparedContent, { kind: "useful_tip" | "report" }>, x: string) {
    this.calls.push("completeSingle");
    return this.complete(claim.attemptId, claim.claimToken, claim.postType, x, () => {});
  }
  async acquireGreetingClaim(a: string, t: string) {
    const at = this.attempt(a, t);
    if (at.phase !== "pre_x") throw new Error("X_CLAIM_NOT_PRE_X");
    const post = this.postOf(at);
    if (post.scheduleDate !== TODAY) throw new Error("GREETING_SCHEDULE_DATE_STALE");
    const key = `${at.brand}|${post.scheduleDate}`;
    const existing = this.greetingClaims.get(key);
    if (!existing) { this.greetingClaims.set(key, { attemptId: a, status: "publishing", xPostId: null }); return; }
    if (existing.attemptId === a && existing.status === "publishing") return;
    throw new Error(existing.status === "published" ? "GREETING_ALREADY_PUBLISHED" : "GREETING_PUBLISH_CLAIM_HELD");
  }
  async plan(a: string, t: string, kind: "tip_thread" | "morning_greeting_media_post", expected: number) {
    const at = this.attempt(a, t);
    if (at.phase !== "pre_x") throw new Error("X_CLAIM_NOT_PRE_X");
    this.plans.set(a, { kind, expected });
  }
  async recordSnapshot(a: string, t: string, payload: Record<string, unknown>) {
    const at = this.attempt(a, t);
    if (at.phase !== "pre_x" || !this.plans.has(a)) throw new Error("PROVIDER_STEP_PLAN_REQUIRED");
    this.snapshots.set(a, structuredClone(payload));
  }
  async readSnapshot(a: string) { return structuredClone(this.snapshots.get(a) ?? null); }
  async listSteps(a: string) { return structuredClone(this.steps.get(a) ?? []); }
  async beginPlannedStep(a: string, t: string, action: BeginAction) {
    this.calls.push(`begin:${action.stepNo}`);
    const at = this.started(a, t);
    const plan = this.plans.get(a);
    if (!plan) throw new Error("PROVIDER_STEP_PLAN_REQUIRED");
    const list = this.steps.get(a) ?? [];
    if (list.some((s) => s.step_no === action.stepNo)) throw new Error("PROVIDER_STEP_ALREADY_STARTED");
    if (action.stepNo !== list.length + 1 || action.stepNo > plan.expected) throw new Error("PROVIDER_STEP_OUT_OF_ORDER");
    const prev = list[list.length - 1];
    if (prev && prev.outcome !== "provider_object_confirmed") throw new Error("PROVIDER_STEP_PREVIOUS_NOT_CONFIRMED");
    const expectedKind = plan.kind === "tip_thread" ? (action.stepNo === 1 ? "create_post" : "create_reply") : (action.stepNo === 1 ? "media_upload" : "create_post");
    if (action.stepKind !== expectedKind) throw new Error("PROVIDER_STEP_KIND_NOT_IN_PLAN");
    if (action.stepKind === "create_reply" && action.parentProviderObjectId !== prev?.provider_object_id) throw new Error("PROVIDER_STEP_PARENT_MISMATCH");
    if (plan.kind === "morning_greeting_media_post") {
      if (this.postOf(at).scheduleDate !== TODAY) throw new Error("GREETING_SCHEDULE_DATE_STALE");
      if (action.stepNo === 2 && action.inputProviderObjectId !== prev?.provider_object_id) throw new Error("PROVIDER_STEP_INPUT_MISMATCH");
    }
    list.push({
      step_no: action.stepNo, step_kind: action.stepKind, parent_provider_object_id: action.parentProviderObjectId,
      input_provider_object_id: action.inputProviderObjectId, phase: "provider_started", outcome: null, provider_object_id: null,
    });
    this.steps.set(a, list);
  }
  async finishStep(a: string, t: string, stepNo: number, outcome: StepOutcome) {
    if (this.failFinishOnce) { this.failFinishOnce = false; throw new Error("RPC_UNAVAILABLE"); }
    this.started(a, t);
    const s = (this.steps.get(a) ?? []).find((x) => x.step_no === stepNo);
    if (!s || s.phase !== "provider_started" || outcome.kind === "not_started") throw new Error("PROVIDER_STEP_NOT_STARTED");
    s.phase = "finished"; s.outcome = outcome.kind;
    s.provider_object_id = outcome.kind === "provider_object_confirmed" ? outcome.objectId : null;
  }
  async completeTip(claim: V2ClaimRow, _tipId: string) {
    const list = this.steps.get(claim.attemptId) ?? [];
    const plan = this.plans.get(claim.attemptId);
    if (!plan || list.length !== plan.expected || !list.every((s) => s.outcome === "provider_object_confirmed")) throw new Error("THREAD_STEPS_NOT_COMPLETE");
    return this.complete(claim.attemptId, claim.claimToken, "tip", list[0].provider_object_id!, () => {});
  }
  async completeGreeting(claim: V2ClaimRow) {
    const list = this.steps.get(claim.attemptId) ?? [];
    if (list.length !== 2 || !list.every((s) => s.outcome === "provider_object_confirmed")) throw new Error("GREETING_STEPS_NOT_COMPLETE");
    const x = list[1].provider_object_id!;
    return this.complete(claim.attemptId, claim.claimToken, "morning_greeting", x, () => {
      const c = [...this.greetingClaims.values()].find((g) => g.attemptId === claim.attemptId && g.status === "publishing");
      if (!c) throw new Error("GREETING_PUBLISH_CLAIM_NOT_HELD");
      c.status = "published"; c.xPostId = x;
    });
  }

  claimReader(): XClaimCredentialReader {
    return {
      readForClaim: async (claim) => {
        const at = this.attempts.get(claim.attemptId);
        if (!at || at.token !== claim.claimToken || at.phase !== "pre_x") throw new Error("X_CLAIM_NOT_PRE_X");
        if (at.account !== claim.socialAccountId || at.brand !== claim.brandId) throw new Error("X_CLAIM_ACCOUNT_MISMATCH");
        const acct = ACCOUNTS[at.account];
        return [{ social_account_id: at.account, brand_id: acct.brand, platform_user_id: acct.xid, access_token: acct.token }];
      },
    };
  }
  resumeReader(): XClaimCredentialReader {
    return {
      readForClaim: async (claim) => {
        const at = this.attempts.get(claim.attemptId);
        if (!at || at.token !== claim.claimToken || !this.resumable(at) ||
            (this.steps.get(at.id) ?? []).length >= this.plans.get(at.id)!.expected) throw new Error("X_RESUME_NOT_ALLOWED");
        const acct = ACCOUNTS[at.account];
        return [{ social_account_id: at.account, brand_id: acct.brand, platform_user_id: acct.xid, access_token: acct.token }];
      },
    };
  }
}

type XCall = { url: string; auth: string | null; body: unknown };
/** Fake X. `create` responses are consumed in order; default = success. */
class FakeX {
  calls: XCall[] = [];
  createScript: Array<Response | Error> = [];
  mediaScript: Array<Response | Error> = [];
  private n = 0;
  fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("Authorization");
    const body = init?.body instanceof FormData ? "multipart" : init?.body ? JSON.parse(String(init.body)) : null;
    this.calls.push({ url, auth, body });
    if (url === "https://api.x.com/2/users/me") {
      const acct = Object.values(ACCOUNTS).find((a) => `Bearer ${a.token}` === auth);
      return acct ? Response.json({ data: { id: acct.xid } }) : Response.json({}, { status: 401 });
    }
    const script = url === "https://api.x.com/2/tweets" ? this.createScript : url === "https://api.x.com/2/media/upload" ? this.mediaScript : null;
    if (!script) throw new Error(`unexpected X url ${url}`);
    const next = script.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    return Response.json({ data: { id: `${url.endsWith("upload") ? "m" : "tw"}_${++this.n}` } }, { status: 201 });
  };
  count(kind: "create" | "media" | "me") {
    const url = { create: "https://api.x.com/2/tweets", media: "https://api.x.com/2/media/upload", me: "https://api.x.com/2/users/me" }[kind];
    return this.calls.filter((c) => c.url === url).length;
  }
}

const CONTENT: Record<string, V2PreparedContent> = {
  useful_tip: { kind: "useful_tip", text: "役立つ話", usefulTipId: "u1", sourceUrls: [], modelUsed: "m", escalated: false, inputTokens: 1, outputTokens: 1, apiCost: 0 },
  close_report: { kind: "report", text: "大引け", runId: "run1" },
  tip3: { kind: "tip", tipId: "00000000-0000-4000-8000-0000000000f1", parts: ["part1", "part2", "part3"] },
  tip2: { kind: "tip", tipId: "00000000-0000-4000-8000-0000000000f1", parts: ["p1", "p2"] },
  morning_greeting: { kind: "morning_greeting", text: "おはよう" },
};

function ports(db: FakeDb, x: FakeX, options: Partial<V2DispatchPorts> & { prepared?: V2PreparedContent } = {}): V2DispatchPorts {
  const { prepared, ...over } = options;
  const received: string[] = [];
  return {
    ledger: db,
    claimCredentials: db.claimReader(),
    resumeCredentials: db.resumeReader(),
    content: {
      prepare: async (claim) => prepared ?? CONTENT[claim.postType],
      loadGreetingMedia: async () => ({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/png", filename: `${TODAY}.png` }),
    },
    afterGreetingPublished: async (_c, id) => { received.push(id); },
    nowJstDate: () => TODAY,
    fetchImpl: x.fetchImpl,
    ...over,
  };
}

// --- gate ------------------------------------------------------------------------

test("gate: only the exact server value turns it on; OFF touches neither ledger nor X", async () => {
  assert.equal(isV2DispatchGateOn((k) => (k === V2_DISPATCH_GATE_ENV ? "enabled" : undefined)), true);
  for (const value of [undefined, "", "true", "1", "Enabled", " enabled", "enabled ", "on"]) {
    assert.equal(isV2DispatchGateOn(() => value), false, String(value));
  }
  assert.equal(isV2DispatchGateOn(() => { throw new Error("env denied"); }), false);
  const trap = new Proxy({}, { get: () => { throw new Error("LEDGER_TOUCHED_WHILE_GATE_OFF"); } }) as V2DispatchLedger;
  const x = new FakeX();
  for (const gate of [false, undefined as unknown as boolean, "enabled" as unknown as boolean]) {
    const r = await runV2DispatchOnce({ ...ports(new FakeDb(), x), ledger: trap }, gate);
    assert.equal(r.class, "gate_off");
  }
  assert.equal(x.calls.length, 0);
});

test("no work and unsupported types never reach the provider", async () => {
  const x = new FakeX();
  const empty = new FakeDb();
  assert.equal((await runV2DispatchOnce(ports(empty, x), true)).class, "no_work");
  for (const postType of ["interaction", "brand_post", "unknown_type"]) {
    const db = new FakeDb();
    db.addPost({ id: "p", brand: "brand_a", account: "acct_a", postType });
    const r = await runV2DispatchOnce(ports(db, x), true);
    assert.equal(r.class, "unsupported_type", postType);
    assert.equal(db.posts.get("p")!.status, "failed");
    assert.ok(db.calls.some((c) => c.startsWith("settle:false:")));
  }
  assert.equal(x.calls.length, 0);
  assert.ok(V2_NON_RECLAIMABLE_CLASSES.has("unsupported_type") && !V2_NON_RECLAIMABLE_CLASSES.has("pre_x_retryable"));
});

test("pre-X result reflects the durable terminal outcome at the attempt cap", async () => {
  const db = new FakeDb();
  const x = new FakeX();
  db.addPost({ id: "p", brand: "brand_a", account: "acct_a", postType: "useful_tip" });
  const scoped = ports(db, x, { content: { prepare: async () => { throw new Error("CONTENT_UNAVAILABLE"); }, loadGreetingMedia: async () => { throw new Error("NOT_USED"); } } });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await runV2DispatchOnce(scoped, true);
    assert.equal(r.class, attempt < 3 ? "pre_x_retryable" : "pre_x_terminal");
  }
  assert.equal(db.posts.get("p")!.status, "failed");
  assert.equal(x.calls.length, 0);
});

test("failed pre-X settlement never reports a committed terminal/unsupported result", async () => {
  for (const postType of ["interaction", "useful_tip"]) {
    const db = new FakeDb();
    const x = new FakeX();
    db.failSettle = true;
    db.addPost({ id: "p", brand: "brand_a", account: "acct_a", postType });
    const r = await runV2DispatchOnce(ports(db, x, { content: { prepare: async () => { throw new Error("CONTENT_UNAVAILABLE"); }, loadGreetingMedia: async () => { throw new Error("NOT_USED"); } } }), true);
    assert.equal(r.class, "blocked_manual_reconciliation");
    assert.equal(r.code, "PRE_X_SETTLEMENT_NOT_RECORDED");
    assert.equal(db.posts.get("p")!.status, "running");
    assert.equal(x.calls.length, 0);
  }
});

// --- single create ---------------------------------------------------------------

test("single create: exactly one create with the claimed account's own token", async () => {
  const db = new FakeDb();
  const x = new FakeX();
  db.addPost({ id: "pa", brand: "brand_a", account: "acct_a", postType: "useful_tip" });
  db.addPost({ id: "pb", brand: "brand_b", account: "acct_b", postType: "close_report" });
  const ra = await runV2DispatchOnce(ports(db, x), true);
  const rb = await runV2DispatchOnce(ports(db, x), true);
  assert.equal(ra.class, "completed");
  assert.equal(rb.class, "completed");
  assert.equal(ra.createRequests + rb.createRequests, 2);
  assert.equal(x.count("create"), 2);
  const creates = x.calls.filter((c) => c.url.endsWith("/2/tweets"));
  assert.equal(creates[0].auth, "Bearer tok_A_secret");
  assert.equal(creates[1].auth, "Bearer tok_B_secret");
  assert.deepEqual(db.effects, { pa: 1, pb: 1 });
  assert.equal((await runV2DispatchOnce(ports(db, x), true)).class, "no_work");
  assert.equal(x.count("create"), 2);
});

test("single create: a credential for another account is refused before any X request", async () => {
  const db = new FakeDb();
  const x = new FakeX();
  db.addPost({ id: "pa", brand: "brand_a", account: "acct_a", postType: "useful_tip" });
  const lying: XClaimCredentialReader = {
    readForClaim: async () => [{ social_account_id: "acct_b", brand_id: "brand_b", platform_user_id: "x_b", access_token: "tok_B_secret" }],
  };
  const r = await runV2DispatchOnce({ ...ports(db, x), claimCredentials: lying }, true);
  assert.equal(r.class, "pre_x_terminal");
  assert.equal(r.code, "X_CLAIM_ACCOUNT_MISMATCH");
  assert.equal(x.calls.length, 0);
  const down: XClaimCredentialReader = { readForClaim: async () => { throw new Error("boom"); } };
  const db2 = new FakeDb();
  db2.addPost({ id: "p2", brand: "brand_a", account: "acct_a", postType: "useful_tip" });
  const r2 = await runV2DispatchOnce({ ...ports(db2, x), claimCredentials: down }, true);
  assert.equal(r2.class, "pre_x_retryable");
  assert.equal(db2.posts.get("p2")!.status, "pending");
  assert.equal(x.calls.length, 0);
});

test("single create: provider-start persistence failure sends nothing", async () => {
  const db = new FakeDb();
  const x = new FakeX();
  db.failMark = true;
  db.addPost({ id: "pa", brand: "brand_a", account: "acct_a", postType: "useful_tip" });
  const r = await runV2DispatchOnce(ports(db, x), true);
  assert.equal(r.class, "pre_x_retryable");
  assert.equal(r.code, "X_PROVIDER_START_NOT_RECORDED");
  assert.equal(x.count("create"), 0);
});

test("single create: 401 after start is rejected with no refresh and no second create", async () => {
  const db = new FakeDb();
  const x = new FakeX();
  x.createScript.push(Response.json({}, { status: 401 }));
  db.addPost({ id: "pa", brand: "brand_a", account: "acct_a", postType: "useful_tip" });
  const r = await runV2DispatchOnce(ports(db, x), true);
  assert.equal(r.class, "provider_rejected");
  assert.equal(x.count("create"), 1);
  assert.ok(x.calls.every((c) => !c.url.includes("oauth2/token")));
  assert.equal((await runV2DispatchOnce(ports(db, x), true)).class, "no_work");
  assert.equal(x.count("create"), 1);
});

test("single create: timeout / 5xx / 3xx / 2xx-without-id are uncertain and never retried", async () => {
  for (const response of [
    new DOMException("timed out", "TimeoutError"),
    Response.json({}, { status: 503 }),
    new Response(null, { status: 307, headers: { Location: "https://x.invalid" } }),
    Response.json({ data: {} }, { status: 201 }),
  ]) {
    const db = new FakeDb();
    const x = new FakeX();
    x.createScript.push(response);
    db.addPost({ id: "pa", brand: "brand_a", account: "acct_a", postType: "close_report" });
    const r = await runV2DispatchOnce(ports(db, x), true);
    assert.equal(r.class, "provider_uncertain");
    assert.equal(x.count("create"), 1);
    assert.equal((await runV2DispatchOnce(ports(db, x), true)).class, "no_work");
    assert.equal(x.count("create"), 1);
    assert.equal(db.effects.pa, undefined);
  }
});

test("single create: completion failure after confirmed X keeps the same id and is never re-sent", async () => {
  const db = new FakeDb();
  const x = new FakeX();
  db.failCompletion.add("pa");
  db.addPost({ id: "pa", brand: "brand_a", account: "acct_a", postType: "useful_tip" });
  const r = await runV2DispatchOnce(ports(db, x), true);
  assert.equal(r.class, "confirmed_db_incomplete");
  const at = [...db.attempts.values()][0];
  assert.equal(at.outcome, "x_confirmed_db_incomplete");
  assert.deepEqual(r.xPostIds, [at.xPostId]);
  for (let i = 0; i < 3; i++) assert.equal((await runV2DispatchOnce(ports(db, x), true)).class, "no_work");
  assert.equal(x.count("create"), 1);
  // Operator re-runs the same typed completion with the same id: exactly once.
  const claim = { attemptId: at.id, claimToken: at.token, scheduledPostId: "pa", brandId: "brand_a", socialAccountId: "acct_a", postType: "useful_tip" };
  assert.equal(await db.completeSingle(claim, CONTENT.useful_tip as never, at.xPostId!), "completed");
  assert.equal(await db.completeSingle(claim, CONTENT.useful_tip as never, at.xPostId!), "already_completed");
  assert.equal(db.effects.pa, 1);
});

// --- tip thread ------------------------------------------------------------------

test("tip: 3 parts with a process restart between every part -> exactly 3 creates, chained, one completion", async () => {
  // One provider request per run; completion needs no provider request, so it follows the last part in the same run.
  const db = new FakeDb();
  const x = new FakeX();
  db.addPost({ id: "pt", brand: "brand_a", account: "acct_a", postType: "tip" });
  const classes: string[] = [];
  for (let run = 0; run < 6; run++) {
    // A fresh ports object per run = no in-memory state survives a restart.
    const r = await runV2DispatchOnce(ports(db, x, { prepared: CONTENT.tip3, maxProviderStepsPerRun: 1 }), true);
    classes.push(r.class);
    if (r.class === "completed" || r.class === "no_work") break;
  }
  assert.deepEqual(classes, ["in_progress", "in_progress", "completed"]);
  const creates = x.calls.filter((c) => c.url.endsWith("/2/tweets"));
  assert.equal(creates.length, 3);
  assert.deepEqual(creates.map((c) => (c.body as { text: string }).text), ["part1", "part2", "part3"]);
  const ids = db.steps.get([...db.attempts.keys()][0])!.map((s) => s.provider_object_id);
  assert.deepEqual((creates[1].body as { reply: unknown }).reply, { in_reply_to_tweet_id: ids[0] });
  assert.deepEqual((creates[2].body as { reply: unknown }).reply, { in_reply_to_tweet_id: ids[1] });
  assert.equal(new Set(ids).size, 3);
  assert.equal(db.effects.pt, 1);
  assert.equal((await runV2DispatchOnce(ports(db, x, { prepared: CONTENT.tip3 }), true)).class, "no_work");
  assert.equal(x.count("create"), 3);
});

test("tip: an uncertain part stops the thread; nothing later is ever created", async () => {
  const db = new FakeDb();
  const x = new FakeX();
  x.createScript.push(Response.json({ data: { id: "root" } }, { status: 201 }), Response.json({}, { status: 503 }));
  db.addPost({ id: "pt", brand: "brand_a", account: "acct_a", postType: "tip" });
  const r = await runV2DispatchOnce(ports(db, x, { prepared: CONTENT.tip3 }), true);
  assert.equal(r.class, "provider_uncertain");
  for (let i = 0; i < 3; i++) assert.equal((await runV2DispatchOnce(ports(db, x, { prepared: CONTENT.tip3 }), true)).class, "no_work");
  assert.equal(x.count("create"), 2);
  assert.equal(db.effects.pt, undefined);
});

test("tip: a rejected reply after a confirmed root is recorded as uncertain, not rejected", async () => {
  const db = new FakeDb();
  const x = new FakeX();
  x.createScript.push(Response.json({ data: { id: "root" } }, { status: 201 }), Response.json({}, { status: 403 }));
  db.addPost({ id: "pt", brand: "brand_a", account: "acct_a", postType: "tip" });
  const r = await runV2DispatchOnce(ports(db, x, { prepared: CONTENT.tip2 }), true);
  assert.equal(r.class, "provider_uncertain");
  assert.equal(r.code, "X_THREAD_PARTIAL_X_STEP_REJECTED_403");
  assert.equal([...db.attempts.values()][0].outcome, "x_outcome_uncertain");
});

test("tip: a crash between the X response and recording it blocks forever instead of re-sending", async () => {
  const db = new FakeDb();
  const x = new FakeX();
  db.failFinishOnce = true;
  db.addPost({ id: "pt", brand: "brand_a", account: "acct_a", postType: "tip" });
  const r = await runV2DispatchOnce(ports(db, x, { prepared: CONTENT.tip2 }), true);
  assert.equal(r.class, "blocked_manual_reconciliation");
  for (let i = 0; i < 3; i++) assert.equal((await runV2DispatchOnce(ports(db, x, { prepared: CONTENT.tip2 }), true)).class, "no_work");
  assert.equal(x.count("create"), 1);
});

// --- morning_greeting ----------------------------------------------------------------

test("greeting: media confirmed, restart, create uses exactly that media id; one upload, one create", async () => {
  const db = new FakeDb();
  const x = new FakeX();
  const receipts: string[] = [];
  db.addPost({ id: "pg", brand: "brand_a", account: "acct_a", postType: "morning_greeting" });
  const p = () => ports(db, x, { maxProviderStepsPerRun: 1, afterGreetingPublished: async (_c, id) => { receipts.push(id); } });
  const r1 = await runV2DispatchOnce(p(), true);
  assert.equal(r1.class, "in_progress");
  assert.equal(x.count("media"), 1);
  // Restart: media id comes back from the ledger, not from memory.
  const r3 = await runV2DispatchOnce(p(), true);
  assert.equal(r3.class, "completed");
  assert.equal(x.count("media"), 1);
  assert.equal(x.count("create"), 1);
  const mediaId = db.steps.get([...db.attempts.keys()][0])![0].provider_object_id;
  const create = x.calls.find((c) => c.url.endsWith("/2/tweets"))!;
  assert.deepEqual(create.body, { text: "おはよう", made_with_ai: true, media: { media_ids: [mediaId] } });
  assert.equal([...db.greetingClaims.values()][0].status, "published");
  assert.deepEqual(receipts, [r3.xPostIds![0]]);
  assert.equal((await runV2DispatchOnce(p(), true)).class, "no_work");
});

test("greeting: uncertain create is never replayed and the day claim is failed", async () => {
  const db = new FakeDb();
  const x = new FakeX();
  x.createScript.push(new TypeError("socket reset"));
  db.addPost({ id: "pg", brand: "brand_a", account: "acct_a", postType: "morning_greeting" });
  const r = await runV2DispatchOnce(ports(db, x), true);
  assert.equal(r.class, "provider_uncertain");
  for (let i = 0; i < 3; i++) assert.equal((await runV2DispatchOnce(ports(db, x), true)).class, "no_work");
  assert.equal(x.count("media"), 1);
  assert.equal(x.count("create"), 1);
  assert.equal([...db.greetingClaims.values()][0].status, "failed");
});

test("greeting: a stale JST schedule makes zero X calls of any kind", async () => {
  const db = new FakeDb();
  const x = new FakeX();
  db.addPost({ id: "pg", brand: "brand_a", account: "acct_a", postType: "morning_greeting", scheduleDate: "2026-09-24" });
  const r = await runV2DispatchOnce(ports(db, x), true);
  assert.equal(r.class, "pre_x_terminal");
  assert.equal(r.code, "GREETING_SCHEDULE_DATE_STALE");
  assert.equal(x.calls.length, 0);
  assert.equal(db.greetingClaims.size, 0);
});

test("greeting: an expired token is found before the day claim is taken", async () => {
  const db = new FakeDb();
  const x = new FakeX();
  db.addPost({ id: "pg", brand: "brand_a", account: "acct_a", postType: "morning_greeting" });
  const expired: XClaimCredentialReader = {
    readForClaim: async () => [{ social_account_id: "acct_a", brand_id: "brand_a", platform_user_id: "x_a", access_token: "tok_EXPIRED" }],
  };
  const r = await runV2DispatchOnce({ ...ports(db, x), claimCredentials: expired }, true);
  assert.equal(r.class, "pre_x_retryable");
  assert.equal(r.code, "X_ACCESS_TOKEN_REFRESH_REQUIRED_PRE_X");
  assert.equal(db.greetingClaims.size, 0);
  assert.equal(x.count("media") + x.count("create"), 0);
});

// --- legacy isolation -----------------------------------------------------------------

test("legacy dispatcher is untouched and does not import the v2 dispatcher", async () => {
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert.doesNotMatch(index, /v2_dispatcher|v2_dispatch_ledger_rpc|X_AUTOPOST_V2_DISPATCH|claim_due_post_v2/u);
  assert.match(index, /"claim_due_post",/u);
  const source = (await Deno.readTextFile(new URL("./v2_dispatcher.ts", import.meta.url))).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, "");
  assert.doesNotMatch(source, /claim_due_post\b|postToX|postThreadToX|refreshXTokens|oauth_token_store|loadBrandXTokens|loadBrandContext|Deno\.env|console\./u);
});

// --- Phase1I refresh seam -----------------------------------------------------------

function tokenSwitchingReader(db: FakeDb, current: Record<string, string>): XClaimCredentialReader {
  return {
    readForClaim: async (claim) => {
      const at = db.attempts.get(claim.attemptId);
      if (!at || at.token !== claim.claimToken || at.phase !== "pre_x") throw new Error("X_CLAIM_NOT_PRE_X");
      const acct = ACCOUNTS[at.account];
      return [{ social_account_id: at.account, brand_id: acct.brand, platform_user_id: acct.xid, access_token: current[at.account] }];
    },
  };
}

test("refresh seam: expired token -> one pre-X refresh, attempt settled for re-entry, next run posts once", async () => {
  const db = new FakeDb();
  const x = new FakeX();
  const current: Record<string, string> = { acct_a: "tok_EXPIRED" };
  const refreshed: string[] = [];
  db.addPost({ id: "pa", brand: "brand_a", account: "acct_a", postType: "useful_tip" });
  const p = () => ports(db, x, {
    claimCredentials: tokenSwitchingReader(db, current),
    refreshAccountPreX: async (claim) => {
      // The seam is only reached while the attempt is still pre-X.
      assert.equal(db.attempts.get(claim.attemptId)!.phase, "pre_x");
      refreshed.push(claim.socialAccountId);
      current[claim.socialAccountId] = ACCOUNTS[claim.socialAccountId].token;
      return { postOutcome: "pre_x_retryable", code: "X_ACCESS_TOKEN_REFRESHED_PRE_X", tokenRequests: 1 };
    },
  });
  const r1 = await runV2DispatchOnce(p(), true);
  assert.equal(r1.class, "pre_x_retryable");
  assert.equal(r1.code, "X_ACCESS_TOKEN_REFRESHED_PRE_X");
  assert.equal(r1.refreshRequests, 1);
  assert.equal(r1.createRequests, 0);
  assert.equal(db.posts.get("pa")!.status, "pending");
  const r2 = await runV2DispatchOnce(p(), true);
  assert.equal(r2.class, "completed");
  assert.equal(r2.refreshRequests, 0);
  assert.deepEqual(refreshed, ["acct_a"]);
  assert.equal(x.count("create"), 1);
  assert.equal(x.calls.find((c) => c.url.endsWith("/2/tweets"))!.auth, "Bearer tok_A_secret");
});

test("refresh seam: terminal refresh result fails the post with zero creates; no seam keeps the old behavior", async () => {
  const db = new FakeDb();
  const x = new FakeX();
  db.addPost({ id: "pa", brand: "brand_a", account: "acct_a", postType: "close_report" });
  const r = await runV2DispatchOnce(ports(db, x, {
    claimCredentials: tokenSwitchingReader(db, { acct_a: "tok_EXPIRED" }),
    refreshAccountPreX: async () => ({ postOutcome: "pre_x_terminal", code: "X_REFRESH_BLOCKED_UNCERTAIN", tokenRequests: 0 }),
  }), true);
  assert.equal(r.class, "pre_x_terminal");
  assert.equal(r.code, "X_REFRESH_BLOCKED_UNCERTAIN");
  assert.equal(db.posts.get("pa")!.status, "failed");
  assert.equal(x.count("create"), 0);

  const db2 = new FakeDb();
  db2.addPost({ id: "pb", brand: "brand_a", account: "acct_a", postType: "close_report" });
  const r2 = await runV2DispatchOnce(ports(db2, x, { claimCredentials: tokenSwitchingReader(db2, { acct_a: "tok_EXPIRED" }) }), true);
  assert.equal(r2.class, "pre_x_retryable");
  assert.equal(r2.code, "X_ACCESS_TOKEN_REFRESH_REQUIRED_PRE_X");

  const db3 = new FakeDb();
  db3.addPost({ id: "pc", brand: "brand_a", account: "acct_a", postType: "close_report" });
  const r3 = await runV2DispatchOnce(ports(db3, x, {
    claimCredentials: tokenSwitchingReader(db3, { acct_a: "tok_EXPIRED" }),
    refreshAccountPreX: async () => { throw new Error("boom"); },
  }), true);
  assert.equal(r3.class, "pre_x_terminal");
  assert.equal(r3.code, "X_REFRESH_HELPER_FAILED");
  assert.equal(x.count("create"), 0);
});

test("refresh seam: only for an X-rejected token, never for other identity failures", async () => {
  const db = new FakeDb();
  const x = new FakeX();
  let refreshCalls = 0;
  db.addPost({ id: "pa", brand: "brand_a", account: "acct_a", postType: "useful_tip" });
  const other: XClaimCredentialReader = {
    readForClaim: async () => [{ social_account_id: "acct_a", brand_id: "brand_a", platform_user_id: "x_WRONG", access_token: "tok_A_secret" }],
  };
  const r = await runV2DispatchOnce(ports(db, x, {
    claimCredentials: other,
    refreshAccountPreX: async () => { refreshCalls++; return { postOutcome: "pre_x_retryable", code: "X", tokenRequests: 1 }; },
  }), true);
  assert.equal(r.class, "pre_x_terminal");
  assert.equal(r.code, "X_CREDENTIAL_IDENTITY_MISMATCH");
  assert.equal(refreshCalls, 0);
});

test("refresh seam: greeting refreshes before the day claim; resume after provider start never refreshes", async () => {
  const db = new FakeDb();
  const x = new FakeX();
  const current: Record<string, string> = { acct_a: "tok_EXPIRED" };
  let refreshCalls = 0;
  db.addPost({ id: "pg", brand: "brand_a", account: "acct_a", postType: "morning_greeting" });
  const r = await runV2DispatchOnce(ports(db, x, {
    claimCredentials: tokenSwitchingReader(db, current),
    refreshAccountPreX: async () => { refreshCalls++; return { postOutcome: "pre_x_retryable", code: "X_ACCESS_TOKEN_REFRESHED_PRE_X", tokenRequests: 1 }; },
  }), true);
  assert.equal(r.class, "pre_x_retryable");
  assert.equal(refreshCalls, 1);
  assert.equal(db.greetingClaims.size, 0);
  assert.equal(x.count("media") + x.count("create"), 0);

  // A tip in flight (provider started, root confirmed) with an expired token on resume.
  const db2 = new FakeDb();
  const x2 = new FakeX();
  db2.addPost({ id: "pt", brand: "brand_a", account: "acct_a", postType: "tip" });
  await runV2DispatchOnce(ports(db2, x2, { prepared: CONTENT.tip2, maxProviderStepsPerRun: 1 }), true);
  assert.equal(x2.count("create"), 1);
  let resumeRefreshCalls = 0;
  const expiredResume: XClaimCredentialReader = {
    readForClaim: async () => [{ social_account_id: "acct_a", brand_id: "brand_a", platform_user_id: "x_a", access_token: "tok_EXPIRED" }],
  };
  const r2 = await runV2DispatchOnce(ports(db2, x2, {
    prepared: CONTENT.tip2,
    resumeCredentials: expiredResume,
    refreshAccountPreX: async () => { resumeRefreshCalls++; return { postOutcome: "pre_x_retryable", code: "X", tokenRequests: 1 }; },
  }), true);
  assert.equal(r2.class, "in_progress");
  assert.equal(r2.code, "X_ACCESS_TOKEN_REFRESH_REQUIRED_PRE_X");
  assert.equal(resumeRefreshCalls, 0);
  assert.equal(x2.count("create"), 1);
});
