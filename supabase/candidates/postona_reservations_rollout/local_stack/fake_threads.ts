// TEST ONLY (G3-02 #27). Never deployed. The fake Threads Graph API the Threads worker e2e twin hands to G4's REAL two-step send port
// (G4 PR #701 threads_send_port.ts, blob-pinned and copied read-only by run.sh), and the fake credential snapshot it passes as the credential
// port. Only https://graph.threads.net/v1.0/... is answered (anything else is refused; nothing leaves the machine):
//   POST {user}/threads           container  -> {id}          GET {container}?fields=id,status,...  status -> FINISHED
//   POST {user}/threads_publish   publish    -> {id}          GET {media}?fields=id,permalink,owner  readback -> same id + permalink
// Each call is recorded in g3ls_test.threads_calls (step, the access token's SHA-256 -- never the token -- and the text of a container) and
// answered as g3ls_test.threads_mode says:
//   ok; container_reject (400, Graph code 100: nothing created); container_unknown (a broken connection: maybe a container);
//   status_hold (the status read parks in pg_sleep(4) as application_name g3ls-threads-fake-hold first, so the test can change the world
//   between the container and the publish); publish_reject (400, Graph code 190: not published); publish_unknown (a broken connection:
//   maybe published); readback_unknown (the read-back answers 500: published but unconfirmed).
// The credential snapshot answers what the test wrote into g3ls_test.threads_token_snapshot. It is NOT G4's credential source and proves
// nothing about G4's token read (G4 has not delivered a generation-bound Threads credential statement). Both read / write only the
// g3ls_test schema through a throw-away login (G3LS_TEST_DB_URL).
import type { ThreadsCredentialPort } from "../_shared/postona_reservations/threads_dispatch.ts";
import { localDbConnect } from "./local_transport.ts";

const GRAPH = "https://graph.threads.net/v1.0/";

export function fakeThreadsFor(application: string) {
  const testDb = localDbConnect(Deno.env.get("G3LS_TEST_DB_URL") ?? "", application);
  const holdDb = localDbConnect(Deno.env.get("G3LS_TEST_DB_URL") ?? "", "g3ls-threads-fake-hold");
  async function testQuery(text: string, args: unknown[], db = testDb): Promise<unknown[][]> {
    const session = await db();
    try {
      return (await session.client.queryArray({ text, args })).rows;
    } finally {
      await session.release();
    }
  }
  /** TEST_ONLY: the fake snapshot the test wrote; not G4's source. */
  const credentials: ThreadsCredentialPort = {
    available: true,
    async credentialFor(socialAccountId: string) {
      const rows = await testQuery("select threads_user_id, token, generation from g3ls_test.threads_token_snapshot where social_account_id = $1", [socialAccountId]);
      return rows.length === 1
        ? { socialAccountId, threadsUserId: String(rows[0][0]), accessToken: String(rows[0][1]), generation: String(rows[0][2]) }
        : null;
    },
  };
  const record = async (step: string, token: string, text: string | null) => {
    const [row] = await testQuery(
      "insert into g3ls_test.threads_calls (step, bearer_sha256, text) values ($1, encode(sha256(convert_to($2, 'UTF8')), 'hex'), $3) returning id, (select mode from g3ls_test.threads_mode)",
      [step, token, text],
    );
    return { id: Number(row[0]), mode: String(row[1]) };
  };
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const graphError = (code: number) => new Response(JSON.stringify({ error: { code, type: "OAuthException" } }), { status: 400 });
  /** TEST_ONLY fake Graph API. */
  async function fakeThreads(input: string, init?: RequestInit): Promise<Response> {
    if (typeof input !== "string" || !input.startsWith(GRAPH)) throw new TypeError("G3LS_EGRESS_REFUSED");
    const url = new URL(input);
    const path = url.pathname.replace(/^\/v1\.0\//u, "");
    if (init?.method === "POST") {
      const form = new URLSearchParams(String(init.body ?? ""));
      const token = form.get("access_token") ?? "";
      const container = /^([1-9][0-9]*)\/threads$/u.exec(path);
      if (container) {
        const call = await record("container", token, form.get("text"));
        if (call.mode === "container_reject") return graphError(100);
        if (call.mode === "container_unknown") throw new TypeError("G3LS_FAKE_THREADS_CONNECTION_BROKEN");
        return ok({ id: String(1_000_000 + call.id) });
      }
      const publish = /^([1-9][0-9]*)\/threads_publish$/u.exec(path);
      if (publish) {
        const call = await record("publish", token, null);
        if (call.mode === "publish_reject") return graphError(190);
        if (call.mode === "publish_unknown") throw new TypeError("G3LS_FAKE_THREADS_CONNECTION_BROKEN");
        return ok({ id: String(2_000_000_000 + call.id) });
      }
      throw new TypeError("G3LS_EGRESS_REFUSED");
    }
    if (init?.method === "GET" && /^[1-9][0-9]*$/u.test(path)) {
      const token = url.searchParams.get("access_token") ?? "";
      const fields = url.searchParams.get("fields") ?? "";
      if (fields.startsWith("id,status")) {
        const call = await record("status", token, null);
        if (call.mode === "status_hold") await testQuery("select pg_sleep(4)", [], holdDb);
        return ok({ id: path, status: "FINISHED" });
      }
      if (fields.startsWith("id,permalink")) {
        const call = await record("readback", token, null);
        if (call.mode === "readback_unknown") return new Response("{}", { status: 500 });
        // no `owner` field: G4's read-back checks the owner only when the provider returns one
        return ok({ id: path, permalink: `https://www.threads.net/@g3ls/post/${path}`, username: "g3ls" });
      }
    }
    throw new TypeError("G3LS_EGRESS_REFUSED");
  }
  return { credentials, fakeThreads };
}
