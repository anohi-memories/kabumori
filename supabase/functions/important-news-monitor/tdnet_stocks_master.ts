import { type GenerationCandidate, stocksMasterRootCode } from "./post_generation_logic.ts";

// Read-only enrichment for TDnet generation candidates: attach stocks_master's official company name for the
// candidate's own securities code, which companyIdentityEvidence() accepts as one more spelling of the issuer
// (see post_generation_logic.ts).  Nothing is written, and every failure — lookup error, unknown code, odd
// row — leaves the candidate exactly as it was, so identity is then decided by the previous rules alone.
export type StocksMasterLookup = (
  rootCode: string,
) => Promise<{ tickerCode: string; companyName: string } | null>;

export async function withStocksMasterName(
  candidate: GenerationCandidate,
  lookup: StocksMasterLookup,
): Promise<GenerationCandidate> {
  // TDnet only: other sources carry no securities code of their own issuer, and never go through this.
  if (candidate.sourceType !== "tdnet" || candidate.sourceName !== "tdnet") return candidate;
  const root = stocksMasterRootCode(candidate.companyCode);
  if (root === null) return candidate;
  try {
    const master = await lookup(root);
    return master ? { ...candidate, stocksMaster: master } : candidate;
  } catch {
    return candidate;
  }
}

export function postgrestStocksMasterLookup(
  supabaseUrl: string,
  requestHeaders: Record<string, string>,
): StocksMasterLookup {
  return async (rootCode) => {
    const params = new URLSearchParams({ ticker_code: `eq.${rootCode}`, select: "ticker_code,company_name", limit: "1" });
    const result = await fetch(`${supabaseUrl}/rest/v1/stocks_master?${params}`, { headers: requestHeaders });
    if (!result.ok) return null;
    const rows = await result.json() as Array<{ ticker_code?: unknown; company_name?: unknown }>;
    const row = rows[0];
    return row && typeof row.ticker_code === "string" && typeof row.company_name === "string"
      ? { tickerCode: row.ticker_code, companyName: row.company_name }
      : null;
  };
}
