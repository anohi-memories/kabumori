// TEST ONLY (G3-02 #9). Never deployed: run.sh copies it into a throw-away local Supabase project only. The real
// postona-x-reservation-worker handler (createWorkerHandler: claim -> 014's generation pin -> ONE credentialFor -> 015's bound pre-send
// check -> one X create -> finish) on the real Edge runtime, with the localtest twin's two differences (the release gate passed as
// enabled; the db container without TLS) and, at the TEST BOUNDARY only, the two overrides the handler already takes for tests:
//   credentials  TEST_ONLY injected credentialFor({ token, generation }): answers the FAKE snapshot the test wrote into
//                g3ls_test.x_token_snapshot. It is NOT G4's source and proves nothing about G4's token read: G4 has not delivered a
//                generation-bound source (the production worker keeps X_GENERATION_CREDENTIALS_NOT_CONNECTED: claim 0, send 0).
//   fetch        a fake X: only POST https://api.x.com/2/tweets is answered (anything else is refused, nothing leaves the machine);
//                each call is recorded in g3ls_test.x_calls (the bearer's SHA-256, never the token) and answered as g3ls_test.x_mode
//                says: ok -> 201 + a numeric id, reject_401 -> 401, unknown -> a broken connection.
// Both read / write only the g3ls_test schema through a throw-away login (G3LS_TEST_DB_URL) that reaches nothing else.
import { createWorkerHandler } from "../postona-x-reservation-worker/http.ts";
import { X_CREATE_POST_URL } from "../_shared/postona_reservations/x_publisher.ts";
import type { XPostingGenerationCredentialSource } from "../_shared/postona_reservations/x_credential_generation.ts";
import { localDbConnect } from "../_shared_g3ls/local_transport.ts";

const testDb = localDbConnect(Deno.env.get("G3LS_TEST_DB_URL") ?? "", "g3ls-x-worker-e2e-test-double");

async function testQuery(text: string, args: unknown[]): Promise<unknown[][]> {
  const session = await testDb();
  try {
    return (await session.client.queryArray({ text, args })).rows;
  } finally {
    await session.release();
  }
}

/** TEST_ONLY: the fake snapshot the test wrote; not G4's source. */
const TEST_ONLY_CREDENTIALS: XPostingGenerationCredentialSource = {
  available: true,
  async credentialFor(socialAccountId: string) {
    const rows = await testQuery("select token, generation from g3ls_test.x_token_snapshot where social_account_id = $1", [socialAccountId]);
    return rows.length === 1 ? { token: String(rows[0][0]), generation: String(rows[0][1]) } : null;
  },
};

/** TEST_ONLY fake X create endpoint. */
async function fakeX(input: string, init?: RequestInit): Promise<Response> {
  if (input !== X_CREATE_POST_URL || init?.method !== "POST") throw new TypeError("G3LS_EGRESS_REFUSED");
  const bearer = new Headers(init.headers).get("authorization") ?? "";
  const text = String((JSON.parse(String(init.body)) as { text?: unknown }).text ?? "");
  const [row] = await testQuery(
    "insert into g3ls_test.x_calls (bearer_sha256, text) values (encode(sha256(convert_to($1, 'UTF8')), 'hex'), $2) returning id, (select mode from g3ls_test.x_mode)",
    [bearer, text],
  );
  const mode = String(row[1]);
  if (mode === "ok") {
    return new Response(JSON.stringify({ data: { id: String(9_000_000_000 + Number(row[0])), text } }), { status: 201, headers: { "content-type": "application/json" } });
  }
  if (mode === "reject_401") return new Response(JSON.stringify({ title: "Unauthorized" }), { status: 401 });
  throw new TypeError("G3LS_FAKE_X_CONNECTION_BROKEN");
}

Deno.serve(createWorkerHandler(Deno.env, {
  enabled: true,
  createConnect: (databaseUrl) => localDbConnect(databaseUrl, "postona-x-reservation-worker"),
  credentials: TEST_ONLY_CREDENTIALS,
  fetch: fakeX,
}));
