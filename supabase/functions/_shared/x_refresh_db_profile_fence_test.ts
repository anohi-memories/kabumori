// G4-02 #8: the fence around the REAL refresh routine (runXTokenRefresh), with a fake ledger and a fake provider.
import assert from "node:assert/strict";
import test from "node:test";
import { runXTokenRefresh, XRefreshLease } from "./x_v2_account_refresh.ts";
import { createXRefreshPrecheck, isPersonalXWorkspaceId, withXRefreshPrecheck, X_REFRESH_DB_PROFILE_MISMATCH } from "./x_refresh_db_profile_fence.ts";

const ACCOUNT = "sa_0123456789abcdef01234567";
const resolveClient = () => ({ clientId: "client", clientSecret: "secret" });

function world(answer: () => Promise<Response>) {
  const calls = { precheck: [] as string[], begin: 0, commit: 0, release: 0, provider: 0 };
  const port = {
    begin() {
      calls.begin += 1;
      return Promise.resolve(new XRefreshLease("lease", "client_ref", "old-refresh-token"));
    },
    commit() {
      calls.commit += 1;
      return Promise.resolve("committed");
    },
    release() {
      calls.release += 1;
      return Promise.resolve("released");
    },
  };
  const precheck = createXRefreshPrecheck({
    supabaseUrl: "https://example.supabase.co/",
    serviceRoleKey: "service-fixture",
    fetchImpl: ((url: string, init: RequestInit) => {
      calls.precheck.push(`${url} ${init.body}`);
      return answer();
    }) as typeof fetch,
  });
  const provider = (() => {
    calls.provider += 1;
    return Promise.resolve(Response.json({ access_token: "new-at", refresh_token: "new-rt", expires_in: 7200 }));
  }) as unknown as typeof fetch;
  const run = () => runXTokenRefresh(withXRefreshPrecheck(port, precheck, () => ACCOUNT), resolveClient, { fetchImpl: provider });
  return { calls, run };
}

test("allow: the routine runs as before; the account id is what is asked about", async () => {
  const w = world(() => Promise.resolve(Response.json("allow")));
  const outcome = await w.run();
  assert.equal(outcome.kind, "refreshed");
  assert.deepEqual([w.calls.begin, w.calls.provider, w.calls.commit], [1, 1, 1]);
  assert.deepEqual(w.calls.precheck, [`https://example.supabase.co/rest/v1/rpc/postona_x_refresh_precheck_v1 {"p_social_account_id":"${ACCOUNT}"}`]);
});

test("anything but allow: not started; no lease, no provider call, no write", async () => {
  for (const [reply, code, retryable] of [
    [() => Response.json({ code: "PGRST202" }, { status: 404 }), X_REFRESH_DB_PROFILE_MISMATCH, false], // full / not installed
    [() => Response.json({ code: "42501" }, { status: 403 }), X_REFRESH_DB_PROFILE_MISMATCH, false], // no privilege
    [() => Response.json({}, { status: 401 }), X_REFRESH_DB_PROFILE_MISMATCH, false],
    [() => Response.json("DB_PROFILE_MISMATCH"), X_REFRESH_DB_PROFILE_MISMATCH, false], // catalog drift
    [() => Response.json({ allow: true }), X_REFRESH_DB_PROFILE_MISMATCH, false],
    [() => new Response("allow"), X_REFRESH_DB_PROFILE_MISMATCH, false], // not JSON
    [() => Response.json("not a code"), X_REFRESH_DB_PROFILE_MISMATCH, false],
    [() => Response.json("SERVICE_NOT_ACTIVE"), "X_REFRESH_PRECHECK_SERVICE_NOT_ACTIVE", false],
    [() => Response.json("DISCONNECTED"), "X_REFRESH_PRECHECK_DISCONNECTED", false],
    [() => Response.json("REFRESH_UNCERTAIN"), "X_REFRESH_PRECHECK_REFRESH_UNCERTAIN", false],
    [() => Response.json("REFRESH_IN_PROGRESS"), "X_REFRESH_IN_PROGRESS", true],
    [() => Response.json({}, { status: 503 }), "X_REFRESH_UNAVAILABLE", true],
  ] as Array<[() => Response, string, boolean]>) {
    const w = world(() => Promise.resolve(reply()));
    const outcome = await w.run();
    assert.deepEqual([outcome.kind, outcome.code, outcome.retryable, outcome.tokenRequests], ["not_started", code, retryable, 0], code);
    assert.deepEqual([w.calls.begin, w.calls.provider, w.calls.commit, w.calls.release], [0, 0, 0, 0], code);
  }
  const offline = world(() => Promise.reject(new TypeError("network")));
  const outcome = await offline.run();
  assert.deepEqual([outcome.kind, outcome.code, outcome.retryable], ["not_started", "X_REFRESH_UNAVAILABLE", true]);
  assert.deepEqual([offline.calls.begin, offline.calls.provider], [0, 0]);
});

test("only begin is fenced: commit and release are the port's own (a single-use token already spent must still be stored)", async () => {
  let asked = 0;
  const port = {
    label: "the port",
    begin: () => Promise.resolve("lease"),
    commit: () => Promise.resolve("committed"),
    release: () => Promise.resolve("released"),
  };
  const fenced = withXRefreshPrecheck(port, () => { asked += 1; return Promise.reject(new Error("REFUSED")); }, () => ACCOUNT);
  assert.equal(await fenced.commit(), "committed");
  assert.equal(await fenced.release(), "released");
  assert.equal(fenced.label, "the port");
  assert.equal(asked, 0);
  await assert.rejects(() => fenced.begin(), /REFUSED/u);
  assert.equal(asked, 1);
});

test("G4-02 #9: only the exact derived id is a personal workspace", () => {
  assert.equal(isPersonalXWorkspaceId("u_0123456789abcdef01234567"), true);
  for (const id of ["kabumori", "ai_salaryman_lab", "brand_future", "u_", "u_0123456789abcdef0123456", "u_0123456789abcdef012345678", "u_0123456789ABCDEF01234567", "xu_0123456789abcdef01234567", "u_0123456789abcdef01234567\n", "", null, undefined, 1]) {
    assert.equal(isPersonalXWorkspaceId(id), false, String(id));
  }
});
