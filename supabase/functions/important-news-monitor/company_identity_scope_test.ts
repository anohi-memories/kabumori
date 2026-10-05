// TDnet company-identity confirmation (2026-10-03). In 48 hours six TDnet posts failed Fact on company
// identity although the disclosure was plainly the TDnet company's own: ＨＤ vs ホールディングス,
// a body that says only 当社 and never states its issuer, and cover-page labels the extractor could not
// read.  The fixtures are those real disclosures (body verbatim).  Everything that must stay unconfirmed
// — other companies, subsidiaries, look-alike names — is pinned next to them.
import assert from "node:assert/strict";
import test from "node:test";
import {
  companyIdentityEvidence,
  type GenerationCandidate,
  generationModelInput,
} from "./post_generation_logic.ts";
import { IDENTITY_FIXTURES, type IdentityFixture } from "./company_identity_fixtures.ts";

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

function fixtureCandidate(fixture: IdentityFixture): GenerationCandidate {
  return candidateOf({
    sourceUrl: fixture.sourceUrl,
    title: fixture.title,
    bodySummary: fixture.bodySummary,
    companyName: fixture.companyName,
    companyCode: fixture.companyCode,
    entityKey: fixture.entityKey,
  });
}

function evidenceFor(companyName: string, body: string, overrides: Partial<GenerationCandidate> = {}) {
  return companyIdentityEvidence(candidateOf({ companyName, bodySummary: body, ...overrides }));
}

// --- the real failures -------------------------------------------------------------------------------

test("PHC ＨＤ: the TDnet short name ＰＨＣＨＤ is the header's PHC ホールディングス", () => {
  const evidence = companyIdentityEvidence(fixtureCandidate(IDENTITY_FIXTURES.phc));
  assert.equal(evidence.sameCompanyConfirmed, true);
  assert.equal(evidence.primarySourceName, "PHC ホールディングス株式会社");
});

test("プロクレアＨＤ: a PDF-spaced header name matches once spacing and ＨＤ are normalised", () => {
  const evidence = companyIdentityEvidence(fixtureCandidate(IDENTITY_FIXTURES.procrea));
  assert.equal(evidence.sameCompanyConfirmed, true);
  assert.match(evidence.primarySourceName ?? "", /プロク/u);
});

test("海帆 / ALSOK / 大塚ＨＤ: 当社-only disclosures are confirmed from the TDnet issuer signals", () => {
  for (const key of ["kaihan", "alsok", "otsuka"]) {
    const evidence = companyIdentityEvidence(fixtureCandidate(IDENTITY_FIXTURES[key]));
    assert.equal(evidence.sameCompanyConfirmed, true, key);
    // The body names nobody, so no source name is claimed (an alias or a subsidiary picked up from the
    // prose must never be presented as the confirmed issuer name).
    assert.equal(evidence.primarySourceName, null, key);
  }
});

test("Synspective / SBIグローバルアセットマネジメント: curated code-keyed aliases for truncated short names", () => {
  assert.equal(companyIdentityEvidence(fixtureCandidate(IDENTITY_FIXTURES.synspective)).sameCompanyConfirmed, true);
  assert.equal(companyIdentityEvidence(fixtureCandidate(IDENTITY_FIXTURES.sbiGam)).sameCompanyConfirmed, true);
});

test("SBI (8473): a parent's filing whose cover lists its subsidiaries' names stays unconfirmed", () => {
  const evidence = companyIdentityEvidence(fixtureCandidate(IDENTITY_FIXTURES.sbi));
  assert.equal(evidence.sameCompanyConfirmed, false);
});

test("the Fact input carries the confirmation (and no invented source name) for a 当社-only filing", () => {
  const input = generationModelInput(fixtureCandidate(IDENTITY_FIXTURES.kaihan), "本文", undefined, false, "fact");
  assert.equal(input.company_identity.sameCompanyConfirmed, true);
  assert.equal(input.company_identity.primarySourceName, null);
  assert.equal(input.company_identity.metadataName, "Ｇ－海帆");
});

// --- abbreviations -----------------------------------------------------------------------------------

test("ＨＤ / HD / ＦＧ expand only at the end of the name", () => {
  const body = (name: string) => `各 位\n会 社 名 ${name}\n代表者名 代表取締役社長 山田 太郎\n`;
  assert.equal(evidenceFor("ＰＨＣＨＤ", body("PHC ホールディングス株式会社")).sameCompanyConfirmed, true);
  assert.equal(evidenceFor("エイチームＨＤ", body("株式会社エイチームホールディングス")).sameCompanyConfirmed, true);
  assert.equal(evidenceFor("京都ＦＧ", body("株式会社 京都フィナンシャルグループ")).sameCompanyConfirmed, true);
  assert.equal(evidenceFor("パレモ・ＨＤ", body("パレモ・ホールディングス株式会社")).sameCompanyConfirmed, true);
});

test("look-alike and different companies are still rejected", () => {
  const body = (name: string) => `各 位\n会 社 名 ${name}\n代表者名 代表取締役社長 山田 太郎\n`;
  // HD in the middle of the longer name: AFC-HD is not AFC-HDアムスライフサイエンス
  assert.equal(evidenceFor("ＡＦＣ－ＨＤ", body("ＡＦＣ-ＨＤアムスライフサイエンス株式会社")).sameCompanyConfirmed, false);
  // an abbreviation never grows into a longer company name
  assert.equal(evidenceFor("ポールＨＤ", body("ポールトゥウィンホールディングス株式会社")).sameCompanyConfirmed, false);
  // a different company with the same ending
  assert.equal(evidenceFor("ＰＨＣＨＤ", body("東邦ホールディングス株式会社")).sameCompanyConfirmed, false);
  assert.equal(evidenceFor("三十三ＦＧ", body("株式会社あいちフィナンシャルグループ")).sameCompanyConfirmed, false);
  // a subsidiary of the same group
  assert.equal(evidenceFor("大塚ＨＤ", body("大鵬薬品工業株式会社")).sameCompanyConfirmed, false);
  assert.equal(evidenceFor("大塚ＨＤ", body("大塚製薬株式会社")).sameCompanyConfirmed, false);
  // partial match / prefix of a longer name
  assert.equal(evidenceFor("ＲＥＭＩＸ", body("株式会社リミックスポイント")).sameCompanyConfirmed, false);
  assert.equal(evidenceFor("ＨＤ", body("株式会社ホールディングス")).sameCompanyConfirmed, false);
});

// --- cover labels that the old extractors could not read ---------------------------------------------

test("mid-line and spaced-out issuer labels are read from the cover", () => {
  assert.equal(
    evidenceFor("積水ハウス", "2026年9月10日\n上 場 会 社 名 積水ハウス株式会社 上場取引所 東・名\nコード番号 1928\n").sameCompanyConfirmed,
    true,
  );
  assert.equal(
    evidenceFor("ニデック", "各位\nお知らせ 会 社 名 ニデック株式会社 代表者名 代表取締役 永守 重信\n").sameCompanyConfirmed,
    true,
  );
  assert.equal(evidenceFor("ミライアル", "各 位\n商 号 ミライアル株式会社\n代表者 山田\n").sameCompanyConfirmed, true);
  assert.equal(
    evidenceFor("Ｇ－ＢｌｕｅＭｅｍｅ", "各 位\n会社名 株式会社BlueMeme (証券コード: 4069 東証グロース)\n").sameCompanyConfirmed,
    true,
  );
});

test("a subsidiary / parent label is never read as the issuer's own field", () => {
  const evidence = evidenceFor("ＡＢＣ", "各 位\n子会社名 ABC株式会社\n親会社名 ABC株式会社\n本件は下記のとおりです。\n");
  assert.equal(evidence.sameCompanyConfirmed, false);
});

test("a labelled issuer field naming another company blocks the 当社 rule", () => {
  // Joint filing: the cover names a different company, so 当社 cannot be assumed to be the metadata one.
  const evidence = evidenceFor("テスト", "各 位\n会 社 名 別会社株式会社\n当社は下記のとおり決議しました。\n");
  assert.equal(evidence.sameCompanyConfirmed, false);
  assert.equal(evidence.primarySourceName, "別会社株式会社");
});

test("an unreadable issuer label also blocks the 当社 rule (fail closed)", () => {
  const evidence = evidenceFor("テスト", "各位\n発行者名\n当社は下記のとおり決議しました。\n");
  assert.equal(evidence.sameCompanyConfirmed, false);
});

// --- 当社-only needs the verified TDnet signals ------------------------------------------------------

test("当社-only: no 当社 and no name means nothing is confirmed", () => {
  assert.equal(evidenceFor("テスト", "新薬承認申請を開始しました。\n").sameCompanyConfirmed, false);
  assert.equal(companyIdentityEvidence(candidateOf({ bodySummary: null })).sameCompanyConfirmed, false);
});

test("当社-only: the TDnet code / entityKey / URL signals must all hold", () => {
  const body = "当社の連結子会社が借入金を返済しました。\n";
  assert.equal(evidenceFor("テスト", body).sameCompanyConfirmed, true);
  assert.equal(evidenceFor("テスト", body, { entityKey: "company:99990" }).sameCompanyConfirmed, false);
  assert.equal(evidenceFor("テスト", body, { entityKey: null as unknown as string }).sameCompanyConfirmed, false);
  assert.equal(evidenceFor("テスト", body, { sourceUrl: "https://example.com/a.pdf" }).sameCompanyConfirmed, false);
  assert.equal(evidenceFor("テスト", body, { sourceName: "company_ir" }).sameCompanyConfirmed, false);
  assert.equal(evidenceFor("テスト", body, { companyName: null }).sameCompanyConfirmed, false);
});
