import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// Phase 2: every operational query is filtered by the already-authorized active brand id that the
// function receives (typed AuthorizedBrandId), never by a hardcoded brand and never unfiltered.
const PARAM_BRAND_FILTER = /\.eq\("brand_id", (brandId|brand\.id)\)/u;

async function source(name: string) {
  return await readFile(new URL(name, import.meta.url), "utf8");
}

function queryStatements(contents: string, table: string) {
  const marker = `.from(${table})`;
  const statements: string[] = [];
  let cursor = 0;
  while (true) {
    const start = contents.indexOf(marker, cursor);
    if (start < 0) return statements;
    const end = contents.indexOf(";", start);
    assert.ok(end > start, `unterminated ${table} query`);
    statements.push(contents.slice(start, end));
    cursor = end + 1;
  }
}

function assertBrandParameterized(contents: string, table: string, expectedQueries: number) {
  const statements = queryStatements(contents, table);
  assert.equal(statements.length, expectedQueries, `${table} query count changed`);
  for (const statement of statements) {
    assert.match(
      statement,
      PARAM_BRAND_FILTER,
      `${table} must be filtered server-side by the authorized active brand`,
    );
  }
}

test("today schedule filters both queries by the authorized active brand", async () => {
  const contents = await source("./today-scheduled-posts.ts");
  assert.match(contents, /brandId: AuthorizedBrandId/u);
  assertBrandParameterized(contents, '"scheduled_posts"', 1);
  assertBrandParameterized(contents, '"post_execution_logs"', 1);
});

test("post history filters logs, scheduled rows, and report runs by the authorized active brand", async () => {
  const contents = await source("./post-history.ts");
  assert.match(contents, /brand: ActiveBrand/u);
  assertBrandParameterized(contents, '"scheduled_posts"', 1);
  assertBrandParameterized(contents, '"post_execution_logs"', 1);
  // getReportRuns is the single query used for morning/close/us_premarket report runs.
  assertBrandParameterized(contents, "table", 1);
  assert.doesNotMatch(contents, /yume_daka/u, "the X URL handle must come from the active brand");
});

test("recent failures filters logs, morning runs, and scheduled rows by the authorized active brand", async () => {
  const contents = await source("./recent-failures.ts");
  assert.match(contents, /brandId: AuthorizedBrandId/u);
  assertBrandParameterized(contents, '"scheduled_posts"', 1);
  assertBrandParameterized(contents, '"post_execution_logs"', 1);
  assertBrandParameterized(contents, '"morning_report_runs"', 1);
});

test("system status filters every posting_windows read by the authorized active brand", async () => {
  const contents = await source("./system-status.ts");
  assert.match(contents, /brandId: AuthorizedBrandId/u);
  assertBrandParameterized(contents, '"posting_windows"', 3);
});

test("no query module hardcodes a Kabumori brand_id filter any more", async () => {
  for (const name of [
    "./today-scheduled-posts.ts",
    "./post-history.ts",
    "./recent-failures.ts",
    "./system-status.ts",
  ]) {
    const contents = await source(name);
    assert.doesNotMatch(contents, /\.eq\("brand_id", KABUMORI_BRAND_ID\)/u, name);
    assert.doesNotMatch(contents, /"ai_salaryman_lab"|"mio"/u, name);
  }
});

test("system toggles stay Kabumori-only: posting_windows read and update are pinned to Kabumori", async () => {
  const contents = await source("./actions/system-toggle.ts");
  const statements = queryStatements(contents, '"posting_windows"');
  assert.equal(statements.length, 2, "posting_windows toggle query count changed");
  for (const statement of statements) {
    assert.match(statement, /\.eq\("brand_id", KABUMORI_BRAND_ID\)/u);
  }
  // The action revalidates the current selection and rejects AI Lab or a rejected fallback before DML.
  assert.doesNotMatch(contents, /brand_selection|kabumori_admin_brand/u);
  assert.match(contents, /const activeBrand = await getActiveBrandContext\(\);/u);
  assert.match(contents, /if \(!isKabumoriMutationAllowed\(activeBrand\)\)/u);
  assert.ok(contents.indexOf("if (!isKabumoriMutationAllowed(activeBrand))") < contents.indexOf("  const result =\n    config.mode"));
  assert.match(contents, /export async function setSystemEnabled\(systemKey: string, enabled: boolean\)/u);
});

test("page and brand-selection action independently require the admin_users authority", async () => {
  const active = await source("./active-brand.ts");
  const action = await source("./actions/select-brand.ts");
  assert.match(active, /return chooseAdminActiveBrand\(\{ access, requestedBrandId, registry: ADMIN_BRANDS \}\)/u);
  assert.match(action, /chooseAdminActiveBrand\(\{ access, requestedBrandId: requested, registry: ADMIN_BRANDS \}\)/u);
});

test("the Admin brand boundary remains the exact Kabumori id", async () => {
  const contents = await source("./brand-boundary.ts");
  assert.match(contents, /KABUMORI_BRAND_ID = "kabumori"/u);
  assert.doesNotMatch(contents, /ai_salaryman_lab|mio/u);
});

test("the admin layout keeps its login and admin_users denials ahead of brand resolution", async () => {
  const contents = await source("../app/(admin)/layout.tsx");
  const login = contents.indexOf('redirect(hadLoginAttempt ? "/login?reason=session" : "/login")');
  const adminCheck = contents.indexOf('.from("admin_users")');
  const unauthorized = contents.indexOf('redirect("/unauthorized")');
  const brand = contents.indexOf("getActiveBrandContext()");
  assert.ok(login > 0 && adminCheck > login && unauthorized > adminCheck && brand > unauthorized);
});

test("the brand selection cookie is only written after server-side re-authorization", async () => {
  const contents = await source("./actions/select-brand.ts");
  const user = contents.indexOf("auth.getUser()");
  const access = contents.indexOf("resolveAdminBrandAccess(");
  const rejected = contents.indexOf("resolution.selectionRejected) return;");
  const write = contents.indexOf(".set(BRAND_SELECTION_COOKIE");
  assert.ok(user > 0 && access > user && rejected > access && write > rejected);
  assert.match(contents, /httpOnly: true/u);
  assert.match(contents, /set\(BRAND_SELECTION_COOKIE, resolution\.active\.id/u);
});
