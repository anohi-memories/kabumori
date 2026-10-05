// JP Coverage Phase A (2026-10-06): TDnet's short name is often a truncation or abbreviation of the official
// name (塩野義薬, Ｇ－売れるネットＧ, Ｒ－サンケイＲＥ, ＸＮＥＴ, エプソン ...) while the disclosure spells the
// official name out. For a verified TDnet code, stocks_master's official name for THAT code is one more accepted
// spelling of the issuer. Everything that must stay unconfirmed — other companies, other codes, look-alike
// names, unknown or unlisted codes, other share classes, other sources — is pinned next to the passing cases.
import assert from "node:assert/strict";
import test from "node:test";
import {
  companyIdentityEvidence,
  type GenerationCandidate,
  stocksMasterRootCode,
} from "./post_generation_logic.ts";
import { IDENTITY_FIXTURES } from "./company_identity_fixtures.ts";
import { postgrestStocksMasterLookup, withStocksMasterName } from "./tdnet_stocks_master.ts";

const TDNET_URL = "https://www.release.tdnet.info/inbs/example.pdf";

function candidateOf(overrides: Partial<GenerationCandidate>): GenerationCandidate {
  return {
    id: "candidate-1",
    sourceType: "tdnet",
    sourceUrl: TDNET_URL,
    sourceName: "tdnet",
    title: "お知らせ",
    bodySummary: null,
    companyName: "テスト",
    companyCode: "12340",
    entityKey: "company:12340",
    category: "other",
    publishedAt: "2026-10-01T00:00:00.000Z",
    importance: "important",
    affectedEntities: [],
    japanMarketRelevance: "low",
    judgementReason: "理由",
    judgementFactStatus: "passed",
    status: "ready_for_generation",
    ...overrides,
  } as unknown as GenerationCandidate;
}

const body = (issuer: string) => `各 位\n会 社 名 ${issuer}\n代表者名 代表取締役社長 山田 太郎\nお知らせ本文です。\n`;

// 塩野義薬 (TDnet) = 塩野義製薬 (stocks_master 4507, and the disclosure header).
const SHIONOGI = {
  companyName: "塩野義薬",
  companyCode: "45070",
  entityKey: "company:45070",
  bodySummary: body("塩野義製薬株式会社"),
};
const SHIONOGI_MASTER = { tickerCode: "4507", companyName: "塩野義製薬" };

// --- passes ------------------------------------------------------------------------------------------

test("TDnet short name + the same code's stocks_master name -> confirmed (塩野義薬 = 塩野義製薬)", () => {
  const withMaster = companyIdentityEvidence(candidateOf({ ...SHIONOGI, stocksMaster: SHIONOGI_MASTER }));
  assert.equal(withMaster.sameCompanyConfirmed, true);
  assert.equal(withMaster.primarySourceName, "塩野義製薬株式会社");
  assert.equal(withMaster.metadataName, "塩野義薬");
  assert.equal(withMaster.normalizedSecurityCode, "4507");
});

test("the same disclosure without the master name stays unconfirmed (the previous behaviour)", () => {
  assert.equal(companyIdentityEvidence(candidateOf(SHIONOGI)).sameCompanyConfirmed, false);
  assert.equal(companyIdentityEvidence(candidateOf({ ...SHIONOGI, stocksMaster: null })).sameCompanyConfirmed, false);
});

test("the official name as TDnet's own name is confirmed with or without the master row", () => {
  const official = { ...SHIONOGI, companyName: "塩野義製薬" };
  assert.equal(companyIdentityEvidence(candidateOf(official)).sameCompanyConfirmed, true);
  assert.equal(companyIdentityEvidence(candidateOf({ ...official, stocksMaster: SHIONOGI_MASTER })).sameCompanyConfirmed, true);
});

test("market prefix, growth/REIT abbreviations and alphanumeric codes resolve through the master name", () => {
  const cases = [
    { companyName: "Ｇ－売れるネットＧ", code: "92350", header: "株式会社売れるネット広告社グループ", master: "売れるネット広告社グループ" },
    { companyName: "Ｒ－三井不ロジパーク", code: "34710", header: "三井不動産ロジスティクスパーク投資法人", master: "三井不動産ロジスティクスパーク投資法人" },
    { companyName: "ＸＮＥＴ", code: "47620", header: "株式会社エックスネット", master: "エックスネット" },
    { companyName: "エプソン", code: "67240", header: "セイコーエプソン株式会社", master: "セイコーエプソン" },
    { companyName: "Ｇ－Ｓｙｎｓ", code: "290A0", header: "株式会社Ｓｙｎｓｐｅｃｔｉｖｅ", master: "Ｓｙｎｓｐｅｃｔｉｖｅ" },
  ];
  for (const item of cases) {
    const candidate = candidateOf({
      companyName: item.companyName,
      companyCode: item.code,
      entityKey: `company:${item.code.toLowerCase()}`,
      bodySummary: body(item.header),
      stocksMaster: { tickerCode: item.code.slice(0, 4), companyName: item.master },
    });
    assert.equal(companyIdentityEvidence(candidate).sameCompanyConfirmed, true, item.companyName);
  }
});

test("a lower-case master ticker and surrounding spaces are tolerated, an exact name is still required", () => {
  const ok = candidateOf({ ...SHIONOGI, stocksMaster: { tickerCode: " 4507 ", companyName: " 塩野義製薬 " } });
  assert.equal(companyIdentityEvidence(ok).sameCompanyConfirmed, true);
});

// --- must stay unconfirmed -----------------------------------------------------------------------------

test("another company named in the disclosure -> not confirmed, even with the master row", () => {
  const other = candidateOf({ ...SHIONOGI, bodySummary: body("武田薬品工業株式会社"), stocksMaster: SHIONOGI_MASTER });
  const evidence = companyIdentityEvidence(other);
  assert.equal(evidence.sameCompanyConfirmed, false);
  assert.notEqual(evidence.primarySourceName, "塩野義製薬");
});

test("a master row of a different code is ignored (code mismatch)", () => {
  const wrongRow = candidateOf({ ...SHIONOGI, stocksMaster: { tickerCode: "4502", companyName: "塩野義製薬" } });
  assert.equal(companyIdentityEvidence(wrongRow).sameCompanyConfirmed, false);
  const otherCode = candidateOf({
    ...SHIONOGI,
    companyCode: "45080",
    entityKey: "company:45080",
    stocksMaster: { tickerCode: "4508", companyName: "別の会社" },
  });
  assert.equal(companyIdentityEvidence(otherCode).sameCompanyConfirmed, false);
});

test("a look-alike name is not widened: the master name must equal the disclosure's name", () => {
  const lookAlike = candidateOf({ ...SHIONOGI, stocksMaster: { tickerCode: "4507", companyName: "塩野義製薬ホールディングス" } });
  assert.equal(companyIdentityEvidence(lookAlike).sameCompanyConfirmed, false);
  const prefixOnly = candidateOf({ ...SHIONOGI, bodySummary: body("塩野義製薬ホールディングス株式会社"), stocksMaster: SHIONOGI_MASTER });
  assert.equal(companyIdentityEvidence(prefixOnly).sameCompanyConfirmed, false, "no safe-suffix widening for the master name");
});

test("missing code, unverified entity key, or other share class: the master name is never used", () => {
  const noCode = candidateOf({ ...SHIONOGI, companyCode: null, entityKey: null, stocksMaster: SHIONOGI_MASTER });
  assert.equal(companyIdentityEvidence(noCode).sameCompanyConfirmed, false);
  const wrongEntity = candidateOf({ ...SHIONOGI, entityKey: "company:99990", stocksMaster: SHIONOGI_MASTER });
  assert.equal(companyIdentityEvidence(wrongEntity).sameCompanyConfirmed, false);
  const otherShareClass = candidateOf({ ...SHIONOGI, companyCode: "45071", entityKey: "company:45071", stocksMaster: SHIONOGI_MASTER });
  assert.equal(companyIdentityEvidence(otherShareClass).sameCompanyConfirmed, false);
});

test("only TDnet's own verified URL counts: another source never takes the master name", () => {
  const notTdnet = candidateOf({ ...SHIONOGI, sourceUrl: "https://example.com/release.pdf", stocksMaster: SHIONOGI_MASTER });
  assert.equal(companyIdentityEvidence(notTdnet).sameCompanyConfirmed, false);
  const overseas = candidateOf({ ...SHIONOGI, sourceType: "breaking_market", sourceName: "bbc_world", stocksMaster: SHIONOGI_MASTER });
  assert.equal(companyIdentityEvidence(overseas).sameCompanyConfirmed, false);
});

test("an unusable master name (empty or one character) is ignored", () => {
  for (const companyName of ["", " ", "塩"]) {
    const candidate = candidateOf({ ...SHIONOGI, stocksMaster: { tickerCode: "4507", companyName } });
    assert.equal(companyIdentityEvidence(candidate).sameCompanyConfirmed, false, JSON.stringify(companyName));
  }
});

test("existing confirmations never change: a master row only ever adds, with the same primarySourceName", () => {
  for (const [key, fixture] of Object.entries(IDENTITY_FIXTURES)) {
    const base = candidateOf({
      sourceUrl: fixture.sourceUrl,
      title: fixture.title,
      bodySummary: fixture.bodySummary,
      companyName: fixture.companyName,
      companyCode: fixture.companyCode,
      entityKey: fixture.entityKey,
    });
    const without = companyIdentityEvidence(base);
    // A master row for the same code whose name matches nothing in the disclosure.
    const unrelated = companyIdentityEvidence({
      ...base,
      stocksMaster: { tickerCode: fixture.companyCode.slice(0, 4), companyName: "まったく別の会社名" },
    });
    assert.deepEqual(unrelated, without, key);
  }
});

// --- the stocks_master root code and the lookup helper --------------------------------------------------

test("stocksMasterRootCode: ordinary-share form only", () => {
  assert.equal(stocksMasterRootCode("45070"), "4507");
  assert.equal(stocksMasterRootCode("290A0"), "290A");
  assert.equal(stocksMasterRootCode("290a0"), "290A");
  assert.equal(stocksMasterRootCode("4507"), "4507");
  for (const bad of ["45071", "4507A", "450", "450700", "", " ", null, undefined, "ABCDE"]) {
    assert.equal(stocksMasterRootCode(bad as string | null | undefined), null, String(bad));
  }
});

test("withStocksMasterName: attaches only for TDnet, only for the ordinary-share code, and fails closed", async () => {
  const calls: string[] = [];
  const found = (root: string) => {
    calls.push(root);
    return Promise.resolve({ tickerCode: root, companyName: "塩野義製薬" });
  };
  const tdnet = candidateOf(SHIONOGI);
  const attached = await withStocksMasterName(tdnet, found);
  assert.deepEqual(attached.stocksMaster, { tickerCode: "4507", companyName: "塩野義製薬" });
  assert.deepEqual(calls, ["4507"]);

  const alnum = await withStocksMasterName(candidateOf({ companyCode: "290A0", entityKey: "company:290a0" }), found);
  assert.equal(alnum.stocksMaster?.tickerCode, "290A");

  calls.length = 0;
  for (const skipped of [
    candidateOf({ ...SHIONOGI, sourceType: "market_macro", sourceName: "market_macro" }),
    candidateOf({ ...SHIONOGI, sourceName: "bbc_world" }),
    candidateOf({ ...SHIONOGI, companyCode: "45071" }),
    candidateOf({ ...SHIONOGI, companyCode: null }),
  ]) {
    assert.equal((await withStocksMasterName(skipped, found)).stocksMaster, undefined);
  }
  assert.deepEqual(calls, [], "no lookup is made for anything that cannot use the master name");

  const unknown = await withStocksMasterName(tdnet, () => Promise.resolve(null));
  assert.equal(unknown.stocksMaster, undefined, "an unlisted / unknown code leaves the candidate unchanged");
  const failing = await withStocksMasterName(tdnet, () => Promise.reject(new Error("network")));
  assert.equal(failing.stocksMaster, undefined, "a failed lookup leaves the candidate unchanged");
  assert.deepEqual(failing, tdnet);
});

test("postgrestStocksMasterLookup: one read-only GET by ticker_code, malformed rows are ignored", async () => {
  const original = globalThis.fetch;
  const seen: Array<{ url: string; method: string | undefined }> = [];
  let payload: unknown = [{ ticker_code: "4507", company_name: "塩野義製薬" }];
  let ok = true;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), method: init?.method });
    return Promise.resolve(new Response(JSON.stringify(payload), { status: ok ? 200 : 500 }));
  }) as typeof fetch;
  try {
    const lookup = postgrestStocksMasterLookup("https://example.supabase.co", { apikey: "k" });
    assert.deepEqual(await lookup("4507"), { tickerCode: "4507", companyName: "塩野義製薬" });
    assert.equal(seen[0].method, undefined, "GET only");
    assert.match(seen[0].url, /^https:\/\/example\.supabase\.co\/rest\/v1\/stocks_master\?/);
    assert.match(seen[0].url, /ticker_code=eq\.4507/);
    assert.match(seen[0].url, /limit=1/);
    payload = [];
    assert.equal(await lookup("4507"), null);
    payload = [{ ticker_code: 4507, company_name: null }];
    assert.equal(await lookup("4507"), null);
    ok = false;
    assert.equal(await lookup("4507"), null);
  } finally {
    globalThis.fetch = original;
  }
});
