// JP official lane: a short main text from the release's OWN official page, so the importance judgement has
// facts to judge (MOF's FX-intervention page says "0円"; Kantei's meeting page states what was discussed).
// News items from these sources arrive with a title only, and a title-only candidate always ends in "cannot
// confirm -> no_post".  Safety is the point of this module:
//  - https only, no credentials, no non-default port, no IP literals / localhost; the host (and every redirect
//    hop) must be the source's own registrable domain or a subdomain of it;
//  - redirects are followed manually, at most MAX_REDIRECTS hops, each hop re-validated;
//  - one overall timeout, a hard byte cap read from the stream, text/html only (PDF / XML are never fetched);
//  - only a short extract is kept (script / style / navigation / footer removed): the page is never stored.

export const ENRICHMENT_LIMITS = {
  timeoutMs: 8_000,
  maxRedirects: 3,
  maxBytes: 400_000,
  maxChars: 700,
  minChars: 40,
} as const;

export type EnrichmentFailure =
  | "invalid_url"
  | "host_not_allowed"
  | "unsupported_content"
  | "too_many_redirects"
  | "http_error"
  | "too_large"
  | "timeout"
  | "network_error"
  | "empty_text";

export type EnrichmentResult =
  | { ok: true; text: string; finalUrl: string }
  | { ok: false; reason: EnrichmentFailure };

export const ENRICHMENT_USER_AGENT = "Kabumori-important-news/0.1 (read-only; contact@kabumori.app)";

/** https URL on an allowed registrable domain (or subdomain), no credentials, default port, not an IP / localhost. */
export function validateOfficialUrl(raw: string, allowedDomains: readonly string[]): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[")) return null;
  const allowed = allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  return allowed ? url : null;
}

const BLOCKS_TO_REMOVE = ["head", "script", "style", "noscript", "svg", "nav", "header", "footer", "aside", "form", "iframe", "template", "button", "select"];
const BOILERPLATE_LINE =
  /^(?:このページの本文へ移動|X\s*ポスト|English|Tweet|シェア|印刷|ホーム|トップへ戻る|.*ホームページトップへ戻る|URLをコピーしました|ミニプレーヤー.*|閉じる|動画が再生できない方は.*|動画ファイルは.*|Note: This page is machine translated.*|PDF(?:形式)?[:：].*)$/u;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " " };

function decodeEntities(value: string): string {
  return value.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,6}));/giu, (whole, dec, hex, name) => {
    try {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      return NAMED_ENTITIES[String(name).toLowerCase()] ?? whole;
    } catch {
      return whole;
    }
  });
}

/** Visible main text of an HTML page, capped; "" when nothing useful is found. Never throws on malformed HTML. */
export function extractMainText(html: string, maxChars: number = ENRICHMENT_LIMITS.maxChars): string {
  let work = html.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of BLOCKS_TO_REMOVE) {
    work = work.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, "giu"), " ");
  }
  const main = work.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/iu) ?? work.match(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/iu);
  if (main) {
    work = main[1];
  } else {
    const byId = /<(?:div|section)\b[^>]*\bid="(?:contents|content|main|mainContents|main-contents|pageContents|primary)"[^>]*>/iu.exec(work);
    if (byId) work = work.slice(byId.index + byId[0].length);
  }
  const lines = decodeEntities(
    work
      .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h[1-6]|dt|dd|section|table|ul|ol|caption)\s*>/giu, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .split(/\n+/u)
    .map((line) => line.replace(/[\s　]+/gu, " ").trim())
    .filter((line) => line.length > 0 && !BOILERPLATE_LINE.test(line));
  // Prefer sentences (lines with 。): they are the body, whereas captions, labels and menus rarely have one.
  const sentences = lines.filter((line) => line.includes("。"));
  const chosen = sentences.join(" ").length >= ENRICHMENT_LIMITS.minChars ? sentences : lines;
  const text = chosen.join(" ").replace(/\s+/gu, " ").trim();
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastStop = cut.lastIndexOf("。");
  return lastStop >= maxChars / 2 ? cut.slice(0, lastStop + 1) : `${cut}…`;
}

function charsetOf(contentType: string | null, head: string): string {
  const declared = contentType?.match(/charset=["']?([\w-]+)/iu)?.[1] ?? head.match(/<meta[^>]+charset=["']?([\w-]+)/iu)?.[1] ?? "utf-8";
  const label = declared.toLowerCase();
  return label === "sjis" || label === "x-sjis" ? "shift_jis" : label;
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | "too_large"> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return "too_large";
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export type EnrichmentDeps = { fetchImpl?: (input: string, init?: RequestInit) => Promise<Response> };

export async function fetchOfficialPageText(
  rawUrl: string,
  allowedDomains: readonly string[],
  deps: EnrichmentDeps = {},
): Promise<EnrichmentResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let url = validateOfficialUrl(rawUrl, allowedDomains);
  if (!url) return { ok: false, reason: "invalid_url" };
  // PDFs and XML telegrams are not read here (a PDF needs its own design); only HTML pages are.
  if (/\.(?:pdf|xml|xlsx?|csv|zip)$/iu.test(url.pathname)) return { ok: false, reason: "unsupported_content" };
  const signal = AbortSignal.timeout(ENRICHMENT_LIMITS.timeoutMs);
  try {
    for (let hop = 0; hop <= ENRICHMENT_LIMITS.maxRedirects; hop += 1) {
      const response = await fetchImpl(url.toString(), {
        headers: {
          "User-Agent": ENRICHMENT_USER_AGENT,
          Accept: "text/html, application/xhtml+xml",
          // Same reason as the EU Commission feed: a length-less compressed body fails on the Edge Runtime.
          "Accept-Encoding": "identity",
        },
        redirect: "manual",
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) return { ok: false, reason: "http_error" };
        if (hop === ENRICHMENT_LIMITS.maxRedirects) return { ok: false, reason: "too_many_redirects" };
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          return { ok: false, reason: "invalid_url" };
        }
        const checked = validateOfficialUrl(next.toString(), allowedDomains);
        if (!checked) return { ok: false, reason: "host_not_allowed" };
        if (/\.(?:pdf|xml|xlsx?|csv|zip)$/iu.test(checked.pathname)) return { ok: false, reason: "unsupported_content" };
        url = checked;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, reason: "http_error" };
      }
      const contentType = response.headers.get("content-type");
      if (!/^(?:text\/html|application\/xhtml\+xml)/iu.test(contentType ?? "")) {
        await response.body?.cancel();
        return { ok: false, reason: "unsupported_content" };
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > ENRICHMENT_LIMITS.maxBytes) {
        await response.body?.cancel();
        return { ok: false, reason: "too_large" };
      }
      const bytes = await readCapped(response, ENRICHMENT_LIMITS.maxBytes);
      if (bytes === "too_large") return { ok: false, reason: "too_large" };
      let html: string;
      try {
        html = new TextDecoder(charsetOf(contentType, new TextDecoder("latin1").decode(bytes.subarray(0, 2000)))).decode(bytes);
      } catch {
        html = new TextDecoder("utf-8").decode(bytes);
      }
      const text = extractMainText(html);
      if (text.length === 0) return { ok: false, reason: "empty_text" };
      return { ok: true, text, finalUrl: url.toString() };
    }
    return { ok: false, reason: "too_many_redirects" };
  } catch (error) {
    return { ok: false, reason: error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "network_error" };
  }
}
