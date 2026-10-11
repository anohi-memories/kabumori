import assert from "node:assert/strict";
import test from "node:test";
import {
  buildThreadsPublishRequest,
  buildThreadsTextContainerRequest,
  checkThreadsText,
  createThreadsTextContainer,
  type FetchLike,
  isThreadsPermalink,
  listRecentThreadsPosts,
  publishThreadsContainer,
  readThreadsContainerStatus,
  readThreadsPublishedPost,
  THREADS_PUBLISH_API,
  THREADS_PUBLISH_ERROR_CODES,
  THREADS_PUBLISH_SCOPES,
  THREADS_TEXT_MAX_LENGTH,
  type ThreadsCredential,
  ThreadsPublishError,
  threadsTextLength,
} from "./threads_publish_contract.ts";

// Fake values only. The token and text are distinctive so any leak into an error is easy to spot.
const USER_ID = "17841405793187218";
const TOKEN = "THQVJfakeLongLivedPublishToken0123456789";
const CREDENTIAL: ThreadsCredential = { threadsUserId: USER_ID, accessToken: TOKEN };
const TEXT = "POSTONAからの手動テスト投稿です。\n2行目。";
const BIG_ODD_ID = "17841405793187219"; // > 2^53 and odd: a JSON number parse would round it
const SENSITIVE = [TOKEN, TEXT];

type Call = { url: string; init?: RequestInit };
function fakeFetch(responses: Array<Response | Error>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      const next = queue.shift();
      if (next === undefined) throw new Error("unexpected extra request");
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
}
const json = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "application/json" } });
const graphError = (status: number, code: number) => json(status, `{"error":{"message":"secret detail ${TOKEN}","type":"OAuthException","code":${code},"fbtrace_id":"A1"}}`);

async function rejects(promise: Promise<unknown>, code: string, outcome: "not_written" | "unknown") {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ThreadsPublishError, `expected ThreadsPublishError, got ${error}`);
    assert.equal(error.code, code);
    assert.equal(error.outcome, outcome);
    assert.equal(error.message, code, "the message is the fixed code only");
    for (const value of SENSITIVE) assert.ok(!String(error.stack ?? "").includes(value) && !JSON.stringify(error).includes(value));
    return;
  }
  assert.fail(`expected ${code}`);
}

// --- Official contract ---------------------------------------------------------------------------------

test("the documented host, version, scopes and limits are pinned", () => {
  assert.deepEqual({ ...THREADS_PUBLISH_API }, { origin: "https://graph.threads.net", version: "v1.0" });
  assert.deepEqual([...THREADS_PUBLISH_SCOPES], ["threads_basic", "threads_content_publish"]);
  assert.equal(THREADS_TEXT_MAX_LENGTH, 500);
});

test("container request: POST /{user-id}/threads, TEXT, the token in the form body only, never auto_publish_text", () => {
  const { url, init } = buildThreadsTextContainerRequest(CREDENTIAL, TEXT);
  assert.equal(url, `https://graph.threads.net/v1.0/${USER_ID}/threads`);
  assert.ok(!url.includes(TOKEN), "no token in the URL");
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, { "content-type": "application/x-www-form-urlencoded" });
  const body = new URLSearchParams(String(init.body));
  assert.deepEqual([...body.keys()].sort(), ["access_token", "media_type", "text"]);
  assert.equal(body.get("media_type"), "TEXT");
  assert.equal(body.get("text"), TEXT, "the exact text, line feed included");
  assert.equal(body.get("access_token"), TOKEN);
  assert.equal(body.get("auto_publish_text"), null);
});

test("publish request: POST /{user-id}/threads_publish with creation_id; token in the body only", () => {
  const { url, init } = buildThreadsPublishRequest(CREDENTIAL, BIG_ODD_ID);
  assert.equal(url, `https://graph.threads.net/v1.0/${USER_ID}/threads_publish`);
  assert.ok(!url.includes(TOKEN));
  const body = new URLSearchParams(String(init.body));
  assert.deepEqual([...body.keys()].sort(), ["access_token", "creation_id"]);
  assert.equal(body.get("creation_id"), BIG_ODD_ID);
});

test("malformed credentials, ids or text are refused before any request", async () => {
  const { fetch, calls } = fakeFetch([]);
  for (const credential of [
    { threadsUserId: "me", accessToken: TOKEN },
    { threadsUserId: "0123", accessToken: TOKEN },
    { threadsUserId: "123/../456", accessToken: TOKEN },
    { threadsUserId: USER_ID, accessToken: "short" },
    { threadsUserId: USER_ID, accessToken: "TH token with spaces 0123456789" },
    { threadsUserId: USER_ID, accessToken: "x".repeat(4097) },
  ]) {
    await rejects(createThreadsTextContainer(fetch, credential, TEXT), "THREADS_REQUEST_INVALID", "not_written");
  }
  await rejects(createThreadsTextContainer(fetch, CREDENTIAL, "   "), "THREADS_REQUEST_INVALID", "not_written");
  await rejects(publishThreadsContainer(fetch, CREDENTIAL, "12a"), "THREADS_REQUEST_INVALID", "not_written");
  await rejects(readThreadsContainerStatus(fetch, CREDENTIAL, "../me"), "THREADS_REQUEST_INVALID", "not_written");
  await rejects(readThreadsPublishedPost(fetch, CREDENTIAL, ""), "THREADS_REQUEST_INVALID", "not_written");
  await rejects(listRecentThreadsPosts(fetch, CREDENTIAL, 0), "THREADS_REQUEST_INVALID", "not_written");
  assert.equal(calls.length, 0);
});

// --- Text ------------------------------------------------------------------------------------------------

test("length: one per character, emojis count their UTF-8 bytes (documented)", () => {
  assert.equal(threadsTextLength("abc"), 3);
  assert.equal(threadsTextLength("日本語"), 3);
  assert.equal(threadsTextLength("😀"), 4);
  assert.equal(threadsTextLength("👍🏽"), 8, "pictograph + skin-tone modifier");
  assert.equal(threadsTextLength("👨‍👩‍👧"), 18, "ZWJ family: 3 x 4 bytes + 2 x 3-byte joiners");
  assert.equal(threadsTextLength("1️⃣"), 7, "keycap: 1 + FE0F (3) + 20E3 (3)");
  assert.equal(threadsTextLength("🇯🇵"), 8, "flag: two regional indicators");
  assert.equal(threadsTextLength("❤️"), 6, "heart (3) + FE0F (3)");
});

test("text checks: empty, too long, too many links, control characters; line feeds and tabs are fine", () => {
  assert.deepEqual(checkThreadsText("こんにちは"), { ok: true, refusal: null, length: 5, links: 0 });
  assert.equal(checkThreadsText("a".repeat(500)).ok, true);
  assert.equal(checkThreadsText("あ".repeat(500)).ok, true, "500 Japanese characters");
  assert.equal(checkThreadsText("a".repeat(501)).refusal, "TOO_LONG");
  assert.equal(checkThreadsText("a".repeat(497) + "😀").refusal, "TOO_LONG", "497 + 4 bytes = 501");
  assert.equal(checkThreadsText("a".repeat(496) + "😀").ok, true, "496 + 4 = 500");
  for (const empty of ["", " ", "\n\n", "\t", "　"]) assert.equal(checkThreadsText(empty).refusal, "EMPTY", JSON.stringify(empty));
  assert.equal(checkThreadsText(42).refusal, "EMPTY");
  assert.equal(checkThreadsText(null).refusal, "EMPTY");
  const links = (n: number) => Array.from({ length: n }, (_, i) => `https://example.com/${i}`).join(" ");
  assert.equal(checkThreadsText(links(5)).ok, true);
  assert.equal(checkThreadsText(links(6)).refusal, "TOO_MANY_LINKS");
  assert.equal(checkThreadsText(`${links(5)} https://example.com/0`).ok, true, "a repeated URL counts once");
  for (const bad of ["a\rb", "a\u0000b", "a\u001bb", "a\u007fb", "a\ud800b", "\udc00"]) {
    assert.equal(checkThreadsText(bad).refusal, "INVALID_CHARACTERS", JSON.stringify(bad));
  }
  assert.equal(checkThreadsText("一行目\n二行目\tタブ").ok, true);
});

// --- Container creation --------------------------------------------------------------------------------

test("container: the id is kept as exact text (a > 2^53 JSON number is not rounded); one request, no redirects", async () => {
  const { fetch, calls } = fakeFetch([json(200, `{"id":${BIG_ODD_ID}}`)]);
  const result = await createThreadsTextContainer(fetch, CREDENTIAL, TEXT);
  assert.equal(result.containerId, BIG_ODD_ID);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.redirect, "error");
  assert.ok(calls[0].init?.signal instanceof AbortSignal, "bounded by a timeout");
  const asString = fakeFetch([json(200, `{"id":"${BIG_ODD_ID}"}`)]);
  assert.equal((await createThreadsTextContainer(asString.fetch, CREDENTIAL, TEXT)).containerId, BIG_ODD_ID);
});

test("container: definite refusals are not_written and classified by Graph error code", async () => {
  const cases: Array<[Response, string]> = [
    [graphError(400, 190), "THREADS_TOKEN_INVALID"],
    [graphError(403, 10), "THREADS_PERMISSION_MISSING"],
    [graphError(403, 200), "THREADS_PERMISSION_MISSING"],
    [graphError(400, 299), "THREADS_PERMISSION_MISSING"],
    [graphError(400, 4), "THREADS_RATE_LIMITED"],
    [graphError(400, 613), "THREADS_RATE_LIMITED"],
    [json(429, "{}"), "THREADS_RATE_LIMITED"],
    [graphError(400, 100), "THREADS_REQUEST_REJECTED"],
    [json(404, "not json at all"), "THREADS_REQUEST_REJECTED"],
  ];
  for (const [response, code] of cases) {
    const { fetch } = fakeFetch([response]);
    await rejects(createThreadsTextContainer(fetch, CREDENTIAL, TEXT), code, "not_written");
  }
});

test("container: anything without a definite answer is unknown (maybe a container, never a post)", async () => {
  const cases: Array<[Response | Error, string]> = [
    [new TypeError("network down"), "THREADS_UNAVAILABLE"],
    [new DOMException("aborted", "AbortError"), "THREADS_UNAVAILABLE"],
    [json(500, "{}"), "THREADS_UNAVAILABLE"],
    [json(503, "{}"), "THREADS_UNAVAILABLE"],
    [json(302, "{}"), "THREADS_UNAVAILABLE"],
    [graphError(400, 2), "THREADS_UNAVAILABLE"],
    [graphError(400, 1), "THREADS_UNAVAILABLE"],
    [json(200, "not json"), "THREADS_RESPONSE_MALFORMED"],
    [json(200, "[]"), "THREADS_RESPONSE_MALFORMED"],
    [json(200, "123"), "THREADS_RESPONSE_MALFORMED"],
    [json(200, "{}"), "THREADS_RESPONSE_MALFORMED"],
    [json(200, `{"id":"abc"}`), "THREADS_RESPONSE_MALFORMED"],
    [json(200, `{"id":1.5}`), "THREADS_RESPONSE_MALFORMED"],
  ];
  for (const [response, code] of cases) {
    const { fetch } = fakeFetch([response]);
    await rejects(createThreadsTextContainer(fetch, CREDENTIAL, TEXT), code, "unknown");
  }
});

// --- Publish -----------------------------------------------------------------------------------------

test("publish: success returns the provider's media id as exact text", async () => {
  const { fetch, calls } = fakeFetch([json(200, `{"id":${BIG_ODD_ID}}`)]);
  assert.deepEqual(await publishThreadsContainer(fetch, CREDENTIAL, "555"), { mediaId: BIG_ODD_ID });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://graph.threads.net/v1.0/${USER_ID}/threads_publish`);
});

test("publish: a definite 4xx is not_written; a lost, 5xx, transient or unreadable answer is unknown", async () => {
  for (const [response, code] of [[graphError(400, 190), "THREADS_TOKEN_INVALID"], [graphError(400, 100), "THREADS_REQUEST_REJECTED"], [json(429, "{}"), "THREADS_RATE_LIMITED"]] as const) {
    await rejects(publishThreadsContainer(fakeFetch([response]).fetch, CREDENTIAL, "555"), code, "not_written");
  }
  for (const [response, code] of [
    [new TypeError("reset"), "THREADS_UNAVAILABLE"],
    [json(500, "{}"), "THREADS_UNAVAILABLE"],
    [graphError(400, 2), "THREADS_UNAVAILABLE"],
    [json(200, "{}"), "THREADS_RESPONSE_MALFORMED"],
    [json(200, "<html>"), "THREADS_RESPONSE_MALFORMED"],
  ] as const) {
    await rejects(publishThreadsContainer(fakeFetch([response]).fetch, CREDENTIAL, "555"), code, "unknown");
  }
});

// --- Status ---------------------------------------------------------------------------------------------

test("status: every documented value maps; the error message is the documented enum only", async () => {
  for (const [provider, status] of [["FINISHED", "finished"], ["IN_PROGRESS", "in_progress"], ["ERROR", "error"], ["EXPIRED", "expired"], ["PUBLISHED", "published"]]) {
    const { fetch, calls } = fakeFetch([json(200, `{"id":"555","status":"${provider}"}`)]);
    assert.deepEqual(await readThreadsContainerStatus(fetch, CREDENTIAL, "555"), { status, errorMessage: null });
    const url = new URL(calls[0].url);
    assert.equal(url.origin + url.pathname, "https://graph.threads.net/v1.0/555");
    assert.equal(url.searchParams.get("fields"), "id,status,error_message");
    assert.equal(calls[0].init?.method, "GET");
  }
  const withMessage = fakeFetch([json(200, `{"id":"555","status":"ERROR","error_message":"UNKNOWN"}`)]);
  assert.deepEqual(await readThreadsContainerStatus(withMessage.fetch, CREDENTIAL, "555"), { status: "error", errorMessage: "UNKNOWN" });
  const freeText = fakeFetch([json(200, `{"id":"555","status":"ERROR","error_message":"token ${TOKEN} bad"}`)]);
  assert.deepEqual(await readThreadsContainerStatus(freeText.fetch, CREDENTIAL, "555"), { status: "error", errorMessage: "UNKNOWN" });
});

test("status: another id or an unknown status is not an answer", async () => {
  await rejects(readThreadsContainerStatus(fakeFetch([json(200, `{"id":"556","status":"FINISHED"}`)]).fetch, CREDENTIAL, "555"), "THREADS_IDENTITY_MISMATCH", "not_written");
  await rejects(readThreadsContainerStatus(fakeFetch([json(200, `{"id":"555","status":"DONE"}`)]).fetch, CREDENTIAL, "555"), "THREADS_RESPONSE_MALFORMED", "not_written");
  await rejects(readThreadsContainerStatus(fakeFetch([json(200, `{"id":"555"}`)]).fetch, CREDENTIAL, "555"), "THREADS_RESPONSE_MALFORMED", "not_written");
  await rejects(readThreadsContainerStatus(fakeFetch([json(500, "{}")]).fetch, CREDENTIAL, "555"), "THREADS_UNAVAILABLE", "not_written");
});

// --- Read-back --------------------------------------------------------------------------------------------

const POST = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ id: BIG_ODD_ID, permalink: "https://www.threads.net/@postona_tester/post/AbC_123", owner: { id: USER_ID }, username: "postona_tester", timestamp: "2026-10-11T03:00:00+0000", ...over });

test("read-back confirms the same id, this owner and a Threads permalink", async () => {
  const { fetch, calls } = fakeFetch([json(200, POST())]);
  assert.deepEqual(await readThreadsPublishedPost(fetch, CREDENTIAL, BIG_ODD_ID), {
    mediaId: BIG_ODD_ID,
    permalink: "https://www.threads.net/@postona_tester/post/AbC_123",
    timestamp: "2026-10-11T03:00:00+0000",
    username: "postona_tester",
  });
  assert.equal(new URL(calls[0].url).searchParams.get("fields"), "id,permalink,owner,username,timestamp");
  // The owner may be absent; the id and permalink are still required.
  const noOwner = fakeFetch([json(200, POST({ owner: undefined }))]);
  assert.equal((await readThreadsPublishedPost(noOwner.fetch, CREDENTIAL, BIG_ODD_ID)).mediaId, BIG_ODD_ID);
});

test("read-back refuses another id, another owner, or a missing / foreign permalink", async () => {
  await rejects(readThreadsPublishedPost(fakeFetch([json(200, POST({ id: "1" }))]).fetch, CREDENTIAL, BIG_ODD_ID), "THREADS_IDENTITY_MISMATCH", "not_written");
  await rejects(readThreadsPublishedPost(fakeFetch([json(200, POST({ owner: { id: "999" } }))]).fetch, CREDENTIAL, BIG_ODD_ID), "THREADS_IDENTITY_MISMATCH", "not_written");
  await rejects(readThreadsPublishedPost(fakeFetch([json(200, POST({ owner: null }))]).fetch, CREDENTIAL, BIG_ODD_ID), "THREADS_RESPONSE_MALFORMED", "not_written");
  for (const permalink of [undefined, "", "http://www.threads.net/@a/post/1", "https://evil.example/@a/post/1", "https://user:pw@threads.net/x", "https://threads.net.evil.example/x", "https://threads.net:8443/x"]) {
    await rejects(readThreadsPublishedPost(fakeFetch([json(200, POST({ permalink }))]).fetch, CREDENTIAL, BIG_ODD_ID), "THREADS_RESPONSE_MALFORMED", "not_written");
  }
  assert.equal(isThreadsPermalink("https://www.threads.com/@a/post/1"), true);
});

test("recent posts listing (reconciliation only) parses ids exactly and refuses odd shapes", async () => {
  const body = `{"data":[{"id":${BIG_ODD_ID},"text":"${"x"}","permalink":"https://www.threads.net/@a/post/1","timestamp":"2026-10-11T03:00:00+0000"},{"id":"42"}]}`;
  const { fetch, calls } = fakeFetch([json(200, body)]);
  const posts = await listRecentThreadsPosts(fetch, CREDENTIAL, 1_760_000_000);
  assert.deepEqual(posts.map((p) => p.mediaId), [BIG_ODD_ID, "42"]);
  assert.equal(posts[1].text, null);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, `/v1.0/${USER_ID}/threads`);
  assert.equal(url.searchParams.get("since"), "1760000000");
  await rejects(listRecentThreadsPosts(fakeFetch([json(200, `{"data":{}}`)]).fetch, CREDENTIAL, 1), "THREADS_RESPONSE_MALFORMED", "not_written");
  await rejects(listRecentThreadsPosts(fakeFetch([json(200, `{"data":[null]}`)]).fetch, CREDENTIAL, 1), "THREADS_RESPONSE_MALFORMED", "not_written");
});

test("the fixed error codes are exactly these", () => {
  assert.deepEqual([...THREADS_PUBLISH_ERROR_CODES], [
    "THREADS_REQUEST_INVALID", "THREADS_TOKEN_INVALID", "THREADS_PERMISSION_MISSING", "THREADS_RATE_LIMITED",
    "THREADS_REQUEST_REJECTED", "THREADS_UNAVAILABLE", "THREADS_RESPONSE_MALFORMED", "THREADS_IDENTITY_MISMATCH",
  ]);
});
