#!/usr/bin/env bash
# Offline-only: native network denied, real provider credentials unset in this child process only.
# SDK0.132.1 reads TWO optional env defaults even with explicit API key/logLevel; scrub them,
# allow only these empty slots, never the live API key/Auth token/secret values.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_WEBHOOK_SIGNING_KEY \
 -u ANTHROPIC_CUSTOM_HEADERS -u OPENAI_API_KEY deno test --cached-only --config "$here/deno.json" \
 --allow-env=ANTHROPIC_WEBHOOK_SIGNING_KEY,ANTHROPIC_CUSTOM_HEADERS --allow-read="$here/../../..,$here/../../../../apps" "$here/bridge_test.ts" "$here/isolation_test.ts"
