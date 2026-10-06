import assert from "node:assert/strict";
import test from "node:test";
import { ENRICHMENT_LIMITS, extractMainText, fetchOfficialPageText, validateOfficialUrl } from "./jp_official_enrichment.ts";

const MOF = ["mof.go.jp"];
const html = (body: string) => `<html><head><title>t</title></head><body>${body}</body></html>`;
const page = (text: string, init: ResponseInit = {}) =>
  new Response(text, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });

test("validateOfficialUrl accepts own domain and subdomain only over plain https", () => {
  assert.ok(validateOfficialUrl("https://www.mof.go.jp/policy/a.html", MOF));
  assert.ok(validateOfficialUrl("https://mof.go.jp/a", MOF));
  for (const bad of [
    "http://www.mof.go.jp/a",
    "https://user:pw@www.mof.go.jp/a",
    "https://www.mof.go.jp:8443/a",
    "https://evil-mof.go.jp/a",
    "https://mof.go.jp.evil.com/a",
    "https://127.0.0.1/a",
    "https://localhost/a",
    "https://[::1]/a",
    "https://169.254.169.254/latest",
    "not a url",
  ]) assert.equal(validateOfficialUrl(bad, MOF), null, bad);
});

test("extractMainText keeps the body sentences and drops scripts, nav and boilerplate", () => {
  const text = extractMainText(html(
    "<script>var x=1;</script><nav>メニュー</nav><main><h1>外国為替平衡操作の実施状況</h1><p>令和8年9月の外国為替平衡操作額は0円でした。詳細は以下のとおりです。</p><p>ホーム</p></main><footer>著作権</footer>",
  ));
  assert.match(text, /外国為替平衡操作額は0円/);
  assert.doesNotMatch(text, /var x|メニュー|著作権/);
});

test("extractMainText caps length at a sentence boundary and decodes entities", () => {
  const long = html(`<main><p>${"重要な発表です。".repeat(200)}</p></main>`);
  const text = extractMainText(long);
  assert.ok(text.length <= ENRICHMENT_LIMITS.maxChars + 1);
  assert.ok(text.endsWith("。"));
  assert.equal(extractMainText(html("<main><p>A&amp;B &#x3042;は十分に長い文章としてここに書かれています。続きの文章もあります。</p></main>")).startsWith("A&B あ"), true);
});

test("extractMainText never throws on malformed HTML", () => {
  for (const broken of ["<main><p>未閉じ", "<<<>>>", "<script>", "", "<div id=\"contents\"><p>本文です。それはとても重要な文章です。さらに続きます。"]) {
    assert.equal(typeof extractMainText(broken), "string");
  }
});

test("fetchOfficialPageText returns the extracted text for an official page", async () => {
  const result = await fetchOfficialPageText("https://www.mof.go.jp/a.html", MOF, {
    fetchImpl: () => Promise.resolve(page(html("<main><p>為替介入は実施されませんでした。実績額は0円です。</p></main>"))),
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.text, /0円/);
});

test("fetchOfficialPageText sends identity encoding, manual redirect mode and a user agent", async () => {
  let seen: RequestInit | undefined;
  await fetchOfficialPageText("https://www.mof.go.jp/a.html", MOF, {
    fetchImpl: (_url, init) => {
      seen = init;
      return Promise.resolve(page(html("<main><p>本文です。十分な長さの本文がここにあります。確認できます。</p></main>")));
    },
  });
  assert.equal(seen?.redirect, "manual");
  assert.equal((seen?.headers as Record<string, string>)["Accept-Encoding"], "identity");
});

test("redirect to a foreign host is refused; redirect within the domain is followed", async () => {
  const evil = await fetchOfficialPageText("https://www.mof.go.jp/a", MOF, {
    fetchImpl: () => Promise.resolve(new Response(null, { status: 302, headers: { location: "https://evil.example.com/x" } })),
  });
  assert.deepEqual(evil, { ok: false, reason: "host_not_allowed" });
  const toInternal = await fetchOfficialPageText("https://www.mof.go.jp/a", MOF, {
    fetchImpl: () => Promise.resolve(new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } })),
  });
  assert.deepEqual(toInternal, { ok: false, reason: "host_not_allowed" });
  const calls: string[] = [];
  const ok = await fetchOfficialPageText("https://www.mof.go.jp/a", MOF, {
    fetchImpl: (url) => {
      calls.push(url);
      return Promise.resolve(calls.length === 1
        ? new Response(null, { status: 301, headers: { location: "/b.html" } })
        : page(html("<main><p>移転先の本文です。十分な長さがあります。内容を確認できます。</p></main>")));
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(calls[1], "https://www.mof.go.jp/b.html");
});

test("too many redirects", async () => {
  const result = await fetchOfficialPageText("https://www.mof.go.jp/a", MOF, {
    fetchImpl: () => Promise.resolve(new Response(null, { status: 302, headers: { location: "/loop" } })),
  });
  assert.deepEqual(result, { ok: false, reason: "too_many_redirects" });
});

test("PDF / XML urls and non-HTML content are never read", async () => {
  let called = 0;
  const fetchImpl = () => {
    called += 1;
    return Promise.resolve(new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } }));
  };
  assert.deepEqual(await fetchOfficialPageText("https://www.mof.go.jp/a.pdf", MOF, { fetchImpl }), { ok: false, reason: "unsupported_content" });
  assert.equal(called, 0);
  assert.deepEqual(await fetchOfficialPageText("https://www.mof.go.jp/a", MOF, { fetchImpl }), { ok: false, reason: "unsupported_content" });
});

test("oversized bodies are refused (declared length and streamed)", async () => {
  const declared = await fetchOfficialPageText("https://www.mof.go.jp/a", MOF, {
    fetchImpl: () => Promise.resolve(page("x", { headers: { "content-type": "text/html", "content-length": String(ENRICHMENT_LIMITS.maxBytes + 1) } })),
  });
  assert.deepEqual(declared, { ok: false, reason: "too_large" });
  const streamed = await fetchOfficialPageText("https://www.mof.go.jp/a", MOF, {
    fetchImpl: () => Promise.resolve(page("あ".repeat(ENRICHMENT_LIMITS.maxBytes))),
  });
  assert.deepEqual(streamed, { ok: false, reason: "too_large" });
});

test("http errors, network errors, timeouts and empty pages map to reason codes", async () => {
  assert.deepEqual(
    await fetchOfficialPageText("https://www.mof.go.jp/a", MOF, { fetchImpl: () => Promise.resolve(new Response("x", { status: 503 })) }),
    { ok: false, reason: "http_error" },
  );
  assert.deepEqual(
    await fetchOfficialPageText("https://www.mof.go.jp/a", MOF, { fetchImpl: () => Promise.reject(new TypeError("boom")) }),
    { ok: false, reason: "network_error" },
  );
  assert.deepEqual(
    await fetchOfficialPageText("https://www.mof.go.jp/a", MOF, { fetchImpl: () => Promise.reject(new DOMException("t", "TimeoutError")) }),
    { ok: false, reason: "timeout" },
  );
  assert.deepEqual(
    await fetchOfficialPageText("https://www.mof.go.jp/a", MOF, { fetchImpl: () => Promise.resolve(page(html("<script>x</script>"))) }),
    { ok: false, reason: "empty_text" },
  );
  assert.deepEqual(await fetchOfficialPageText("http://www.mof.go.jp/a", MOF), { ok: false, reason: "invalid_url" });
});

test("validateOfficialUrl rejects hostname tricks (trailing dot, punycode, encoding, userinfo, backslash, IP forms)", () => {
  for (const bad of [
    "https://www.mof.go.jp./a",
    "https://xn--mof-go-jp.example/a",
    "https://www.mof.go.jp.xn--evil/a",
    "https://mof.go.jp%2eevil.com/a",
    "https://www.mof.go.jp@evil.com/a",
    "https://evil.com\\@www.mof.go.jp/a",
    "https://evil.com#@www.mof.go.jp/a",
    "https://0x7f000001/a",
    "https://2130706433/a",
    "https://[::ffff:127.0.0.1]/a",
    "https://ｅｖｉｌ.com/a",
    "https://notmof.go.jp/a",
    "https://mof.go.jp.cn/a",
  ]) assert.equal(validateOfficialUrl(bad, MOF), null, bad);
  // Case and IDN-normalised official hosts are accepted, and the parser's own hostname is what is fetched.
  assert.equal(validateOfficialUrl("https://WWW.MOF.GO.JP/a", MOF)?.hostname, "www.mof.go.jp");
});

test("a redirect to the project's own Supabase host or a metadata address is refused at the hop", async () => {
  for (const location of ["https://abcd.supabase.co/rest/v1/x", "http://www.mof.go.jp/a", "https://www.mof.go.jp:8443/a"]) {
    assert.deepEqual(
      await fetchOfficialPageText("https://www.mof.go.jp/a", MOF, {
        fetchImpl: () => Promise.resolve(new Response(null, { status: 302, headers: { location } })),
      }),
      { ok: false, reason: "host_not_allowed" },
      location,
    );
  }
});
