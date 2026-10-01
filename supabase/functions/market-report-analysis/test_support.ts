// Shared test fixtures: real production inputs (market data + public news, no user data) and
// hand-written presentation-v2 analyses grounded in them. Used by the analysis, handler, transport and
// presentation tests so they all exercise the same full-length output a production run returns.
import { type AnalysisInput, buildAnalysisInput, type NewsTextRow } from "./analysis_input.ts";
import type { GeneratedAnalysis } from "./analysis_logic.ts";
import type { MarketDataPacket } from "../market-report-data-packet/packet_schema.ts";

const directory = new URL("./fixtures/", import.meta.url);
const read = async (name: string) => JSON.parse(await Deno.readTextFile(new URL(name, directory)));

export type Fixture = { data: { id: string; content_hash: string; payload: MarketDataPacket }; news: NewsTextRow[] };

export async function loadFixture(name: string): Promise<Fixture> {
  return { data: await read(`${name}_data_packet.json`), news: await read(`${name}_news_rows.json`) };
}

export function inputOf(fixture: Fixture, overrides: { payload?: MarketDataPacket; news?: NewsTextRow[] } = {}): AnalysisInput {
  return buildAnalysisInput({
    dataPacket: overrides.payload ?? fixture.data.payload,
    dataPacketId: fixture.data.id,
    dataContentHash: fixture.data.content_hash,
    newsRows: overrides.news ?? fixture.news,
  });
}

const refOf = (input: AnalysisInput, match: (headline: string, company: string | null) => boolean): string => {
  const item = input.news.find((news) => match(news.headline_ja, news.company));
  if (!item) throw new Error("fixture news item not found");
  return item.ref;
};

/** 2026-09-17 close: Tokyo up on 9/17, US down on 9/16. */
export function rich0917(input: AnalysisInput): GeneratedAnalysis {
  const shipping = refOf(input, (headline) => headline.includes("中東の主要航路"));
  const kakaku = refOf(input, (_headline, company) => !!company?.includes("カカクコム"));
  return {
    headline_ja: "日経平均は64,136.25で小幅高",
    market_summary_ja: "9月17日の東京市場は、日経平均が64,136.25（前日比+0.33%）、TOPIX連動ETF（1306）が427.4円（前日比+0.83%）と上昇しました。9月16日の米国市場はNYダウが51,461.90（前日比−1.21%）と下げていました。上昇の理由を説明するニュースは確認できません。",
    claims: [
      { claim_id: "c1", text_ja: "9月17日の日経平均は64,136.25（前日比+0.33%）で取引を終えました。", claim_type: "observation", evidence_refs: ["metric:nikkei225"], scope: "today" },
      { claim_id: "c2", text_ja: "カカクコムでTOB価格の引き上げが伝えられました。", claim_type: "causal", evidence_refs: [kakaku], scope: "today" },
      { claim_id: "c3", text_ja: "指数全体の上昇理由は入力からは確認できません。", claim_type: "insufficient_evidence", evidence_refs: [], scope: "today" },
      { claim_id: "c4", text_ja: "今夜の米国株の動きを確認したいところです。", claim_type: "watch_point", evidence_refs: [], scope: "next" },
      { claim_id: "c5", text_ja: "中東の主要航路で船舶への攻撃が増えていると、国連の海事機関トップが警告しました。", claim_type: "observation", evidence_refs: [shipping], scope: "today" },
    ],
    key_news: [
      { ref: shipping, why_it_matters_ja: "原油や物流に関わる航路の安全に関するニュースです。" },
      { ref: kakaku, why_it_matters_ja: "非公開化の条件が変わる材料です。" },
    ],
    strong_themes: [{ name_ja: "非公開化関連", claim_ids: ["c2"] }],
    weak_themes: [],
    next_watch_ja: ["今夜の米国株の動き", "中東の航路をめぐる続報"],
    risks_ja: ["前夜の米国株安の影響", "中東の航路をめぐる緊張"],
    x_post: {
      lead_ja: "きょうの日本株は日経平均が+0.33%で、TOPIX連動ETF（1306）も+0.83%でした📈",
      points_ja: [
        "日経平均は64,136.25で取引終了",
        "9月16日のNYダウは−1.21%でも東京は上昇",
        "カカクコムでTOB価格引き上げの連絡",
      ],
      context_ja: "9月17日の東京市場は、TOPIX連動ETF（1306）も427.4円（前日比+0.83%）と上げて終えました。9月16日の米国市場ではNYダウとS&P500が下落していましたが、東京市場は上昇しています。上昇の理由は確認できていません。",
      news_ja: "中東の主要航路で船舶への攻撃が増えていると、国連の海事機関トップが警告しました。原油や物流に関わるニュースとして確認されていますが、東京市場の値動きとの関係は確認できていません。",
      watch_ja: "今夜の米国株がどう動くか、ドル円が155.05円近辺から動くかを見ていきます。中東の航路をめぐる続報も確認点です。",
      closing_ja: "今夜の米国株がどう動くか、あしたの手がかりになりそうです",
    },
    app_story: {
      summary_ja: "9月17日の東京市場は、日経平均とTOPIX連動ETF（1306）がそろって上昇して終えました。前日の米国株は下げていましたが、東京市場は上昇しており、理由を説明するニュースは確認できていません。",
      overseas_ja: "9月16日の米国市場は、NYダウが51,461.90（前日比−1.21%）、S&P500が7,551.81（前日比−0.45%）と下落しました。ナスダック総合は25,978.43（前日比−0.01%）とほぼ横ばいで、フィラデルフィア半導体株指数（SOX）は11,246.11（前日比+0.63%）と上昇しました。",
      japan_ja: "9月17日の東京市場は、日経平均が64,136.25（前日比+0.33%）、TOPIX連動ETF（1306）が427.4円（前日比+0.83%）と、主要な指標がそろって上昇しました。前日の米国株安とは違う動きですが、上昇の理由を説明するニュースは確認できていません。業種別の騰落は取得元がなく、確認できていません。",
      cross_asset_ja: "ドル円は9月16日時点で155.05円でした。米国10年債利回りは9月15日時点で5%、WTI原油は9月15日時点で107.02ドルです。日本国債の利回りは8月31日時点の値で、最新の水準は確認できていません。",
      news_ja: "中東の主要航路では船舶への攻撃が増えているとして、国連の海事機関トップが警告しました。東京市場の値動きとの関係は確認できていません。個別企業では、カカクコムをめぐる非公開化の提案でTOB価格の引き上げが伝えられ、銚子丸は通期予想を上方修正しました。",
      strong_ja: "カカクコムをめぐる非公開化の提案では、TOB価格の引き上げが伝えられています。",
      caution_ja: "前日の米国市場ではNYダウが大きく下げており、今夜の米国株の動き次第で地合いが変わる点に注意が必要です。中東の航路をめぐる緊張も続いています。",
      watch_ja: "今夜の米国株がどう動くか、ドル円が155.05円近辺から動くかが確認点です。中東の航路をめぐる続報と、原油の値動きもあわせて確認します。",
    },
  };
}

/** 2026-09-30 close: Tokyo up on 9/30, US down on 9/29 with SOX up. */
export function richClose0930(input: AnalysisInput): GeneratedAnalysis {
  const tsunami = refOf(input, (headline) => headline.includes("津波予報"));
  const canada = refOf(input, (headline) => headline.includes("カナダ産"));
  const confidence = refOf(input, (headline) => headline.includes("消費者信頼感"));
  const sbi = refOf(input, (headline) => headline.startsWith("SBIグローバルAM"));
  return {
    headline_ja: "日経平均は+1.94%、東京市場はそろって上昇",
    market_summary_ja: "9月30日の東京市場は、日経平均が66,753.72（前日比+1.94%）、TOPIX連動ETF（1306）が431.5円（前日比+1.43%）と上昇しました。9月29日の米国市場はNYダウが51,349.92（前日比−0.26%）と下げ、フィラデルフィア半導体株指数（SOX）は12,629.16（前日比+1.32%）でした。気象庁は「若干の海面変動」とする津波予報を発表しています。上昇の理由を説明するニュースは確認できません。",
    claims: [
      { claim_id: "c1", text_ja: "9月30日の日経平均は66,753.72（前日比+1.94%）でした。", claim_type: "observation", evidence_refs: ["metric:nikkei225"], scope: "today" },
      { claim_id: "c2", text_ja: "9月30日のTOPIX連動ETF（1306）は431.5円（前日比+1.43%）でした。", claim_type: "observation", evidence_refs: ["metric:topix_proxy_1306"], scope: "today" },
      { claim_id: "c3", text_ja: "9月29日の米国市場は、NYダウとS&P500が下落しました。", claim_type: "observation", evidence_refs: ["metric:dow", "metric:sp500"], scope: "overnight" },
      { claim_id: "c4", text_ja: "9月29日のフィラデルフィア半導体株指数（SOX）は12,629.16（前日比+1.32%）でした。", claim_type: "observation", evidence_refs: ["metric:sox"], scope: "overnight" },
      { claim_id: "c5", text_ja: "気象庁が「若干の海面変動」とする津波予報を発表しました。津波警報・注意報ではありません。", claim_type: "observation", evidence_refs: [tsunami], scope: "today" },
      { claim_id: "c6", text_ja: "東京市場が上昇した理由は、入力のニュースからは確認できません。", claim_type: "insufficient_evidence", evidence_refs: [], scope: "today" },
      { claim_id: "c7", text_ja: "米国の消費者信頼感の悪化が、次の米国市場でどう受け止められるかが確認点です。", claim_type: "watch_point", evidence_refs: [confidence], scope: "next" },
    ],
    key_news: [
      { ref: tsunami, why_it_matters_ja: "警報・注意報ではなく、若干の海面変動とする予報です。" },
      { ref: canada, why_it_matters_ja: "米国とカナダの関税の応酬が広がっています。" },
      { ref: confidence, why_it_matters_ja: "米国の消費の勢いを見る材料です。" },
      { ref: sbi, why_it_matters_ja: "グループ内の再編に関する発表です。" },
    ],
    strong_themes: [],
    weak_themes: [],
    next_watch_ja: ["米国の消費者信頼感の悪化の受け止め", "米国とカナダの関税をめぐる続報"],
    risks_ja: ["米国の消費者信頼感の悪化", "関税の応酬の広がり"],
    x_post: {
      lead_ja: "9月30日の東京市場は、日経平均もTOPIX連動ETF（1306）も上昇しました📈",
      points_ja: [
        "日経平均は66,753.72（前日比+1.94%）",
        "TOPIX連動ETF（1306）は431.5円（前日比+1.43%）",
        "9月29日の米国はNYダウ−0.26%、SOXは+1.32%",
      ],
      context_ja: "9月29日の米国市場はNYダウとS&P500が下落した一方、フィラデルフィア半導体株指数（SOX）は上昇していました。9月30日の東京市場の上昇と同じ時期の動きですが、上昇の理由を説明するニュースは確認できていません。",
      news_ja: "気象庁は「若干の海面変動」とする津波予報を発表しました。津波警報・注意報ではありません。米国ではカナダ産品の輸入禁止が発効し、消費者信頼感は2014年以来の低水準と報じられています。",
      watch_ja: "米国の消費者信頼感の悪化が次の米国市場でどう受け止められるか、ドル円が157.12円近辺から動くかが確認点です。",
      closing_ja: "理由がはっきりしない上昇の日は、数字と材料を分けて並べておくと後で見返しやすいです。",
    },
    app_story: {
      summary_ja: "9月30日の東京市場は、日経平均とTOPIX連動ETF（1306）がそろって上昇して終えました。上昇の理由を説明するニュースは確認できておらず、値動きと材料を分けて整理します。",
      overseas_ja: "9月29日の米国市場は、NYダウが51,349.92（前日比−0.26%）、S&P500が7,670.84（前日比−0.17%）と下落しました。ナスダック総合は26,797.54（前日比−0.09%）とほぼ横ばいです。フィラデルフィア半導体株指数（SOX）は12,629.16（前日比+1.32%）と上昇しており、指数によって動きが分かれました。",
      japan_ja: "9月30日の東京市場は、日経平均が66,753.72（前日比+1.94%）、TOPIX連動ETF（1306）が431.5円（前日比+1.43%）と、主要な指標がそろって上昇しました。業種別の騰落は取得元がないため、どの業種が上げたかは確認できていません。上昇の理由を説明するニュースも確認できていません。",
      cross_asset_ja: "ドル円は9月29日時点で157.12円でした。米国10年債利回りは9月28日時点で5.24%です。WTI原油は9月22日時点の96.41ドルが最新で、新しい値は確認できていません。日本国債の利回りも8月31日時点の値です。",
      news_ja: "気象庁は「若干の海面変動」とする津波予報を発表しました。津波警報・注意報ではありません。米国では、カナダ産の輸入禁止が発効して関税の応酬が広がっており、消費者信頼感は9月に2014年以来の低水準になりました。朝鮮半島のDMZでは地雷の爆発があり、韓国軍の要員が負傷しています。これらと東京市場の上昇との関係は確認できていません。個別企業では、SBIグローバルAMとSBIインシュアランスが経営統合で基本合意しました。",
      strong_ja: "",
      caution_ja: "米国では消費者信頼感が大きく悪化しており、商品やサービスの値上がりが理由に挙げられています。米国とカナダの関税の応酬も続いています。原油は9月22日時点の値までしか確認できていません。",
      watch_ja: "次の米国市場で消費者信頼感の悪化がどう受け止められるか、関税をめぐる続報が出るかが確認点です。東京市場では、今日の上昇が次の取引日も続くかを見ていきます。",
    },
  };
}

/** 2026-10-01 morning: Tokyo up on 9/30 (previous session), US mixed on 9/30. */
export function richMorning1001(input: AnalysisInput): GeneratedAnalysis {
  const accord = refOf(input, (headline) => headline.includes("AI企業と自主協定"));
  const steel = refOf(input, (headline) => headline.includes("鉄鋼過剰生産能力"));
  const russia = refOf(input, (headline) => headline.includes("ウクライナのエネルギー施設"));
  const nidec = refOf(input, (headline, company) => !!company?.includes("ニデック") && headline.includes("減損損失"));
  return {
    headline_ja: "東京は前営業日に上昇、前夜の米国株はまちまち",
    market_summary_ja: "9月30日の東京市場は日経平均が66,753.72（前日比+1.94%）、TOPIX連動ETF（1306）が431.5円（前日比+1.43%）と上昇しました。9月30日の米国市場はNYダウが50,906.05（前日比−0.86%）、ナスダック総合が26,861.06（前日比+0.24%）とまちまちです。値動きの理由を説明するニュースは確認できません。",
    claims: [
      { claim_id: "c1", text_ja: "9月30日の日経平均は66,753.72（前日比+1.94%）でした。", claim_type: "observation", evidence_refs: ["metric:nikkei225"], scope: "today" },
      { claim_id: "c2", text_ja: "9月30日のTOPIX連動ETF（1306）は431.5円（前日比+1.43%）でした。", claim_type: "observation", evidence_refs: ["metric:topix_proxy_1306"], scope: "today" },
      { claim_id: "c3", text_ja: "9月30日の米国市場は、NYダウとS&P500が下落し、ナスダック総合は上昇しました。", claim_type: "observation", evidence_refs: ["metric:dow", "metric:sp500", "metric:nasdaq_composite"], scope: "overnight" },
      { claim_id: "c4", text_ja: "トランプ米大統領がAI企業と自主協定を発表しました。法的拘束力はないと報じられています。", claim_type: "observation", evidence_refs: [accord], scope: "overnight" },
      { claim_id: "c5", text_ja: "9月30日の東京市場の上昇と米国市場のまちまちな動きは同時期に確認できますが、因果関係は確認できません。", claim_type: "consistent_with", evidence_refs: ["metric:nikkei225", "metric:dow"], scope: "overnight" },
      { claim_id: "c6", text_ja: "東京市場が上昇した理由は、入力のニュースからは確認できません。", claim_type: "insufficient_evidence", evidence_refs: [], scope: "today" },
      { claim_id: "c7", text_ja: "ドル円は9月30日時点で157.00円でした。今日の為替の動きが確認点です。", claim_type: "watch_point", evidence_refs: ["metric:usdjpy"], scope: "next" },
    ],
    key_news: [
      { ref: nidec, why_it_matters_ja: "減損損失などの計上に関する開示です。" },
      { ref: accord, why_it_matters_ja: "AI企業の安全対策に関わる自主協定です。" },
      { ref: steel, why_it_matters_ja: "鉄鋼の過剰生産能力への共同対応の枠組みです。" },
      { ref: russia, why_it_matters_ja: "エネルギー施設への攻撃で、地政学の材料です。" },
    ],
    strong_themes: [],
    weak_themes: [],
    next_watch_ja: ["米国の主要3指数がそろって方向を出すか", "ドル円の水準", "AI関連の規制をめぐる続報"],
    risks_ja: ["米国株の方向がそろっていない点", "エネルギー施設への攻撃など地政学の動き"],
    x_post: {
      lead_ja: "前営業日の東京市場は上昇、前夜の米国株はまちまちでした📊",
      points_ja: [
        "9月30日の日経平均は66,753.72（前日比+1.94%）📈",
        "9月30日の米国はNYダウ−0.86%、ナスダック総合+0.24%",
        "トランプ米大統領がAI企業と自主協定を発表",
      ],
      context_ja: "9月30日の東京市場では、TOPIX連動ETF（1306）も431.5円（前日比+1.43%）と上げました。一方、9月30日の米国市場はNYダウとS&P500が下落し、ナスダック総合は上昇と方向が分かれています。上昇の理由は確認できていません。",
      news_ja: "米国ではトランプ大統領がAI企業と安全対策の自主協定を発表し、鉄鋼の過剰生産能力をめぐる共同枠組みでも合意がありました。ロシアによるウクライナのエネルギー施設への攻撃も報じられています。",
      watch_ja: "米国株の方向がそろうか、ドル円が157.00円近辺から動くか、AI規制の続報が出るかを見ていきます。",
      closing_ja: "指数の方向が分かれた日は、どの材料がどの市場の話かを分けて見ると整理しやすいです。",
    },
    app_story: {
      summary_ja: "前営業日の東京市場は上昇して終え、前夜の米国市場は指数によって方向が分かれました。値動きの理由ははっきりせず、今日は為替と米国の政策ニュースの続報が確認点です。",
      overseas_ja: "9月30日の米国市場は、NYダウが50,906.05（前日比−0.86%）、S&P500が7,651.54（前日比−0.25%）と下げた一方、ナスダック総合は26,861.06（前日比+0.24%）と小幅に上昇しました。主要3指数の方向はそろっていません。フィラデルフィア半導体株指数（SOX）は12,628.62（前日比±0.00%）でした。",
      japan_ja: "9月30日の東京市場は、日経平均が66,753.72（前日比+1.94%）、TOPIX連動ETF（1306）が431.5円（前日比+1.43%）とそろって上昇しました。今日の東京市場がこの流れを保つかどうかは、前夜の米国株の方向が分かれているため見通しにくい状況です。上昇の理由を説明するニュースは確認できていません。",
      cross_asset_ja: "ドル円は9月30日時点で157.00円でした。米国10年債利回りは9月29日時点で5.26%、WTI原油は9月29日時点で96.16ドルです。日本国債の利回りは8月31日時点の値しかなく、最新の水準は確認できていません。",
      news_ja: "米国では、トランプ大統領がAI企業の幹部と会い、安全対策の内部整備を求める自主協定を発表しました。法的拘束力はないと報じられています。鉄鋼の過剰生産能力をめぐる世界フォーラムでは、共同対応の枠組みで合意がありました。ロシアはウクライナのエネルギー施設を攻撃し、シリアではガス管の爆発があり発電所が停止しています。これらと東京市場の値動きとの関係は確認できていません。個別企業では、ニデックが減損損失などの計上を発表しました。",
      strong_ja: "",
      caution_ja: "米国の主要3指数は方向がそろっておらず、指数だけでは地合いを判断しにくい状況です。エネルギー施設への攻撃など地政学のニュースが続いており、原油の最新の値は9月29日時点までしか確認できていません。",
      watch_ja: "今日は、米国株の方向がそろうか、ドル円が157.00円近辺からどちらに動くかが確認点です。AI企業との自主協定や鉄鋼の枠組みについて、具体的な運用の続報が出るかも見ていきます。",
    },
  };
}
