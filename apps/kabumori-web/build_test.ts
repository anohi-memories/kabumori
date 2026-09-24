import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSite, PAGES, REQUIRED_VALUES } from "./build.mjs";

const FULL_ENV = {
  KABUMORI_OPERATOR_NAME: "テスト運営者",
  KABUMORI_SUPPORT_EMAIL: "support@example.com",
  KABUMORI_POLICY_EFFECTIVE_DATE: "2026-10-01",
};

function build(env: Record<string, string>, production: boolean) {
  const outDir = mkdtempSync(join(tmpdir(), "kabumori-web-"));
  try {
    const result = buildSite({ outDir, env, production });
    const read = (route: string) =>
      readFileSync(route === "/" ? join(outDir, "index.html") : join(outDir, route.slice(1), "index.html"), "utf8");
    const pages = Object.fromEntries(PAGES.map((page) => [page.route, read(page.route)]));
    return { result, pages, css: existsSync(join(outDir, "styles.css")) };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

test("every release route is built", () => {
  const { result, css } = build(FULL_ENV, true);
  assert.deepEqual(result.routes, ["/", "/privacy", "/terms", "/support", "/account-deletion"]);
  assert.equal(css, true);
});

test("a production build refuses to run while any operator value is missing or malformed", () => {
  for (const { key } of REQUIRED_VALUES) {
    const env = { ...FULL_ENV, [key]: "" };
    assert.throws(() => build(env, true), new RegExp(key));
  }
  assert.throws(() => build({ ...FULL_ENV, KABUMORI_SUPPORT_EMAIL: "not-an-email" }, true), /KABUMORI_SUPPORT_EMAIL/);
  assert.throws(() => build({ ...FULL_ENV, KABUMORI_POLICY_EFFECTIVE_DATE: "10/1" }, true), /EFFECTIVE_DATE/);
});

test("a production build contains no placeholder and is indexable", () => {
  const { pages } = build(FULL_ENV, true);
  for (const [route, html] of Object.entries(pages)) {
    assert.ok(!html.includes("{{"), `${route} has an unrendered token`);
    assert.ok(!html.includes("未設定"), `${route} shows an unset value`);
    assert.ok(!html.includes("プレビュー版"), `${route} carries the preview banner`);
    assert.match(html, /<meta name="robots" content="index, follow">/);
    assert.match(html, /<html lang="ja">/);
    assert.match(html, /name="viewport"/);
  }
  assert.match(pages["/privacy"], /mailto:support@example\.com/);
  assert.match(pages["/privacy"], /テスト運営者/);
});

test("a preview build shows every missing value visibly and is not indexed", () => {
  const { result, pages } = build({}, false);
  assert.equal(result.preview, true);
  assert.equal(result.missing.length, REQUIRED_VALUES.length);
  for (const [route, html] of Object.entries(pages)) {
    assert.ok(!html.includes("{{"), `${route} has an unrendered token`);
    assert.match(html, /プレビュー版です/);
    assert.match(html, /noindex, nofollow/);
  }
  assert.match(pages["/privacy"], /【未設定：運営者名】/);
});

test("operator values are HTML-escaped", () => {
  const { pages } = build({ ...FULL_ENV, KABUMORI_OPERATOR_NAME: '<script>x</script>"' }, true);
  assert.ok(!pages["/privacy"].includes("<script>x</script>"));
  assert.match(pages["/privacy"], /&lt;script&gt;/);
});

test("the pages carry no secret or internal identifier", () => {
  const { pages } = build(FULL_ENV, true);
  const sources = [
    ...Object.values(pages),
    readFileSync(new URL("./netlify.toml", import.meta.url), "utf8"),
  ].join("\n");
  for (const forbidden of [
    /eyJ[A-Za-z0-9_-]{10,}/, // JWT-shaped values
    /sb_(publishable|secret)_/, // Supabase keys
    /service_role/i,
    /sk-[A-Za-z0-9]{10,}/, // OpenAI keys
    /[a-z]{20}\.supabase\.co/, // project ref
    /wsmznyzcvmuitkglfeuj/,
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, // UUIDs
  ]) {
    assert.ok(!forbidden.test(sources), `found ${forbidden}`);
  }
});

test("the privacy page names every processor the app actually sends data to", () => {
  const { pages } = build(FULL_ENV, true);
  const privacy = pages["/privacy"];
  for (const processor of ["Supabase", "Expo", "Apple Push Notification service", "OpenAI"]) {
    assert.ok(privacy.includes(processor), processor);
  }
  // The report generator does not send these; the page must not claim otherwise.
  assert.match(privacy, /メールアドレス、ユーザーID、メモ、目標価格は送信しません/);
});

test("the account deletion page describes the in-app path that exists", () => {
  const { pages } = build(FULL_ENV, true);
  assert.match(pages["/account-deletion"], /「設定」/);
  assert.match(pages["/account-deletion"], /「アカウントを削除」/);
  assert.match(pages["/account-deletion"], /「アカウントを完全に削除する」/);
});
