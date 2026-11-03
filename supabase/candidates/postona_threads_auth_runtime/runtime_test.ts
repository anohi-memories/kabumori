import {
  createActorVerifier,
  requireVerified,
  type VerifiedActor,
} from "./verified_actor.ts";
import { createThreadsRuntime } from "./runtime.ts";
import {
  createOwnerTransport,
  type OwnerSqlClient,
} from "./owner_transport.ts";
import { handler } from "../../functions/threads-oauth-connect-user/index.ts";
import { deletionReadiness } from "./deletion_contract.ts";
function check(value: unknown) {
  if (!value) throw new Error("assertion failed");
}
Deno.test("T10 local custody absence never proves provider revoke", () => {
  check(
    !deletionReadiness({
      localTokenCustody: "absent",
      remoteRevocation: "not_confirmed",
    }).confirmedRemoteRevoked,
  );
  check(
    !deletionReadiness({
      localTokenCustody: "absent",
      remoteRevocation: "confirmed_with_provider_evidence",
    }).confirmedRemoteRevoked,
  );
  check(
    deletionReadiness({
      localTokenCustody: "absent",
      remoteRevocation: "confirmed_with_provider_evidence",
      providerEvidenceId: "offline_dummy_proof",
    }).confirmedRemoteRevoked,
  );
});
const uid = "00000000-0000-4000-8000-000000000001";
const sid = "00000000-0000-4000-8000-000000000002";
const expiry = Date.now() + 3600000;
function sdk(
  claims: Record<string, unknown> = {},
  user: { id: string; is_anonymous: boolean } | null = {
    id: uid,
    is_anonymous: false,
  },
  error: unknown = null,
) {
  return {
    getClaims: () =>
      Promise.resolve({
        data: {
          claims: {
            sub: uid,
            session_id: sid,
            role: "authenticated",
            aud: "authenticated",
            is_anonymous: false,
            exp: expiry / 1000,
            ...claims,
          },
        },
        error,
      }),
    getUser: () => Promise.resolve({ data: { user }, error }),
  };
}
const auth = "Bearer offline_dummy_session";
for (
  const [label, claims, user, error] of [
    ["anonymous", { is_anonymous: true }],
    ["missing-session", { session_id: null }],
    ["foreign-subject", { sub: "00000000-0000-4000-8000-000000000099" }],
    ["service-role", { role: "service_role" }],
    ["foreign-audience", { aud: "foreign" }],
    ["expired", { exp: 0 }],
    ["bad-expiry", { exp: NaN }],
    ["claims-signature-error", {}, undefined, new Error("offline_dummy")],
    ["deleted-user", {}, null],
    ["anonymous-user", {}, { id: uid, is_anonymous: true }],
  ] as const
) {
  Deno.test(`verified actor refuses ${label}`, async () => {
    let refused = false;
    try {
      await createActorVerifier(sdk(claims, user, error))(auth);
    } catch {
      refused = true;
    }
    check(refused);
  });
}
Deno.test("valid SDK verified principal sealed; forged object cannot reach owner connection", async () => {
  const actor = await createActorVerifier(sdk())(auth);
  requireVerified(actor);
  let opens = 0;
  const transport = createOwnerTransport(() => {
    opens++;
    throw new Error("unexpected");
  });
  try {
    await transport.claim(
      { ...actor },
      "a".repeat(64),
      "b".repeat(64),
      "https://postona.example/callback",
    );
  } catch { /* expected */ }
  check(opens === 0);
});
Deno.test("disabled entry neither reads payload nor invokes external dependency", async () => {
  const response = handler(
    new Request("https://postona.example/callback", {
      method: "POST",
      body: "offline_dummy_secret",
    }),
  );
  check(response.status === 503);
  check((await response.text()) === '{"error":"THREADS_CONNECT_DISABLED"}');
});
function world() {
  let ms = Date.now();
  let stateHash = "";
  let burned = false;
  let uncertain = 0;
  let complete = 0;
  let requests = 0;
  const verify = createActorVerifier(sdk(), () => ms);
  const settings = {
    appId: "123456",
    appSecret: "offline_dummy_app_secret_1234567890",
    redirectUri: "https://postona.example/callback",
  };
  const row = {
    oauth_state_id: "00000000-0000-4000-8000-000000000003",
    brand_id: "u_" + "a".repeat(24),
    social_account_id: "sa_" + "b".repeat(24),
    expires_at: new Date(ms + 600000).toISOString(),
    redirect_uri: settings.redirectUri,
  };
  const bridge = {
    begin: (_a: VerifiedActor, h: string) => {
      stateHash = h;
      return Promise.resolve({
        brand_id: row.brand_id,
        social_account_id: row.social_account_id,
      });
    },
    claim: (_a: VerifiedActor, h: string) => {
      if (burned || h !== stateHash) throw new Error("claim refused");
      burned = true;
      return Promise.resolve(row);
    },
    complete: (
      _a: VerifiedActor,
      _h: string,
      p: { p_access_token: string },
    ) => {
      check(p.p_access_token === "offline_dummy_LONG_TOKEN_123456");
      complete++;
      return Promise.resolve();
    },
    uncertain: () => {
      uncertain++;
      return Promise.resolve();
    },
  };
  const fetch = (_url: string, init?: RequestInit) => {
    check(init?.redirect === "error");
    requests++;
    return Promise.resolve(
      new Response(
        requests % 3 === 1
          ? '{"access_token":"offline_dummy_SHORT_TOKEN_123456","token_type":"bearer","user_id":9007199254740993}'
          : requests % 3 === 2
          ? '{"access_token":"offline_dummy_LONG_TOKEN_123456","token_type":"bearer","expires_in":5184000}'
          : '{"id":"9007199254740993","username":"offline_dummy"}',
        { status: 200 },
      ),
    );
  };
  const d = {
    verify,
    bridge,
    settings,
    attestationKey: "offline_dummy_attestation_" + "k".repeat(40),
    fetch,
    now: () => ms,
  };
  return {
    d,
    row,
    bridge,
    setTime: (n: number) => {
      ms = n;
    },
    stats: () => ({ requests, uncertain, complete, burned }),
  };
}
async function start(w: ReturnType<typeof world>) {
  const r = await createThreadsRuntime(w.d).start(auth);
  check(r.ok);
  return new URL(r.authorizationUrl!);
}
function callback(url: URL, host = "https://postona.example/callback") {
  return host + "?code=offline_dummy_code&state=" +
    url.searchParams.get("state");
}
Deno.test("real adapter composition uses durable claim before exchange, large identity, no credential receipt", async () => {
  const w = world();
  const u = await start(w);
  const result = await createThreadsRuntime(w.d).callback(auth, callback(u));
  check(result.ok);
  check(w.stats().requests === 3 && w.stats().complete === 1);
  check(!JSON.stringify(result).includes("TOKEN"));
});
Deno.test("two workers cannot exchange one code twice; later restart also refuses", async () => {
  const w = world();
  const u = await start(w);
  const c = callback(u);
  const [a, b] = await Promise.all([
    createThreadsRuntime(w.d).callback(auth, c),
    createThreadsRuntime(w.d).callback(auth, c),
  ]);
  check(Number(a.ok) + Number(b.ok) === 1);
  check(w.stats().requests === 3);
  check(!(await createThreadsRuntime(w.d).callback(auth, c)).ok);
  check(w.stats().requests === 3);
});
for (
  const [label, modify] of [
    [
      "wrong redirect",
      (c: string) => c.replace("postona.example", "foreign.example"),
    ],
    [
      "wrong csrf",
      (c: string) => c.replace(/state=.*/, "state=" + "x".repeat(43)),
    ],
    ["duplicate code", (c: string) => c + "&code=another"],
    ["unexpected identity field", (c: string) => c + "&userId=" + uid],
    ["wrong fragment", (c: string) => c + "#credential"],
  ] as const
) {
  Deno.test(`callback rejects ${label} before provider exchange`, async () => {
    const w = world();
    const u = await start(w);
    check(
      !(await createThreadsRuntime(w.d).callback(auth, modify(callback(u)))).ok,
    );
    check(w.stats().requests === 0);
  });
}
for (
  const label of [
    "claim-lost-commit",
    "claim-refused-inactive",
    "exchange-unknown",
    "profile-mismatch",
    "malformed-token",
    "completion-lost-commit",
    "auth-stale-before-complete",
    "state-expired",
  ] as const
) {
  Deno.test(`no retry and no secret output: ${label}`, async () => {
    const w = world();
    const u = await start(w);
    const d = w.d;
    if (label.startsWith("claim-")) {
      d.bridge.claim = () => {
        throw new Error("offline_dummy_claim");
      };
    }
    if (label === "exchange-unknown") {
      d.fetch = () => {
        throw new Error("offline_dummy_secret");
      };
    }
    if (label === "profile-mismatch") {
      const original = d.fetch;
      d.fetch = (url, init) =>
        url.endsWith("access_token=offline_dummy_LONG_TOKEN_123456")
          ? Promise.resolve(
            new Response('{"id":"2","username":"offline_dummy"}'),
          )
          : original(url, init);
    }
    if (label === "malformed-token") {
      d.fetch = () =>
        Promise.resolve(new Response('{"access_token":"bad","user_id":1}'));
    }
    if (label === "completion-lost-commit") {
      d.bridge.complete = () => {
        throw new Error("lost");
      };
    }
    if (label === "auth-stale-before-complete") {
      let v = 0;
      const orig = d.verify;
      d.verify = (a) => {
        if (++v > 1) throw new Error("stale");
        return orig(a);
      };
    }
    if (label === "state-expired") w.setTime(Date.now() + 700000);
    const r = await createThreadsRuntime(d).callback(auth, callback(u));
    check(!r.ok);
    check(!JSON.stringify(r).includes("offline_dummy"));
    if (label.startsWith("claim-") || label === "state-expired") {
      check(w.stats().requests === 0);
    }
    if (label === "completion-lost-commit") {
      check(r.error === "COMPLETE_OUTCOME_UNKNOWN");
    }
  });
}
Deno.test("hanging exchange times out, no automatic retry", async () => {
  const w = world();
  const u = await start(w);
  w.d.fetch = () => new Promise(() => {});
  const r = await createThreadsRuntime({ ...w.d, deadlineMs: 5 }).callback(
    auth,
    callback(u),
  );
  check(!r.ok);
  check(r.reconciliationRequired === true);
});
for (const mode of ["owner-denied", "commit-lost", "success"] as const) {
  Deno.test(`SQL owner channel ${mode}`, async () => {
    const actor = await createActorVerifier(sdk())(auth);
    const statements: string[] = [];
    const c: OwnerSqlClient = {
      queryObject<T>(sql: string) {
        statements.push(sql);
        if (sql === "commit" && mode === "commit-lost") throw new Error("lost");
        const rows = sql.startsWith("select\n")
          ? [{ allowed: mode !== "owner-denied" }]
          : sql.includes(" as allowed")
          ? [{ allowed: mode !== "owner-denied" }]
          : sql.includes(" as claim")
          ? [{ claim: world().row }]
          : [];
        return Promise.resolve({ rows: rows as T[] });
      },
      end: () => Promise.resolve(),
    };
    let result = "success";
    try {
      await createOwnerTransport(() => Promise.resolve(c)).claim(
        actor,
        "a".repeat(64),
        "b".repeat(64),
        "https://postona.example/callback",
      );
    } catch (e) {
      result = (e as Error).message;
    }
    if (mode === "owner-denied") check(result === "DB_OPERATION_REFUSED");
    if (mode === "commit-lost") {
      check(result === "DB_COMMIT_OUTCOME_UNKNOWN");
      check(!statements.includes("rollback"));
    }
    if (mode === "success") {
      check(result === "success" && statements.includes("commit"));
    }
  });
}
