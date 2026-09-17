import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const BRAND_FILTER = /\.eq\("brand_id", KABUMORI_BRAND_ID\)/u;

async function source(name: string) {
  return await readFile(new URL(name, import.meta.url), "utf8");
}

function queryStatements(contents: string, table: string) {
  const marker = `.from("${table}")`;
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

function assertKabumoriOnly(
  contents: string,
  table: string,
  expectedQueries: number,
) {
  const statements = queryStatements(contents, table);
  assert.equal(
    statements.length,
    expectedQueries,
    `${table} query count changed`,
  );
  for (const statement of statements) {
    assert.match(
      statement,
      BRAND_FILTER,
      `${table} must be filtered server-side to Kabumori`,
    );
  }
}

test("today schedule excludes AI Lab rows at both server-side query boundaries", async () => {
  const contents = await source("./today-scheduled-posts.ts");
  assertKabumoriOnly(contents, "scheduled_posts", 1);
  assertKabumoriOnly(contents, "post_execution_logs", 1);
});

test("post history excludes other brands from logs and scheduled-row hydration", async () => {
  const contents = await source("./post-history.ts");
  assertKabumoriOnly(contents, "scheduled_posts", 1);
  assertKabumoriOnly(contents, "post_execution_logs", 1);
});

test("recent failures excludes other brands from logs and scheduled-row hydration", async () => {
  const contents = await source("./recent-failures.ts");
  assertKabumoriOnly(contents, "scheduled_posts", 1);
  assertKabumoriOnly(contents, "post_execution_logs", 1);
});

test("dashboard posting-window status reads Kabumori rows only", async () => {
  const contents = await source("./system-status.ts");
  assertKabumoriOnly(contents, "posting_windows", 2);
});

test("the Admin brand boundary remains the exact Kabumori id", async () => {
  const contents = await source("./brand-boundary.ts");
  assert.match(contents, /KABUMORI_BRAND_ID = "kabumori"/u);
  assert.doesNotMatch(contents, /ai_salaryman_lab|mio/u);
});
