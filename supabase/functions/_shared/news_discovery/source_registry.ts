// Source registry for the N2 discovery observer.
//
// Every entry's policy comes from docs/news-sources/news_source_catalog.md (N1, 2026-09-28).
// "Can be fetched" and "may be stored / shown" are separate fields on purpose: a DISCOVERY_ONLY
// source is fetched but its items are never displayed and never carry a body or an image.
// DISABLED entries are kept here (with the reason) so nobody re-adds them without reading N1.
import type { DisabledScope, SourceDefinition, Topic } from "./types.ts";

const MINUTE = 60;

type Direct = Omit<
  SourceDefinition,
  | "policy"
  | "content_usage_scope"
  | "discovery_only"
  | "article_body_allowed"
  | "headline_storage_allowed"
  | "min_request_gap_ms"
  | "timeout_ms"
  | "requires_api_key"
  | "enabled_for_n2"
> & Partial<Pick<SourceDefinition, "min_request_gap_ms" | "timeout_ms" | "requires_api_key" | "enabled_for_n2">>;

/** Official primary publisher. Headline + short summary hint may be stored; bodies are not kept. */
function direct(def: Direct): SourceDefinition {
  return {
    min_request_gap_ms: 1_000,
    timeout_ms: 15_000,
    requires_api_key: false,
    enabled_for_n2: true,
    ...def,
    policy: "DIRECT_SOURCE",
    content_usage_scope: "direct",
    discovery_only: false,
    // N2 keeps a <=280 char hint only; full bodies are out of scope even where terms would allow.
    article_body_allowed: false,
    headline_storage_allowed: true,
  };
}

function disabled(
  source_id: string,
  source_name: string,
  operator: string,
  country: string,
  endpoint: string,
  commercial_usage_status: SourceDefinition["commercial_usage_status"],
  terms_url: string | null,
  notes: string,
  disabled_scope: DisabledScope = "no_direct_fetch",
  publisher_domains: string[] = [new URL(endpoint).hostname.replace(/^(www|rss|feeds|news|search)\./, "")],
): SourceDefinition {
  return {
    disabled_scope,
    publisher_domains,
    source_id,
    source_name,
    operator,
    category: "discovery",
    country,
    language: country === "JP" ? "ja" : "en",
    source_type: "rss",
    endpoint,
    fetch_interval_hint_sec: 0,
    min_request_gap_ms: 0,
    timeout_ms: 0,
    policy: "DISABLED",
    commercial_usage_status,
    content_usage_scope: "none",
    trust_level: "untrusted",
    discovery_only: false,
    article_body_allowed: false,
    headline_storage_allowed: false,
    image_usage_allowed: false,
    requires_api_key: false,
    enabled_for_n2: false,
    default_topics: [],
    terms_url,
    attribution: null,
    notes,
  };
}

const US_PD = "allowed_public_domain" as const;
const PDL = "allowed_with_attribution" as const;
const t = (...topics: Topic[]) => topics;

export const NEWS_SOURCE_REGISTRY: readonly SourceDefinition[] = [
  // ---------------------------------------------------------------- United States (public domain)
  direct({
    source_id: "us_federal_register",
    source_name: "Federal Register API",
    operator: "Office of the Federal Register / GPO",
    category: "trade_tariffs",
    country: "US",
    language: "en",
    source_type: "federal_register_json",
    endpoint:
      "https://www.federalregister.gov/api/v1/documents.json?order=newest&per_page=20&fields%5B%5D=title&fields%5B%5D=abstract&fields%5B%5D=document_number&fields%5B%5D=html_url&fields%5B%5D=publication_date&fields%5B%5D=type&fields%5B%5D=agencies",
    fetch_interval_hint_sec: 15 * MINUTE,
    commercial_usage_status: US_PD,
    trust_level: "official_primary",
    image_usage_allowed: false,
    default_topics: t("regulation"),
    terms_url: "https://www.federalregister.gov/developers/documentation/api/v1",
    attribution: "Federal Register",
    notes: "API key not required (official docs). publication_date is date-only: stored with precision=date.",
  }),
  direct({
    source_id: "us_fed_press",
    source_name: "Federal Reserve press releases",
    operator: "Board of Governors of the Federal Reserve System",
    category: "monetary_policy",
    country: "US",
    language: "en",
    source_type: "rss",
    endpoint: "https://www.federalreserve.gov/feeds/press_all.xml",
    fetch_interval_hint_sec: 30 * MINUTE,
    commercial_usage_status: US_PD,
    trust_level: "official_primary",
    image_usage_allowed: false,
    default_topics: t("monetary_policy"),
    terms_url: "https://www.federalreserve.gov/disclaimer.htm",
    attribution: "Federal Reserve",
    notes: "Also used by the existing market_macro lane; this observer polls it independently.",
  }),
  direct({
    source_id: "us_sec_8k",
    source_name: "SEC EDGAR current 8-K filings",
    operator: "U.S. Securities and Exchange Commission",
    category: "corporate_disclosure",
    country: "US",
    language: "en",
    source_type: "atom",
    endpoint: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&count=40&output=atom",
    fetch_interval_hint_sec: 15 * MINUTE,
    commercial_usage_status: US_PD,
    trust_level: "official_primary",
    image_usage_allowed: false,
    default_topics: t(),
    terms_url: "https://www.sec.gov/os/accessing-edgar-data",
    attribution: "SEC EDGAR",
    notes: "Fair access: <=10 req/s and a declared User-Agent with contact (403 without it).",
  }),
  direct({
    source_id: "us_whitehouse_news",
    source_name: "White House news",
    operator: "The White House",
    category: "government",
    country: "US",
    language: "en",
    source_type: "rss",
    endpoint: "https://www.whitehouse.gov/news/feed/",
    fetch_interval_hint_sec: 15 * MINUTE,
    commercial_usage_status: US_PD,
    trust_level: "official_primary",
    image_usage_allowed: false,
    default_topics: t(),
    terms_url: "https://www.whitehouse.gov/copyright/",
    attribution: "The White House",
    notes: "/feed/ returns 403; /news/feed/ works. Some photos are third-party: images not used.",
  }),
  direct({
    source_id: "us_ustr",
    source_name: "USTR press",
    operator: "Office of the U.S. Trade Representative",
    category: "trade_tariffs",
    country: "US",
    language: "en",
    source_type: "rss",
    endpoint: "https://ustr.gov/rss.xml",
    fetch_interval_hint_sec: 15 * MINUTE,
    commercial_usage_status: US_PD,
    trust_level: "official_primary",
    image_usage_allowed: false,
    default_topics: t("tariffs"),
    terms_url: null,
    attribution: "USTR",
    notes: "Feed starts with a pinned 2009 item: never rely on feed order.",
  }),
  direct({
    source_id: "us_state_press",
    source_name: "U.S. Department of State press releases",
    operator: "U.S. Department of State",
    category: "geopolitics",
    country: "US",
    language: "en",
    source_type: "rss",
    endpoint: "https://www.state.gov/rss-feed/press-releases/feed/",
    fetch_interval_hint_sec: 15 * MINUTE,
    commercial_usage_status: US_PD,
    trust_level: "official_primary",
    image_usage_allowed: false,
    default_topics: t("geopolitics"),
    terms_url: "https://www.state.gov/copyright-information/",
    attribution: "U.S. Department of State",
    enabled_for_n2: false,
    notes:
      "Feed carries content:encoded full text; the observer keeps only a short hint. 2026-09-28: 200 for a browser-like probe (N1) but 403 for the declared observer UA — disabled until access is clarified; never spoof the UA.",
  }),
  direct({
    source_id: "us_bea",
    source_name: "BEA releases",
    operator: "U.S. Bureau of Economic Analysis",
    category: "macro_data",
    country: "US",
    language: "en",
    source_type: "rss",
    endpoint: "https://apps.bea.gov/rss/rss.xml",
    fetch_interval_hint_sec: 30 * MINUTE,
    commercial_usage_status: US_PD,
    trust_level: "official_primary",
    image_usage_allowed: false,
    default_topics: t("macro_data"),
    terms_url: null,
    attribution: "BEA",
    notes: "Release times are scheduled; a calendar-driven burst is an N3 topic.",
  }),
  direct({
    source_id: "us_eia_today_in_energy",
    source_name: "EIA Today in Energy",
    operator: "U.S. Energy Information Administration",
    category: "energy",
    country: "US",
    language: "en",
    source_type: "rss",
    endpoint: "https://www.eia.gov/rss/todayinenergy.xml",
    fetch_interval_hint_sec: 60 * MINUTE,
    commercial_usage_status: US_PD,
    trust_level: "official_primary",
    image_usage_allowed: false,
    default_topics: t("energy"),
    terms_url: "https://www.eia.gov/about/copyrights_reuse.php",
    attribution: "U.S. Energy Information Administration",
    notes: "EIA API v2 needs a free key; not registered in N2.",
  }),
  direct({
    source_id: "us_eia_press",
    source_name: "EIA press releases",
    operator: "U.S. Energy Information Administration",
    category: "energy",
    country: "US",
    language: "en",
    source_type: "rss",
    endpoint: "https://www.eia.gov/rss/press_rss.xml",
    fetch_interval_hint_sec: 60 * MINUTE,
    commercial_usage_status: US_PD,
    trust_level: "official_primary",
    image_usage_allowed: false,
    default_topics: t("energy"),
    terms_url: "https://www.eia.gov/about/copyrights_reuse.php",
    attribution: "U.S. Energy Information Administration",
    notes: "Links are site-relative in the feed; resolved against the feed URL.",
  }),
  direct({
    source_id: "us_usgs_significant",
    source_name: "USGS significant earthquakes (past week)",
    operator: "U.S. Geological Survey",
    category: "disaster",
    country: "INT",
    language: "en",
    source_type: "atom",
    endpoint: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.atom",
    fetch_interval_hint_sec: 5 * MINUTE,
    commercial_usage_status: US_PD,
    trust_level: "official_primary",
    image_usage_allowed: false,
    default_topics: t("disaster"),
    terms_url: "https://www.usgs.gov/information-policies-and-instructions",
    attribution: "USGS",
    notes: "Global, low volume (significant events only).",
  }),
  // ---------------------------------------------------------------- Europe
  direct({
    source_id: "eu_ecb_press",
    source_name: "ECB press releases",
    operator: "European Central Bank",
    category: "monetary_policy",
    country: "EU",
    language: "en",
    source_type: "rss",
    endpoint: "https://www.ecb.europa.eu/rss/press.html",
    fetch_interval_hint_sec: 30 * MINUTE,
    commercial_usage_status: PDL,
    trust_level: "official_primary",
    image_usage_allowed: false,
    default_topics: t("monetary_policy"),
    terms_url: "https://www.ecb.europa.eu/services/disclaimer/html/index.en.html",
    attribution: "Source: ECB",
    notes: "Reuse with source attribution; no framing. Speech links may be PDFs.",
  }),
  direct({
    source_id: "eu_commission_press",
    source_name: "European Commission Press Corner",
    operator: "European Commission",
    category: "regulation",
    country: "EU",
    language: "en",
    source_type: "rss",
    endpoint: "https://ec.europa.eu/commission/presscorner/api/rss?language=en",
    fetch_interval_hint_sec: 30 * MINUTE,
    commercial_usage_status: PDL,
    trust_level: "official_primary",
    image_usage_allowed: false,
    default_topics: t("regulation"),
    terms_url: "https://commission.europa.eu/legal-notice_en",
    attribution: "© European Union",
    notes: "Commission Decision 2011/833/EU (generally CC BY 4.0); photos excluded.",
  }),
  // ---------------------------------------------------------------- Japan (PDL1.0)
  direct({
    source_id: "jp_mof_news",
    source_name: "財務省 新着情報",
    operator: "財務省",
    category: "fiscal_policy",
    country: "JP",
    language: "ja",
    source_type: "rss",
    endpoint: "https://www.mof.go.jp/news.rss",
    fetch_interval_hint_sec: 15 * MINUTE,
    commercial_usage_status: PDL,
    trust_level: "official_primary",
    image_usage_allowed: false,
    default_topics: t("fiscal"),
    terms_url: "https://www.mof.go.jp/about_mof/notice/index.html",
    attribution: "出典：財務省ウェブサイト",
    notes: "rss/all.xml is 404. FX intervention results are not in this feed (separate page).",
  }),
  direct({
    source_id: "jp_fsa_news",
    source_name: "金融庁 新着情報",
    operator: "金融庁",
    category: "regulation",
    country: "JP",
    language: "ja",
    source_type: "rss",
    endpoint: "https://www.fsa.go.jp/fsaNewsListAll_rss2.xml",
    fetch_interval_hint_sec: 30 * MINUTE,
    commercial_usage_status: PDL,
    trust_level: "official_primary",
    image_usage_allowed: false,
    default_topics: t("regulation"),
    terms_url: "https://www.fsa.go.jp/rules/index.html",
    attribution: "出典：金融庁ウェブサイト",
    notes: "Administrative actions name companies: a useful ticker-matching source.",
  }),
  direct({
    source_id: "jp_kantei_news",
    source_name: "首相官邸 新着",
    operator: "内閣官房",
    category: "government",
    country: "JP",
    language: "ja",
    source_type: "rdf",
    endpoint: "https://www.kantei.go.jp/index-jnews.rdf",
    fetch_interval_hint_sec: 30 * MINUTE,
    commercial_usage_status: PDL,
    trust_level: "official_primary",
    image_usage_allowed: false,
    default_topics: t(),
    terms_url: "https://www.kantei.go.jp/jp/terms.html",
    attribution: "出典：首相官邸ホームページ",
    notes: "/jp/rss/index.rdf is 404. Person photos have portrait rights: images not used.",
  }),
  direct({
    source_id: "jp_esri",
    source_name: "内閣府 経済社会総合研究所 新着",
    operator: "内閣府",
    category: "macro_data",
    country: "JP",
    language: "ja",
    source_type: "rss",
    endpoint: "https://www.esri.cao.go.jp/rss-jp.xml",
    fetch_interval_hint_sec: 30 * MINUTE,
    commercial_usage_status: PDL,
    trust_level: "official_primary",
    image_usage_allowed: false,
    default_topics: t("macro_data"),
    terms_url: "https://www.cao.go.jp/notice/rule.html",
    attribution: "出典：内閣府ウェブサイト",
    notes: "GDP / business-cycle releases at fixed times.",
  }),
  direct({
    source_id: "jp_caa_news",
    source_name: "消費者庁 新着情報",
    operator: "消費者庁",
    category: "regulation",
    country: "JP",
    language: "ja",
    source_type: "rss",
    endpoint: "https://www.caa.go.jp/news.rss",
    fetch_interval_hint_sec: 60 * MINUTE,
    commercial_usage_status: PDL,
    trust_level: "official_primary",
    image_usage_allowed: false,
    default_topics: t("regulation"),
    terms_url: "https://www.caa.go.jp/terms_of_use/",
    attribution: "出典：消費者庁ウェブサイト",
    notes: "Recalls and administrative actions. recall.caa.go.jp has no RSS.",
  }),
  direct({
    source_id: "jp_jma_eqvol",
    source_name: "気象庁 防災情報XML（地震火山・高頻度）",
    operator: "気象庁",
    category: "disaster",
    country: "JP",
    language: "ja",
    source_type: "atom",
    endpoint: "https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml",
    fetch_interval_hint_sec: 2 * MINUTE,
    commercial_usage_status: PDL,
    trust_level: "official_primary",
    image_usage_allowed: false,
    default_topics: t("disaster"),
    terms_url: "https://www.jma.go.jp/jma/kishou/info/coment.html",
    attribution: "出典：気象庁ホームページ",
    notes:
      "Only material telegram types are kept (JMA_MATERIAL_TITLES). Relaying JMA warnings with attribution is fine; issuing our own warnings is not (気象業務法23条).",
  }),
  direct({
    source_id: "jp_jma_extra",
    source_name: "気象庁 防災情報XML（随時・高頻度）",
    operator: "気象庁",
    category: "disaster",
    country: "JP",
    language: "ja",
    source_type: "atom",
    endpoint: "https://www.data.jma.go.jp/developer/xml/feed/extra.xml",
    fetch_interval_hint_sec: 2 * MINUTE,
    timeout_ms: 20_000,
    commercial_usage_status: PDL,
    trust_level: "official_primary",
    image_usage_allowed: false,
    default_topics: t("disaster"),
    terms_url: "https://www.jma.go.jp/jma/kishou/info/coment.html",
    attribution: "出典：気象庁ホームページ",
    notes: "~1,700 routine telegrams/day; only 特別警報-class titles are kept.",
  }),
  direct({
    source_id: "jp_edinet_documents",
    source_name: "EDINET API v2 書類一覧",
    operator: "金融庁",
    category: "corporate_disclosure",
    country: "JP",
    language: "ja",
    source_type: "edinet_documents_json",
    endpoint: "https://api.edinet-fsa.go.jp/api/v2/documents.json",
    fetch_interval_hint_sec: 15 * MINUTE,
    requires_api_key: true,
    enabled_for_n2: false,
    commercial_usage_status: PDL,
    trust_level: "official_primary",
    image_usage_allowed: false,
    default_topics: t(),
    terms_url: "https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/WZEK0030.html",
    attribution: "出典：EDINET",
    notes:
      "Tier A, but the Subscription-Key requires an account the user must create. Parser is implemented and tested on fixtures only.",
  }),
  // ---------------------------------------------------------------- Discovery (metadata only)
  {
    source_id: "gdelt_doc",
    source_name: "GDELT DOC 2.0 (article list)",
    operator: "The GDELT Project",
    category: "discovery",
    country: "INT",
    language: "mul",
    source_type: "gdelt_doc_json",
    endpoint: "https://api.gdeltproject.org/api/v2/doc/doc",
    fetch_interval_hint_sec: 15 * MINUTE,
    // GDELT answers 429 "one every 5 seconds"; 6 s leaves margin.
    min_request_gap_ms: 6_000,
    timeout_ms: 20_000,
    policy: "DISCOVERY_ONLY",
    commercial_usage_status: "allowed_open_data",
    content_usage_scope: "discovery_only",
    trust_level: "discovery_metadata",
    discovery_only: true,
    article_body_allowed: false,
    // GDELT metadata (URL, domain, title, language, source country, seen date) under GDELT's open terms.
    // The title is the publisher's: it is kept for matching/dedupe only and must never be displayed.
    headline_storage_allowed: true,
    image_usage_allowed: false,
    requires_api_key: false,
    enabled_for_n2: true,
    default_topics: [],
    terms_url: "https://www.gdeltproject.org/about.html",
    attribution: "GDELT Project (citation and link required)",
    notes:
      "Discovery only: no body, no socialimage, never shown to users, never used as a news source of record.",
  },
  // ---------------------------------------------------------------- Disabled (N1 tier C/D or needs consent)
  disabled("boj_whatsnew", "日本銀行 新着", "日本銀行", "JP", "https://www.boj.or.jp/rss/whatsnew.xml", "unclear",
    "https://www.boj.or.jp/about/copyright.htm", "独自規約: 商用目的の転載・複製は事前相談。相談前は N2 で使わない（既存 market_macro は別所管）。"),
  disabled("nhk_news", "NHK ニュース RSS", "NHK", "JP", "https://news.web.nhk/n-data/conf/na/rss/cat0.xml", "prohibited",
    "https://www.nhk.or.jp/toppage/rss/index.html", "個人利用のみ。商業目的の再配信・再提供は不可。", "no_direct_fetch", ["nhk.or.jp", "news.web.nhk"]),
  disabled("jiji_rss", "時事通信 RSS", "時事通信社", "JP", "https://www.jiji.com/rss/ranking.rdf", "prohibited",
    "https://www.jiji.com/policy/rss.html", "個人の私的利用のみ。"),
  disabled("asahi_rss", "朝日新聞 RSS", "朝日新聞社", "JP", "https://www.asahi.com/rss/asahi/newsheadlines.rdf", "prohibited",
    "https://www.asahi.com/information/service/rss.html", "営利目的サイトでの利用禁止。"),
  disabled("mainichi_rss", "毎日新聞 RSS", "毎日新聞社", "JP", "https://mainichi.jp/rss/etc/mainichi-flash.rss", "prohibited",
    "https://mainichi.jp/rss/", "商業目的の利用はお断り。"),
  disabled("yahoo_news_jp", "Yahoo!ニュース RSS", "LINEヤフー", "JP", "https://news.yahoo.co.jp/rss/topics/business.xml", "prohibited",
    "https://news.yahoo.co.jp/rss", "個人利用のみ。アプリでの公開は不許可。", "no_direct_fetch", ["news.yahoo.co.jp", "finance.yahoo.co.jp"]),
  disabled("google_news_rss", "Google News RSS", "Google", "INT", "https://news.google.com/rss", "prohibited",
    "https://www.google.com/intl/ja_jp/terms_google_news.html", "営利目的以外の個人的使用が条件。", "no_direct_fetch", ["news.google.com"]),
  disabled("tdnet_list", "TDnet 閲覧サイト", "JPX", "JP", "https://www.release.tdnet.info/inbs/", "prohibited",
    null, "robots.txt Disallow: /。有料 TDnet API が正規経路。", "no_direct_fetch", ["release.tdnet.info"]),
  disabled("jpx_rss", "JPX RSS", "日本取引所グループ", "JP", "https://www.jpx.co.jp/rss/markets_news.xml", "prohibited",
    "https://www.jpx.co.jp/term-of-use/index.html", "商用目的のデータ収集・二次利用・再配信不可。", "no_direct_fetch", ["jpx.co.jp"]),
  disabled("prtimes_rss", "PR TIMES RSS", "PR TIMES", "JP", "https://prtimes.jp/index.rdf", "unclear",
    "https://prtimes.jp/main/html/kiyaku", "営利利用は許可制。提携後に再評価（企業ニュースで最有力）。"),
  disabled("itmedia_rss", "ITmedia RSS", "アイティメディア", "JP", "https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml", "unclear",
    "https://corp.itmedia.co.jp/media/rss_condition/", "アプリ組み込みは許諾制。", "no_direct_fetch", ["itmedia.co.jp"]),
  disabled("bbc_world", "BBC World RSS", "BBC", "GB", "https://feeds.bbci.co.uk/news/world/rss.xml", "unclear",
    "https://www.bbc.co.uk/news/10628494", "商用可否の明記なし。robots で AI クローラー拒否。", "no_direct_fetch", ["bbc.co.uk", "bbc.com"]),
  disabled("al_jazeera", "Al Jazeera RSS", "Al Jazeera Media Network", "QA", "https://www.aljazeera.com/xml/rss/all.xml", "prohibited",
    "https://www.aljazeera.com/terms-and-conditions", "personal, non-commercial。AI・TDM・商用を明示禁止。", "no_access", ["aljazeera.com"]),
  disabled("un_news", "UN News RSS", "United Nations", "INT", "https://news.un.org/feed/subscribe/en/news/all/rss.xml", "unclear",
    "https://www.un.org/en/about-us/terms-of-use", "UN サイト規約は personal, non-commercial use。", "no_direct_fetch", ["news.un.org"]),
  disabled("cnbc_rss", "CNBC RSS", "Versant", "US", "https://search.cnbc.com/rs/search/combinedcms/view.xml", "prohibited",
    "https://www.cnbc.com/nbcuniversal-terms-of-service/", "personal / non-commercial。", "no_direct_fetch", ["cnbc.com"]),
  disabled("ft_rss", "Financial Times RSS", "FT", "GB", "https://www.ft.com/world?format=rss", "prohibited",
    null, "robots.txt で ML/AI 利用を明示禁止。", "no_access", ["ft.com"]),
  disabled("diamond_online", "ダイヤモンド・オンライン", "ダイヤモンド社", "JP", "https://diamond.jp/list/feed/rss/dol", "prohibited",
    "https://www.diamond.co.jp/tos/dol.html", "スクレイピング収集・生成 AI への利用を明示禁止。", "no_access", ["diamond.jp"]),
  disabled("toyokeizai_rss", "東洋経済オンライン", "東洋経済新報社", "JP", "https://toyokeizai.net/list/feed/rss", "prohibited",
    "https://toyokeizai.net/list/base-terms", "営利目的の利用・クローラ収集を禁止。", "no_direct_fetch", ["toyokeizai.net"]),
  disabled("nyt_rss", "New York Times", "NYT", "US", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml", "prohibited",
    "https://www.nytimes.com/rss", "事前の書面許可なき商用利用禁止。", "no_direct_fetch", ["nytimes.com"]),
  disabled("dowjones_rss", "MarketWatch / WSJ", "Dow Jones", "US", "https://feeds.content.dowjones.io/public/rss/mw_topstories", "prohibited",
    null, "一般に個人・非商用。", "no_direct_fetch", ["marketwatch.com", "wsj.com"]),
  // ---------------------------------------------------------------- Observer Web Search (N3 v2)
  {
    source_id: "web_search",
    source_name: "Observer limited Web Search",
    operator: "OpenAI Responses API web_search (observer-owned lanes)",
    category: "discovery",
    country: "INT",
    language: "mul",
    source_type: "web_search",
    endpoint: "https://api.openai.com/v1/responses",
    fetch_interval_hint_sec: 0, // driven by the search budget, not by polling
    min_request_gap_ms: 0,
    timeout_ms: 60_000,
    policy: "SEARCH_DISCOVERY",
    commercial_usage_status: "allowed_search_metadata",
    content_usage_scope: "discovery_only",
    trust_level: "discovery_metadata",
    discovery_only: true,
    article_body_allowed: false,
    // URL, domain and the discovery title only; the title is never displayed and never
    // treated as a fact. Result pages are not fetched.
    headline_storage_allowed: true,
    image_usage_allowed: false,
    requires_api_key: true,
    enabled_for_n2: false, // never polled by the feed fetcher; the search stage calls it under budget
    default_topics: [],
    terms_url: null,
    attribution: null,
    notes:
      "Radar, not a source of record: a result means 'a story exists'. Confirm with an official/primary source before any use. Independent of important-news-monitor's searches.",
  },
];

export function sourceById(sourceId: string): SourceDefinition | undefined {
  return NEWS_SOURCE_REGISTRY.find((source) => source.source_id === sourceId);
}

/** Feed/API sources the observer may actually request (Web Search is budgeted separately). */
export function fetchableSources(registry: readonly SourceDefinition[] = NEWS_SOURCE_REGISTRY): SourceDefinition[] {
  return registry.filter((source) =>
    (source.policy === "DIRECT_SOURCE" || source.policy === "DISCOVERY_ONLY") && source.enabled_for_n2 && !source.requires_api_key
  );
}

export type PublisherRestriction = { source_id: string; scope: DisabledScope } | null;

/** Recognises a DISABLED publisher by URL host (exact domain or subdomain). */
export function publisherRestriction(url: string, registry: readonly SourceDefinition[] = NEWS_SOURCE_REGISTRY): PublisherRestriction {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  let found: PublisherRestriction = null;
  for (const source of registry) {
    if (source.policy !== "DISABLED" || !source.disabled_scope) continue;
    for (const domain of source.publisher_domains ?? []) {
      if (host === domain || host.endsWith(`.${domain}`)) {
        // no_access wins over no_direct_fetch if a host is listed twice.
        if (!found || source.disabled_scope === "no_access") found = { source_id: source.source_id, scope: source.disabled_scope };
      }
    }
  }
  return found;
}

/**
 * Structural checks that keep the policy honest. Returns human-readable violations (empty = OK).
 * The test suite runs this over the real registry so a careless edit fails CI.
 */
export function validateRegistry(registry: readonly SourceDefinition[] = NEWS_SOURCE_REGISTRY): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const source of registry) {
    if (ids.has(source.source_id)) problems.push(`${source.source_id}: duplicate source_id`);
    ids.add(source.source_id);
    if (!source.endpoint.startsWith("https://")) problems.push(`${source.source_id}: endpoint must be https`);
    if (source.policy === "DISABLED" && source.enabled_for_n2) {
      problems.push(`${source.source_id}: DISABLED source cannot be enabled`);
    }
    if (source.policy === "DISABLED" && (!source.disabled_scope || !(source.publisher_domains ?? []).length)) {
      problems.push(`${source.source_id}: DISABLED source needs disabled_scope and publisher_domains`);
    }
    if (source.policy === "SEARCH_DISCOVERY" && (source.enabled_for_n2 || !source.requires_api_key)) {
      problems.push(`${source.source_id}: SEARCH_DISCOVERY is budgeted, never polled`);
    }
    if (source.policy === "DISCOVERY_ONLY" || source.policy === "SEARCH_DISCOVERY") {
      if (!source.discovery_only) problems.push(`${source.source_id}: ${source.policy} must set discovery_only`);
      if (source.article_body_allowed || source.image_usage_allowed) {
        problems.push(`${source.source_id}: ${source.policy} cannot allow body or images`);
      }
    }
    if (source.policy !== "DISABLED" && (source.commercial_usage_status === "prohibited" ||
      source.commercial_usage_status === "unclear")) {
      problems.push(`${source.source_id}: ${source.commercial_usage_status} terms may not be enabled in N2`);
    }
    if (source.policy === "DIRECT_SOURCE" && source.trust_level !== "official_primary") {
      problems.push(`${source.source_id}: N2 DIRECT sources must be official primary publishers`);
    }
    if (source.article_body_allowed) problems.push(`${source.source_id}: N2 never stores article bodies`);
  }
  return problems;
}
