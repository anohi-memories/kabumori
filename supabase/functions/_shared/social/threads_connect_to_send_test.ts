// Offline: no --allow-net, no --allow-env (read only, for the isolation scan). Every port is a fake writing to ONE
// shared log, so the order across G5, the account read, the credential statement and Threads is asserted.
//   deno test --no-config --cached-only --allow-read=. supabase/functions/_shared/social/threads_connect_to_send_test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type { FetchLike } from "./threads_publish_contract.ts";
import type { ThreadsAccountBinding, ThreadsConnectFlowContext } from "./threads_account_binding.ts";
import {
  createGatedThreadsVerticalPath,
  createThreadsVerticalPath,
  THREADS_VERTICAL_PATH_ENABLED,
  type ThreadsVerticalDeps,
} from "./threads_connect_to_send.ts";

const ALICE = "0b6a8c1e-2d3f-4a5b-8c7d-9e0f1a2b3c4d";
const BOB = "7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const ACCOUNT = "3f6c1b8e-5d2a-4c7f-9e1b-0a2b3c4d5e6f";
const BRAND = "brand_alice_personal";
const USER = "17841400000000001";
const TOKEN = "THfaketoken0123456789abcdef";
const GEN = "a".repeat(64);
/** Synthetic, tests only: G5-02 names x_autopost, which G4 has not adopted (see the doc). */
const TEST_KEY = "postona_threads_test";
const NOW = 1_760_800_000_000;
const PERMALINK = "https://www.threads.net/@postona_tester/post/AbC_123";

const receipt = { ok: true, status: "connected", provider: "threads", social_account_id: ACCOUNT, publish_enabled: false, token_expires_at: "2026-12-18T00:00:00.000Z" };
const flow = (over: Partial<ThreadsConnectFlowContext> = {}): ThreadsConnectFlowContext => ({
  startedByPrincipalId: ALICE,
  currentPrincipalId: ALICE,
  brandId: BRAND,
  stateExpiresAtMs: NOW + 60_000,
  receivedAtMs: NOW,
  previousThreadsUserId: null,
  ...over,
});
const accountRow = (over: Record<string, unknown> = {}) => ({
  socialAccountId: ACCOUNT,
  brandId: BRAND,
  platform: "threads",
  platformUserId: USER,
  connectionStatus: "identity_verified",
  hasAccessCredential: true,
  boundByPrincipalId: ALICE,
  bindOwnerEpoch: "3",
  bindLifecycleVersion: "2",
  ...over,
});
const personVerdict = (over: Record<string, unknown> = {}) => ({
  principalId: ALICE,
  brandId: BRAND,
  serviceKey: TEST_KEY,
  verdict: "allow",
  role: "owner",
  entitlementVersion: "ent:v7",
  ownerEpochToken: "g5oe:3:2",
  ...over,
});
const credentialRow = (over: Record<string, unknown> = {}) => ({ social_account_id: ACCOUNT, threads_user_id: USER, access_token: TOKEN, generation: GEN, ...over });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const PUBLISH_FLOW = [
  () => json(200, { id: "111" }),
  () => json(200, { id: "111", status: "FINISHED" }),
  () => json(200, { id: "222" }),
  () => json(200, { id: "222", permalink: PERMALINK, owner: { id: USER } }),
];

type World = {
  account?: unknown;
  person?: unknown;
  credential?: unknown;
  worker?: unknown;
  threads?: Array<() => Response | Error>;
  noStatement?: boolean;
  noWorker?: boolean;
  /** G4-07: successive worker answers (the first check, then the pre-publish hook). */
  workerSeq?: unknown[];
};
function world(w: World = {}) {
  const log: string[] = [];
  const answer = (v: unknown) => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  const threads = [...(w.threads ?? PUBLISH_FLOW)];
  const fetch: FetchLike = (input, init) => {
    log.push(`threads ${init?.method ?? "GET"} ${new URL(input).pathname}`);
    const next = threads.shift();
    if (!next) return Promise.reject(new Error("unexpected request"));
    return answer(next()) as Promise<Response>;
  };
  const deps: ThreadsVerticalDeps = {
    bindingPorts: {
      readThreadsAccount: (id) => (log.push(`account ${id}`), answer("account" in w ? w.account : accountRow())),
      principalVerdict: (p, b, k) => (log.push(`g5-person ${p} ${b} ${k}`), answer("person" in w ? w.person : personVerdict())),
    },
    credentialStatement: w.noStatement ? null : (id, key) => (log.push(`credential ${id} ${key}`), answer("credential" in w ? w.credential : credentialRow())),
    workerVerdict: w.noWorker ? null : (b, k, e, t) => (log.push(`g5-worker ${b} ${k} ${e} ${t}`),
      answer(w.workerSeq ? w.workerSeq.shift() : "worker" in w ? w.worker : "active")),
    fetch,
    transport: "simulated",
    sendOptions: { sleep: () => Promise.resolve() },
  };
  return { deps, log, path: createGatedThreadsVerticalPath(true, TEST_KEY, deps) };
}
async function boundIn(w: ReturnType<typeof world>): Promise<ThreadsAccountBinding> {
  const verdict = await w.path.bind(receipt, flow());
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  return (verdict as { binding: ThreadsAccountBinding }).binding;
}
const post = (binding: ThreadsAccountBinding, over: Record<string, unknown> = {}) => ({ binding, expectedGeneration: GEN, text: "hello threads", ...over });
const threadsCalls = (log: string[]) => log.filter((l) => l.startsWith("threads")).length;

// ---- closed ---------------------------------------------------------------------------------------------------------

test("the deployable path is closed: no account read, no G5, no token read, no request; it declares the real transport", async () => {
  assert.equal(THREADS_VERTICAL_PATH_ENABLED, false);
  const w = world();
  const deployable = createThreadsVerticalPath(w.deps);
  assert.equal(deployable.available, false);
  assert.equal(deployable.transport, "threads");
  assert.equal(deployable.credentials.available, false);
  assert.equal(deployable.sender.available, false);
  assert.deepEqual(await deployable.bind(receipt, flow()), { ok: false, code: "BINDING_DISABLED" });
  const forged = Object.freeze({ socialAccountId: ACCOUNT, brandId: BRAND, threadsUserId: USER, principalId: ALICE, serviceKey: TEST_KEY, ownerEpoch: "3", lifecycleVersion: "2", entitlementVersion: "v" });
  assert.deepEqual(await deployable.postOnce(post(forged)), { kind: "refused", code: "PATH_DISABLED" });
  assert.equal(await deployable.credentials.credentialFor(ACCOUNT), null);
  assert.deepEqual(await deployable.sender.send({ threadsUserId: USER, accessToken: TOKEN }, "x"), { kind: "not_written", stage: "container", code: "THREADS_SEND_DISABLED" });
  assert.deepEqual(w.log, []);
});

test("an undecided key, or x_autopost before G4 adopts it, closes bind and post before any port", async () => {
  for (const key of [null, "x_autopost", "kabumori"]) {
    const w = world();
    const p = createGatedThreadsVerticalPath(true, key, w.deps);
    assert.equal(p.available, false);
    assert.deepEqual(await p.bind(receipt, flow()), { ok: false, code: "SERVICE_KEY_UNDECIDED" });
    const forged = Object.freeze({ socialAccountId: ACCOUNT, brandId: BRAND, threadsUserId: USER, principalId: ALICE, serviceKey: key, ownerEpoch: "3", lifecycleVersion: "2", entitlementVersion: "v" });
    assert.deepEqual(await p.postOnce(post(forged as ThreadsAccountBinding)), { kind: "refused", code: "SERVICE_KEY_UNDECIDED" });
    assert.deepEqual(w.log, [], String(key));
  }
});

test("today's PR #124 row (no owner epoch recorded at binding) is NOT a binding: refused at bind, nothing posted", async () => {
  const w = world({ account: accountRow({ bindOwnerEpoch: null }) });
  assert.deepEqual(await w.path.bind(receipt, flow()), { ok: false, code: "BIND_EPOCH_UNRECORDED" });
  assert.deepEqual(w.log, [`account ${ACCOUNT}`, `g5-person ${ALICE} ${BRAND} ${TEST_KEY}`]);
});

// ---- the whole path ---------------------------------------------------------------------------------------------------

test("connect -> bind -> one post: G5 person, account, credential, G5 worker LAST, then Threads; published and read back", async () => {
  const w = world();
  assert.equal(w.path.available, true);
  assert.equal(w.path.transport, "simulated");
  const binding = await boundIn(w);
  const result = await w.path.postOnce(post(binding));
  assert.deepEqual(result, { kind: "sent", outcome: { kind: "published", mediaId: "222", readBack: "confirmed" }, transport: "simulated" });
  assert.deepEqual(w.log, [
    `account ${ACCOUNT}`,
    `g5-person ${ALICE} ${BRAND} ${TEST_KEY}`,
    `credential ${ACCOUNT} ${TEST_KEY}`,
    `g5-worker ${BRAND} ${TEST_KEY} 3 2`,
    "threads POST /v1.0/17841400000000001/threads",
    "threads GET /v1.0/111",
    `g5-worker ${BRAND} ${TEST_KEY} 3 2`, // G4-07: the pre-publish hook asks again once the container is ready
    "threads POST /v1.0/17841400000000001/threads_publish",
    "threads GET /v1.0/222",
  ]);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("the wrong person or brand never binds, and a duplicate callback is the same verdict with no write", async () => {
  for (const [f, code] of [[flow({ currentPrincipalId: BOB }), "PRINCIPAL_CHANGED"], [flow({ brandId: "brand_bob" }), "BRAND_MISMATCH"]] as const) {
    const w = world();
    assert.deepEqual(await w.path.bind(receipt, f), { ok: false, code });
    assert.equal(w.log.some((l) => l.startsWith("credential") || l.startsWith("threads")), false);
  }
  const w = world();
  const first = await w.path.bind(receipt, flow());
  assert.deepEqual(await w.path.bind(receipt, flow()), first);
  assert.equal(w.log.length, 4); // two reads each; no credential, no request, nothing written
});

test("forged or incomplete bindings are refused before any port (owner epoch missing included)", async () => {
  const w = world();
  const good = await boundIn(w);
  w.log.length = 0;
  const cases: [unknown, string][] = [
    [{ ...good }, "BINDING_INVALID"], // not frozen: not produced by bind
    [Object.freeze({ ...good, serviceKey: "x_autopost" }), "BINDING_INVALID"],
    [Object.freeze({ ...good, threadsUserId: "0" }), "BINDING_INVALID"],
    [Object.freeze({ ...good, socialAccountId: "nope" }), "BINDING_INVALID"],
    [Object.freeze({ ...good, ownerEpoch: null }), "OWNER_EPOCH_MISSING"],
    [Object.freeze({ ...good, ownerEpoch: "0" }), "OWNER_EPOCH_MISSING"],
    [Object.freeze({ ...good, ownerEpoch: 3 }), "OWNER_EPOCH_MISSING"], // a JS number is refused, never rounded
    [Object.freeze({ ...good, ownerEpoch: "9223372036854775808" }), "OWNER_EPOCH_MISSING"],
    [Object.freeze({ ...good, lifecycleVersion: null }), "LIFECYCLE_VERSION_MISSING"],
    [Object.freeze({ ...good, lifecycleVersion: "0" }), "LIFECYCLE_VERSION_MISSING"],
    [Object.freeze({ ...good, lifecycleVersion: 2 }), "LIFECYCLE_VERSION_MISSING"],
    [null, "BINDING_INVALID"],
  ];
  for (const [binding, code] of cases) {
    assert.deepEqual(await w.path.postOnce(post(binding as ThreadsAccountBinding)), { kind: "refused", code }, code);
  }
  assert.deepEqual(await w.path.postOnce(post(good, { expectedGeneration: "A".repeat(64) })), { kind: "refused", code: "BINDING_INVALID" });
  assert.deepEqual(await w.path.postOnce(post(good, { text: "" })), { kind: "refused", code: "TEXT_INVALID" });
  assert.deepEqual(w.log, []);
});

test("missing statement or worker verdict: no token read, no request", async () => {
  for (const [opts, code] of [[{ noWorker: true }, "WORKER_VERDICT_UNAVAILABLE"], [{ noStatement: true }, "CREDENTIAL_UNAVAILABLE"]] as const) {
    const w = world(opts);
    assert.equal(w.path.available, false);
    const binding = await boundIn(w);
    w.log.length = 0;
    assert.deepEqual(await w.path.postOnce(post(binding)), { kind: "refused", code });
    assert.deepEqual(w.log, []);
  }
});

test("expired / revoked / owner-changed credential, another identity, another generation: no G5 worker call, no request", async () => {
  const cases: [unknown, string][] = [
    [null, "CREDENTIAL_UNAVAILABLE"], // the statement refused (expired, revoked, owner moved)
    [new Error(`db ${TOKEN}`), "CREDENTIAL_UNAVAILABLE"],
    [credentialRow({ threads_user_id: "17841499999999999" }), "CREDENTIAL_IDENTITY_CHANGED"],
    [credentialRow({ generation: "b".repeat(64) }), "GENERATION_CHANGED"],
  ];
  for (const [credential, code] of cases) {
    const w = world({ credential });
    const binding = await boundIn(w);
    w.log.length = 0;
    assert.deepEqual(await w.path.postOnce(post(binding)), { kind: "refused", code }, code);
    assert.deepEqual(w.log, [`credential ${ACCOUNT} ${TEST_KEY}`]);
  }
  const w = world({ credential: credentialRow({ generation: "b".repeat(64) }) });
  assert.equal((await w.path.postOnce(post(await boundIn(w), { expectedGeneration: null }))).kind, "sent"); // no expectation given
});

test("G5 worker verdict LAST: A->B->A, a stopped service, deletion, unknown or failing answers stop the request", async () => {
  for (const answer of ["OWNER_EPOCH_CHANGED", "SERVICE_NOT_ACTIVE", "SERVICE_GENERATION_CHANGED", "ACCOUNT_DELETION_IN_PROGRESS", "EXPECTED_LIFECYCLE_VERSION_REQUIRED", "SERVICE_STATE_UNKNOWN"]) {
    const w = world({ worker: answer });
    const binding = await boundIn(w);
    assert.deepEqual(await w.path.postOnce(post(binding)), { kind: "refused", code: answer });
    assert.equal(threadsCalls(w.log), 0);
  }
  for (const [answer, code] of [["ACTIVE", "WORKER_VERDICT_UNKNOWN"], [true, "WORKER_VERDICT_UNKNOWN"], [{ v: "active" }, "WORKER_VERDICT_UNKNOWN"],
    // G4-08: the pre-G5-04 names are no longer G5's answers
    ["SERVICE_REACTIVATED_SINCE_BIND", "WORKER_VERDICT_UNKNOWN"], ["BOUND_AT_REQUIRED", "WORKER_VERDICT_UNKNOWN"], ["FACTS_UNAVAILABLE", "WORKER_VERDICT_UNKNOWN"],
    [new Error("down"), "WORKER_VERDICT_UNAVAILABLE"]] as const) {
    const w = world({ worker: answer });
    assert.deepEqual(await w.path.postOnce(post(await boundIn(w))), { kind: "refused", code });
    assert.equal(threadsCalls(w.log), 0);
  }
});

test("an unknown publish or an unconfirmed read-back is returned as is and never resent", async () => {
  const unknownPublish = world({ threads: [PUBLISH_FLOW[0], PUBLISH_FLOW[1], () => new Error("timeout")] });
  assert.deepEqual(await unknownPublish.path.postOnce(post(await boundIn(unknownPublish))), {
    kind: "sent",
    outcome: { kind: "unknown", stage: "publish", code: "THREADS_UNAVAILABLE" },
    transport: "simulated",
  });
  assert.equal(threadsCalls(unknownPublish.log), 3);
  const unknownContainer = world({ threads: [() => new Error("reset")] });
  assert.deepEqual((await unknownContainer.path.postOnce(post(await boundIn(unknownContainer)))), {
    kind: "sent",
    outcome: { kind: "unknown", stage: "container", code: "THREADS_UNAVAILABLE" },
    transport: "simulated",
  });
  assert.equal(threadsCalls(unknownContainer.log), 1);
  const unconfirmed = world({ threads: [...PUBLISH_FLOW.slice(0, 3), () => new Error("reset")] });
  assert.deepEqual((await unconfirmed.path.postOnce(post(await boundIn(unconfirmed)))), {
    kind: "sent",
    outcome: { kind: "published", mediaId: "222", readBack: "unknown" },
    transport: "simulated",
  });
  assert.equal(threadsCalls(unconfirmed.log), 4);
});

test("isolation: composes only the three G4 modules; nothing imports it but its test", async () => {
  const source = await Deno.readTextFile(new URL("./threads_connect_to_send.ts", import.meta.url));
  assert.deepEqual([...source.matchAll(/from "([^"]+)"/gu)].map((m) => m[1]).sort(), [
    "./g5_owner_epoch_token.ts",
    "./threads_account_binding.ts",
    "./threads_publish_contract.ts",
    "./threads_send_port.ts",
  ]);
  assert.equal(/\b(fetch\(|Deno\.|console\.)/u.test(source.replace(/^\s*\/\/.*$/gmu, "")), false);
  const importers: string[] = [];
  async function walk(dir: URL, rel: string) {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      if (entry.isDirectory) await walk(new URL(`${entry.name}/`, dir), `${rel}${entry.name}/`);
      else if (/\.(ts|tsx|mjs|js)$/u.test(entry.name) && /(?:from|import\()\s*["'][^"']*\/threads_connect_to_send\.ts["']/u.test(await Deno.readTextFile(new URL(entry.name, dir)))) {
        importers.push(`${rel}${entry.name}`);
      }
    }
  }
  const root = new URL("../../../../", import.meta.url);
  await walk(new URL("supabase/", root), "supabase/");
  await walk(new URL("apps/", root), "apps/");
  assert.deepEqual(importers, ["supabase/functions/_shared/social/threads_connect_to_send_test.ts"]);
});

test("G4-07: the service or owner changes while the container waits -> the pre-publish hook stops the publish request", async () => {
  for (const later of ["OWNER_EPOCH_CHANGED", "SERVICE_NOT_ACTIVE", "SERVICE_GENERATION_CHANGED", "ACCOUNT_DELETION_IN_PROGRESS", new Error("g5 down"), "ACTIVE"]) {
    const w = world({ workerSeq: ["active", later] });
    const result = await w.path.postOnce(post(await boundIn(w)));
    assert.deepEqual(result, { kind: "sent", outcome: { kind: "not_written", stage: "publish", code: "THREADS_PREPUBLISH_REFUSED" }, transport: "simulated" }, String(later));
    assert.deepEqual(w.log.filter((l) => l.startsWith("threads") || l.startsWith("g5-worker")), [
      `g5-worker ${BRAND} ${TEST_KEY} 3 2`,
      "threads POST /v1.0/17841400000000001/threads",
      "threads GET /v1.0/111",
      `g5-worker ${BRAND} ${TEST_KEY} 3 2`,
    ], String(later));
  }
});

test("G4-08: the worker gets the binding's two numbers exactly (decimal text, beyond 2^53), never re-read at send", async () => {
  const big = "9007199254740993";
  const w = world({
    account: accountRow({ bindOwnerEpoch: big, bindLifecycleVersion: "9223372036854775807" }),
    person: personVerdict({ ownerEpochToken: `g5oe:${big}:9223372036854775807` }),
  });
  const binding = await boundIn(w);
  w.log.length = 0;
  const result = await w.path.postOnce(post(binding));
  assert.equal(result.kind, "sent");
  const asked = w.log.filter((l) => l.startsWith("g5"));
  assert.deepEqual(asked, [
    `g5-worker ${BRAND} ${TEST_KEY} ${big} 9223372036854775807`,
    `g5-worker ${BRAND} ${TEST_KEY} ${big} 9223372036854775807`,
  ]); // no g5-person: the numbers are not refreshed at send time
});

test("G4-08: a service ended and restarted since the binding (new generation) never publishes", async () => {
  for (const seq of [["SERVICE_GENERATION_CHANGED"], ["active", "SERVICE_GENERATION_CHANGED"]]) {
    const w = world({ workerSeq: [...seq] });
    const result = await w.path.postOnce(post(await boundIn(w)));
    const expected = seq.length === 1
      ? { kind: "refused", code: "SERVICE_GENERATION_CHANGED" }
      : { kind: "sent", outcome: { kind: "not_written", stage: "publish", code: "THREADS_PREPUBLISH_REFUSED" }, transport: "simulated" };
    assert.deepEqual(result, expected, seq.join(","));
    assert.equal(w.log.some((l) => l.endsWith("/threads_publish")), false);
  }
});
