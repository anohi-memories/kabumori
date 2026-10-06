// Disposable-only stand-in for the Supabase Auth + Data API surface that the publish-permission code
// uses (no Docker / Supabase stack here). It lets the REAL Edge handler and the REAL publish adapter run
// against the REAL SQL functions on a throwaway local database:
//   GET  /auth/v1/user                         fake-jwt.<uuid> -> {id}
//   POST /rest/v1/rpc/set_social_account_publish_enabled      as `authenticated`, JWT subject set
//   POST /rest/v1/rpc/read_x_publish_credential_for_legacy_post
//   POST /rest/v1/rpc/assert_x_publish_permission_for_legacy_post   as `service_role`
//   POST /rest/v1/rpc/{begin,commit}_x_account_refresh_legacy_post, release_x_account_refresh_v2,
//        record_x_account_{access_unauthorized,rejected_after_refresh}   as `service_role` (token refresh)
//   GET  /rest/v1/{brands,social_accounts,brand_settings}?<col>=eq.<v>   as `service_role` (brand context)
//   POST /__fixture/brand                      test-only: set is_active / publish_mode of one brand
//   POST /__fixture/account                    test-only: set verified_at / last_connection_error_code
//   POST /__fixture/refresh_rollout            test-only: enable token refresh for one account
// A function that does not exist (the migration not applied yet) is answered like PostgREST does:
// 404 PGRST202. Each call is its own transaction, like the Data API. Refuses anything else, refuses
// non-/tmp socket hosts, binds to 127.0.0.1 only. Started by social_mobile_publish_permission_run.sh
// (PUB_E2E=1).
const host = Deno.env.get("PUB_PGHOST") ?? "";
if (!/^\/(private\/)?tmp\//u.test(host)) throw new Error("Refusing: PUB_PGHOST must be a local /tmp socket directory");
const port = Deno.env.get("PUB_PGPORT") ?? "";
const db = Deno.env.get("PUB_DB") ?? "";
const owner = Deno.env.get("PUB_OWNER") ?? "";
const anonKey = Deno.env.get("SHIM_ANON_KEY") ?? "";
const serviceKey = Deno.env.get("SHIM_SERVICE_KEY") ?? "";
if (!db || !owner || !anonKey || !serviceKey || anonKey === serviceKey) throw new Error("shim configuration incomplete");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const IDENT = /^[a-z][a-z0-9_]{1,80}$/u;

async function psql(sql: string): Promise<{ ok: boolean; out: string; err: string }> {
  const command = new Deno.Command("psql", {
    args: ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", host, "-p", port, "-U", owner, "-d", db],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: { LC_ALL: "C" },
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(sql));
  await writer.close();
  const result = await child.output();
  return { ok: result.success, out: new TextDecoder().decode(result.stdout).trim(), err: new TextDecoder().decode(result.stderr).trim() };
}

type ArgType = "text" | "boolean" | "uuid" | "integer";

function literal(value: unknown, type: ArgType): string {
  if (value === null || value === undefined) return `null::${type}`;
  if (type === "boolean") {
    if (typeof value !== "boolean") throw new Error("bad argument");
    return value ? "true" : "false";
  }
  if (type === "integer") {
    if (!Number.isSafeInteger(value)) throw new Error("bad argument");
    return `${value}::integer`;
  }
  if (typeof value !== "string") throw new Error("bad argument");
  let tag = "a";
  while (value.includes(`$${tag}$`)) tag += "x";
  return `$${tag}$${value}$${tag}$::${type}`;
}

type RpcSpec = { role: "authenticated" | "service_role"; args: Record<string, ArgType>; rows: boolean };
const POST_ARGS: Record<string, ArgType> = { p_scheduled_post_id: "uuid", p_social_account_id: "text", p_brand_id: "text" };
const RPC: Record<string, RpcSpec> = {
  set_social_account_publish_enabled: {
    role: "authenticated",
    args: { p_social_account_id: "text", p_desired_enabled: "boolean", p_expected_current_enabled: "boolean" },
    rows: false,
  },
  read_x_publish_credential_for_legacy_post: {
    role: "service_role",
    args: { p_scheduled_post_id: "uuid", p_social_account_id: "text", p_brand_id: "text" },
    rows: true,
  },
  assert_x_publish_permission_for_legacy_post: {
    role: "service_role",
    args: { p_scheduled_post_id: "uuid", p_social_account_id: "text", p_brand_id: "text" },
    rows: false,
  },
  begin_x_account_refresh_legacy_post: { role: "service_role", args: POST_ARGS, rows: true },
  commit_x_account_refresh_legacy_post: {
    role: "service_role",
    args: { p_lease_token: "uuid", p_social_account_id: "text", p_access_token: "text", p_refresh_token: "text", p_expires_in: "integer" },
    rows: false,
  },
  release_x_account_refresh_v2: {
    role: "service_role",
    args: { p_lease_token: "uuid", p_social_account_id: "text", p_outcome: "text", p_error_code: "text" },
    rows: false,
  },
  record_x_account_access_unauthorized: { role: "service_role", args: POST_ARGS, rows: false },
  record_x_account_rejected_after_refresh: { role: "service_role", args: POST_ARGS, rows: false },
};

const TABLES: Record<string, string> = {
  brands: "select id, display_name, is_active, publish_mode, code_profile_key from public.brands",
  social_accounts: "select id, brand_id, platform, handle, publish_enabled, oauth_client_ref, platform_user_id from public.social_accounts",
  brand_settings: "select brand_id, fixed_hashtags, null::text as note_url, '{}'::jsonb as image_policy, '[]'::jsonb as enabled_post_types from public.brand_settings",
};

const json = (body: unknown, status = 200) => Response.json(body, { status });

function userFromBearer(request: Request): string | null {
  const match = /^Bearer fake-jwt\.(.+)$/u.exec(request.headers.get("authorization") ?? "");
  return match && UUID.test(match[1]) ? match[1] : null;
}
const isService = (request: Request) =>
  request.headers.get("apikey") === serviceKey && request.headers.get("authorization") === `Bearer ${serviceKey}`;

Deno.serve({ hostname: "127.0.0.1", port: Number(Deno.env.get("SHIM_PORT") ?? "54398"), onListen: () => console.log("SHIM_READY") }, async (request) => {
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/auth/v1/user") {
      const user = userFromBearer(request);
      return user && request.headers.get("apikey") === anonKey ? json({ id: user }) : json({ code: 401 }, 401);
    }

    const rpc = /^\/rest\/v1\/rpc\/([a-z_0-9]+)$/u.exec(url.pathname);
    if (request.method === "POST" && rpc && Object.hasOwn(RPC, rpc[1])) {
      const spec = RPC[rpc[1]];
      let prelude: string;
      if (spec.role === "authenticated") {
        const user = userFromBearer(request);
        // Like the Data API: an unverifiable token never reaches the function.
        if (!user || request.headers.get("apikey") !== anonKey) return json({ code: "PGRST301", message: "JWT invalid" }, 401);
        prelude = `select set_config('request.jwt.claim.sub', '${user}', true);\nset local role authenticated;`;
      } else {
        if (!isService(request)) return json({ code: "42501", message: "permission denied" }, 403);
        prelude = "set local role service_role;";
      }
      const body = await request.json() as Record<string, unknown>;
      if (Object.keys(body).some((key) => !Object.hasOwn(spec.args, key))) return json({ code: "PGRST202", message: "Could not find the function" }, 404);
      const args = Object.entries(spec.args).filter(([name]) => Object.hasOwn(body, name))
        .map(([name, type]) => `${name} => ${literal(body[name], type)}`).join(", ");
      const call = spec.rows
        ? `select coalesce(json_agg(r), '[]'::json)::jsonb from public.${rpc[1]}(${args}) r;`
        : `select to_json(public.${rpc[1]}(${args}));`;
      const result = await psql(`begin;\n${prelude}\n${call}\ncommit;\n`);
      if (!result.ok) {
        const message = /ERROR:\s+(.*)/u.exec(result.err)?.[1] ?? "error";
        if (/^function public\.\w+\(.*\) does not exist$/u.test(message)) {
          return json({ code: "PGRST202", message: `Could not find the function public.${rpc[1]} in the schema cache` }, 404);
        }
        return json({ code: "P0001", message }, 400);
      }
      const lines = result.out.split("\n").filter((line) => line.trim() !== "");
      return new Response(lines[lines.length - 1] ?? "null", { headers: { "Content-Type": "application/json" } });
    }

    const table = /^\/rest\/v1\/([a-z_]+)$/u.exec(url.pathname);
    if (request.method === "GET" && table && Object.hasOwn(TABLES, table[1])) {
      if (!isService(request)) return json({ code: "42501" }, 403);
      const filters: string[] = [];
      for (const [key, value] of url.searchParams) {
        if (key === "select" || key === "limit") continue;
        const eq = /^eq\.(.*)$/u.exec(value);
        if (!IDENT.test(key) || !eq) return json({ code: "PGRST100" }, 400);
        filters.push(`${key} = ${literal(eq[1], "text")}`);
      }
      const where = filters.length ? ` where ${filters.join(" and ")}` : "";
      const result = await psql(`set role service_role;\nselect coalesce(json_agg(r), '[]'::json)::jsonb from (${TABLES[table[1]]}${where}) r;\n`);
      return result.ok ? new Response(result.out, { headers: { "Content-Type": "application/json" } }) : json({ code: "XX000" }, 500);
    }

    // Test-only: what an operator/admin does to a brand (active flag and publish mode).
    if (request.method === "POST" && url.pathname === "/__fixture/brand") {
      if (!isService(request)) return json({ code: "42501" }, 403);
      const body = await request.json() as { id?: unknown; is_active?: unknown; publish_mode?: unknown };
      if (typeof body.id !== "string" || typeof body.is_active !== "boolean" || typeof body.publish_mode !== "string") return json({}, 400);
      const result = await psql(
        `update public.brands set is_active = ${literal(body.is_active, "boolean")}, publish_mode = ${literal(body.publish_mode, "text")} where id = ${literal(body.id, "text")};\n`,
      );
      return result.ok ? json({ ok: true }) : json({ code: "XX000" }, 500);
    }

    // Test-only: an account's verification stamp and recorded connection error.
    if (request.method === "POST" && url.pathname === "/__fixture/account") {
      if (!isService(request)) return json({ code: "42501" }, 403);
      const body = await request.json() as { id?: unknown; verified?: unknown; error_code?: unknown };
      if (typeof body.id !== "string" || typeof body.verified !== "boolean" || (body.error_code !== null && typeof body.error_code !== "string")) {
        return json({}, 400);
      }
      const result = await psql(
        `update public.social_accounts set verified_at = ${body.verified ? "now()" : "null"}, ` +
          `last_connection_error_code = ${literal(body.error_code, "text")} where id = ${literal(body.id, "text")};\n`,
      );
      return result.ok ? json({ ok: true }) : json({ code: "XX000" }, 500);
    }

    // Test-only: the operator enables token refresh for one account (Stage 3A rollout row).
    if (request.method === "POST" && url.pathname === "/__fixture/refresh_rollout") {
      if (!isService(request)) return json({ code: "42501" }, 403);
      const body = await request.json() as { id?: unknown };
      if (typeof body.id !== "string") return json({}, 400);
      const result = await psql(
        `insert into public.x_account_refresh_rollout (social_account_id, mode, reason_code) values (${literal(body.id, "text")}, 'enabled', 'E2E_FIXTURE');\n`,
      );
      return result.ok ? json({ ok: true }) : json({ code: "XX000" }, 500);
    }
    return json({ code: "PGRST404" }, 404);
  } catch {
    return json({ code: "XX000" }, 500);
  }
});
