#!/usr/bin/env bash
# READ-ONLY production inventory for the POSTONA X autopost Stage 3B readiness (G3, 2026-10-10).
# Runs only with the explicit argument --production-read-only. Nothing is written, applied or deployed:
#   1. prod_catalog.sql inside BEGIN TRANSACTION READ ONLY (catalog facts and aggregate counts only);
#   2. the Edge function list, and the DEPLOYED x-test-post source downloaded into $READY_OUT (never into the
#      repository) to see whether the Stage 3B generic brand_post route is already live;
#   3. Edge secret NAMES only (values/digests are dropped in the pipe, never stored).
# The DB password is asked once, kept in a non-exported variable and given only to psql's environment.
# Usage: READY_OUT=<dir> bash prod_catalog.sh --production-read-only
set -euo pipefail
[[ "${1:-}" == "--production-read-only" ]] || { echo "REFUSED: pass --production-read-only explicitly" >&2; exit 2; }
[[ -n "${READY_OUT:-}" ]] || { echo "REFUSED: set READY_OUT" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
REF="wsmznyzcvmuitkglfeuj"
mkdir -p "$READY_OUT"

read -r -s -p "Supabase DB password (input hidden): " PW </dev/tty
printf '\n'
[[ -n "$PW" ]] || { echo "REFUSED: empty password" >&2; exit 2; }

echo "1/3 catalog (read-only transaction)"
PGPASSWORD="$PW" psql -X -q -v ON_ERROR_STOP=1 -A -t \
  "host=aws-0-ap-northeast-1.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require" \
  -c "begin transaction read only" -f "$HERE/prod_catalog.sql" -c "rollback" > "$READY_OUT/catalog.json"
PW=""
python3 -c "import json,sys; v=json.load(open(sys.argv[1])); assert v['transaction_read_only']=='on'; print('  OK read-only, keys', len(v))" "$READY_OUT/catalog.json"

echo "2/3 Edge functions + deployed x-test-post route"
supabase functions list --project-ref "$REF" --output-format json > "$READY_OUT/functions.json" 2> "$READY_OUT/functions.err"
rm -rf "$READY_OUT/dl"; mkdir -p "$READY_OUT/dl/supabase"
printf 'project_id = "%s"\n' "$REF" > "$READY_OUT/dl/supabase/config.toml"
supabase functions download x-test-post --project-ref "$REF" --use-api --workdir "$READY_OUT/dl" > "$READY_OUT/download.log" 2>&1
python3 - "$READY_OUT/dl/supabase/functions" "$REPO/supabase/functions" > "$READY_OUT/x_test_post_deployed.json" <<'PY'
import json, os, sys
deployed, source = sys.argv[1], sys.argv[2]
files = sorted(os.path.relpath(os.path.join(d, n), deployed) for d, _, ns in os.walk(deployed) for n in ns)
same = [f for f in files if os.path.exists(os.path.join(source, f)) and open(os.path.join(deployed, f), 'rb').read() == open(os.path.join(source, f), 'rb').read()]
index = open(os.path.join(deployed, 'x-test-post', 'index.ts'), encoding='utf-8').read() if 'x-test-post/index.ts' in files else ''
print(json.dumps({
  'files': len(files), 'identical_to_checkout': len(same), 'differs_or_missing_in_checkout': sorted(set(files) - set(same)),
  'has_generic_vault_brand_post_route': 'dispatchVaultAccountScheduledBrandPost' in index,
  'has_publish_authority_check': 'checkVaultAccountPublishAuthority' in index,
  'vault_account_brand_post_deployed': 'brand/vault_account_brand_post.ts' in ' '.join(files),
}, indent=1))
PY
echo "  OK"

echo "3/3 Edge secret names (values not read)"
supabase secrets list --project-ref "$REF" --output-format json 2> "$READY_OUT/secrets.err" | python3 -c "
import json, sys
raw = sys.stdin.read()
try:
    v = json.loads(raw)
except ValueError:
    v = []
if isinstance(v, dict):
    v = next((x for x in v.values() if isinstance(x, list)), [])
names = sorted({i.get('name') for i in v if isinstance(i, dict) and i.get('name')})
del raw, v
json.dump({'names': [n for n in names if n.startswith(('X_', 'OPENAI', 'SUPABASE_URL'))], 'total': len(names)}, open(sys.argv[1], 'w'), indent=1)
print('  OK', len(names), 'names')
" "$READY_OUT/secret_names.json"
echo "PROD_CATALOG_READ_ONLY_DONE (nothing was changed)"
