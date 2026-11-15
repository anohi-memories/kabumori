# news_body_extraction (Phase 6, offline)

Pure, side-effect-free extraction helpers for the official-document bodies that reach the importance judgement.
Nothing here is imported by any Edge Function yet; production integration is a separate, reviewed step.

| module | purpose | finding it addresses |
|---|---|---|
| `kessan_tanshin_facts.ts` | reads the 経営成績 / 業績予想 tables of a 決算短信 (current vs prior row, units, sign, basis), fail-closed | the keyword-line summary dropped the current-period row (0 of 52 real tables kept it) |
| `boj_document_text.ts` | URL classification, CJK-space normalisation, quality verdict for BOJ PDF / HTML text | BOJ RSS descriptions are empty (77 of 77): the document behind the link was never read |
| `fomc_statement_facts.ts` | decision, change size, target range and vote from the official statement page | `press_monetary.xml` items are title-only |
| `body_quality.ts` | shared "is this a body?" gate (empty / garbled / not Japanese / too short) | an empty body must never be passed on as the document |

Rights: no module fetches or stores anything. BOJ: prior consultation is required for commercial reproduction, so
fetching BOJ document text must wait for that confirmation. Test fixtures are synthetic (fictional names and figures).

## Release switches (PR #129 / R5) — both default OFF

| env (Edge Function `important-news-monitor`) | ON value | what it enables | OFF behaviour |
|---|---|---|---|
| `IMPORTANT_NEWS_FED_STATEMENT_BODY_ENRICHMENT` | `enabled` | reads the official FOMC **statement** page for statement items of the Fed feed, stores the facts as the body, and fills the body of a stored, still-unjudged statement without one | Fed feed handled exactly as before PR #129 (headline-only; no extra read, fetch or write) |
| `IMPORTANT_NEWS_TDNET_KESSAN_FACTS` | `enabled` | 決算短信 table facts first in the TDnet PDF body | the unchanged keyword summary (same PDF fetch, limits and failures) |

- Only the exact value `enabled` turns a switch on; unset / empty / `true` / typo / `disabled` are OFF (fail closed).
- The switches are independent; neither touches the BOJ path (not connected), other macro / JP official / breaking lanes.
- Turning a switch OFF returns to the previous behaviour: the FOMC decision is again judged from the headline only and the
  決算短信 body is again the keyword excerpt — missed-news risk and the old number ambiguity are back, they do not vanish.
- The value is an Edge Function secret/environment variable: it takes effect on the deployed function only after it is
  set in the project's function environment (`supabase secrets set NAME=enabled`, then the function picks it up on its
  next start; setting secrets bumps all function versions — verify by readback). Nothing in this repository sets it.
