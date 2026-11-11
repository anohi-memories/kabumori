// G4-02 #15: read-before-rebind recovery evidence (reconnect_recovery.ts), offline. Every request is recorded: the recovery
// may only ever GET, and only final container states become evidence.
import { assertEquals } from "jsr:@std/assert@1";
import { readOnlyFetch, readRecoveryEvidence, type RecoveryCandidate, THREADS_RECOVERY_READ_BUDGET_MS } from "./reconnect_recovery.ts";

const PUID = "17841400000004501";
const TOKEN = "long17841400000004501abcdefghijklmnop";
const CREDENTIAL = { threadsUserId: PUID, accessToken: TOKEN };
const CONTAINER = "18000000000000501";
const TEXT = "結果不明のあとに失効した投稿";
const BEGAN = new Date("2026-11-11T10:00:00Z");
const candidate = (over: Partial<RecoveryCandidate> = {}): RecoveryCandidate => ({ attemptId: "a", containerId: CONTAINER, createdAt: BEGAN, text: TEXT, ...over });

type World = { status?: string; posts?: { id: string; text: string }[]; containerReply?: (url: URL) => Response | Promise<Response> };
function graph(world: World) {
  const calls: { method: string; path: string }[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ method: init?.method ?? "GET", path: url.pathname });
    if ((init?.method ?? "GET") !== "GET") return Promise.resolve(Response.json({ id: "1" }));
    if (url.searchParams.get("access_token") !== TOKEN) return Promise.resolve(Response.json({ error: { code: 190 } }, { status: 400 }));
    if (url.pathname === `/v1.0/${CONTAINER}`) {
      if (world.containerReply) return Promise.resolve(world.containerReply(url));
      return Promise.resolve(Response.json({ id: CONTAINER, status: world.status ?? "FINISHED", error_message: null }));
    }
    if (url.pathname === `/v1.0/${PUID}/threads`) {
      return Promise.resolve(Response.json({
        data: (world.posts ?? []).map((p) => ({ id: p.id, text: p.text, permalink: `https://www.threads.net/@flow_4501/post/C${p.id}`, timestamp: "2026-11-11T10:00:05+0000" })),
      }));
    }
    const post = (world.posts ?? []).find((p) => url.pathname === `/v1.0/${p.id}`);
    if (post) {
      return Promise.resolve(Response.json({ id: post.id, permalink: `https://www.threads.net/@flow_4501/post/C${post.id}`, owner: { id: PUID }, username: "flow_4501", timestamp: "2026-11-11T10:00:05+0000" }));
    }
    return Promise.resolve(Response.json({ error: { code: 100 } }, { status: 400 }));
  };
  return { fetch, calls };
}
const reads = (f: ReturnType<typeof graph>) => readOnlyFetch(f.fetch, Date.now() + THREADS_RECOVERY_READ_BUDGET_MS);
const onlyGets = (f: ReturnType<typeof graph>) => assertEquals(f.calls.filter((c) => c.method !== "GET"), [], "the recovery never writes");

Deno.test("G4-02 #15: PUBLISHED and exactly one post with the exact text -> published, with its permalink (GET only)", async () => {
  const f = graph({ status: "PUBLISHED", posts: [{ id: "18000000000000601", text: TEXT }, { id: "18000000000000602", text: "別の投稿" }] });
  assertEquals(await readRecoveryEvidence(reads(f), CREDENTIAL, candidate()), {
    to: "published", providerPostId: "18000000000000601", permalink: "https://www.threads.net/@flow_4501/post/C18000000000000601",
  });
  onlyGets(f);
});

Deno.test("G4-02 #15: PUBLISHED but the post is ambiguous / not found -> published_unidentified (a post exists, never 'not posted')", async () => {
  const two = graph({ status: "PUBLISHED", posts: [{ id: "18000000000000601", text: TEXT }, { id: "18000000000000602", text: TEXT }] });
  assertEquals(await readRecoveryEvidence(reads(two), CREDENTIAL, candidate()), { to: "published_unidentified", errorCode: "PUBLISHED_POST_AMBIGUOUS" });
  const none = graph({ status: "PUBLISHED", posts: [] });
  assertEquals(await readRecoveryEvidence(reads(none), CREDENTIAL, candidate()), { to: "published_unidentified", errorCode: "PUBLISHED_POST_NOT_FOUND" });
  const unknownText = graph({ status: "PUBLISHED", posts: [{ id: "18000000000000601", text: TEXT }] });
  assertEquals(await readRecoveryEvidence(reads(unknownText), CREDENTIAL, candidate({ text: null })), { to: "published_unidentified", errorCode: "PUBLISHED_POST_NOT_FOUND" });
  onlyGets(two);
  onlyGets(none);
});

Deno.test("G4-02 #15: ERROR / EXPIRED -> failed (the container can never be published)", async () => {
  assertEquals(await readRecoveryEvidence(reads(graph({ status: "ERROR" })), CREDENTIAL, candidate()), { to: "failed", errorCode: "CONTAINER_ERROR" });
  assertEquals(await readRecoveryEvidence(reads(graph({ status: "EXPIRED" })), CREDENTIAL, candidate()), { to: "failed", errorCode: "CONTAINER_EXPIRED" });
});

Deno.test("G4-02 #15: FINISHED / IN_PROGRESS / an unknown status -> no evidence (nothing may be recorded)", async () => {
  for (const status of ["FINISHED", "IN_PROGRESS", "SOMETHING_NEW"]) {
    const f = graph({ status });
    assertEquals(await readRecoveryEvidence(reads(f), CREDENTIAL, candidate()), null, status);
    assertEquals(f.calls.map((c) => c.path), [`/v1.0/${CONTAINER}`], "one container read, nothing else");
  }
});

Deno.test("G4-02 #15: a failed read is no evidence: 5xx, a network error, a rejected token, another container's answer", async () => {
  const replies: ((url: URL) => Response | Promise<Response>)[] = [
    () => new Response("upstream timeout", { status: 503 }),
    () => Promise.reject(new TypeError("network down")),
    () => Response.json({ error: { message: "Error validating access token", code: 190 } }, { status: 400 }),
    () => Response.json({ id: "18000000000000999", status: "PUBLISHED", error_message: null }),
  ];
  for (const containerReply of replies) assertEquals(await readRecoveryEvidence(reads(graph({ containerReply })), CREDENTIAL, candidate()), null);
  // a token of another Threads user is rejected by the provider here -> no evidence
  assertEquals(await readRecoveryEvidence(reads(graph({ status: "PUBLISHED" })), { threadsUserId: PUID, accessToken: "long17841400000009706abcdefghijklmnop" }, candidate()), null);
});

Deno.test("G4-02 #15: the read-only fetch refuses every write and stops at its budget", async () => {
  const f = graph({ status: "PUBLISHED" });
  const ro = reads(f);
  for (const method of ["POST", "DELETE", "PUT", "post"]) {
    let refused = false;
    await ro(`https://graph.threads.net/v1.0/${PUID}/threads_publish`, { method }).catch(() => (refused = true));
    assertEquals(refused, true, method);
  }
  assertEquals(f.calls, [], "nothing reached the network");
  let spent = false;
  await readOnlyFetch(f.fetch, Date.now() - 1)(`https://graph.threads.net/v1.0/${CONTAINER}`).catch(() => (spent = true));
  assertEquals(spent, true);
  // a read that outlives the budget is aborted -> no evidence
  const slow = (_: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  const t0 = performance.now();
  assertEquals(await readRecoveryEvidence(readOnlyFetch(slow, Date.now() + 50), CREDENTIAL, candidate()), null);
  assertEquals(performance.now() - t0 < 2_000, true, "bounded by the budget");
});
