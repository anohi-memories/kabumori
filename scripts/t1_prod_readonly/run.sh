#!/bin/sh
# TDnet T1: read-only aggregate queries for the production workload (no row data, no writes).
# Usage: sh scripts/t1_prod_readonly/run.sh   (run in your own terminal; output goes to ./t1_out/)
set -eu
REF=wsmznyzcvmuitkglfeuj
DIR=$(cd "$(dirname "$0")" && pwd)
OUT=./t1_out
mkdir -p "$OUT"
for q in q_tdnet_daily q_tdnet_hourly q_runs q_ai_cost; do
  supabase db query --linked --project-ref "$REF" --output-format json -f "$DIR/$q.sql" > "$OUT/$q.json"
  echo "wrote $OUT/$q.json"
done
