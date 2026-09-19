import {
  extractReadableOfficialText,
  fetchOfficialBodySummary,
  planOfficialBodyEnrichment,
  prepareOfficialCandidateForJudgement,
} from "./official_body_enrichment.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

const highSignal = {
  sourceType: "market_macro",
  sourceUrl: "https://www.boj.or.jp/en/announcements/release_2026/k260918a.htm",
  title: "Bank of Japan raises benchmark interest rate to 1.25%",
  bodySummary: null,
};

Deno.test("official high-signal title with missing body plans a fetch", () => {
  const plan = planOfficialBodyEnrichment(highSignal);
  equal(plan.kind, "fetch", "plan kind");
  if (plan.kind === "fetch") {
    equal(new URL(plan.url).hostname, "www.boj.or.jp", "trusted host");
  }
});

Deno.test("sufficient existing body is never fetched", () => {
  const plan = planOfficialBodyEnrichment({
    ...highSignal,
    bodySummary: "x".repeat(160),
  });
  equal(plan.kind, "skip", "plan kind");
  if (plan.kind === "skip") {
    equal(plan.reason, "body_sufficient", "skip reason");
  }
});

Deno.test("low-signal title does not trigger a network fetch", () => {
  const plan = planOfficialBodyEnrichment({
    ...highSignal,
    title: "Weekly statistics published",
    bodySummary: "",
  });
  equal(plan.kind, "skip", "plan kind");
});

Deno.test("TDnet remains on its existing PDF enrichment path", () => {
  const plan = planOfficialBodyEnrichment({
    ...highSignal,
    sourceType: "tdnet",
    sourceUrl: "https://www.release.tdnet.info/inbs/example.pdf",
  });
  equal(plan.kind, "skip", "plan kind");
  if (plan.kind === "skip") {
    equal(plan.reason, "existing_tdnet_pdf_path", "skip reason");
  }
});

Deno.test("private, non-HTTPS, credentialed, custom-port, and deceptive hosts are rejected", () => {
  const urls = [
    "http://www.boj.or.jp/notice",
    "https://user@www.boj.or.jp/notice",
    "https://www.boj.or.jp:8443/notice",
    "https://boj.or.jp.attacker.example/notice",
    "https://127.0.0.1/notice",
  ];
  for (const sourceUrl of urls) {
    const plan = planOfficialBodyEnrichment({ ...highSignal, sourceUrl });
    equal(plan.kind, "needs_review", `reject ${sourceUrl}`);
  }
});

Deno.test("non-official source types cannot be fetched by the official-page helper", () => {
  const plan = planOfficialBodyEnrichment({
    ...highSignal,
    sourceType: "breaking_market",
  });
  equal(plan.kind, "needs_review", "plan kind");
});

Deno.test("PDF URLs never use the HTML reader", () => {
  const plan = planOfficialBodyEnrichment({
    ...highSignal,
    sourceUrl: "https://www.boj.or.jp/report.pdf",
  });
  equal(plan.kind, "needs_review", "plan kind");
  if (plan.kind === "needs_review") {
    equal(plan.reason, "pdf_requires_pdf_pipeline", "review reason");
  }
});

Deno.test("HTML extraction removes scripts and boilerplate and decodes common entities", () => {
  const extracted = extractReadableOfficialText(
    `<html><nav>Menu</nav><main><h1>Policy &amp; Rate</h1><article>${
      "<p>Official facts &nbsp; confirmed.</p>".repeat(20)
    }</article></main><script>secret()</script></html>`,
  );
  assert(extracted.includes("Policy & Rate"), "title should remain");
  assert(
    extracted.includes("Official facts confirmed."),
    "article text should remain",
  );
  assert(
    !extracted.includes("Menu") && !extracted.includes("secret"),
    "non-article text should be removed",
  );
});

Deno.test("fetch uses only validated HTTPS URL, bounded timeout, and redirect:error", async () => {
  const plan = planOfficialBodyEnrichment(highSignal);
  assert(plan.kind === "fetch", "test precondition");
  let captured: RequestInit | undefined;
  const html = `<main><article>${
    "The central bank published an official policy decision with detailed reasons and implementation dates. "
      .repeat(4)
  }</article></main>`;
  const result = await fetchOfficialBodySummary(plan, {
    fetcher: async (_input, init) => {
      captured = init;
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  equal(result.status, "enriched", "result status");
  equal(captured?.redirect, "error", "redirect mode");
  assert(
    captured?.signal instanceof AbortSignal,
    "request should have a timeout signal",
  );
});

Deno.test("redirects and failed retrieval become needs_review, never title-only judgement", async () => {
  const plan = planOfficialBodyEnrichment(highSignal);
  assert(plan.kind === "fetch", "test precondition");
  const result = await fetchOfficialBodySummary(plan, {
    fetcher: async () => {
      throw new TypeError("redirect rejected");
    },
  });
  equal(result.status, "needs_review", "result status");
  if (result.status === "needs_review") {
    equal(result.reason, "fetch_failed", "review reason");
  }
});

Deno.test("non-HTML responses and oversized declared bodies fail closed", async () => {
  const plan = planOfficialBodyEnrichment(highSignal);
  assert(plan.kind === "fetch", "test precondition");
  const pdf = await fetchOfficialBodySummary(plan, {
    fetcher: async () =>
      new Response("%PDF-", { headers: { "content-type": "application/pdf" } }),
  });
  equal(pdf.status, "needs_review", "PDF response status");
  if (pdf.status === "needs_review") {
    equal(pdf.reason, "content_type_rejected", "PDF reason");
  }
  const oversized = await fetchOfficialBodySummary(plan, {
    fetcher: async () =>
      new Response("", {
        headers: { "content-type": "text/html", "content-length": "600000" },
      }),
  });
  equal(oversized.status, "needs_review", "oversized response status");
  if (oversized.status === "needs_review") {
    equal(oversized.reason, "body_too_large", "oversized response reason");
  }
});

Deno.test("empty/unparseable article becomes needs_review", async () => {
  const plan = planOfficialBodyEnrichment(highSignal);
  assert(plan.kind === "fetch", "test precondition");
  const result = await fetchOfficialBodySummary(plan, {
    fetcher: async () =>
      new Response("<html><script>ignore</script></html>", {
        headers: { "content-type": "text/html" },
      }),
  });
  equal(result.status, "needs_review", "result status");
  if (result.status === "needs_review") {
    equal(result.reason, "body_empty", "review reason");
  }
});

Deno.test("integrated preparation sends successfully enriched official content to judgement", async () => {
  const html = `<main><article>${
    "The central bank issued an official policy decision with detailed reasons and implementation dates. "
      .repeat(4)
  }</article></main>`;
  const disposition = await prepareOfficialCandidateForJudgement(highSignal, {
    fetcher: async () =>
      new Response(html, { headers: { "content-type": "text/html" } }),
  });
  equal(disposition.action, "judge", "disposition");
  if (disposition.action === "judge") {
    assert(
      (disposition.candidate.bodySummary ?? "").length >= 160,
      "enriched body must accompany judgement",
    );
  }
});

Deno.test("failed official fetch explicitly requires fallback and never permits title-only judgement", async () => {
  const disposition = await prepareOfficialCandidateForJudgement(highSignal, {
    fetcher: async () => {
      throw new TypeError("network unavailable");
    },
  });
  equal(disposition.action, "conditional_search_fallback", "disposition");
  if (disposition.action === "conditional_search_fallback") {
    equal(disposition.reason, "fetch_failed", "fallback reason");
    equal(
      disposition.candidate.bodySummary,
      null,
      "candidate stays body-empty until fallback",
    );
  }
});
