// Disposable-only PostgREST stand-in for the local observer proof (no Docker / Supabase stack here).
// Serves exactly what the observer uses:
//   POST /rest/v1/rpc/news_discovery_*   -> select public.<fn>(p) as service_role (via psql)
//   GET  /rest/v1/stocks_master?...      -> listed rows, paged by the Range header
// Refuses anything else, refuses non-/tmp socket hosts, and binds to 127.0.0.1 only.
//   ND_PGHOST=/private/tmp/... ND_PGPORT=55432 ND_DB=<db> ND_OWNER=kb_news_discovery_owner \
//   SHIM_PORT=54399 SHIM_KEY=<local fake key> deno run --allow-net=127.0.0.1 --allow-env --allow-run=psql <this file>
const host = Deno.env.get("ND_PGHOST") ?? "";
if (!/^\/(private\/)?tmp\//.test(host)) throw new Error("Refusing: ND_PGHOST must be a local /tmp socket directory");
const port = Deno.env.get("ND_PGPORT") ?? "";
const db = Deno.env.get("ND_DB") ?? "";
const owner = Deno.env.get("ND_OWNER") ?? "";
const key = Deno.env.get("SHIM_KEY") ?? "";
const ALLOWED_RPC = /^news_discovery_(begin_run|find_duplicates|insert_signals|recent_for_grouping|finish_run|reserve_search|complete_search)$/;

async function psql(sql: string): Promise<{ ok: boolean; out: string; err: string }> {
  const command = new Deno.Command("psql", {
    args: ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=sqlstate", "-h", host, "-p", port, "-U", owner, "-d", db],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
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

Deno.serve({ hostname: "127.0.0.1", port: Number(Deno.env.get("SHIM_PORT") ?? "54399") }, async (request) => {
  if (request.headers.get("apikey") !== key || request.headers.get("authorization") !== `Bearer ${key}`) {
    return new Response(JSON.stringify({ code: "PGRST301" }), { status: 401 });
  }
  const url = new URL(request.url);
  const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
  if (request.method === "POST" && rpc && ALLOWED_RPC.test(rpc[1])) {
    const body = await request.json() as { p?: unknown };
    const result = await psql(`set role service_role;\nselect public.${rpc[1]}(${dollarQuote(JSON.stringify(body.p ?? {}))}::jsonb);\n`);
    if (!result.ok) {
      const code = result.err.match(/ERROR:\s+([0-9A-Z]{5})/)?.[1] ?? "XX000";
      return new Response(JSON.stringify({ code }), { status: code.startsWith("08") ? 503 : 400 });
    }
    return new Response(result.out || "null", { headers: { "Content-Type": "application/json" } });
  }
  if (request.method === "GET" && url.pathname === "/rest/v1/stocks_master") {
    const range = (request.headers.get("range") ?? "0-999").match(/^(\d+)-(\d+)$/);
    const from = Number(range?.[1] ?? 0);
    const to = Number(range?.[2] ?? 999);
    const result = await psql(`set role service_role;\nselect coalesce(json_agg(r), '[]') from (select ticker_code, company_name, is_listed from public.stocks_master where is_listed order by ticker_code offset ${from} limit ${to - from + 1}) r;\n`);
    if (!result.ok) return new Response(JSON.stringify({ code: "XX000" }), { status: 500 });
    return new Response(result.out, { status: 206, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ code: "PGRST404" }), { status: 404 });
});
