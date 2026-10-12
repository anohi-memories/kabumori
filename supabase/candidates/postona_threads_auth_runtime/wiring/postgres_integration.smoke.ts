// Explicit smoke, not default discovery: actual driver/transport + real pinned G5 T13/G4 SQL source.
// LOCAL FAKE ONLY. Unix socket config exists only in tests; production connector cannot select socket.
import { Client } from "@db/postgres";
import {
  createOwnerTransport,
  type OwnerSqlClient,
} from "../owner_transport.ts";
import { createActorVerifier } from "../verified_actor.ts";
import { completeRpcPayload } from "../../../functions/_shared/social/threads_connect_rpc_contract.ts";
import { assertCustodyContract } from "./custody_port.ts";
const host = Deno.env.get("H5_PGHOST") ?? "",
  port = Number(Deno.env.get("H5_PGPORT")),
  user = Deno.env.get("H5_PGUSER") ?? "",
  database = Deno.env.get("H5_PGDATABASE") ?? "";
if (
  !host.startsWith("/private/tmp/") || !/^h5_wiring_owner_\d+$/.test(user) ||
  !/^h5_wiring_\d+$/.test(database)
) throw new Error("LOCAL_FIXTURE_REQUIRED");
const check = (v: unknown) => {
  if (!v) throw new Error("assertion failed");
};
async function open() {
  const c = new Client({
    hostname: host,
    host_type: "socket",
    port,
    user,
    database,
    applicationName: "h5_local_test",
    connection: { attempts: 1 },
  });
  await c.connect();
  return c;
}
const hash = (n: number) => n.toString(16).padStart(64, "0");
async function actor(n: number) {
  const uid = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    sid = `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const c = await open();
  try {
    await c.queryObject("begin");
    await c.queryObject("select public.fixture_login($1::uuid)", [uid]);
    await c.queryObject(
      "insert into auth.sessions(id,user_id)values($1::uuid,$2::uuid)",
      [sid, uid],
    );
    await claims(c, uid, sid);
    await c.queryObject("select public.start_x_autopost_service()");
    await c.queryObject("commit");
  } finally {
    await c.end();
  }
  return await createActorVerifier({
    getClaims: () =>
      Promise.resolve({
        data: {
          claims: {
            sub: uid,
            session_id: sid,
            role: "authenticated",
            aud: "authenticated",
            is_anonymous: false,
            exp: Math.floor(Date.now() / 1000) + 3600,
          },
        },
        error: null,
      }),
    getUser: () =>
      Promise.resolve({
        data: { user: { id: uid, is_anonymous: false } },
        error: null,
      }),
  })("Bearer offline_dummy");
}
async function claims(c: OwnerSqlClient, u: string, s: string) {
  await c.queryObject(
    "select set_config('request.jwt.claims',$1,true) as claims,set_config('request.jwt.claim.sub',$2,true) as sub,set_config('request.jwt.claim.role','authenticated',true) as role,set_config('request.jwt.claim.session_id',$3,true) as session",
    [JSON.stringify({ sub: u, session_id: s, role: "authenticated" }), u, s],
  );
}
async function prepare(n: number) {
  const a = await actor(n), bridge = createOwnerTransport(open);
  const h = hash(n);
  await bridge.begin(
    a,
    h,
    "https://postona.example/callback",
    new Date(Date.now() + 300000),
  );
  const r = await bridge.claim(
    a,
    h,
    hash(n + 1000),
    "https://postona.example/callback",
  );
  const payload = await completeRpcPayload(
    "fake_attestation_key_0123456789abcdef0123456789abcdef",
    {
      oauthStateId: r.oauth_state_id,
      providerUserId: String(9007199254740993n + BigInt(n)),
      handle: "offline_dummy",
      accessToken: "fakeH5token_01234567890123456789",
    },
  );
  return {
    a,
    bridge,
    h,
    r,
    payload,
    expiry: new Date(Date.now() + 12345 * 1000),
  };
}
async function refused(p: Promise<unknown>) {
  try {
    await p;
    throw new Error("unexpected success");
  } catch (e) {
    check((e as Error).message === "DB_OPERATION_REFUSED");
  }
}
async function waitLock(c: Client, pid: number) {
  for (let i = 0; i < 150; i++) {
    const r = await c.queryObject<{ waiting: boolean }>(
      "select wait_event_type='Lock' as waiting from pg_stat_activity where pid=$1",
      [pid],
    );
    if (r.rows[0]?.waiting) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("LOCK_BARRIER_NOT_REACHED");
}
async function tokenCount(c: Client, acct: string) {
  return (await c.queryObject<{ count: number }>(
    "select count(*)::int as count from public.social_accounts where id=$1 and vault_access_token_secret_id is not null",
    [acct],
  )).rows[0].count;
}
Deno.test("actual owner adapter records exact observed expiry/account in same commit", async () => {
  const x = await prepare(11), c = await open();
  try {
    await assertCustodyContract(c);
    await x.bridge.complete(x.a, x.h, x.payload, x.expiry);
    const r = await c.queryObject<{ matched: boolean }>(
      `select s.publish_enabled=false and s.vault_access_token_secret_id=c.vault_secret_id and c.recorded_by=$2::uuid
 and c.expires_at=$3::timestamptz and c.recorded_at=s.verified_at and a.status='complete' as matched
 from public.social_accounts s join public.threads_account_credential_custody c on c.social_account_id=s.id
 join postona_threads_runtime.attempts a on a.social_account_id=s.id where s.id=$1`,
      [x.r.social_account_id, x.a.userId, x.expiry.toISOString()],
    );
    check(r.rows[0]?.matched);
  } finally {
    await c.end();
  }
});
Deno.test("completion-first FOR SHARE blocks non-key not_after update until complete COMMIT", async () => {
  const x = await prepare(12), c = await open(), updater = await open();
  let release: () => void = () => {};
  let ready: () => void = () => {};
  const held = new Promise<void>((r) => {
      ready = r;
    }),
    go = new Promise<void>((r) => {
      release = r;
    });
  const bridge = createOwnerTransport(async () => {
    const driver = await open();
    return {
      queryObject: async <T>(sql: string, args?: unknown[]) => {
        const r = await driver.queryObject<T>(sql, args);
        if (sql.includes("assert_actor")) {
          ready();
          await go;
        }
        return r;
      },
      end: () => driver.end(),
    };
  });
  const completion = bridge.complete(x.a, x.h, x.payload, x.expiry);
  try {
    await held;
    const update = updater.queryObject(
      "update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=$1::uuid",
      [x.a.sessionId],
    );
    await waitLock(c, updater.session.pid!);
    release();
    await completion;
    await update;
    check(await tokenCount(c, x.r.social_account_id) === 1);
    await refused(x.bridge.complete(x.a, x.h, x.payload, x.expiry));
  } finally {
    release();
    await completion.catch(() => {});
    await Promise.all([c.end(), updater.end()]);
  }
});
Deno.test("expiry-update-first, waiter sees new revoked session, ZERO token/custody write", async () => {
  const x = await prepare(13), c = await open(), updater = await open();
  let pid = 0;
  const bridge = createOwnerTransport(async () => {
    const driver = await open();
    pid = driver.session.pid!;
    return driver;
  });
  try {
    await updater.queryObject("begin");
    await updater.queryObject(
      "update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=$1::uuid",
      [x.a.sessionId],
    );
    const completion = bridge.complete(x.a, x.h, x.payload, x.expiry);
    const failure = refused(completion);
    while (!pid) await new Promise((r) => setTimeout(r, 1));
    await waitLock(c, pid);
    await updater.queryObject("commit");
    await failure;
    check(await tokenCount(c, x.r.social_account_id) === 0);
    check(
      (await c.queryObject<{ count: number }>(
        "select count(*)::int as count from public.threads_account_credential_custody where social_account_id=$1",
        [x.r.social_account_id],
      )).rows[0].count === 0,
    );
  } finally {
    await Promise.all([c.end(), updater.end()]);
  }
});
Deno.test("missing custody drift and custody runtime failure roll back parent token/state/Vault", async () => {
  const x = await prepare(14), c = await open();
  try {
    await c.queryObject(
      "alter function public.record_threads_credential_custody(text,timestamptz) rename to h5_hidden_custody",
    );
    try {
      await refused(x.bridge.complete(x.a, x.h, x.payload, x.expiry));
      check(await tokenCount(c, x.r.social_account_id) === 0);
    } finally {
      await c.queryObject(
        "alter function public.h5_hidden_custody(text,timestamptz) rename to record_threads_credential_custody",
      );
    }
    await c.queryObject(
      "grant execute on function public.record_threads_credential_custody(text,timestamptz) to authenticated",
    );
    try {
      await refused(x.bridge.complete(x.a, x.h, x.payload, x.expiry));
      check(await tokenCount(c, x.r.social_account_id) === 0);
    } finally {
      await c.queryObject(
        "revoke execute on function public.record_threads_credential_custody(text,timestamptz) from authenticated",
      );
    }
    // Force custody failure AFTER parent complete without altering G4 function source: trigger on custody table.
    await c.queryObject(
      "create function public.h5_fail_custody() returns trigger language plpgsql as $$begin raise exception 'OFFLINE_INJECTED';end$$",
    );
    await c.queryObject(
      "create trigger h5_custody_failure before insert on public.threads_account_credential_custody for each row execute function public.h5_fail_custody()",
    );
    try {
      const count = (await c.queryObject<{ n: number }>(
        "select count(*)::int n from vault.secrets",
      )).rows[0].n;
      await refused(x.bridge.complete(x.a, x.h, x.payload, x.expiry));
      check(await tokenCount(c, x.r.social_account_id) === 0);
      check(
        (await c.queryObject<{ n: number }>(
          "select count(*)::int n from vault.secrets",
        )).rows[0].n === count,
      );
      check(
        (await c.queryObject<{ status: string }>(
          "select status from postona_threads_runtime.attempts where state_hash=$1",
          [x.h],
        )).rows[0].status === "claimed",
      );
    } finally {
      await c.queryObject(
        "drop trigger h5_custody_failure on public.threads_account_credential_custody; drop function public.h5_fail_custody()",
      );
    }
  } finally {
    await c.end();
  }
});
Deno.test("duplicate code/state, missing session and lifecycle freeze fail closed with real G5 guard", async () => {
  const x = await prepare(15), c = await open();
  try {
    await refused(
      x.bridge.claim(x.a, x.h, hash(5555), "https://postona.example/callback"),
    );
    await c.queryObject("delete from auth.sessions where id=$1::uuid", [
      x.a.sessionId,
    ]);
    await refused(x.bridge.complete(x.a, x.h, x.payload, x.expiry));
    await c.queryObject(
      "insert into auth.sessions(id,user_id)values($1::uuid,$2::uuid)",
      [x.a.sessionId, x.a.userId],
    );
    await c.queryObject(
      "update public.service_entitlements set status='ended',ended_at=now() where user_id=$1::uuid and service_key='x_autopost'",
      [x.a.userId],
    );
    await refused(x.bridge.complete(x.a, x.h, x.payload, x.expiry));
    check(await tokenCount(c, x.r.social_account_id) === 0);
  } finally {
    await c.end();
  }
});
Deno.test("foreign actor, cross-workspace duplicate code and swapped state cannot write credentials", async () => {
  const x = await prepare(21),
    a = await actor(22),
    bridge = createOwnerTransport(open),
    c = await open();
  try {
    await refused(
      bridge.claim(a, x.h, hash(9911), "https://postona.example/callback"),
    );
    await bridge.begin(
      a,
      hash(22),
      "https://postona.example/callback",
      new Date(Date.now() + 300000),
    );
    await refused(
      bridge.claim(a, hash(22), hash(1021), "https://postona.example/callback"),
    );
    await refused(
      x.bridge.complete(
        x.a,
        x.h,
        { ...x.payload, p_oauth_state_id: a.userId },
        x.expiry,
      ),
    );
    check(await tokenCount(c, x.r.social_account_id) === 0);
  } finally {
    await c.end();
  }
});
