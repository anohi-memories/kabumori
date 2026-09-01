import assert from "node:assert/strict";
import test from "node:test";
import {
  candidateStatusForDuplicate,
  findNewsDuplicate,
  prepareNewsCandidate,
  type DuplicateComparable,
} from "./news_candidate_logic.ts";
import {
  buildTdnetBodySummary,
  cleanupPdfDocument,
  enrichTdnetCandidatesWithPdfSummaries,
  fetchCompanyIrSource,
  fetchTdnetPdfBodySummary,
  parseTdnetListHtml,
  runNewsSourceProviders,
  type CompanyIrSource,
} from "./official_source_fetchers.ts";

const tdnetHtml = `
<table><tr>
  <td>15:00</td><td>1234</td><td>テスト株式会社</td>
  <td><a href="/inbs/140120260831000001.pdf">通期業績予想の上方修正について</a></td>
</tr></table>`;

test("TDnet candidate is normalized to the common format", () => {
  const candidates = parseTdnetListHtml(
    tdnetHtml, "2026-08-31", "https://www.release.tdnet.info/inbs/I_list_001_20260831.html",
  );
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], {
    sourceType: "tdnet", sourceName: "tdnet",
    sourceUrl: "https://www.release.tdnet.info/inbs/140120260831000001.pdf",
    title: "通期業績予想の上方修正について", bodySummary: null,
    companyName: "テスト株式会社", companyCode: "1234", entityKey: "company:1234",
    category: "other_corporate_ir", publishedAt: "2026-08-31T06:00:00.000Z",
  });
});

test("company IR RSS candidate is normalized to the common format", async () => {
  const source: CompanyIrSource = {
    id: "source-1", companyCode: "5678", companyName: "サンプル株式会社",
    entityKey: "company:5678", feedUrl: "https://example.co.jp/ir/rss.xml", feedFormat: "rss",
  };
  const rss = `<rss><channel><item><title>自己株式取得のお知らせ</title>
    <link>https://example.co.jp/ir/20260831.html</link>
    <pubDate>Mon, 31 Aug 2026 06:30:00 GMT</pubDate><description>IR更新</description>
  </item></channel></rss>`;
  const candidates = await fetchCompanyIrSource(
    source, async () => new Response(rss, { status: 200 }),
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceType, "company_ir");
  assert.equal(candidates[0].companyName, "サンプル株式会社");
  assert.equal(candidates[0].publishedAt, "2026-08-31T06:30:00.000Z");
});

test("TDnet exact content duplicate is excluded", async () => {
  const candidate = await prepareNewsCandidate(parseTdnetListHtml(
    tdnetHtml, "2026-08-31", "https://www.release.tdnet.info/inbs/I_list_001_20260831.html",
  )[0]);
  const existing: DuplicateComparable[] = [{
    id: "existing", sourceUrl: "https://different.example/disclosure",
    normalizedTitle: "different", contentHash: candidate.contentHash,
    companyCode: "1234", entityKey: "company:1234", publishedAt: candidate.publishedAt,
  }];
  assert.equal(findNewsDuplicate(candidate, existing)?.id, "existing");
});

test("same disclosure URL is excluded", async () => {
  const candidate = await prepareNewsCandidate(parseTdnetListHtml(
    tdnetHtml, "2026-08-31", "https://www.release.tdnet.info/inbs/I_list_001_20260831.html",
  )[0]);
  const existing: DuplicateComparable[] = [{
    id: "existing", sourceUrl: candidate.sourceUrl,
    normalizedTitle: "different", contentHash: "0".repeat(64),
    companyCode: null, entityKey: null, publishedAt: candidate.publishedAt,
  }];
  assert.equal(findNewsDuplicate(candidate, existing)?.id, "existing");
});

test("candidate without a match remains eligible for saving", async () => {
  const candidate = await prepareNewsCandidate(parseTdnetListHtml(
    tdnetHtml, "2026-08-31", "https://www.release.tdnet.info/inbs/I_list_001_20260831.html",
  )[0]);
  const duplicate = findNewsDuplicate(candidate, []);
  assert.equal(duplicate, null);
  assert.equal(candidateStatusForDuplicate(duplicate?.id ?? null), "pending_judgement");
});

test("one source failure does not stop another source", async () => {
  const collected = await runNewsSourceProviders([
    { key: "tdnet", fetchCandidates: async () => { throw new Error("TDNET_FETCH_FAILED:503"); } },
    { key: "company_ir:source-1", fetchCandidates: async () => parseTdnetListHtml(
      tdnetHtml, "2026-08-31", "https://www.release.tdnet.info/inbs/I_list_001_20260831.html",
    ) },
  ]);
  assert.equal(collected.candidates.length, 1);
  assert.deepEqual(collected.succeededSources, ["company_ir:source-1"]);
  assert.deepEqual(collected.errors, ["tdnet:TDNET_FETCH_FAILED:503"]);
});

const tdnetPdfText = `
自己株式の取得中止及び取得状況に関するお知らせ
公開買付けに賛同する旨の意見表明に伴い、自己株式の取得を中止しました。
（2）取得した株式の総数 0株
（3）株式の取得価額の総額 0円
（4）取得期間 2026年8月1日～2026年8月28日
取得する株式の総数 3,800,000株
取得価額の総額 1,000,000,000円（上限）`;

test("TDnet PDF is fetched and extracted into body_summary", async () => {
  const summary = await fetchTdnetPdfBodySummary(
    "https://www.release.tdnet.info/inbs/example.pdf",
    {
      fetcher: async () => new Response(new TextEncoder().encode("%PDF-fixture"), {
        status: 200, headers: { "content-type": "application/pdf" },
      }),
      extractor: async () => tdnetPdfText,
    },
  );
  assert.match(summary, /公開買付け/);
  assert.match(summary, /3,800,000株/);
  assert.match(summary, /1,000,000,000円（上限）/);
});

test("body_summary keeps disclosed numbers unchanged", () => {
  const summary = buildTdnetBodySummary(tdnetPdfText);
  assert.ok(summary);
  assert.match(summary, /0株/);
  assert.match(summary, /0円/);
  assert.match(summary, /2026年8月1日～2026年8月28日/);
  assert.match(summary, /3,800,000株/);
  assert.match(summary, /1,000,000,000円/);
});

test("TDnet PDF fetch failure keeps the candidate safely unchanged", async () => {
  const candidate = parseTdnetListHtml(
    tdnetHtml, "2026-08-31", "https://www.release.tdnet.info/inbs/I_list_001_20260831.html",
  )[0];
  const result = await enrichTdnetCandidatesWithPdfSummaries(
    [candidate], async () => { throw new Error("TDNET_PDF_FETCH_FAILED:503"); },
  );
  assert.equal(result.candidates[0].bodySummary, null);
  assert.equal(result.errors.length, 1);
});

test("TDnet PDF HTTP failure is reported without inventing a summary", async () => {
  await assert.rejects(
    fetchTdnetPdfBodySummary("https://www.release.tdnet.info/inbs/example.pdf", {
      fetcher: async () => new Response("unavailable", { status: 503 }),
      extractor: async () => tdnetPdfText,
    }),
    /TDNET_PDF_FETCH_FAILED:503/,
  );
});

test("non-PDF response is rejected", async () => {
  await assert.rejects(
    fetchTdnetPdfBodySummary("https://www.release.tdnet.info/inbs/example.pdf", {
      fetcher: async () => new Response("not a pdf", { status: 200 }),
      extractor: async () => tdnetPdfText,
    }),
    /TDNET_PDF_INVALID/,
  );
});

test("unpdf cleanup is safe when destroy is unavailable", async () => {
  await cleanupPdfDocument({ numPages: 1 });
  let destroyed = 0;
  await cleanupPdfDocument({ destroy: () => { destroyed += 1; } });
  assert.equal(destroyed, 1);
});

test("one TDnet PDF parse failure does not stop another candidate", async () => {
  const first = parseTdnetListHtml(
    tdnetHtml, "2026-08-31", "https://www.release.tdnet.info/inbs/I_list_001_20260831.html",
  )[0];
  const second = { ...first, sourceUrl: "https://www.release.tdnet.info/inbs/second.pdf", companyCode: "5678" };
  const result = await enrichTdnetCandidatesWithPdfSummaries([first, second], async (url) => {
    if (url.endsWith("example.pdf") || url.includes("000001")) throw new Error("TDNET_PDF_PARSE_FAILED");
    return tdnetPdfText;
  });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].bodySummary, null);
  assert.match(result.candidates[1].bodySummary ?? "", /3,800,000株/);
  assert.equal(result.errors.length, 1);
});
