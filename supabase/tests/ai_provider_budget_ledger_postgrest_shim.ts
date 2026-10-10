// Disposable-only PostgREST stand-in for the AI ledger end-to-end proof (no Docker / Supabase stack here).
// Serves exactly POST /rest/v1/rpc/ai_ledger_* -> select public.<fn>(p) AS service_role (via psql), with the same
// apikey + Bearer check PostgREST would apply. Refuses anything else and non-/tmp socket hosts; binds 127.0.0.1 only.
//   AIL_PGHOST=/private/tmp/... AIL_PGPORT=54891 AIL_PGSUPER=<superuser> AIL_DB=<db> SHIM_PORT=54398 SHIM_KEY=<fake key> \
//   deno run --no-config --allow-net=127.0.0.1 --allow-env --allow-run=psql <this file>
const host = Deno.env.get("AIL_PGHOST") ?? "";
if (!/^\/(private\/)?tmp\//.test(host)) throw new Error("Refusing: AIL_PGHOST must be a local /tmp socket directory");
const port = Deno.env.get("AIL_PGPORT") ?? "";
const superuser = Deno.env.get("AIL_PGSUPER") ?? "";
const db = Deno.env.get("AIL_DB") ?? "";
const key = Deno.env.get("SHIM_KEY") ?? "";
if (key.length < 16) throw new Error("SHIM_KEY too short");
const ALLOWED_RPC = /^ai_ledger_(reserve|mark_sent|settle|release|recover_stale|usage_summary|budget_status)$/;

async function psql(sql: string): Promise<{ ok: boolean; out: string; err: string }> {
  const command = new Deno.Command("psql", {
    args: ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=sqlstate", "-h", host, "-p", port, "-U", superuser, "-d", db],
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

function dollarQuote(value: string): string {
  let tag = "j";
  while (value.includes(`$${tag}$`)) tag += "x";
  return `$${tag}$${value}$${tag}$`;
}

// Test-only fault: after the RPC has COMMITTED, hold the response longer than the client waits (a lost / timed-out
// response). Set with POST /__test/fault {"rpc": "...", "hangMs": n, "count": n}; same key check as the RPCs.
let fault: { rpc: string; hangMs: number; count: number } | null = null;

Deno.serve({ hostname: "127.0.0.1", port: Number(Deno.env.get("SHIM_PORT") ?? "54398") }, async (request) => {
  if (request.headers.get("apikey") !== key || request.headers.get("authorization") !== `Bearer ${key}`) {
    return new Response(JSON.stringify({ code: "PGRST301" }), { status: 401 });
  }
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/__test/fault") {
    fault = await request.json() as { rpc: string; hangMs: number; count: number };
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  }
  const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
  if (request.method !== "POST" || !rpc || !ALLOWED_RPC.test(rpc[1])) {
    return new Response(JSON.stringify({ code: "PGRST404" }), { status: 404 });
  }
  const body = await request.json() as { p?: unknown };
  const result = await psql(`set role service_role;\nselect public.${rpc[1]}(${dollarQuote(JSON.stringify(body.p ?? null))}::jsonb);\n`);
  if (!result.ok) {
    const code = result.err.match(/ERROR:\s+([0-9A-Z]{5})/)?.[1] ?? "XX000";
    const status = code === "42501" ? 403 : code.startsWith("22") || code.startsWith("P0") ? 400 : 500;
    return new Response(JSON.stringify({ code }), { status, headers: { "Content-Type": "application/json" } });
  }
  if (fault && fault.rpc === rpc[1] && fault.count > 0) {
    fault.count -= 1;
    await new Promise((resolve) => setTimeout(resolve, fault!.hangMs));
    return new Response(JSON.stringify({ code: "504" }), { status: 504 });
  }
  return new Response(result.out || "null", { headers: { "Content-Type": "application/json" } });
});
