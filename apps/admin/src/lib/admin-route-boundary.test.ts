import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { CONFIRM_SUCCESS_DESTINATION } from "./password-recovery.ts";

// Structural guard for which Admin routes are reachable without an Admin
// session. Authorization is enforced by app/(admin)/layout.tsx, and proxy.ts
// only refreshes the session cookie, so a page is protected exactly when it
// lives under (admin)/. Adding a page anywhere else makes it public; this test
// forces that to be an explicit, reviewed decision.

const APP_DIR = new URL("../app/", import.meta.url);
const RECOVERY_CONTEXT_ACTION = new URL("./actions/recovery-context.ts", import.meta.url);

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
  // Every redirect targets one of the two fixed destinations (relative path +
  // own query string). An absolute URL from request.url is not used: on Netlify
  // it pointed at the per-deploy host, where the session cookie does not exist.
  const code = withoutLineComments(route);
  assert.doesNotMatch(code, /NextResponse\.redirect|request\.url/u);
  const redirects = code.match(/redirect\([^)]*\)/gu) ?? [];
  assert.equal(redirects.length, 3);
  for (const call of redirects) {
    assert.match(call, /^redirect\((?:CONFIRM_(?:SUCCESS|FAILURE)_DESTINATION|error \? CONFIRM_FAILURE_DESTINATION : CONFIRM_SUCCESS_DESTINATION)\)$/u, call);
  }
});

test("a consumed or reused link fails closed instead of reaching the reset form", async () => {
  // Supabase rejects an already-used code / token_hash; any error from
  // verifyOtp / exchangeCodeForSession must land on the failure destination.
  const route = withoutLineComments(await appSource("auth/confirm/route.ts"));
  assert.match(route, /redirect\(error \? CONFIRM_FAILURE_DESTINATION : CONFIRM_SUCCESS_DESTINATION\)/u);
});

test("a successful reset goes to /login, never straight into an Admin route", async () => {
  // Setting a password must not imply Admin access: the user signs in again
  // and the (admin) layout's admin_users check decides, so a non-admin whose
  // reset succeeds still ends at /unauthorized.
  const form = withoutLineComments(await appSource("reset-password/reset-password-form.tsx"));
  assert.match(form, /const PASSWORD_UPDATED_LOGIN = "\/login\?reason=password_updated";/u);
  const navigations = form.match(/window\.location\.(?:assign|replace|href)\b[^;]*/gu) ?? [];
  assert.ok(navigations.length > 0);
  for (const navigation of navigations) {
    assert.equal(navigation, "window.location.replace(PASSWORD_UPDATED_LOGIN)", navigation);
  }
  const confirmTarget = new URL(CONFIRM_SUCCESS_DESTINATION, "https://x.invalid");
  assert.ok(PUBLIC_PAGES.has(`${confirmTarget.pathname.slice(1)}/page.tsx`));
});

test("implicit-flow credentials are removed from the address bar before any network call", async () => {
  const fallback = withoutLineComments(await appSource("reset-password/recovery-link-fallback.tsx"));
  const strip = fallback.indexOf("window.history.replaceState(");
  const establish = fallback.indexOf("establishSessionFromFragment(");
  assert.ok(strip >= 0 && establish >= 0);
  assert.ok(strip < establish, "the fragment must be stripped before setSession runs");
});

test("public recovery pages do not depend on the Admin brand context", async () => {
  // The multibrand helpers resolve an Admin's allowed brands and redirect
  // non-admins to /unauthorized; the recovery pages must work for any user
  // holding a valid link (including a not-yet-authorized invitee).
  for (const file of RECOVERY_FLOW_FILES) {
    const contents = await appSource(file);
    assert.doesNotMatch(contents, /active-brand|selected-brand|admin-brands|admin-context/u, file);
  }
});

test("the reset page gates the form on a verified recovery context", async () => {
  const page = withoutLineComments(await appSource("reset-password/page.tsx"));
  assert.match(page, /const recoveryContext = await verifyRecoveryContext\(\);/u);
  assert.match(page, /recoveryContext \? \(/u);
});

test("the recovery authority check verifies signed claims on the server clock", async () => {
  const action = withoutLineComments(await readFile(RECOVERY_CONTEXT_ACTION, "utf8"));
  assert.match(action, /^"use server";/u);
  assert.match(action, /supabase\.auth\.getClaims\(\)/u);
  assert.match(action, /hasRecoveryContext\(data\.claims\.amr, Math\.floor\(Date\.now\(\) \/ 1000\)\)/u);
  // Same data-safety rules as the pages: no table reads, no Admin grant, no
  // service role, no logging.
  assert.doesNotMatch(action, /\.from\(|admin_users|service_role|SERVICE_ROLE|console\./u);
  // Takes no arguments, so the password can never be sent through it.
  assert.match(action, /export async function verifyRecoveryContext\(\): Promise<boolean>/u);
  assert.equal((action.match(/export async function/gu) ?? []).length, 1);
});

test("the password update re-verifies the context at submit time (C1 P2)", async () => {
  const form = withoutLineComments(await appSource("reset-password/reset-password-form.tsx"));
  // The form no longer receives a render-time boolean it could trust later.
  assert.doesNotMatch(form, /recoveryContext/u);
  assert.match(
    form,
    /completePasswordReset\(\s*createAdminBrowserClient\(\)\.auth,\s*password,\s*confirmation,\s*verifyRecoveryContext,\s*\)/u,
  );
});

test("an unconfirmed sign-out never navigates away as if signed out (C1 P2)", async () => {
  const form = withoutLineComments(await appSource("reset-password/reset-password-form.tsx"));
  // Navigation to the post-update login happens only for "updated" and after
  // a retry that signOutConfirmed() reports as successful.
  assert.match(form, /if \(result\.status === "updated"\) \{\s*[^}]*window\.location\.replace\(PASSWORD_UPDATED_LOGIN\);/u);
  assert.match(form, /if \(await signOutConfirmed\(createAdminBrowserClient\(\)\.auth\)\) \{\s*window\.location\.replace\(PASSWORD_UPDATED_LOGIN\);/u);
  assert.match(form, /case "updated_signout_unconfirmed":\s*setPassword\(""\);\s*setConfirmation\(""\);\s*setSignOutPending\(true\);\s*return;/u);
});
