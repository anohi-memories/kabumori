"""G5-32: static evidence check for docs/common-account/g5-32-personal-workspace-session-consumer-matrix.md.

Every path:line the document cites is read from the PINNED git object (`git show <sha>:<path>`), never from a working tree, and must contain
the stated token. Every "not implemented" claim the document makes about an absence is a whole-file / whole-tree search that must find nothing.
Read-only: no checkout, no network, no database. A failure means the document is stale or wrong, not that a product is broken. Usage:
  python3 supabase/tests/g5_32_consumer_contract_evidence_check.py <repository root with the pinned commits fetched>"""
import subprocess
import sys

repo = sys.argv[1] if len(sys.argv) > 1 else '.'

MAIN = '0c42933ca5030ab31a56267529430d0473d9b155'
G5S = '21a5cad4b71de63265db8517da93c6efc60cdde8'   # G5 stack head (PR #457): R1 001, R0 002, SV 003, W1
P494 = 'c9f726e9bea8dece62c12f6cfd7872890ae3b5ad'  # D1 R0 / R1 / SV strict is_anonymous (PR #494)
P489 = '1c3b16a75e9fe6230af913eb720376ab34566356'  # T13 + S2-1 (PR #489)
G4 = '85d3891a7587a7566579a793083f540952664fa6'    # G4-36 (PR #491)
G3 = 'f34aab9714f5d4f11388609262d5f64cdcce5ed9'    # G3 reservation candidates (PR #392)
G6 = 'e0bdad4dccb44ba59b3520c9ba154cad2809f0cb'    # G6-18 (PR #496)

V = 'supabase/candidates/common_account_authorization_verdict/'
XB = 'supabase/migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql'
XR = 'supabase/candidates/postona_x_reservations/'
TR = 'supabase/candidates/postona_threads_reservations/007_postona_threads_reservations.sql'
GW = 'supabase/ai_gateway/'

# (label, sha, path, line, token that line must contain)
LINES = [
    # ---- G5 (the gates)
    ('R0 derives the own workspace id', G5S, V + '002_bootstrap_verdict.sql', 157, "v_workspace := 'u_'"),
    ('R0 refuses a non-personal kind under the own id', G5S, V + '002_bootstrap_verdict.sql', 209, 'OWN_WORKSPACE_CONFLICT'),
    ('R0 refuses an own id owned by someone else', G5S, V + '002_bootstrap_verdict.sql', 211, 'OWN_WORKSPACE_CONFLICT'),
    ('R0: owner count of the own id not 1 -> unknown', G5S, V + '002_bootstrap_verdict.sql', 210, 'WORKSPACE_OWNER_UNKNOWN'),
    ('R1 refuses a non-personal workspace kind', G5S, V + '001_authorization_verdict.sql', 271, "'social_mobile_user_v1'"),
    ('R1 allow carries g5oe', G5S, V + '001_authorization_verdict.sql', 287, "'g5oe:'"),
    ('W1 compares the bound owner epoch', G5S, V + '001_authorization_verdict.sql', 330, 'v_epoch <> p_expected_owner_epoch'),
    ('SV install depends on the owner-epoch exposure helper', G5S, V + '003_session_verdict.sql', 46, 'account_lifecycle_owner_epoch_exposure'),
    ('SV answers revoked / expired', G5S, V + '003_session_verdict.sql', 130, "'SESSION_REVOKED'"),
    ('SV is owner-only', G5S, V + '003_session_verdict.sql', 133, 'revoke all on function private.account_lifecycle_session_verdict()'),
    ('D1: R1 reads only a JSON boolean', P494, 'supabase/candidates/postona_personal_auth/002_verdicts_anonymous_strict.sql', 175, "jsonb_typeof(v_claims -> 'is_anonymous') = 'boolean'"),
    ('D1: R1 passes only a proven false', P494, 'supabase/candidates/postona_personal_auth/002_verdicts_anonymous_strict.sql', 179, "v_anonymous = 'false'"),
    ('D1: SV passes only a proven false', P494, 'supabase/candidates/postona_personal_auth/002_verdicts_anonymous_strict.sql', 458, "v_anonymous = 'false'"),
    ('S2-1: T13 refuses anything but a proven false', P489, 'supabase/candidates/postona_personal_auth/001_t13_anonymous_refusal.sql', 126, "v_anonymous is distinct from 'false'"),
    # ---- main: the live X begin
    ('main X begin: auth.uid() only', MAIN, XB, 15, 'v_user_id uuid := auth.uid();'),
    ('main X begin: several owned brands refused', MAIN, XB, 31, 'SOCIAL_MOBILE_MULTIPLE_OWNED_BRANDS_UNSUPPORTED'),
    ('main X begin: zero owned -> creates u_<md5>', MAIN, XB, 39, "v_brand_id := 'u_' || substr(md5(v_user_id::text), 1, 24);"),
    ('main X begin: exactly one owned brand is reused, any kind', MAIN, XB, 34, 'if v_owner_brand_count = 1 then'),
    ('main X begin: an existing row under the derived id is kept', MAIN, XB, 42, 'on conflict (id) do nothing;'),
    ('main X begin: ... and the caller is added as its owner', MAIN, XB, 45, 'on conflict on constraint brand_memberships_pkey do nothing;'),
    # ---- G4 (PR #491)
    ('G4 X Edge: GoTrue user lookup', G4, 'supabase/functions/x-oauth-connect-user/oauth_logic.ts', 54, '/auth/v1/user'),
    ('G4 Threads: T13 first in begin', G4, 'supabase/candidates/postona_threads_oauth_workspace_candidate.sql', 191, 'account_lifecycle_assert_active_service_write'),
    ('G4 Threads: no API role may EXECUTE the candidate', G4, 'supabase/candidates/postona_threads_oauth_workspace_candidate.sql', 347, 'revoke'),
    ('G4 Threads: complete compares the bound epoch', G4, 'supabase/candidates/postona_threads_binding_epoch/001_threads_binding_epoch.sql', 280, 'THREADS_BINDING_OWNER_EPOCH_CHANGED'),
    ('G4 Threads: the T13 in the suite is a mock', G4, 'supabase/tests/postona_threads_oauth_mock_t13_fixture.sql', 7, 'auth.sessions'),
    # ---- G3 (PR #392)
    ('G3 Threads create: R1', G3, TR, 230, 'common_account_authorization_verdict'),
    ('G3 X Edge: only is_anonymous === true refused', G3, 'supabase/functions/_shared/postona_reservations/supabase_auth.ts', 60, 'is_anonymous'),
    ('G3 X single post: T13', G3, XR + '006_postona_x_single_post_live_fence.sql', 111, 'account_lifecycle_assert_active_service_write'),
    # ---- G6 (PR #496)
    ('G6 transport: exactly the 8 RPC keys', G6, GW + 'g5_rpc_transport.ts', 19, 'RPC_WIRE_KEYS'),
    ('G6 port: deny reason TOKEN', G6, GW + 'authority_port.ts', 54, 'TOKEN'),
    ('G6 port: g5oe shape', G6, GW + 'authority_port.ts', 57, 'g5oe'),
    ('G6 gateway: recheck before send', G6, GW + 'gateway.ts', 343, 'recheck'),
]

# (label, sha, path prefix, token): no file under the prefix may contain the token (case-sensitive)
ABSENT = [
    ('main X begin reads no is_anonymous', MAIN, XB, 'is_anonymous'),
    ('main X begin reads no auth.sessions', MAIN, XB, 'auth.sessions'),
    ('main X begin reads no entitlement', MAIN, XB, 'service_entitlements'),
    ('G4 X Edge reads no is_anonymous', G4, 'supabase/functions/x-oauth-connect-user/', 'is_anonymous'),
    ('G6 Gateway reads no is_anonymous', G6, GW, 'is_anonymous'),
    ('main has no G5 verdict RPC in migrations', MAIN, 'supabase/migrations/', 'common_account_authorization_verdict'),
    ('main has no session verdict in migrations', MAIN, 'supabase/migrations/', 'account_lifecycle_session_verdict'),
    ('main has no AI Gateway', MAIN, GW, ''),
    ('G3 Threads reservations call no session verdict', G3, TR, 'account_lifecycle_session_verdict'),
    ('G3 X reservations call no session verdict', G3, XR, 'account_lifecycle_session_verdict'),
    ('G3 X reservations carry no g5oe', G3, XR, 'g5oe'),
]


def git(*args):
    return subprocess.run(['git', '-C', repo, *args], capture_output=True, text=True)


failures = 0
for label, sha, path, line, token in LINES:
    out = git('show', f'{sha}:{path}')
    lines = out.stdout.split('\n') if out.returncode == 0 else []
    ok = len(lines) >= line and token in lines[line - 1]
    failures += 0 if ok else 1
    print(f'{"PASS" if ok else "FAIL"}  {label}  ({path}:{line} @ {sha[:8]})', flush=True)
for label, sha, prefix, token in ABSENT:
    names = [n for n in git('ls-tree', '-r', '--name-only', sha).stdout.split('\n') if n.startswith(prefix)]
    if token == '':
        ok = names == []
    else:
        ok = all(token not in git('show', f'{sha}:{n}').stdout for n in names) and git('cat-file', '-e', f'{sha}^{{commit}}').returncode == 0
    failures += 0 if ok else 1
    print(f'{"PASS" if ok else "FAIL"}  {label}  (absent under {prefix} @ {sha[:8]}, {len(names)} file(s))', flush=True)
# controls: the checker itself must be able to fail -- a token on the wrong line, and an "absent" token that is present
controls = [
    git('show', f'{G5S}:{V}002_bootstrap_verdict.sql').stdout.split('\n')[156].find('OWN_WORKSPACE_CONFLICT') < 0,
    'auth.uid()' in git('show', f'{MAIN}:{XB}').stdout,
]
print(f'{"PASS" if all(controls) else "FAIL"}  controls: a wrong line and a present token are both detected', flush=True)
failures += 0 if all(controls) else 1
total = len(LINES) + len(ABSENT) + 1
print(f'EVIDENCE  {total - failures}/{total} PASS', flush=True)
sys.exit(1 if failures else 0)
