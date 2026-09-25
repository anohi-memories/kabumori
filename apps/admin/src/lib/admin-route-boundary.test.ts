import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";

// Structural guard for which Admin routes are reachable without an Admin
// session. Authorization is enforced by app/(admin)/layout.tsx, and proxy.ts
// only refreshes the session cookie, so a page is protected exactly when it
// lives under (admin)/. Adding a page anywhere else makes it public; this test
// forces that to be an explicit, reviewed decision.

const APP_DIR = new URL("../app/", import.meta.url);

const PUBLIC_PAGES = new Set([
  "login/page.tsx",
  "forgot-password/page.tsx",
  "reset-password/page.tsx",
  "unauthorized/page.tsx",
]);
const PUBLIC_ROUTE_HANDLERS = new Set(["auth/confirm/route.ts"]);

// Files that make up the password recovery / invite flow.
const RECOVERY_FLOW_FILES = [
  "forgot-password/page.tsx",
  "forgot-password/forgot-password-form.tsx",
  "reset-password/page.tsx",
  "reset-password/reset-password-form.tsx",
  "reset-password/recovery-link-fallback.tsx",
  "auth/confirm/route.ts",
];

async function listFiles(dir: URL, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(new URL(`${entry.name}/`, dir), `${relative}/`)));
    } else {
      files.push(relative);
    }
  }
  return files;
}

async function appSource(relative: string) {
  return await readFile(new URL(relative, APP_DIR), "utf8");
}

// Code only: drops `//` comment lines so explanatory comments (e.g. "No <form>
// element ...") don't trip the structural checks below.
function withoutLineComments(contents: string) {
  return contents
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

test("every page is either under (admin)/ or an explicitly public auth page", async () => {
  const pages = (await listFiles(APP_DIR)).filter((file) => file.endsWith("/page.tsx"));
  assert.ok(pages.length > 0);
  for (const page of pages) {
    if (page.startsWith("(admin)/")) continue;
    assert.ok(PUBLIC_PAGES.has(page), `unexpected public page: ${page}`);
  }
  for (const page of PUBLIC_PAGES) {
    assert.ok(pages.includes(page), `expected public page missing: ${page}`);
  }
});

test("the only route handler is the recovery/invite link receiver", async () => {
  const handlers = (await listFiles(APP_DIR)).filter((file) => /\/route\.tsx?$/u.test(file));
  assert.deepEqual(new Set(handlers), PUBLIC_ROUTE_HANDLERS);
});

test("the (admin) layout still requires a session and an admin_users row", async () => {
  const layout = await appSource("(admin)/layout.tsx");
  assert.match(layout, /supabase\.auth\.getUser\(\)/u);
  assert.match(layout, /redirect\(hadLoginAttempt \? "\/login\?reason=session" : "\/login"\)/u);
  assert.match(layout, /\.from\("admin_users"\)/u);
  assert.match(layout, /redirect\("\/unauthorized"\)/u);
});

test("the proxy never redirects, so public auth routes stay reachable without a loop", async () => {
  const proxy = await readFile(new URL("../lib/supabase/proxy.ts", import.meta.url), "utf8");
  assert.doesNotMatch(proxy, /redirect/iu);
});

test("recovery flow reads no data and never touches admin authorization", async () => {
  for (const file of RECOVERY_FLOW_FILES) {
    const contents = await appSource(file);
    assert.doesNotMatch(contents, /admin_users/u, `${file} must not reference admin_users`);
    assert.doesNotMatch(contents, /\.from\(/u, `${file} must not query tables`);
    assert.doesNotMatch(contents, /service_role|SERVICE_ROLE/u, `${file} must not use service_role`);
  }
});

test("recovery flow logs nothing and never submits through a native <form>", async () => {
  for (const file of RECOVERY_FLOW_FILES) {
    const contents = withoutLineComments(await appSource(file));
    assert.doesNotMatch(contents, /console\./u, `${file} must not log`);
    assert.doesNotMatch(contents, /<form/u, `${file} must not use a native form submission`);
  }
});

test("the link receiver takes no redirect target from the request", async () => {
  const route = await appSource("auth/confirm/route.ts");
  // The query string is only ever interpreted by resolveConfirmAction, which
  // has no next/redirect_to handling.
  assert.doesNotMatch(route, /searchParams\.get\(/u);
  assert.doesNotMatch(route, /["'](?:next|redirect_to|redirectTo)["']/u);
  assert.match(route, /resolveConfirmAction\(request\.nextUrl\.searchParams\)/u);
  // Every redirect goes through buildSameOriginRedirect (absolute URL, no
  // carried-over query); a bare relative redirect was seen to re-attach the
  // incoming query string on Netlify.
  const code = withoutLineComments(route);
  assert.doesNotMatch(code, /from "next\/navigation"/u);
  assert.match(code, /NextResponse\.redirect\(buildSameOriginRedirect\(request\.url, path\), 307\)/u);
  assert.equal((code.match(/NextResponse\.redirect\(/gu) ?? []).length, 1);
});

test("the reset page gates the form on a verified recovery context", async () => {
  const page = await appSource("reset-password/page.tsx");
  assert.match(page, /supabase\.auth\.getClaims\(\)/u);
  assert.match(page, /hasRecoveryContext\(/u);
  assert.match(page, /recoveryContext \? \(/u);
});
