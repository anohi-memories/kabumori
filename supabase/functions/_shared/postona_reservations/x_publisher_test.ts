// MOCK_ONLY: a fake X (fetch) and a fake credential source; no network, no real token.
import assert from "node:assert/strict";
import test from "node:test";
import { createXReservationPublisher, X_CREATE_POST_URL, X_CREDENTIALS_NOT_CONNECTED, type XPostingCredentialSource } from "./x_publisher.ts";

const TOKEN = "fake-user-access-token-0123456789";
const creds = (token: string | null | Error = TOKEN): XPostingCredentialSource & { asked: string[] } => {
  const asked: string[] = [];
  return {
    available: true,
    asked,
    accessTokenFor(account) {
      asked.push(account);
      return token instanceof Error ? Promise.reject(token) : Promise.resolve(token);
    },
  };
};
type Seen = { url: string; init: RequestInit };
const fakeX = (answer: () => Response | Promise<Response>) => {
  const seen: Seen[] = [];
  const fetch = (url: string, init?: RequestInit) => {
    seen.push({ url, init: init ?? {} });
    return Promise.resolve(answer());
  };
  return { fetch, seen };
};

test("not connected (G4 has not delivered): unavailable, and even a direct call never reaches X", async () => {
  const x = fakeX(() => Response.json({ data: { id: "1" } }, { status: 201 }));
  const publisher = createXReservationPublisher({ credentials: X_CREDENTIALS_NOT_CONNECTED, fetch: x.fetch });
  assert.equal(publisher.available, false);
  assert.deepEqual(await publisher.publish("x_acc", "hello"), { kind: "rejected_before_send", code: "X_CREDENTIALS_UNAVAILABLE" });
  assert.equal(x.seen.length, 0);
});

test("201 with a numeric id is published; the stored text is sent unchanged with the account's own token", async () => {
  const x = fakeX(() => Response.json({ data: { id: "1790000000000000001", text: "本文 🍣" } }, { status: 201 }));
  const source = creds();
  const publisher = createXReservationPublisher({ credentials: source, fetch: x.fetch });
  assert.equal(publisher.available, true);
  assert.deepEqual(await publisher.publish("x_acc", "本文 🍣"), { kind: "published", providerPostId: "1790000000000000001" });
  assert.deepEqual(source.asked, ["x_acc"]);
  assert.equal(x.seen[0].url, X_CREATE_POST_URL);
  assert.equal(x.seen[0].init.method, "POST");
  assert.equal(new Headers(x.seen[0].init.headers).get("authorization"), `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(String(x.seen[0].init.body)), { text: "本文 🍣" });
});

test("X refusals (400/401/403/429) are provably not posted; 5xx, other codes and malformed 201s are unknown", async () => {
  for (const status of [400, 401, 403, 429]) {
    const x = fakeX(() => Response.json({ title: "refused" }, { status }));
    assert.deepEqual(await createXReservationPublisher({ credentials: creds(), fetch: x.fetch }).publish("x_acc", "t"), { kind: "rejected_before_send", code: `X_REJECTED_${status}` });
  }
  for (const status of [500, 502, 503, 504, 200, 202, 409]) {
    const x = fakeX(() => Response.json({}, { status }));
    assert.deepEqual(await createXReservationPublisher({ credentials: creds(), fetch: x.fetch }).publish("x_acc", "t"), { kind: "unknown", code: `X_HTTP_${status}` }, String(status));
  }
  for (const body of ["not json", JSON.stringify({ data: {} }), JSON.stringify({ data: { id: "12a" } }), JSON.stringify({ data: { id: 12 } })]) {
    const x = fakeX(() => new Response(body, { status: 201 }));
    assert.deepEqual(await createXReservationPublisher({ credentials: creds(), fetch: x.fetch }).publish("x_acc", "t"), { kind: "unknown", code: "X_RESPONSE_INVALID" }, body);
  }
});

test("a network error or a timeout may have reached X: unknown, never failed-before-send", async () => {
  const broken = createXReservationPublisher({ credentials: creds(), fetch: () => Promise.reject(new TypeError("connection reset")) });
  assert.deepEqual(await broken.publish("x_acc", "t"), { kind: "unknown", code: "X_TRANSPORT_UNKNOWN" });
  const hanging = createXReservationPublisher({
    credentials: creds(),
    timeoutMs: 20,
    fetch: (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
  });
  assert.deepEqual(await hanging.publish("x_acc", "t"), { kind: "unknown", code: "X_TIMEOUT" });
});

test("no token, a malformed token or a failing credential source never sends; the token never appears in any answer", async () => {
  for (const source of [creds(null), creds(""), creds("short"), creds("has space in the token 0123"), creds(new Error(TOKEN))]) {
    const x = fakeX(() => Response.json({ data: { id: "1" } }, { status: 201 }));
    const answer = await createXReservationPublisher({ credentials: source, fetch: x.fetch }).publish("x_acc", "t");
    assert.deepEqual(answer, { kind: "rejected_before_send", code: "X_CREDENTIALS_UNAVAILABLE" });
    assert.equal(x.seen.length, 0);
  }
  const x = fakeX(() => Response.json({ detail: TOKEN }, { status: 503 }));
  const answer = await createXReservationPublisher({ credentials: creds(), fetch: x.fetch }).publish("x_acc", "t");
  assert.ok(!JSON.stringify(answer).includes(TOKEN));
});

test("source: the publisher reads no Vault / env / refresh token and logs nothing", async () => {
  const source = await Deno.readTextFile(new URL("./x_publisher.ts", import.meta.url));
  for (const banned of ["Deno.env", "vault", "refresh_token", "console.", "service_role"]) assert.ok(!source.includes(banned), banned);
});
