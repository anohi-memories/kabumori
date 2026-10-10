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
