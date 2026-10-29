// G6-05 (2026-10-19): an EXECUTABLE preflight of the proposed Edge placement of the G6 AI gateway, run entirely on
// throw-away copies. Nothing in the repository is changed: the shared provider's isolation test, its allowlists and
// `supabase/functions/_shared/ai_gateway/` stay as they are; the proposal lives in supabase/tests/fixtures/g6_05_edge_placement/.
//
// For each case it copies supabase/functions + src + apps (no node_modules, no dot entries) into a temp directory, places
// supabase/ai_gateway/*.ts at functions/_shared/ai_gateway/ (only the import paths are rewritten), optionally applies the
// proposed allowlist patch and the proposed G6 isolation test, optionally applies a malicious change, and runs the COPY's own
// provider isolation test, consumer bridge isolation test and (when placed) the G6 isolation test. Expected:
//   baseline (repository as is)                     -> PASS  (the real tests on an unchanged tree)
//   placed, no patch                                -> FAIL  (the boundary refuses the unauthorized placement)
//   placed + proposal                               -> PASS  (the minimal widening is exactly enough)
//   placed + proposal + any malicious change        -> FAIL  (the widening admits nothing else)
//
//   deno run --no-config --allow-read --allow-write=<tmp> --allow-run=deno,patch --allow-env=TMPDIR,HOME,DENO_DIR \
//     supabase/tests/common_ai_gateway_edge_preflight.ts [--only=<case>] [--show=<case>]
const REPO = new URL("../../", import.meta.url);
const FIXTURES = new URL("./fixtures/g6_05_edge_placement/", import.meta.url);
const PATCH = new URL("provider_isolation_allowlist.patch", FIXTURES);
const G6_ISOLATION = new URL("ai_gateway_isolation_test.ts.txt", FIXTURES);
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

/** The placement: the same files, only their import paths rewritten for functions/_shared/ai_gateway/. */
const REWRITES: ReadonlyArray<[string, string]> = [
  ["../functions/_shared/ai_provider/", "../ai_provider/"],
  ["../functions/_shared/brand/", "../brand/"],
  ["../functions/social-mobile-consult/", "../../social-mobile-consult/"],
];
async function place(root: URL): Promise<string[]> {
  const target = new URL("supabase/functions/_shared/ai_gateway/", root);
  await Deno.mkdir(target, { recursive: true });
  const placed: string[] = [];
  for await (const entry of Deno.readDir(new URL("supabase/ai_gateway/", REPO))) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    let text = await Deno.readTextFile(new URL(`supabase/ai_gateway/${entry.name}`, REPO));
    for (const [a, b] of REWRITES) text = text.replaceAll(a, b);
    if (text.includes("../functions/")) throw new Error(`unrewritten path in ${entry.name}`);
    await Deno.writeTextFile(new URL(entry.name, target), text);
    placed.push(entry.name);
  }
  return placed.sort();
}

async function run(cmd: string, args: string[], cwd: URL): Promise<{ ok: boolean; out: string }> {
  const r = await new Deno.Command(cmd, { args, cwd, stdout: "piped", stderr: "piped", env: { NO_COLOR: "1" } }).output();
  const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
  return { ok: r.success, out };
}

/** The isolation tests of the copy: the provider's, the consumer bridge's and (when placed) the G6 one. */
async function isolation(root: URL, withG6: boolean): Promise<{ ok: boolean; out: string }> {
  const files = ["supabase/functions/_shared/ai_provider/isolation_test.ts", "supabase/functions/_shared/ai_consumer_bridge/isolation_test.ts"];
  if (withG6) files.push("supabase/functions/_shared/ai_gateway/isolation_test.ts");
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

/** G6-23: put the proposed Edge entry file in the copy, with (or without) its entry-point grant. */
const ENTRY_FIXTURES = new URL("./fixtures/g6_23_post_assist_edge/", import.meta.url);
async function placeEntry(root: URL, approved: boolean): Promise<void> {
  await Deno.mkdir(new URL("supabase/functions/postona-post-assist/", root), { recursive: true });
  await Deno.copyFile(new URL("index.ts.txt", ENTRY_FIXTURES), new URL("supabase/functions/postona-post-assist/index.ts", root));
  if (!approved) return;
  const p = await run("patch", ["-p1", "--forward", "--no-backup-if-mismatch", "-i", new URL("entry_point_allowlist.patch", ENTRY_FIXTURES).pathname], root);
  if (!p.ok) throw new Error(`entry patch did not apply:\n${p.out}`);
}

type Case = Readonly<{ name: string; place: boolean; proposal: boolean; expect: "pass" | "fail"; mutate?: (root: URL) => Promise<void>; why: string }>;
const G = "supabase/functions/_shared/ai_gateway/";
const CASES: readonly Case[] = [
  { name: "baseline", place: false, proposal: false, expect: "pass", why: "the real isolation tests pass on an unchanged copy" },
  { name: "placed-without-proposal", place: true, proposal: false, expect: "fail", why: "the boundary refuses an unauthorized placement" },
  { name: "placed-with-proposal", place: true, proposal: true, expect: "pass", why: "the proposed widening is exactly enough" },
  {
    name: "extra-provider-name", place: true, proposal: true, expect: "fail", why: "a placed file takes a provider name the proposal does not list (secret reader)",
    mutate: (r) => edit(r, G + "runtime.ts", "import { SecretValue } from \"../ai_provider/secrets.ts\";", "import { resolveSecret, SecretValue } from \"../ai_provider/secrets.ts\";\nvoid resolveSecret;"),
  },
  {
    name: "namespace-import", place: true, proposal: true, expect: "fail", why: "a namespace import hands over every provider export",
    mutate: (r) => edit(r, G + "app_policies.ts", "import { findModelSpec } from \"../ai_provider/mod.ts\";", "import * as P from \"../ai_provider/mod.ts\";\nconst findModelSpec = P.findModelSpec;"),
  },
  {
    name: "dynamic-import", place: true, proposal: true, expect: "fail", why: "a dynamic import of the provider is refused",
    mutate: (r) => edit(r, G + "authority_port.ts", "export type VerdictScope", "export const loadProvider = () => import(\"../ai_provider/mod.ts\");\nexport type VerdictScope"),
  },
  {
    name: "unlisted-placed-file", place: true, proposal: true, expect: "fail", why: "a new gateway file that reaches the provider is not authorized by name",
    mutate: (r) => Deno.writeTextFile(new URL(G + "extra.ts", r), "import { executeAiRequest } from \"../ai_provider/mod.ts\";\nexport const run = executeAiRequest;\n"),
  },
  {
    name: "edge-entry-imports-gateway", place: true, proposal: true, expect: "fail", why: "no Edge entry point may reach the provider through the gateway before its own approval",
    mutate: (r) => edit(r, "supabase/functions/social-mobile-consult/index.ts", "import { handleSocialMobileConsult } from \"./logic.ts\";", "import { handleSocialMobileConsult } from \"./logic.ts\";\nimport { handleConsultViaGateway } from \"../_shared/ai_gateway/postona_consult_adapter.ts\";\nvoid handleConsultViaGateway;"),
  },
  {
    name: "post-assist-entry-without-approval", place: true, proposal: true, expect: "fail", why: "G6-23's exact Edge entry (postona-post-assist/index.ts) is refused without its own entry-point grant",
    mutate: (r) => placeEntry(r, false),
  },
  {
    name: "post-assist-entry-with-approval", place: true, proposal: true, expect: "pass", why: "G6-23's exact Edge entry plus entry_point_allowlist.patch is exactly enough (and type-checks in place)",
    mutate: (r) => placeEntry(r, true),
  },
  {
    name: "post-assist-entry-no-entry-point-grant", place: true, proposal: true, expect: "fail", why: "the entry patch minus its AUTHORIZED_ENTRY_POINTS grant",
    mutate: async (r) => {
      await placeEntry(r, true);
      await edit(r, "supabase/functions/_shared/ai_provider/isolation_test.ts", ", \"postona-post-assist/index.ts\"];", "];");
    },
  },
  {
    name: "post-assist-entry-no-reacher-grant", place: true, proposal: true, expect: "fail", why: "the entry patch minus its AUTHORIZED_REACHERS grant",
    mutate: async (r) => {
      await placeEntry(r, true);
      await edit(r, "supabase/functions/_shared/ai_provider/isolation_test.ts", "  \"postona-post-assist/index.ts\",\n];", "];");
    },
  },
  {
    name: "post-assist-entry-imports-more", place: true, proposal: true, expect: "fail", why: "the approved entry may import only postona_post_assist_edge.ts",
    mutate: async (r) => {
      await placeEntry(r, true);
      await edit(r, "supabase/functions/postona-post-assist/index.ts", "\nDeno.serve(", "import { createAiGateway } from \"../_shared/ai_gateway/runtime.ts\";\nvoid createAiGateway;\n\nDeno.serve(");
    },
  },
  {
    name: "other-function-imports-gateway", place: true, proposal: true, expect: "fail", why: "another deployable file may not import the gateway (it would reach the provider)",
    mutate: (r) => Deno.writeTextFile(new URL("supabase/functions/_shared/brand/ai_shortcut.ts", r), "import { createAiGateway } from \"../ai_gateway/runtime.ts\";\nexport const make = createAiGateway;\n"),
  },
  {
    name: "anthropic-key-name", place: true, proposal: true, expect: "fail", why: "an ANTHROPIC_* name outside the provider module",
    mutate: (r) => edit(r, G + "runtime.ts", "const PROVIDER_KEY_NAMES", "const SHORTCUT = \"ANTHROPIC_API_KEY\";\nvoid SHORTCUT;\nconst PROVIDER_KEY_NAMES"),
  },
  {
    name: "environment-read", place: true, proposal: true, expect: "fail", why: "a placed file reads the environment itself (the G6 isolation test)",
    mutate: (r) => edit(r, G + "runtime.ts", "const PROVIDER_KEY_NAMES", "const SERVICE = Deno.env.get(\"SUPABASE_SERVICE_ROLE_KEY\");\nvoid SERVICE;\nconst PROVIDER_KEY_NAMES"),
  },
  {
    name: "console-log", place: true, proposal: true, expect: "fail", why: "a placed file writes logs (the G6 isolation test)",
    mutate: (r) => edit(r, G + "g5_rpc_transport.ts", "  async function ask(", "  console.log(\"g5\");\n  async function ask("),
  },
  {
    name: "gateway-imports-bridge", place: true, proposal: true, expect: "fail", why: "the gateway may not pull in the Claude-only consumer bridge",
    mutate: (r) => edit(r, G + "gateway.ts", "export type AppId", "import type { BridgeResult } from \"../ai_consumer_bridge/types.ts\";\nexport type Unused = BridgeResult;\nexport type AppId"),
  },
  {
    name: "node-import", place: true, proposal: true, expect: "fail", why: "a node: import in a placed file (the G6 isolation test)",
    mutate: (r) => edit(r, G + "policy_registry.ts", "const APPS", "import \"node:crypto\";\nconst APPS"),
  },
  {
    name: "app-references-gateway-key", place: true, proposal: true, expect: "fail", why: "an app file naming the provider key (keys stay server-side)",
    mutate: (r) => Deno.writeTextFile(new URL("src/leak_probe.ts", r), "export const k = \"ANTHROPIC_API_KEY\";\n"),
  },
];

// The proposal only ADDS allowlist entries: no existing line of the provider's isolation test is removed or changed.
{
  const patch = await Deno.readTextFile(PATCH);
  const lines = patch.split("\n");
  const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---"));
  const files = lines.filter((l) => l.startsWith("+++ "));
  if (removed.length !== 0 || files.length !== 1 || !files[0].startsWith("+++ b/supabase/functions/_shared/ai_provider/isolation_test.ts")) {
    console.log(`BAD  proposal-only-adds: ${removed.length} removed line(s), files ${JSON.stringify(files)}`);
    Deno.exit(1);
  }
  console.log(`OK   proposal-only-adds: ${lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length} added lines, 0 removed, 1 file (the provider's isolation test)`);
}

// The real path (macOS: /var is /private/var), so the copy's own permission scope and import.meta.url agree.
const tmpRoot = await Deno.realPath(await Deno.makeTempDir({ prefix: "g6_05_edge_" }));
const tmpRoot2 = await Deno.realPath(await Deno.makeTempDir({ prefix: "g6_05_min_" }));
let failures = 0;
try {
  for (const c of CASES) {
    if (only && c.name !== only) continue;
    const root = new URL(`file://${tmpRoot}/${c.name}/`);
    for (const dir of ["supabase/functions/", "src/", "apps/"]) await copyTree(new URL(dir, REPO), new URL(dir, root));
    if (c.place) await place(root);
    if (c.proposal) {
      const p = await run("patch", ["-p1", "--forward", "--no-backup-if-mismatch", "-i", PATCH.pathname], root);
      if (!p.ok) throw new Error(`proposal patch did not apply:\n${p.out}`);
      await Deno.copyFile(G6_ISOLATION, new URL(G + "isolation_test.ts", root));
    }
    if (c.mutate) await c.mutate(root);
    let r = await isolation(root, c.proposal);
    if (c.name === "post-assist-entry-with-approval" && r.ok) {
      const t = await run("deno", ["check", "--cached-only", "--config", "supabase/functions/_shared/ai_consumer_bridge/deno.json", "supabase/functions/postona-post-assist/index.ts"], root);
      console.log(`       deno check of the placed Edge entry: ${t.ok ? "OK" : "FAILED"}`);
      if (!t.ok) r = { ok: false, out: r.out + t.out };
    }
    if (c.name === "placed-with-proposal" && r.ok) {
      // The placed files also type-check where they would live (the same config the provider tests use).
      const t = await run("deno", ["check", "--cached-only", "--config", "supabase/functions/_shared/ai_consumer_bridge/deno.json",
        "supabase/functions/_shared/ai_gateway/runtime.ts", "supabase/functions/_shared/ai_gateway/postona_consult_adapter.ts",
        "supabase/functions/_shared/ai_gateway/g5_rpc_transport.ts", "supabase/functions/_shared/ai_gateway/app_policies.ts"], root);
      console.log(`       deno check of the placed files: ${t.ok ? "OK" : "FAILED"}`);
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
// Minimality: every single grant of the proposal is needed. Each variant drops ONE allowlist line (a file's references or a
// reacher) or ONE name from a file's provider imports, on top of the full proposal; each variant must FAIL.
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
    await place(root);
    const p = await run("patch", ["-p1", "--forward", "--no-backup-if-mismatch", "-i", PATCH.pathname], root);
    if (!p.ok) throw new Error(`proposal patch did not apply:\n${p.out}`);
    await Deno.copyFile(G6_ISOLATION, new URL(G + "isolation_test.ts", root));
    await editNth(root, "supabase/functions/_shared/ai_provider/isolation_test.ts", from, to, nth);
    const r = await isolation(root, true);
    if (r.ok) {
      failures++;
      console.log(`BAD  minimality: ${label} still passes (an unnecessary grant)`);
    } else caught++;
    await Deno.remove(root, { recursive: true });
  }
  // 8 file references (G6-23 adds postona_post_assist_edge.ts) + 12 reachers (G6-06 adds recovery.ts, G6-20
  // postona_post_assist.ts, G6-21 postona_post_assist_mvp.ts, G6-23 postona_post_assist_edge.ts) + 28 provider names
  // (G6-20 adds LedgerOwnerNotHeldError for gateway.ts, G6-23 SecretValue for the Edge entry), counted from the patch.
  if (variants.length !== 48) {
    failures++;
    console.log(`BAD  minimality: expected 48 single grants in the proposal, parsed ${variants.length}`);
  }
  console.log(`${caught === variants.length ? "OK  " : "BAD "} minimality: ${caught}/${variants.length} single-grant removals each make the placed tree fail`);
}
await Deno.remove(tmpRoot2, { recursive: true }).catch(() => {});
console.log(failures === 0 ? "EDGE PREFLIGHT: ALL CASES AS EXPECTED" : `EDGE PREFLIGHT: ${failures} UNEXPECTED`);
if (failures) Deno.exit(1);
