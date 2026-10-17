// Explicit smoke, not default test discovery. Pinned G4/H5 overlay; real SDK, fake Auth/JWKS/SQL/Meta.
import { createSourceServer, type HandlerFactory } from "./server_factory.ts";
import { check, fakeConfig } from "./offline.fixture.ts";
import type { OwnerSqlClient } from "../owner_transport.ts";
import { handler as disabled } from "../../../functions/threads-oauth-connect-user/index.ts";
const uid = "00000000-0000-4000-8000-000000000001",
  sid = "00000000-0000-4000-8000-000000000002";
const oid = "00000000-0000-4000-8000-000000000003",
  acct = "sa_" + "b".repeat(24);
const encode = (v: Uint8Array) =>
  btoa(String.fromCharCode(...v)).replaceAll("+", "-").replaceAll("/", "_")
    .replaceAll("=", "");
const json64 = (v: unknown) =>
  encode(new TextEncoder().encode(JSON.stringify(v)));
const kp = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const jwk = {
  ...await crypto.subtle.exportKey("jwk", kp.publicKey),
  kid: "offline-key",
  alg: "RS256",
  use: "sig",
};
async function jwt(overrides: Record<string, unknown> = {}) {
  const part = json64({ alg: "RS256", typ: "JWT", kid: "offline-key" }) + "." +
    json64({
      sub: uid,
      session_id: sid,
      iss: fakeConfig.projectUrl + "auth/v1",
      aud: "authenticated",
      role: "authenticated",
      is_anonymous: false,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    });
  return part + "." +
    encode(
      new Uint8Array(
        await crypto.subtle.sign(
          "RSASSA-PKCS1-v1_5",
          kp.privateKey,
          new TextEncoder().encode(part),
        ),
      ),
    );
}
const moduleUrl = new URL(
  "../../../functions/_shared/social/threads_connect_edge.ts",
  import.meta.url,
).href;
const g4 = await import(moduleUrl) as {
  createThreadsConnectHandler: HandlerFactory;
  THREADS_CONNECT_EDGE_WIRED: boolean;
};
check(g4.THREADS_CONNECT_EDGE_WIRED === false);
type Mode =
  | "happy"
  | "foreign-user"
  | "missing-custody"
  | "owner-denied"
  | "session-revoked"
  | "meta-unknown"
  | "meta-timeout"
  | "complete-lost"
  | "custody-fails"
  | "freeze-late";
function world(mode: Mode) {
  let state = "",
    burned = false,
    committedWrites = 0,
    pendingWrites = 0,
    claimsSub = uid,
    providerCalls = 0,
    custody = 0,
    completion = false;
  const statements: string[] = [];
  const connect = (): Promise<OwnerSqlClient> =>
    Promise.resolve({
      queryObject<T>(sql: string, args?: unknown[]) {
        statements.push(sql);
        let rows: unknown[] = [];
        if (sql === "rollback") pendingWrites = 0;
        if (sql === "commit") {
          committedWrites += pendingWrites;
          pendingWrites = 0;
          if (mode === "complete-lost" && completion) {
            return Promise.reject(new Error("offline_dummy_lost"));
          }
        }
        if (sql.includes("set_config('request.jwt.claims'")) {
          claimsSub = (JSON.parse(String(args?.[0])) as { sub: string }).sub;
        }
        if (sql.includes(" as allowed")) {
          rows = [{
            allowed: sql.includes("record_threads_credential_custody")
              ? mode !== "missing-custody"
              : mode !== "owner-denied",
            social_account_id: acct,
          }];
        }
        if (
          sql.includes("assert_actor") &&
          (mode === "session-revoked" ||
            mode === "freeze-late" && providerCalls > 0)
        ) return Promise.reject(new Error("offline_dummy_fence"));
        if (sql.includes("begin_social_mobile")) {
          state = String(args?.[0]);
          rows = [{ brand_id: "u_" + "a".repeat(24), social_account_id: acct }];
        }
        if (sql.includes(" as claim")) {
          if (
            burned || args?.[0] !== state || claimsSub !== uid
          ) return Promise.reject(new Error("offline_dummy_replay"));
          burned = true;
          rows = [{
            claim: {
              oauth_state_id: oid,
              brand_id: "u_" + "a".repeat(24),
              social_account_id: acct,
              redirect_uri: fakeConfig.callback,
              expires_at: new Date(Date.now() + 300000).toISOString(),
            },
          }];
        }
        if (sql.includes("select public.complete_social")) {
          pendingWrites++;
          completion = true;
        }
        if (sql.startsWith("select public.record_threads")) {
          custody++;
          if (mode === "custody-fails") {
            return Promise.reject(
              new Error("offline_dummy_custody"),
            );
          }
        }
        return Promise.resolve({ rows: rows as T[] });
      },
      end: () => Promise.resolve(),
    });
  const http: typeof fetch = (input, init) => {
    const u = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url,
    );
    if (u.origin === new URL(fakeConfig.projectUrl).origin) {
      if (u.pathname.endsWith("jwks.json")) {
        return Promise.resolve(Response.json({ keys: [jwk] }));
      }
      if (u.pathname.endsWith("/user")) {
        const token =
          new Headers(init?.headers).get("authorization")?.slice(7) ?? "";
        const claims = JSON.parse(
          atob(token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/")),
        ) as { sub: string };
        return Promise.resolve(
          Response.json({ id: claims.sub, is_anonymous: false }),
        );
      }
      throw new Error("unexpected offline Auth endpoint");
    }
    providerCalls++;
    check(init?.redirect === "error");
    if (mode === "meta-timeout") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("offline_dummy_timeout")),
          { once: true },
        );
      });
    }
    if (mode === "meta-unknown") {
      return Promise.reject(new Error("offline_dummy_secret"));
    }
    return Promise.resolve(
      new Response(
        providerCalls === 1
          ? '{"access_token":"offline_dummy_SHORT_TOKEN_123456","token_type":"bearer","user_id":9007199254740993}'
          : providerCalls === 2
          ? '{"access_token":"offline_dummy_LONG_TOKEN_123456","token_type":"bearer","expires_in":2592000}'
          : '{"id":"9007199254740993","username":"offline_dummy"}',
      ),
    );
  };
  const server = createSourceServer(fakeConfig, {
    handlerFactory: g4.createThreadsConnectHandler,
    ownerConnect: connect,
    fetch: http,
  });
  return {
    server,
    stats: () => ({ committedWrites, providerCalls, custody, statements }),
    loseCustody: () => {
      mode = "missing-custody";
    },
  };
}
function req(token: string, body: unknown) {
  return new Request("https://postona.example/runtime", {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
for (
  const mode of [
    "happy",
    "foreign-user",
    "missing-custody",
    "owner-denied",
    "session-revoked",
    "meta-unknown",
    "meta-timeout",
    "complete-lost",
    "custody-fails",
    "freeze-late",
  ] as const
) {
  Deno.test("actual SDK + G4 HTTP + owner composition: " + mode, async () => {
    const w = world(mode);
    const token = await jwt();
    const start = await w.server.sourceHandler(req(token, { action: "start" }));
    const startBody = await start.json();
    if (["missing-custody", "owner-denied", "session-revoked"].includes(mode)) {
      check(
        start.status !== 200 && w.stats().providerCalls === 0 &&
          w.stats().committedWrites === 0,
      );
      return;
    }
    check(start.status === 200);
    const state = new URL(startBody.authorization_url).searchParams.get(
      "state",
    );
    const callback = fakeConfig.callback + "?code=offline_dummy_code&state=" +
      state;
    const result = await w.server.sourceHandler(
      req(mode === "foreign-user" ? await jwt({ sub: oid }) : token, {
        action: "callback",
        callback_url: callback,
      }),
    );
    const body = await result.json();
    check(
      !JSON.stringify(body).includes("TOKEN") &&
        !JSON.stringify(body).includes("offline_dummy"),
    );
    if (mode === "happy") {
      check(
        result.status === 200 && body.publish_enabled === false &&
          body.social_account_id === acct && w.stats().committedWrites === 1 &&
          w.stats().custody === 1,
      );
      const replay = await w.server.sourceHandler(
        req(token, { action: "callback", callback_url: callback }),
      );
      check(
        replay.status !== 200 && w.stats().providerCalls === 3 &&
          w.stats().committedWrites === 1,
      );
      const s = w.stats().statements;
      check(
        s.findIndex((x) => x.startsWith("select public.complete_social")) <
          s.findIndex((x) => x.startsWith("select public.record_threads")),
      );
    } else {
      check(
        result.status !== 200 &&
          w.stats().committedWrites === (mode === "complete-lost" ? 1 : 0),
      );
      if (mode === "complete-lost") {
        check(body.error === "COMPLETE_OUTCOME_UNKNOWN");
      }
    }
  });
}
for (
  const claims of [{ exp: 1 }, { iss: "https://evil.example/auth/v1" }, {
    role: "service_role",
  }, { is_anonymous: true }]
) {
  Deno.test(
    "SDK verifies/rejects claims " + JSON.stringify(claims),
    async () => {
      const w = world("happy");
      const r = await w.server.sourceHandler(
        req(await jwt(claims), { action: "start" }),
      );
      check(r.status !== 200 && w.stats().statements.length === 0);
    },
  );
}
Deno.test("malicious envelope/callback/account-swap refused before credential write; deployed entry always503", async () => {
  const w = world("happy"), token = await jwt();
  for (
    const body of [{ action: "start", userId: uid }, {
      action: "callback",
      callback_url: "https://evil.example/?code=x&state=y",
    }, {
      action: "callback",
      callback_url: fakeConfig.callback + "?code=x&code=y&state=z",
    }, {
      action: "callback",
      callback_url: fakeConfig.callback + "?code=x&state=z",
      social_account_id: acct,
    }]
  ) {
    const r = await w.server.sourceHandler(req(token, body));
    check(
      r.status !== 200 && w.stats().committedWrites === 0 &&
        w.stats().providerCalls === 0,
    );
  }
  check(disabled(req(token, { action: "start" })).status === 503);
});
Deno.test("actual SDK rejects tampered signature before SQL/Auth authority", async () => {
  const w = world("happy"), token = await jwt();
  const p = token.split(".");
  p[2] = (p[2][0] === "a" ? "b" : "a") + p[2].slice(1);
  const r = await w.server.sourceHandler(req(p.join("."), { action: "start" }));
  check(
    r.status !== 200 && w.stats().statements.length === 0 &&
      w.stats().committedWrites === 0,
  );
});
