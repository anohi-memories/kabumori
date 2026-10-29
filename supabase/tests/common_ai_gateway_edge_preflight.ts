// G6-05 (2026-10-19) / G6-24 (2026-10-29): an EXECUTABLE check of the G6 AI gateway's Edge placement, run entirely on
// throw-away copies. Since G6-24 the gateway lives in supabase/functions/_shared/ai_gateway/ with its own isolation test,
// its one Edge entry is supabase/functions/postona-post-assist/index.ts, and the shared provider's isolation test carries
// the grants recorded in supabase/tests/fixtures/g6_24_provider_isolation/provider_isolation_g6.patch (G6-05's proposal
// + G6-23's entry grant, applied). Nothing in the repository is changed by this script.
//
// For each case it copies supabase/functions + src + apps (no node_modules, no dot entries) into a temp directory,
// optionally applies a change, and runs the COPY's own provider isolation test, consumer bridge isolation test and G6
// isolation test. Expected:
//   the repository as is                                 -> PASS  (and the entry and the gateway type-check in place)
//   the G6 grants taken back out of the provider's test  -> FAIL  (the boundary refuses the gateway and its entry)
//   only the entry's grants taken out, or one of them    -> FAIL
//   any malicious change                                 -> FAIL  (the grants admit nothing else)
//   any ONE grant line / provider name removed          -> FAIL  (minimality: no unnecessary grant)
//
//   deno run --no-config --allow-read --allow-write=<tmp> --allow-run=deno,patch --allow-env=TMPDIR,HOME,DENO_DIR \
//     supabase/tests/common_ai_gateway_edge_preflight.ts [--only=<case>] [--show=<case>]
const REPO = new URL("../../", import.meta.url);
const PATCH = new URL("./fixtures/g6_24_provider_isolation/provider_isolation_g6.patch", import.meta.url);
const PROVIDER_TEST = "supabase/functions/_shared/ai_provider/isolation_test.ts";
const ENTRY = "supabase/functions/postona-post-assist/index.ts";
const only = Deno.args.find((a) => a.startsWith("--only="))?.slice(7);
const show = Deno.args.find((a) => a.startsWith("--show="))?.slice(7);

async function copyTree(from: URL, to: URL): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    if (entry.isSymlink) throw new Error(`symlink in source tree: ${entry.name}`);
    const src = new URL(encodeURIComponent(entry.name) + (entry.isDirectory ? "/" : ""), from);
    const dst = new URL(encodeURIComponent(entry.name) + (entry.isDirectory ? "/" : ""), to);
    if (entry.isDirectory) await copyTree(src, dst);
    else await Deno.copyFile(src, dst);
  }
}

async function run(cmd: string, args: string[], cwd: URL): Promise<{ ok: boolean; out: string }> {
  const r = await new Deno.Command(cmd, { args, cwd, stdout: "piped", stderr: "piped", env: { NO_COLOR: "1" } }).output();
  const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
  return { ok: r.success, out };
}

/** The isolation tests of the copy: the provider's, the consumer bridge's and the G6 gateway's. */
async function isolation(root: URL): Promise<{ ok: boolean; out: string }> {
  const files = [PROVIDER_TEST, "supabase/functions/_shared/ai_consumer_bridge/isolation_test.ts", "supabase/functions/_shared/ai_gateway/isolation_test.ts"];
  return await run("deno", ["test", "--cached-only", "--no-check", "--no-config", "--deny-net", "--allow-read=" + new URL(".", root).pathname, ...files], root);
}

async function edit(root: URL, path: string, from: string, to: string): Promise<void> {
  const file = new URL(path, root);
  const text = await Deno.readTextFile(file);
  const count = text.split(from).length - 1;
  if (count !== 1) throw new Error(`fixture anchor not found exactly once in ${path}: ${from.slice(0, 60)}`);
  await Deno.writeTextFile(file, text.replace(from, to));
}

/** Replace the nth (0-based) occurrence of `from` (used when the same allowlist line appears for several files). */
async function editNth(root: URL, path: string, from: string, to: string, nth: number): Promise<void> {
  const file = new URL(path, root);
  const parts = (await Deno.readTextFile(file)).split(from);
  if (parts.length - 1 <= nth) throw new Error(`occurrence ${nth} of an anchor not found in ${path}: ${from.slice(0, 60)}`);
  const head = parts.slice(0, nth + 1).join(from);
  await Deno.writeTextFile(file, head + to + parts.slice(nth + 1).join(from));
}

const ENTRY_POINTS_LINE = 'const AUTHORIZED_ENTRY_POINTS = ["market-report-analysis/index.ts", "postona-post-assist/index.ts"];';
const ENTRY_REACHER_LINE = '  "postona-post-assist/index.ts",\n';
const dropEntryPointGrant = (r: URL) => edit(r, PROVIDER_TEST, ENTRY_POINTS_LINE, 'const AUTHORIZED_ENTRY_POINTS = ["market-report-analysis/index.ts"];');
const dropEntryReacherGrant = (r: URL) => edit(r, PROVIDER_TEST, ENTRY_REACHER_LINE, "");

type Case = Readonly<{ name: string; expect: "pass" | "fail"; mutate?: (root: URL) => Promise<void>; why: string }>;
const G = "supabase/functions/_shared/ai_gateway/";
const CASES: readonly Case[] = [
  { name: "repository", expect: "pass", why: "the real isolation tests pass on the tree as it is" },
  {
    name: "without-g6-grants", expect: "fail", why: "the provider's isolation test as it was before G6-24 refuses the placed gateway and its entry",
    mutate: async (r) => {
      const p = await run("patch", ["-p1", "-R", "--no-backup-if-mismatch", "-i", PATCH.pathname], r);
      if (!p.ok) throw new Error(`the recorded G6 grants did not reverse-apply (the provider test drifted from the record):\n${p.out}`);
    },
  },
  {
    name: "entry-without-its-grants", expect: "fail", why: "the gateway's grants alone do not admit the Edge entry",
    mutate: async (r) => {
      await dropEntryPointGrant(r);
      await dropEntryReacherGrant(r);
    },
  },
  { name: "entry-no-entry-point-grant", expect: "fail", why: "the entry's AUTHORIZED_ENTRY_POINTS grant is needed", mutate: dropEntryPointGrant },
  { name: "entry-no-reacher-grant", expect: "fail", why: "the entry's AUTHORIZED_REACHERS grant is needed", mutate: dropEntryReacherGrant },
  {
    name: "entry-imports-more", expect: "fail", why: "the approved entry may import only postona_post_assist_edge.ts",
    mutate: (r) => edit(r, ENTRY, "\nDeno.serve(", "import { createAiGateway } from \"../_shared/ai_gateway/runtime.ts\";\nvoid createAiGateway;\n\nDeno.serve("),
  },
  {
    name: "second-entry", expect: "fail", why: "another Edge entry serving the same handler is not authorized",
    mutate: async (r) => {
      await Deno.mkdir(new URL("supabase/functions/postona-post-assist-2/", r), { recursive: true });
      await Deno.copyFile(new URL(ENTRY, r), new URL("supabase/functions/postona-post-assist-2/index.ts", r));
    },
  },
  {
    name: "extra-provider-name", expect: "fail", why: "a gateway file takes a provider name the grants do not list (secret reader)",
    mutate: (r) => edit(r, G + "runtime.ts", "import { SecretValue } from \"../ai_provider/secrets.ts\";", "import { resolveSecret, SecretValue } from \"../ai_provider/secrets.ts\";\nvoid resolveSecret;"),
  },
  {
    name: "namespace-import", expect: "fail", why: "a namespace import hands over every provider export",
    mutate: (r) => edit(r, G + "app_policies.ts", "import { findModelSpec } from \"../ai_provider/mod.ts\";", "import * as P from \"../ai_provider/mod.ts\";\nconst findModelSpec = P.findModelSpec;"),
  },
  {
    name: "dynamic-import", expect: "fail", why: "a dynamic import of the provider is refused",
    mutate: (r) => edit(r, G + "authority_port.ts", "export type VerdictScope", "export const loadProvider = () => import(\"../ai_provider/mod.ts\");\nexport type VerdictScope"),
  },
  {
    name: "unlisted-gateway-file", expect: "fail", why: "a new gateway file that reaches the provider is not authorized by name",
    mutate: (r) => Deno.writeTextFile(new URL(G + "extra.ts", r), "import { executeAiRequest } from \"../ai_provider/mod.ts\";\nexport const run = executeAiRequest;\n"),
  },
  {
    name: "other-entry-imports-gateway", expect: "fail", why: "no other Edge entry point may reach the provider through the gateway",
    mutate: (r) => edit(r, "supabase/functions/social-mobile-consult/index.ts", "import { handleSocialMobileConsult } from \"./logic.ts\";", "import { handleSocialMobileConsult } from \"./logic.ts\";\nimport { handleConsultViaGateway } from \"../_shared/ai_gateway/postona_consult_adapter.ts\";\nvoid handleConsultViaGateway;"),
  },
  {
    name: "other-function-imports-gateway", expect: "fail", why: "another deployable file may not import the gateway (it would reach the provider)",
    mutate: (r) => Deno.writeTextFile(new URL("supabase/functions/_shared/brand/ai_shortcut.ts", r), "import { createAiGateway } from \"../ai_gateway/runtime.ts\";\nexport const make = createAiGateway;\n"),
  },
  {
    name: "anthropic-key-name", expect: "fail", why: "an ANTHROPIC_* name outside the provider module",
    mutate: (r) => edit(r, G + "runtime.ts", "const PROVIDER_KEY_NAMES", "const SHORTCUT = \"ANTHROPIC_API_KEY\";\nvoid SHORTCUT;\nconst PROVIDER_KEY_NAMES"),
  },
  {
    name: "environment-read", expect: "fail", why: "a gateway file reads the environment itself (the G6 isolation test)",
    mutate: (r) => edit(r, G + "runtime.ts", "const PROVIDER_KEY_NAMES", "const SERVICE = Deno.env.get(\"SUPABASE_SERVICE_ROLE_KEY\");\nvoid SERVICE;\nconst PROVIDER_KEY_NAMES"),
  },
  {
    name: "console-log", expect: "fail", why: "a gateway file writes logs (the G6 isolation test)",
    mutate: (r) => edit(r, G + "g5_rpc_transport.ts", "  async function ask(", "  console.log(\"g5\");\n  async function ask("),
  },
  {
    name: "gateway-imports-bridge", expect: "fail", why: "the gateway may not pull in the Claude-only consumer bridge",
    mutate: (r) => edit(r, G + "gateway.ts", "export type AppId", "import type { BridgeResult } from \"../ai_consumer_bridge/types.ts\";\nexport type Unused = BridgeResult;\nexport type AppId"),
  },
  {
    name: "node-import", expect: "fail", why: "a node: import in a gateway file (the G6 isolation test)",
    mutate: (r) => edit(r, G + "policy_registry.ts", "const APPS", "import \"node:crypto\";\nconst APPS"),
  },
  {
    name: "app-references-gateway-key", expect: "fail", why: "an app file naming the provider key (keys stay server-side)",
    mutate: (r) => Deno.writeTextFile(new URL("src/leak_probe.ts", r), "export const k = \"ANTHROPIC_API_KEY\";\n"),
  },
];

// The recorded grants: lines are only ADDED to the provider's isolation test, except the comments that described the old
// scope and the one AUTHORIZED_ENTRY_POINTS line (which gains postona-post-assist/index.ts).
{
  const lines = (await Deno.readTextFile(PATCH)).split("\n");
  const files = lines.filter((l) => l.startsWith("+++ ")).map((l) => l.slice(4).trim());
  const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1));
  const allowed = (l: string) => /^\s*(?:\/\/|\/\*\*)/u.test(l) || l === 'const AUTHORIZED_ENTRY_POINTS = ["market-report-analysis/index.ts"];';
  if (files.length !== 1 || files[0] !== `b/${PROVIDER_TEST}` || !removed.every(allowed)) {
    console.log(`BAD  grants-only-add: removed ${JSON.stringify(removed.filter((l) => !allowed(l)))}, files ${JSON.stringify(files)}`);
    Deno.exit(1);
  }
  const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  console.log(`OK   grants-only-add: ${added} added lines; ${removed.length} removed = ${removed.length - 1} scope comment line(s) + the entry-points line; 1 file (the provider's isolation test)`);
}

// The real path (macOS: /var is /private/var), so the copy's own permission scope and import.meta.url agree.
const tmpRoot = await Deno.realPath(await Deno.makeTempDir({ prefix: "g6_24_edge_" }));
const tmpRoot2 = await Deno.realPath(await Deno.makeTempDir({ prefix: "g6_24_min_" }));
let failures = 0;
try {
  for (const c of CASES) {
    if (only && c.name !== only) continue;
    const root = new URL(`file://${tmpRoot}/${c.name}/`);
    for (const dir of ["supabase/functions/", "src/", "apps/"]) await copyTree(new URL(dir, REPO), new URL(dir, root));
    if (c.mutate) await c.mutate(root);
    let r = await isolation(root);
    if (c.name === "repository" && r.ok) {
      // The entry and the gateway also type-check where they live (the same config the provider tests use).
      const t = await run("deno", ["check", "--cached-only", "--config", "supabase/functions/_shared/ai_consumer_bridge/deno.json", ENTRY,
        G + "runtime.ts", G + "postona_consult_adapter.ts", G + "recovery.ts"], root);
      console.log(`       deno check of the entry and the gateway in place: ${t.ok ? "OK" : "FAILED"}`);
      if (!t.ok) r = { ok: false, out: r.out + t.out };
    }
    const got = r.ok ? "pass" : "fail";
    const ok = got === c.expect;
    if (!ok) failures++;
    const summary = r.out.match(/(ok|FAILED) \| \d+ passed[^\n]*/u)?.[0] ?? "?";
    console.log(`${ok ? "OK  " : "BAD "} ${c.name}: expected ${c.expect}, got ${got} (${summary}) — ${c.why}`);
    // Which tests stopped it (the FAILURES section of the copy's run).
    const failureText = r.out.split(" FAILURES ")[1] ?? "";
    for (const m of new Set(failureText.match(/^.+(?= => \.\/supabase)/gmu) ?? [])) console.log(`       caught by: ${m.slice(0, 110)}`);
    if (show === c.name || (!ok && show === "bad")) console.log(r.out);
  }
} catch (e) {
  await Deno.remove(tmpRoot2, { recursive: true });
  throw e;
} finally {
  await Deno.remove(tmpRoot, { recursive: true });
}
// Minimality: every single grant is needed. Each variant drops ONE added allowlist line (a gateway file's references or
// a reacher) or ONE name from a gateway file's provider imports from the real provider test; each variant must FAIL.
// (The entry's two grants are the entry-no-* cases above.)
if (!only || only === "minimality") {
  const added = (await Deno.readTextFile(PATCH)).split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
  const variants: Array<[string, string, string, number]> = [];
  const seen = new Map<string, number>();
  for (const line of added) {
    if (/^\s*\/\//u.test(line)) continue;
    const nth = seen.get(line) ?? 0;
    seen.set(line, nth + 1);
    if (/^ {2}"_shared\/ai_gateway\/[a-z0-9_]+\.ts"(?:,|: \[.*\],)$/u.test(line)) variants.push([`drop ${line.trim().slice(0, 70)}`, line + "\n", "", nth]);
    const names = /^ {4}"(_shared\/ai_provider\/[a-z0-9_]+\.ts)": \[(.*)\],$/u.exec(line);
    if (names) {
      const list = [...names[2].matchAll(/"([^"]+)"/gu)].map((m) => m[1]);
      for (const n of list) {
        const rest = list.filter((x) => x !== n).map((x) => `"${x}"`).join(", ");
        variants.push([`drop ${n} from ${names[1]} (#${nth})`, line, `    "${names[1]}": [${rest}],`, nth]);
      }
    }
  }
  let caught = 0;
  for (const [label, from, to, nth] of variants) {
    const root = new URL(`file://${tmpRoot2}/${caught + 1}/`);
    for (const dir of ["supabase/functions/", "src/", "apps/"]) await copyTree(new URL(dir, REPO), new URL(dir, root));
    await editNth(root, PROVIDER_TEST, from, to, nth);
    const r = await isolation(root);
    if (r.ok) {
      failures++;
      console.log(`BAD  minimality: ${label} still passes (an unnecessary grant)`);
    } else caught++;
    await Deno.remove(root, { recursive: true });
  }
  // 8 file references + 12 reachers + 28 provider names (G6-05 ... G6-23), counted from the recorded grants.
  if (variants.length !== 48) {
    failures++;
    console.log(`BAD  minimality: expected 48 single grants, parsed ${variants.length}`);
  }
  console.log(`${caught === variants.length ? "OK  " : "BAD "} minimality: ${caught}/${variants.length} single-grant removals each make the tree fail`);
}
await Deno.remove(tmpRoot2, { recursive: true }).catch(() => {});
console.log(failures === 0 ? "EDGE PREFLIGHT: ALL CASES AS EXPECTED" : `EDGE PREFLIGHT: ${failures} UNEXPECTED`);
if (failures) Deno.exit(1);
