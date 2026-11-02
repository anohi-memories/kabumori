#!/bin/bash
# G1 TASK 36: the disconnected-X check on G3's throw-away local runtime (real GoTrue -> Kong -> Edge twin -> Postgres, 127.0.0.1 only).
# Needs what G3's run.sh needs (docker or podman, supabase CLI, deno, psql). Run alone. Nothing here reaches a hosted project or X.
# G1T36_AFTER: optional command run with the runtime still up, after the tests (the Simulator check). G3's files are not edited.
here="$(cd "$(dirname "$0")" && pwd)"
tests="$(dirname "$here")"
tmp="$(mktemp -d)"
generated="$tests/zz-x-disconnected-manage.generated.mjs $tests/zz-x-disconnected-tab.generated.mjs"
cleanup() { rm -f $generated; rm -rf "$tmp"; }
trap cleanup EXIT
python3 "$here/build-x-disconnected.py" "$tmp" || exit 1
cat > "$tmp/inner.sh" <<EOF
#!/bin/bash
node --test --test-concurrency=1 $generated || exit 1
if [ -n "\${G1T36_AFTER:-}" ]; then "\$G1T36_AFTER" || exit 1; fi
echo G1T36_LOCAL_STACK_PASS
EOF
chmod +x "$tmp/inner.sh"
G1T36_RUN="$tmp/inner.sh" bash "$tmp/g1t36-run.sh"
