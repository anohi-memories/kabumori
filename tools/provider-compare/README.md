# provider-compare — OpenAI / Claude comparison harness

Independent of production. Nothing under `supabase/`, `apps/` or `src/` imports it, it is not inside
`supabase/functions` (so no Edge Function deploy can ship it), and it has no Supabase / X / Push / publishing surface
(`src/isolation_test.ts` enforces all of this). It only **reads** production's pure request builders to obtain the exact
prompts and schemas production sends.

## What it compares

| Task | Production step it copies | Production model |
|---|---|---|
| `judgement_primary` | first-pass importance judgement | gpt-6-luna, effort low |
| `judgement_detail` | escalation judgement (with the Luna preliminary) | gpt-6-sol, effort medium |
| `generation_draft` | news post draft | gpt-6-luna |
| `generation_fact` | Fact check of the stored post | gpt-6-luna |
| `generation_voice` | Voice check of the stored post | gpt-6-luna |
| `web_search` | the four daily generic search topics | gpt-5.6-luna + web_search |

The OpenAI side of every task production already ran is **replayed from the stored result** (`recorded`), so no OpenAI
call is repeated. Cases: `fixtures/cases.json` (22 real candidates: BOJ, FX, geopolitics, North Korea, domestic incidents,
an FSA action, TDnet earnings / capital / governance, generation failures, a known miss, negative controls).

## Modes (default is `dry-run`)

```
deno run --no-config --allow-read --allow-env --allow-net \
  tools/provider-compare/src/cli.ts --mode dry-run \
  --providers "anthropic:claude-haiku-5-5@effort=low,thinking=off;anthropic:claude-sonnet-5-5@effort=medium"
```

| Mode | Network | Key | Output |
|---|---|---|---|
| `dry-run` | none (works without `--allow-net`) | none | estimated tokens / cost per task and provider + the monthly scenario table |
| `mock` | none | none | full pipeline with scripted providers (plumbing check; the "Claude" mock mirrors production) |
| `live` | yes, **paid** | yes | real calls, results scored against the recorded production answer |

`live` refuses to start unless **all** of these hold: `PROVIDER_COMPARE_ALLOW_PAID=1`, `--max-calls N`, `--max-usd X`, and a
key (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, or a macOS Keychain item named with `--keychain-anthropic <service>`). Every
HTTP attempt, retries included, is counted; the run stops with `stoppedBy=BUDGET_...` and keeps the results so far.
Keys are only ever handed to a provider constructor: they are never printed, logged or written (a result that contains one
makes the run throw).

## Zero-cost preflight

```
deno run --no-config --allow-read --allow-env --allow-net=api.anthropic.com --allow-run=security \
  tools/provider-compare/src/probe_cli.ts --keychain-anthropic <service> --out probe.json
```

Uses only `GET /v1/models` and `POST /v1/messages/count_tokens` (both free per the docs, rate limited). It shows whether the
key works, which models the organization sees, whether each accepts web search / structured outputs / `thinking: disabled`,
and how many tokens the real prompts take on Claude (the tokenizer assumption in the cost simulation).

## Suggested first live run (needs the owner's approval of the budget)

| Step | What | Models | Calls | Estimated cost | Suggested caps |
|---|---|---|---|---|---|
| L0 | `probe_cli.ts` | — | ~300 free | $0 | — |
| L1 | smoke: 3 cases of `judgement_primary` | haiku (thinking off), sonnet (medium) | 6 | ~$0.04 | `--max-calls 12 --max-usd 0.10` |
| L2 | `judgement_primary,judgement_detail` on all 22 cases | haiku, sonnet | 88 | ~$0.55 | `--max-calls 120 --max-usd 1.00` |
| L3 | `generation_draft,generation_fact,generation_voice` | haiku, sonnet | 114 | ~$0.80 | `--max-calls 150 --max-usd 1.50` |
| L4 | `web_search` (4 topics) | sonnet (haiku if the probe says it supports search) | 4–8 | ~$0.25 | `--max-calls 12 --max-usd 0.50` |
| optional | the same with `claude-opus-5-5@effort=medium` | opus | +105 | ~$3.3 | separate approval |

Estimates come from `src/estimate.ts` and rest on UNMEASURED thinking-overhead assumptions; L1 replaces them with measured
usage before anything larger runs.

## Rebuilding the fixtures

`scripts/export_cases.sql` is a read-only SELECT; `scripts/build_cases.ts` reshapes and sanitises its JSON-lines output
(contact lines, emails and phone numbers are removed; bodies are capped at 1,800 characters).

## Tests

```
deno test --no-config -A tools/provider-compare/src
```
