// Offline: no --allow-net, no --allow-env (read only, for the isolation scan); the Threads API is a scripted fake.
//   deno test --no-config --cached-only --allow-read=. supabase/functions/_shared/social/threads_send_port_test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type { FetchLike } from "./threads_publish_contract.ts";
import {
  acceptableServiceKey,
  createGatedThreadsCredentialPort,
  createGatedThreadsSendPort,
  createThreadsCredentialPort,
  createThreadsSendPort,
  parseThreadsCredentialRow,
  THREADS_CREDENTIAL_PORT_ENABLED,
  THREADS_POSTING_SERVICE_KEY,
  THREADS_SEND_PORT_ENABLED,
  type ThreadsSendOutcome,
} from "./threads_send_port.ts";
import { INVALID_SOCIAL_ACCOUNT_IDS, VALID_SOCIAL_ACCOUNT_IDS } from "./social_account_id_cases.ts";

const USER = "17841400000000001";
const TOKEN = "THfaketoken0123456789abcdef";
const CRED = { threadsUserId: USER, accessToken: TOKEN };
const ACCOUNT = "sa_3f6c1b8e5d2a4c7f9e1b0a2b"; // the real social_accounts id shape (G4-12)
const GEN = "a".repeat(64);
const PERMALINK = "https://www.threads.net/@postona_tester/post/AbC_123";

const json = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const graphError = (status: number, code: number) => json(status, { error: { message: `detail ${TOKEN}`, code } });
const CONTAINER_OK = () => json(200, { id: "111" });
const STATUS = (s: string) => () => json(200, { id: "111", status: s });
const PUBLISH_OK = () => json(200, { id: "222" });
const READBACK_OK = () => json(200, { id: "222", permalink: PERMALINK, owner: { id: USER } });

type Step = () => Response | Error;
/** Scripted Threads: one entry per expected request; an extra request fails the test. Records method + path only. */
function fakeThreads(steps: Step[]) {
  const calls: string[] = [];
  const bodies: string[] = [];
  const queue = [...steps];
  const fetch: FetchLike = (input, init) => {
    const url = new URL(input);
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    bodies.push(`${input} ${typeof init?.body === "string" ? init.body : ""}`);
    const next = queue.shift();
    if (!next) return Promise.reject(new Error("unexpected extra request"));
    const answer = next();
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return { fetch, calls, bodies, left: () => queue.length };
}
const sleeps: number[] = [];
/** G3's hook as G3 PR #356 hands it: here it always allows and counts its calls. */
let hookCalls = 0;
const ALLOW = { beforePublish: () => (hookCalls += 1, Promise.resolve(true)) };
const port = (fetch: FetchLike, checks = 3) =>
  createGatedThreadsSendPort(true, "simulated", fetch, {
    containerChecks: checks,
    containerCheckDelayMs: 7,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
const C = "POST /v1.0/17841400000000001/threads";
const S = "GET /v1.0/111";
const P = "POST /v1.0/17841400000000001/threads_publish";
const R = "GET /v1.0/222";

async function run(steps: Step[], expected: ThreadsSendOutcome, calls: string[], text = "hello threads") {
  const fake = fakeThreads(steps);
  const outcome = await port(fake.fetch).send(CRED, text, ALLOW);
  assert.deepEqual(outcome, expected);
  assert.deepEqual(fake.calls, calls);
  assert.equal(fake.left(), 0, "every scripted answer was used");
  assert.equal(JSON.stringify(outcome).includes(TOKEN), false);
  if ("code" in outcome) assert.match(outcome.code, /^[A-Z][A-Z0-9_]{1,63}$/u);
  return fake;
}

// ---- gates ------------------------------------------------------------------------------------------------------

test("the static gates are closed; the key is G5's common POSTONA key (G4-10)", () => {
  assert.equal(THREADS_SEND_PORT_ENABLED, false);
  assert.equal(THREADS_CREDENTIAL_PORT_ENABLED, false);
  assert.equal(THREADS_POSTING_SERVICE_KEY, "x_autopost");
});

test("the deployable send port is unavailable, declares the real transport, and sends nothing", async () => {
  const fake = fakeThreads([]);
  const deployable = createThreadsSendPort(fake.fetch);
  assert.equal(deployable.available, false);
  assert.equal(deployable.transport, "threads");
  assert.deepEqual(await deployable.send(CRED, "hello"), { kind: "not_written", stage: "container", code: "THREADS_SEND_DISABLED" });
  assert.deepEqual(fake.calls, []);
});

test("a mock port is 'simulated' and cannot be relabelled", () => {
  const simulated = port(fakeThreads([]).fetch);
  assert.equal(simulated.available, true);
  assert.equal(simulated.transport, "simulated");
  assert.throws(() => ((simulated as { transport: string }).transport = "threads"));
  assert.equal(createGatedThreadsSendPort(true, "bogus" as "simulated", fakeThreads([]).fetch).transport, "simulated");
  assert.equal(createGatedThreadsSendPort(true, "bogus" as "simulated", fakeThreads([]).fetch).available, false);
});

// ---- send outcomes ------------------------------------------------------------------------------------------------

test("published and read back: four requests in order, token never in a write URL", async () => {
  const fake = await run([CONTAINER_OK, STATUS("FINISHED"), PUBLISH_OK, READBACK_OK], { kind: "published", mediaId: "222", readBack: "confirmed" }, [C, S, P, R]);
  assert.equal(fake.bodies[0].startsWith(`https://graph.threads.net/v1.0/${USER}/threads `), true);
  assert.equal(fake.bodies[0].split(" ")[0].includes(TOKEN), false);
  assert.equal(fake.bodies[2].split(" ")[0].includes(TOKEN), false);
  assert.match(fake.bodies[2], /creation_id=111/u);
});

test("container step: a definite refusal is not_written, anything uncertain is unknown, and nothing follows", async () => {
  await run([() => graphError(400, 100)], { kind: "not_written", stage: "container", code: "THREADS_REQUEST_REJECTED" }, [C]);
  await run([() => graphError(400, 190)], { kind: "not_written", stage: "container", code: "THREADS_TOKEN_INVALID" }, [C]);
  await run([() => graphError(429, 4)], { kind: "not_written", stage: "container", code: "THREADS_RATE_LIMITED" }, [C]);
  await run([() => new Error("connection reset")], { kind: "unknown", stage: "container", code: "THREADS_UNAVAILABLE" }, [C]);
  await run([() => json(500, "{}")], { kind: "unknown", stage: "container", code: "THREADS_UNAVAILABLE" }, [C]);
  await run([() => json(200, "not json")], { kind: "unknown", stage: "container", code: "THREADS_RESPONSE_MALFORMED" }, [C]);
  await run([() => json(200, { id: "abc" })], { kind: "unknown", stage: "container", code: "THREADS_RESPONSE_MALFORMED" }, [C]);
});

test("bad input is refused before any request", async () => {
  for (const [cred, text] of [
    [{ threadsUserId: "0123", accessToken: TOKEN }, "hi"],
    [{ threadsUserId: USER, accessToken: "short" }, "hi"],
    [{ threadsUserId: USER, accessToken: `${TOKEN} x` }, "hi"],
    [null, "hi"],
    [CRED, ""],
    [CRED, "x".repeat(501)],
    [CRED, "a\rb"],
  ] as const) {
    const fake = fakeThreads([]);
    const outcome = await port(fake.fetch).send(cred as typeof CRED, text, ALLOW);
    assert.deepEqual(outcome, { kind: "not_written", stage: "container", code: "THREADS_REQUEST_INVALID" });
    assert.deepEqual(fake.calls, []);
  }
});

test("container wait: never publishes unless FINISHED; ERROR / EXPIRED / not ready / unreadable are no post", async () => {
  await run([CONTAINER_OK, STATUS("ERROR")], { kind: "not_written", stage: "publish", code: "THREADS_CONTAINER_ERROR" }, [C, S]);
  await run([CONTAINER_OK, STATUS("EXPIRED")], { kind: "not_written", stage: "publish", code: "THREADS_CONTAINER_EXPIRED" }, [C, S]);
  await run([CONTAINER_OK, () => new Error("reset")], { kind: "not_written", stage: "publish", code: "THREADS_CONTAINER_STATUS_UNREADABLE" }, [C, S]);
  await run([CONTAINER_OK, () => json(200, { id: "999", status: "FINISHED" })], {
    kind: "not_written",
    stage: "publish",
    code: "THREADS_CONTAINER_STATUS_UNREADABLE",
  }, [C, S]);
  sleeps.length = 0;
  await run([CONTAINER_OK, STATUS("IN_PROGRESS"), STATUS("IN_PROGRESS"), STATUS("IN_PROGRESS")], {
    kind: "not_written",
    stage: "publish",
    code: "THREADS_CONTAINER_NOT_READY",
  }, [C, S, S, S]);
  assert.deepEqual(sleeps, [7, 7]);
  await run([CONTAINER_OK, STATUS("IN_PROGRESS"), STATUS("FINISHED"), PUBLISH_OK, READBACK_OK], { kind: "published", mediaId: "222", readBack: "confirmed" }, [C, S, S, P, R]);
});

test("a container already PUBLISHED that we never published is unknown at the publish step, never published again", async () => {
  await run([CONTAINER_OK, STATUS("PUBLISHED")], { kind: "unknown", stage: "publish", code: "THREADS_CONTAINER_ALREADY_PUBLISHED" }, [C, S]);
});

test("publish step: refused is not_written; lost, 5xx, transient or unreadable is unknown; exactly one publish request", async () => {
  const head = [CONTAINER_OK, STATUS("FINISHED")];
  await run([...head, () => graphError(400, 100)], { kind: "not_written", stage: "publish", code: "THREADS_REQUEST_REJECTED" }, [C, S, P]);
  await run([...head, () => graphError(403, 10)], { kind: "not_written", stage: "publish", code: "THREADS_PERMISSION_MISSING" }, [C, S, P]);
  await run([...head, () => new Error("timeout")], { kind: "unknown", stage: "publish", code: "THREADS_UNAVAILABLE" }, [C, S, P]);
  await run([...head, () => json(502, "{}")], { kind: "unknown", stage: "publish", code: "THREADS_UNAVAILABLE" }, [C, S, P]);
  await run([...head, () => graphError(500, 2)], { kind: "unknown", stage: "publish", code: "THREADS_UNAVAILABLE" }, [C, S, P]);
  await run([...head, () => json(200, { nope: 1 })], { kind: "unknown", stage: "publish", code: "THREADS_RESPONSE_MALFORMED" }, [C, S, P]);
});

test("read-back: another owner or id is a mismatch, a failed read is unknown; the media id is kept, no further request", async () => {
  const head = [CONTAINER_OK, STATUS("FINISHED"), PUBLISH_OK];
  await run([...head, () => json(200, { id: "222", permalink: PERMALINK, owner: { id: "999" } })], { kind: "published", mediaId: "222", readBack: "mismatch" }, [C, S, P, R]);
  await run([...head, () => json(200, { id: "223", permalink: PERMALINK })], { kind: "published", mediaId: "222", readBack: "mismatch" }, [C, S, P, R]);
  await run([...head, () => new Error("reset")], { kind: "published", mediaId: "222", readBack: "unknown" }, [C, S, P, R]);
  await run([...head, () => json(200, { id: "222", permalink: "https://evil.example/x" })], { kind: "published", mediaId: "222", readBack: "unknown" }, [C, S, P, R]);
});

test("send never throws: a failing sleep after the container is an unknown publish, not a failure", async () => {
  const fake = fakeThreads([CONTAINER_OK, STATUS("IN_PROGRESS")]);
  const p = createGatedThreadsSendPort(true, "simulated", fake.fetch, { sleep: () => Promise.reject(new Error("killed")) });
  assert.deepEqual(await p.send(CRED, "hello", ALLOW), { kind: "unknown", stage: "publish", code: "THREADS_UNAVAILABLE" });
  assert.deepEqual(fake.calls, [C, S]);
});

// ---- credential port ------------------------------------------------------------------------------------------------

const ROW = { social_account_id: ACCOUNT, threads_user_id: USER, access_token: TOKEN, generation: GEN };
function statement(answers: unknown[]) {
  const calls: string[] = [];
  const fn = (account: string, key: string) => {
    calls.push(`${account} ${key}`);
    const next = answers.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { fn, calls };
}

test("the deployable credential port is unavailable and never calls the statement", async () => {
  const s = statement([ROW]);
  const deployable = createThreadsCredentialPort(s.fn);
  assert.equal(deployable.available, false);
  assert.equal(await deployable.credentialFor(ACCOUNT), null);
  assert.deepEqual(s.calls, []);
});

test("service key: only the common POSTONA key; the app's, unknown, other spellings or none leave the port unavailable", async () => {
  for (const key of [null, "kabumori", "", "Threads", "a", "postona_threads", "X_AUTOPOST", " x_autopost", "x_autopost ", "x_autopost\n"]) {
    const s = statement([ROW]);
    const p = createGatedThreadsCredentialPort(true, key, s.fn);
    assert.equal(p.available, false, String(key));
    assert.equal(await p.credentialFor(ACCOUNT), null);
    assert.deepEqual(s.calls, []);
  }
  assert.equal(acceptableServiceKey("x_autopost"), true);
  assert.equal(acceptableServiceKey("postona_threads"), false);
  assert.equal(createGatedThreadsCredentialPort(true, "x_autopost", null).available, false);
  assert.equal(createGatedThreadsCredentialPort(false, "x_autopost", statement([]).fn).available, false);
});

test("one statement per lookup, nothing cached: an owner change or a newer generation is what the next call says", async () => {
  const newer = { ...ROW, access_token: `${TOKEN}2`, generation: "b".repeat(64) };
  const s = statement([ROW, newer, null, [ROW]]);
  const p = createGatedThreadsCredentialPort(true, "x_autopost", s.fn);
  assert.equal(p.available, true);
  const first = await p.credentialFor(ACCOUNT);
  assert.deepEqual(first, { socialAccountId: ACCOUNT, threadsUserId: USER, accessToken: TOKEN, generation: GEN });
  assert.equal(Object.isFrozen(first), true);
  assert.equal((await p.credentialFor(ACCOUNT))?.generation, "b".repeat(64));
  assert.equal(await p.credentialFor(ACCOUNT), null); // owner changed / credential stale: the statement refuses
  assert.equal((await p.credentialFor(ACCOUNT))?.generation, GEN);
  assert.deepEqual(s.calls, Array(4).fill(`${ACCOUNT} x_autopost`));
});

test("rows that are not provably this account's current credential are refused", async () => {
  const bad: unknown[] = [
    { ...ROW, social_account_id: "sa_111122224333844455550000" }, // cross-account / cross-brand
    { ...ROW, generation: "A".repeat(64) },
    { ...ROW, generation: "a".repeat(63) },
    { ...ROW, generation: null },
    { ...ROW, threads_user_id: 17841400000000001 },
    { ...ROW, threads_user_id: "0" },
    { ...ROW, access_token: "short" },
    { ...ROW, refresh_token: "x".repeat(20) },
    { social_account_id: ACCOUNT, threads_user_id: USER, access_token: TOKEN },
    [ROW, ROW],
    [],
    null,
    "row",
  ];
  for (const answer of bad) {
    assert.equal(parseThreadsCredentialRow(ACCOUNT, answer), null, JSON.stringify(answer));
    const p = createGatedThreadsCredentialPort(true, "x_autopost", statement([answer]).fn);
    assert.equal(await p.credentialFor(ACCOUNT), null);
  }
  const failing = createGatedThreadsCredentialPort(true, "x_autopost", statement([new Error(`db ${TOKEN}`)]).fn);
  assert.equal(await failing.credentialFor(ACCOUNT), null);
  const s = statement([ROW]);
  const p = createGatedThreadsCredentialPort(true, "x_autopost", s.fn);
  assert.equal(await p.credentialFor("not-a-uuid"), null);
  assert.equal(await p.credentialFor(ACCOUNT.toUpperCase()), null);
  assert.deepEqual(s.calls, []);
});

test("isolation: the module imports only the existing transport; only its test and the G4-03 binding verdict import it", async () => {
  const source = await Deno.readTextFile(new URL("./threads_send_port.ts", import.meta.url));
  assert.deepEqual([...source.matchAll(/from "([^"]+)"/gu)].map((m) => m[1]), ["./threads_publish_contract.ts", "./social_account_id.ts"]);
  assert.equal(/\b(Deno\.|console\.)/u.test(source.replace(/^\s*\/\/.*$/gmu, "")), false);
  const importers: string[] = [];
  async function walk(dir: URL, rel: string) {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      if (entry.isDirectory) await walk(new URL(`${entry.name}/`, dir), `${rel}${entry.name}/`);
      else if (/\.(ts|tsx|mjs|js)$/u.test(entry.name) && /(?:from|import\()\s*["'][^"']*\/threads_send_port\.ts["']/u.test(await Deno.readTextFile(new URL(entry.name, dir)))) {
        importers.push(`${rel}${entry.name}`);
      }
    }
  }
  const root = new URL("../../../../", import.meta.url);
  await walk(new URL("supabase/", root), "supabase/");
  await walk(new URL("apps/", root), "apps/");
  // G4-03 reuses the service-key rule (read-only; it takes no credential and sends nothing).
  assert.deepEqual(importers.sort(), [
    "supabase/functions/_shared/social/threads_account_binding.ts",
    "supabase/functions/_shared/social/threads_connect_to_send.ts", // G4-04 composes the same ports
    "supabase/functions/_shared/social/threads_send_port_test.ts",
  ]);
});

// ---- G4-07: the pre-publish hook (G3 #318 contract, Issue #319 comment 6279580056; G3 PR #356) ----------------------

test("hook: a send without beforePublish is refused before anything is created", async () => {
  for (const hooks of [undefined, null, {}, { beforePublish: true }, { beforePublish: "yes" }]) {
    const fake = fakeThreads([]);
    const outcome = await port(fake.fetch).send(CRED, "hello", hooks as never);
    assert.deepEqual(outcome, { kind: "not_written", stage: "container", code: "THREADS_PREPUBLISH_HOOK_REQUIRED" });
    assert.deepEqual(fake.calls, []);
  }
});

test("hook: anything but true -> no publish request, not_written publish THREADS_PREPUBLISH_REFUSED", async () => {
  const answers: Array<() => Promise<unknown>> = [
    () => Promise.resolve(false),
    () => Promise.reject(new Error(`store down ${TOKEN}`)),
    () => Promise.resolve("true"),
    () => Promise.resolve(1),
    () => Promise.resolve({ ok: true }),
    () => Promise.resolve(undefined),
    () => {
      throw new Error("sync throw");
    },
  ];
  for (const answer of answers) {
    let calls = 0;
    const fake = fakeThreads([CONTAINER_OK, STATUS("FINISHED")]);
    const outcome = await port(fake.fetch).send(CRED, "hello", { beforePublish: () => (calls += 1, answer() as Promise<boolean>) });
    assert.deepEqual(outcome, { kind: "not_written", stage: "publish", code: "THREADS_PREPUBLISH_REFUSED" });
    assert.deepEqual(fake.calls, [C, S]);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(outcome).includes(TOKEN), false);
  }
});

test("hook: awaited exactly once, after the container is FINISHED and before the publish request", async () => {
  const order: string[] = [];
  const fake = fakeThreads([CONTAINER_OK, STATUS("IN_PROGRESS"), STATUS("FINISHED"), PUBLISH_OK, READBACK_OK]);
  const logged: FetchLike = (input, init) => (order.push(`${init?.method ?? "GET"} ${new URL(input).pathname}`), fake.fetch(input, init));
  const outcome = await port(logged).send(CRED, "hello", {
    beforePublish: async () => {
      order.push("hook start");
      await new Promise((r) => setTimeout(r, 15)); // a slow hook: G4 adds no bound of its own
      order.push("hook true");
      return true;
    },
  });
  assert.deepEqual(outcome, { kind: "published", mediaId: "222", readBack: "confirmed" });
  assert.deepEqual(order, [C, S, S, "hook start", "hook true", P, R]);
});

test("hook: not asked when no publish could follow (container refused / unknown / ERROR / not ready / unreadable / PUBLISHED)", async () => {
  const scripts: Step[][] = [
    [() => graphError(400, 100)],
    [() => new Error("reset")],
    [CONTAINER_OK, STATUS("ERROR")],
    [CONTAINER_OK, STATUS("IN_PROGRESS"), STATUS("IN_PROGRESS"), STATUS("IN_PROGRESS")],
    [CONTAINER_OK, () => new Error("reset")],
    [CONTAINER_OK, STATUS("PUBLISHED")],
  ];
  for (const steps of scripts) {
    let calls = 0;
    const fake = fakeThreads(steps);
    await port(fake.fetch).send(CRED, "hello", { beforePublish: () => (calls += 1, Promise.resolve(true)) });
    assert.equal(calls, 0);
    assert.equal(fake.calls.includes(P), false);
  }
});

test("hook: what changes during the container wait is what the hook sees; every change stops the publish", async () => {
  // A synthetic world standing in for G3's store preflight (owner, deletion, service, generation, G4 verification).
  const changes: Array<[string, (w: Record<string, unknown>) => void]> = [
    ["owner changed", (w) => (w.owner = "someone-else")],
    ["account deletion started", (w) => (w.deleting = true)],
    ["service ended", (w) => (w.service = "ended")],
    ["service ended and restarted (new period)", (w) => (w.servicePeriod = 2)],
    ["credential generation changed", (w) => (w.generation = "b".repeat(64))],
    ["G4 verification revoked", (w) => (w.verified = false)],
    ["publish switch off", (w) => (w.publishEnabled = false)],
  ];
  for (const [label, change] of changes) {
    const world: Record<string, unknown> = { owner: "alice", deleting: false, service: "active", servicePeriod: 1, generation: "a".repeat(64), verified: true, publishEnabled: true };
    const before = JSON.stringify(world);
    const fake = fakeThreads([CONTAINER_OK, () => (change(world), json(200, { id: "111", status: "FINISHED" }))]);
    const outcome = await port(fake.fetch).send(CRED, "hello", { beforePublish: () => Promise.resolve(JSON.stringify(world) === before) });
    assert.deepEqual(outcome, { kind: "not_written", stage: "publish", code: "THREADS_PREPUBLISH_REFUSED" }, label);
    assert.equal(fake.calls.includes(P), false, label);
  }
});

test("hook: a closed hook (G3 answers false after its send returned) stops a duplicate / replayed send", async () => {
  let open = true;
  const hooks = { beforePublish: () => Promise.resolve(open) };
  const first = fakeThreads([CONTAINER_OK, STATUS("FINISHED"), PUBLISH_OK, READBACK_OK]);
  assert.equal((await port(first.fetch).send(CRED, "hello", hooks)).kind, "published");
  open = false;
  const again = fakeThreads([CONTAINER_OK, STATUS("FINISHED")]);
  assert.deepEqual(await port(again.fetch).send(CRED, "hello", hooks), { kind: "not_written", stage: "publish", code: "THREADS_PREPUBLISH_REFUSED" });
  assert.equal(again.calls.includes(P), false);
});

test("hook: never called again after send returns", async () => {
  let calls = 0;
  const fake = fakeThreads([CONTAINER_OK, STATUS("FINISHED"), PUBLISH_OK, () => new Error("reset")]);
  await port(fake.fetch).send(CRED, "hello", { beforePublish: () => (calls += 1, Promise.resolve(true)) });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 1);
});

// ---- G4-12: the real social_accounts id shape (G3 U2) -----------------------------------------------------------------

test("G4-12: credentialFor takes every real account id (sa_...) to exactly one statement call for that id", async () => {
  for (const id of VALID_SOCIAL_ACCOUNT_IDS) {
    const s = statement([{ ...ROW, social_account_id: id }]);
    const p = createGatedThreadsCredentialPort(true, "x_autopost", s.fn);
    assert.deepEqual(await p.credentialFor(id), { socialAccountId: id, threadsUserId: USER, accessToken: TOKEN, generation: GEN }, id);
    assert.deepEqual(s.calls, [`${id} x_autopost`]);
  }
});

test("G4-12: an id the table refuses (UUID, case, space, control, Unicode, length) never reaches the statement", async () => {
  const s = statement([]);
  const p = createGatedThreadsCredentialPort(true, "x_autopost", s.fn);
  for (const id of INVALID_SOCIAL_ACCOUNT_IDS) assert.equal(await p.credentialFor(id as string), null, JSON.stringify(String(id)));
  assert.deepEqual(s.calls, []);
});

test("G4-12: a well-formed id still gets only its own row (another account's answer is refused)", async () => {
  const s = statement([{ ...ROW, social_account_id: "sa_x" }]);
  const p = createGatedThreadsCredentialPort(true, "x_autopost", s.fn);
  assert.equal(await p.credentialFor(ACCOUNT), null);
  assert.deepEqual(s.calls, [`${ACCOUNT} x_autopost`]);
});
