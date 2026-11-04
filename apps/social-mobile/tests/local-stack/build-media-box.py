"""G1 TASK 43: builds the media box runner from G5's own local runner (supabase/tests/postona_personal_workspace_local_run.sh, PR #638),
read from this tree and changed in three places only, each checked:
  1. its own project and ports (g1mb, 563xx), so it never meets a G5 run (g5ls, 557xx) on the same machine;
  2. the last step: instead of G5's deno suites, G1's apps/social-mobile/tests/local-stack/media-box.e2e.mjs (node, the app's screen);
  3. an optional hold (G1MB_AFTER) while the stack is up, for a Simulator check.
Everything else -- the world it builds, the images it refuses to pull, the clean-up -- is G5's, byte for byte.
Usage: build-media-box.py <repo> <out.sh>"""
import re
import sys

repo, out = sys.argv[1:]
src = open(f"{repo}/supabase/tests/postona_personal_workspace_local_run.sh", encoding="utf-8").read()

def once(text, old, new):
    assert text.count(old) == 1, (old, text.count(old))
    return text.replace(old, new)

s = src
s = once(s, 'API_PORT=55721 DB_PORT=55722 FAKE_PORT=55799', 'API_PORT=56321 DB_PORT=56322 FAKE_PORT=56399')
s = once(s, 'for old, new in [("54321", "55721"), ("54322", "55722"), ("54320", "55720"), ("54329", "55729"), ("54323", "55723"), ("54324", "55724"), ("54327", "55727")]:',
         'for old, new in [("54321", "56321"), ("54322", "56322"), ("54320", "56320"), ("54329", "56329"), ("54323", "56323"), ("54324", "56324"), ("54327", "56327")]:')
assert s.count('"g5ls"') == 2, s.count('"g5ls"')
s = s.replace('"g5ls"', '"g1mb"')
s = once(s, 'mktemp -d "${TMPDIR:-/tmp}/g5ls.XXXXXX"', 'mktemp -d "${TMPDIR:-/tmp}/g1mb.XXXXXX"')
assert not re.search(r"557\d\d", s), "a G5 port is left"

start = s.index('env -u ANTHROPIC_API_KEY')
tail = s[start:]
assert tail.rstrip().endswith('"$REPO/supabase/tests/postona_personal_workspace_local_test.ts" "$REPO/supabase/tests/postona_personal_media_box_local_test.ts"'), tail[-200:]
s = s[:start] + '''# ---- G1 TASK 43: the app's media box screen on this stack (build-media-box.py replaced G5's deno suites here) ----------------------------
export G1MB_API="http://127.0.0.1:$API_PORT" G1MB_PUBLISHABLE="$PUBLISHABLE" G1MB_DB_PORT="$DB_PORT"
export G1MB_MVP="$REPO/supabase/candidates/postona_personal_mvp_auth" G1MB_MEDIA="$REPO/supabase/candidates/postona_personal_media_box"
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u OPENAI_API_KEY \\
  node --test --test-concurrency=1 "$REPO/apps/social-mobile/tests/local-stack/media-box.e2e.mjs"
if [ -n "${G1MB_AFTER:-}" ]; then "$G1MB_AFTER"; fi
'''
open(out, "w", encoding="utf-8").write(s)
print("built", out)
