// TEST ONLY (G3-02 #9 / #26). Never deployed. The fake X create endpoint the e2e twins pass as their `fetch` / `xFetch`, and the fake
// credential snapshot they pass as `credentials`. Only POST https://api.x.com/2/tweets is answered (anything else is refused, nothing leaves
// the machine). Each call is recorded in g3ls_test.x_calls (the bearer's SHA-256, never the token) and answered as g3ls_test.x_mode says:
//   ok -> 201 + a numeric id; reject_400 / reject_401 / reject_403 / reject_429 -> that status (X refused before creating anything);
//   http_500 -> 500 (X may or may not have created it); unknown -> a broken connection.
// The credential snapshot answers what the test wrote into g3ls_test.x_token_snapshot. It is NOT G4's source and proves nothing about
// G4's token read. Both read / write only the g3ls_test schema through a throw-away login (G3LS_TEST_DB_URL).
import { X_CREATE_POST_URL } from "../_shared/postona_reservations/x_publisher.ts";
import type { XPostingGenerationCredentialSource } from "../_shared/postona_reservations/x_credential_generation.ts";
import { localDbConnect } from "./local_transport.ts";

export function fakeXFor(application: string) {
  const testDb = localDbConnect(Deno.env.get("G3LS_TEST_DB_URL") ?? "", application);
  async function testQuery(text: string, args: unknown[]): Promise<unknown[][]> {
    const session = await testDb();
    try {
      return (await session.client.queryArray({ text, args })).rows;
    } finally {
      await session.release();
    }
  }
  /** TEST_ONLY: the fake snapshot the test wrote; not G4's source. */
  const credentials: XPostingGenerationCredentialSource = {
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
    const refused = /^reject_(400|401|403|429)$/u.exec(mode);
    if (refused) return new Response(JSON.stringify({ title: "Refused" }), { status: Number(refused[1]) });
    if (mode === "http_500") return new Response(JSON.stringify({ title: "Internal Error" }), { status: 500 });
    throw new TypeError("G3LS_FAKE_X_CONNECTION_BROKEN");
  }
  return { credentials, fakeX };
}
