// MOCK_ONLY: environment, connection factory, credential port and send port are fakes; no database or network.
import assert from "node:assert/strict";
import test from "node:test";
import type { PgConnect } from "./postgres_db.ts";
import type { ThreadsCredentialPort, ThreadsSendPort } from "./threads_dispatch.ts";
import {
  createThreadsWorkerHandler, THREADS_CREDENTIALS_NOT_CONNECTED, THREADS_RESERVATION_WORKER_ENABLED, THREADS_SEND_NOT_CONNECTED,
} from "./threads_worker_http.ts";

const SECRET = "worker-secret-0123456789abcdef-0123456789";
const RID = "11111111-1111-4111-8111-111111111111";
const LEASE = "22222222-2222-4222-8222-222222222222";
const GEN = "b".repeat(64);
const TOKEN = "fake-threads-token-0123456789";
const env = (values: Record<string, string>) => {
  const read: string[] = [];
  return { read, get: (name: string) => { read.push(name); return values[name]; } };
};
const FULL = { POSTONA_RESV_WORKER_SECRET: SECRET, POSTONA_RESV_WORKER_DATABASE_URL: "postgres://worker@db.example.invalid/postgres" };
const post = (secret?: string, method = "POST") => new Request("https://fn.example/postona-threads-reservation-worker", {
  method, headers: secret === undefined ? {} : { "x-postona-worker-secret": secret }, body: method === "POST" ? "{}" : undefined,
});
const counting = () => {
  let connects = 0;
  const connect: PgConnect = () => { connects += 1; return Promise.reject(new Error("no database in this test")); };
  return { connect, count: () => connects };
};
const credentials = (generation = GEN): ThreadsCredentialPort => ({
  available: true,
  credentialFor: (socialAccountId) => Promise.resolve({ socialAccountId, threadsUserId: "17841400000000001", accessToken: TOKEN, generation }),
});
function sender(outcome = { kind: "published", mediaId: "1790", readBack: "confirmed" } as const) {
  const sent: string[] = [];
  const port: ThreadsSendPort = {
    available: true,
    transport: "simulated",
    async send(_credential, text, hooks) {
      if (!(await hooks?.beforePublish())) return { kind: "not_written", stage: "publish", code: "THREADS_PREPUBLISH_REFUSED" };
      sent.push(text);
      return outcome;
    },
  };
  return { port, sent };
}
/** A scripted worker database that answers 007's four functions for ONE due row. */
function oneRowDb(preflight: { verdict: string; credential_generation: string | null } = { verdict: "OK", credential_generation: GEN }) {
  const calls: string[] = [];
  const recorded: unknown[][] = [];
  const connect: PgConnect = () => Promise.resolve({
    client: {
      queryArray(query: { text: string; args?: unknown[] }) {
        if (/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/u.test(query.text)) return Promise.resolve({ rows: [] });
        const fn = /postona_threads_resv\.([a-z_]+)\(/u.exec(query.text)?.[1] ?? "?";
        calls.push(fn);
        if (fn === "claim_due") {
          const first = calls.filter((c) => c === "claim_due").length === 1;
          return Promise.resolve({ rows: [[JSON.stringify(first ? [{ reservation_id: RID, lease_token: LEASE, provider: "threads", social_account_id: "th_a", body: "本文" }] : [])]] });
        }
        if (fn === "preflight") return Promise.resolve({ rows: [[JSON.stringify([preflight])]] });
        if (fn === "record") { recorded.push(query.args ?? []); return Promise.resolve({ rows: [[String(query.args?.[2])]] }); }
        return Promise.resolve({ rows: [["released"]] });
      },
    },
    release: () => Promise.resolve(),
  });
  return { connect, calls, recorded };
}

test("the shipped gate is OFF: 503 before the environment, the body or the database is touched", async () => {
  assert.equal(THREADS_RESERVATION_WORKER_ENABLED, false);
  const e = env(FULL);
  const db = counting();
  const response = await createThreadsWorkerHandler(e, { connect: db.connect, credentials: credentials(), sender: sender().port })(post(SECRET));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, code: "NOT_AVAILABLE" });
  assert.deepEqual(e.read, []);
  assert.equal(db.count(), 0);
});

test("behind the gate: method, configuration and the worker secret come first (401 / 405 / 503), nothing claimed", async () => {
  const db = counting();
  const on = (values: Record<string, string>) => createThreadsWorkerHandler(env(values), { enabled: true, connect: db.connect, credentials: credentials(), sender: sender().port });
  assert.equal((await on(FULL)(post(SECRET, "GET"))).status, 405);
  assert.deepEqual(await (await on({ POSTONA_RESV_WORKER_SECRET: "short" })(post("short"))).json(), { ok: false, code: "NOT_CONFIGURED" });
  for (const given of [undefined, "", SECRET.slice(0, -1), SECRET + "x"]) {
    const response = await on(FULL)(post(given));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { ok: false, code: "WORKER_AUTH_REQUIRED" });
  }
  assert.equal(db.count(), 0);
});

test("G4's ports NOT CONNECTED (the production default): 200 notAvailable, claims nothing, opens no connection", async () => {
  assert.equal(THREADS_CREDENTIALS_NOT_CONNECTED.available, false);
  assert.equal(THREADS_SEND_NOT_CONNECTED.available, false);
  for (const over of [{}, { credentials: credentials() }, { sender: sender().port }]) {
    const db = counting();
    const response = await createThreadsWorkerHandler(env(FULL), { enabled: true, connect: db.connect, ...over })(post(SECRET));
    const body = await response.json();
    assert.deepEqual([response.status, body.report.notAvailable, body.report.claimed, body.report.sends], [200, true, 0, 0]);
    assert.equal(db.count(), 0);
  }
});

test("one due row: claim -> preflight -> send with the pre-publish re-check -> record published; the answer has counts only (no token, text, id)", async () => {
  const db = oneRowDb();
  const s = sender();
  const response = await createThreadsWorkerHandler(env(FULL), { enabled: true, connect: db.connect, credentials: credentials(), sender: s.port })(post(SECRET));
  const text = await response.text();
  const body = JSON.parse(text);
  assert.equal(response.status, 200);
  assert.deepEqual([body.report.claimed, body.report.sends, body.report.published, body.report.prepublishRechecks], [1, 1, 1, 1]);
  assert.deepEqual(db.calls, ["claim_due", "preflight", "preflight", "record"]);
  assert.deepEqual(db.recorded, [[RID, LEASE, "published", "1790", "PUBLISHED", "simulated"]]);
  assert.deepEqual(s.sent, ["本文"]);
  for (const secret of [TOKEN, "本文", "1790", "th_a", RID, LEASE]) assert.ok(!text.includes(secret), `the answer leaks ${secret}`);
});

test("a credential of another generation is never sent (failed_before_send CREDENTIAL_GENERATION_CHANGED); a refused preflight sends nothing", async () => {
  const changed = oneRowDb();
  const s1 = sender();
  const r1 = await (await createThreadsWorkerHandler(env(FULL), { enabled: true, connect: changed.connect, credentials: credentials("c".repeat(64)), sender: s1.port })(post(SECRET))).json();
  assert.deepEqual([r1.report.sends, r1.report.failedBeforeSend, s1.sent.length], [0, 1, 0]);
  assert.deepEqual(changed.recorded.map((a) => [a[2], a[4]]), [["failed_before_send", "CREDENTIAL_GENERATION_CHANGED"]]);
  const refused = oneRowDb({ verdict: "NOT_PUBLISHABLE", credential_generation: null });
  const s2 = sender();
  const r2 = await (await createThreadsWorkerHandler(env(FULL), { enabled: true, connect: refused.connect, credentials: credentials(), sender: s2.port })(post(SECRET))).json();
  assert.deepEqual([r2.report.sends, r2.report.skipped, s2.sent.length, refused.recorded.length], [0, 1, 0, 0]);
});

test("an unknown publish is recorded uncertain once; the claim store failing is 503 STORE_UNAVAILABLE with nothing sent", async () => {
  const db = oneRowDb();
  const s = sender({ kind: "unknown", stage: "publish", code: "THREADS_UNAVAILABLE" } as never);
  const r = await (await createThreadsWorkerHandler(env(FULL), { enabled: true, connect: db.connect, credentials: credentials(), sender: s.port })(post(SECRET))).json();
  assert.deepEqual([r.report.sends, r.report.uncertain], [1, 1]);
  assert.deepEqual(db.recorded.map((a) => [a[2], a[3], a[4]]), [["uncertain", null, "THREADS_UNAVAILABLE"]]);
  const broken = counting();
  const s2 = sender();
  const response = await createThreadsWorkerHandler(env(FULL), { enabled: true, connect: broken.connect, credentials: credentials(), sender: s2.port })(post(SECRET));
  assert.deepEqual([response.status, await response.json(), s2.sent.length], [503, { ok: false, code: "STORE_UNAVAILABLE" }, 0]);
});

test("the run budget: past the deadline nothing more is sent, the claimed row is handed back (never left to age into uncertain)", async () => {
  const db = oneRowDb();
  const s = sender();
  let t = 0;
  const r = await (await createThreadsWorkerHandler(env(FULL), { enabled: true, connect: db.connect, credentials: credentials(), sender: s.port, runBudgetMs: 10, now: () => (t += 20) })(post(SECRET))).json();
  assert.deepEqual([r.report.claimed, r.report.sends, r.report.released, r.report.stopped, s.sent.length], [1, 0, 1, true, 0]);
  assert.deepEqual(db.calls, ["claim_due", "release_unsent"]);
});

test("source: the worker handler and its store log nothing, read no Deno.env / Vault / service-role key and open no network client of their own", async () => {
  for (const file of ["threads_worker_http.ts", "threads_worker_store.ts"]) {
    const source = (await Deno.readTextFile(new URL(file, import.meta.url))).replace(/^\s*(\/\/|\*|\/\*\*).*$/gmu, "");
    for (const banned of [/console\./u, /Deno\.env/u, /\bfetch\(/u, /service_role/u, /vault/iu, /Deno\.serve/u]) {
      assert.doesNotMatch(source, banned, `${file}: ${banned}`);
    }
  }
  const http = await Deno.readTextFile(new URL("threads_worker_http.ts", import.meta.url));
  assert.match(http, /export const THREADS_RESERVATION_WORKER_ENABLED = false as const;/u);
});
