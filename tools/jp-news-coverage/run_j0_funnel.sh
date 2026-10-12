#!/bin/bash
# Phase J0: run the production READ-ONLY aggregate funnel query (one SELECT, one json document, no ids/urls/titles/users).
# Run it yourself in your own terminal; it writes the result next to this script.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ref="wsmznyzcvmuitkglfeuj"
out="$here/prod_readonly/j0_funnel_result.json"
supabase db query --linked --project-ref "$ref" --output-format json -f "$here/prod_readonly/j0_funnel_aggregate.sql" > "$out"
echo "wrote $out"
