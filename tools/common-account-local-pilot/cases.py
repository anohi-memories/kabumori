"""Cases of the G5 local OSS pilot (Phase 3h). Usage: cases.py <boot> where boot is A, A9, B or C (see the runbook)."""
import json
import sys
import threading
import time
from datetime import datetime, timezone

sys.path.insert(0, __import__('os').path.dirname(__file__))
from core import *  # noqa: F401,F403

RESULTS = []
RUN = datetime.now(timezone.utc).strftime('%H%M%S')


def record(case, exp, name, setup, expected, observed, result, limits=''):
    RESULTS.append({'case': case, 'exp': exp, 'name': name, 'setup': setup, 'expected': expected,
                    'observed': observed, 'result': result, 'limits': limits})
    print(f'[{result}] {case} {name}: {observed}', flush=True)


def fresh_email(tag):
    return f'p3h.{tag}.{RUN}@example.test'


def kc_signin(kc_user, expect_code=True):
    """Full PKCE login through Keycloak as a fake user; returns (redirect params, verifier)."""
    verifier, loc = start_oauth()
    kc = KeycloakLogin(kc_user)
    kc.open(loc)
    return parse_redirect(kc.submit()), verifier


def cleanup_users(prefixes=('p3h.',)):
    for r in sql("select id from auth.users where email like 'p3h.%'"):
        admin('DELETE', f'/auth/v1/admin/users/{r[0]}')


def setup_sql():
    sql("""create table if not exists public.p3h_notes (id bigserial primary key, user_id uuid not null default auth.uid(), body text);
alter table public.p3h_notes enable row level security;
grant select, insert on public.p3h_notes to authenticated;
grant usage, select on sequence public.p3h_notes_id_seq to authenticated;
drop policy if exists p3h_notes_insert on public.p3h_notes;
create policy p3h_notes_insert on public.p3h_notes for insert to authenticated with check (user_id = auth.uid());
drop policy if exists p3h_notes_select on public.p3h_notes;
create policy p3h_notes_select on public.p3h_notes for select to authenticated using (user_id = auth.uid());
create table if not exists public.p3h_state (user_id uuid primary key, state text not null);
insert into storage.buckets (id, name, public) values ('p3h-fake', 'p3h-fake', false) on conflict (id) do nothing;
drop policy if exists p3h_fake_insert on storage.objects;
create policy p3h_fake_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'p3h-fake' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists p3h_fake_select on storage.objects;
create policy p3h_fake_select on storage.objects for select to authenticated
  using (bucket_id = 'p3h-fake' and (storage.foldername(name))[1] = auth.uid()::text);""")


def versions():
    st, js = api('GET', '/auth/v1/health')
    env = subprocess.run(PODMAN + ['exec', 'supabase_auth_g5-p3h', 'env'], capture_output=True, text=True).stdout
    allow = ('GOTRUE_SECURITY_MANUAL_LINKING_ENABLED', 'GOTRUE_JWT_EXP', 'GOTRUE_EXTERNAL_KEYCLOAK_ENABLED', 'GOTRUE_EXTERNAL_KEYCLOAK_URL',
             'GOTRUE_MAILER_AUTOCONFIRM', 'GOTRUE_EXTERNAL_EMAIL_ENABLED', 'GOTRUE_DISABLE_SIGNUP', 'GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED',
             'GOTRUE_SESSIONS_TIMEBOX', 'GOTRUE_SESSIONS_INACTIVITY_TIMEOUT', 'API_EXTERNAL_URL')
    cfg = {}
    for line in env.splitlines():
        k, _, v = line.partition('=')
        if k in allow:
            cfg[k] = v
    return js.get('version'), cfg


def case_c0():
    version, cfg = versions()
    images = subprocess.run(PODMAN + ['ps', '--format', '{{.Names}} {{.Image}}'], capture_output=True, text=True).stdout.split('\n')
    pg = sql_scalar('select version()').split(',')[0]
    audit_on = sql_scalar("select count(*) from information_schema.tables where table_schema='auth' and table_name='audit_log_entries'")
    record('C0', 'E1-local', 'environment fingerprint',
           'local stack from Supabase CLI 2.116 on the isolated Podman machine; Keycloak 26.8.0',
           'versions and non-secret config recorded', f'GoTrue {version}; {pg}; config {json.dumps(cfg, sort_keys=True)}; audit table present={audit_on}; images ' +
           '; '.join(i.split(' ')[1].split('/')[-1] for i in images if i), 'PARTIAL',
           'LOCAL_OSS_EVIDENCE: the OSS stack is not the managed service; managed version/config unknown')


def case_c1_c2():
    # C1 control: automatic link by the same verified e-mail, user not banned.
    email = 'p3h.user1@example.test'
    uid, pw = create_user(email)
    params, verifier = kc_signin('kc-user-1')
    linked = ''
    if 'code' in params:
        st, js = exchange(params['code'], verifier)
        linked = f'exchange {st}; same user={js.get("user", {}).get("id") == uid}'
    record('C1', 'E2-control', 'automatic link, user not banned', 'Supabase user with verified e-mail X; Keycloak fake user with the same verified e-mail',
           'Keycloak identity is linked to the existing user', f'{linked}; providers={providers(uid)}',
           'PASS' if providers(uid) == 'email,keycloak' else 'FAIL')
    admin('DELETE', f'/auth/v1/admin/users/{uid}')

    # C2: ban first, then the same sign-in.
    email2 = 'p3h.user2@example.test'
    uid2, pw2 = create_user(email2)
    ban(uid2)
    before_users = int(sql_scalar('select count(*) from auth.users'))
    params, verifier = kc_signin('kc-user-2')
    after_users = int(sql_scalar('select count(*) from auth.users'))
    ident = providers(uid2)
    ok = params.get('error_code') in ('user_banned',) or 'error' in params
    record('C2', 'E2', 'automatic link attempt for a BANNED user', 'banned Supabase user (24h); Keycloak fake user with the same verified e-mail',
           '403 user_banned; no identity row; no new user; no session',
           f'redirect {sorted(params)} error_code={params.get("error_code")}; providers={ident}; users {before_users}->{after_users}; sessions={counts(uid2)["sessions"]}',
           'PASS' if ok and ident == 'email' and before_users == after_users else 'FAIL',
           'one banned user, no concurrency: the in-flight window is E4/E6')
    admin('DELETE', f'/auth/v1/admin/users/{uid2}')


def case_c3_default_disabled():
    email = fresh_email('c3')
    uid, pw = create_user(email)
    st, js = sign_in(email, pw)
    status, verifier, body = start_link(js['access_token'])
    record('C3', 'E3-default', 'manual linking is disabled by default', 'CLI default enable_manual_linking=false; signed-in user calls /user/identities/authorize',
           'the endpoint refuses (manual linking disabled)', f'status {status} code={body.get("error_code") or body.get("code")} msg={str(body.get("msg") or body.get("message"))[:70]}',
           'PASS' if status in (400, 403, 404, 422) and 'url' not in body else 'FAIL')
    admin('DELETE', f'/auth/v1/admin/users/{uid}')


def case_c8_e5():
    # Ban vs refresh / password grant / logout; ordering revoke -> ban.
    email = fresh_email('c8a')
    uid, pw = create_user(email)
    st, s1 = sign_in(email, pw)
    access, refresh = s1['access_token'], s1['refresh_token']
    ban(uid)
    st_ref, js_ref = api('POST', '/auth/v1/token?grant_type=refresh_token', {'refresh_token': refresh})
    st_pw, js_pw = sign_in(email, pw)
    st_lo, js_lo = api('POST', '/auth/v1/logout?scope=global', token=access)
    st_user, js_user = api('GET', '/auth/v1/user', token=access)
    record('C8a', 'E5', 'banned user: refresh, password grant, logout, GET /user with the pre-ban access token',
           'user signed in, then Admin ban', 'refresh 400 user_banned; password grant refused; logout refused; GET /user 403',
           f'refresh {st_ref}/{js_ref.get("error_code")}; password {st_pw}/{js_pw.get("error_code")}; logout {st_lo}/{js_lo.get("error_code")}; GET /user {st_user}/{js_user.get("error_code")}',
           'PASS' if (st_ref == 400 and st_pw in (400, 403) and st_lo == 403 and st_user == 403) else 'PARTIAL',
           'GoTrue v2.196.0 only (>= v2.195.0 behaviour)')
    admin('DELETE', f'/auth/v1/admin/users/{uid}')

    email = fresh_email('c8b')
    uid, pw = create_user(email)
    st, s1 = sign_in(email, pw)
    access, refresh = s1['access_token'], s1['refresh_token']
    st_lo, _ = api('POST', '/auth/v1/logout?scope=global', token=access)
    sess_after_logout = counts(uid)['sessions']
    ban(uid)
    st_ref, js_ref = api('POST', '/auth/v1/token?grant_type=refresh_token', {'refresh_token': refresh})
    record('C8b', 'E5', 'revoke (global logout) BEFORE the ban', 'logout?scope=global with a valid token, then Admin ban',
           'logout 204, no sessions, refresh refused', f'logout {st_lo}; sessions after logout={sess_after_logout}; refresh {st_ref}/{js_ref.get("error_code")}',
           'PASS' if st_lo == 204 and sess_after_logout == 0 and st_ref >= 400 else 'FAIL')
    admin('DELETE', f'/auth/v1/admin/users/{uid}')

    # ID-token grant with a Keycloak ID token (direct access grant), unbanned control and banned user.
    def kc_id_token(user):
        body = urllib.parse.urlencode({'grant_type': 'password', 'client_id': 'g5-pilot',
                                       'client_secret': (WORK / 'env.keycloak').read_text().split('=', 1)[1].strip(),
                                       'username': user, 'password': PASSWORDS[user], 'scope': 'openid email profile'}).encode()
        status, hdrs, data, _ = Net().request('POST', 'http://keycloak:8080/realms/g5test/protocol/openid-connect/token',
                                              {'Content-Type': 'application/x-www-form-urlencoded'}, body)
        return json.loads(data).get('id_token')

    tok = kc_id_token('kc-user-5')
    st_id, js_id = api('POST', '/auth/v1/token?grant_type=id_token', {'provider': 'keycloak', 'id_token': tok})
    new_uid = js_id.get('user', {}).get('id') if st_id == 200 else None
    record('C8c', 'E5', 'ID-token grant, control (not banned)', 'Keycloak ID token of a fake user, provider=keycloak',
           'sign-in succeeds', f'status {st_id} code={js_id.get("error_code") or js_id.get("code")} msg={str(js_id.get("msg") or "")[:80]}',
           'PASS' if st_id == 200 else 'FAIL' if st_id >= 500 else 'BLOCKED',
           'if refused for a configuration reason (audience/issuer) the banned half is NOT_RUN')
    if new_uid:
        ban(new_uid)
        tok2 = kc_id_token('kc-user-5')
        st2, js2 = api('POST', '/auth/v1/token?grant_type=id_token', {'provider': 'keycloak', 'id_token': tok2})
        record('C8d', 'E5', 'ID-token grant for a banned user', 'the same Keycloak fake user after Admin ban', '403 user_banned',
               f'status {st2} code={js2.get("error_code")}', 'PASS' if st2 in (400, 403) else 'FAIL')
        admin('DELETE', f'/auth/v1/admin/users/{new_uid}')
    else:
        record('C8d', 'E5', 'ID-token grant for a banned user', 'needs C8c', '403 user_banned', 'not run (C8c did not sign in)', 'NOT_RUN')


def case_c9_e8_e10():
    email = fresh_email('c9')
    uid, pw = create_user(email)
    # The Keycloak identity is linked by the same verified e-mail, so this case uses kc-user-6's e-mail.
    uid_k, pw_k = create_user('p3h.user6@example.test')
    params, verifier = kc_signin('kc-user-6')
    st, js = exchange(params['code'], verifier) if 'code' in params else (0, {})
    s2 = [sign_in('p3h.user6@example.test', pw_k) for _ in range(2)]
    ident_ids = [r[0] for r in sql(f"select id from auth.identities where user_id='{uid_k}'")]
    sess_ids = [r[0] for r in sql(f"select id from auth.sessions where user_id='{uid_k}'")]
    rt_ids = [r[0] for r in sql(f"select id from auth.refresh_tokens where user_id='{uid_k}'")]
    before = counts(uid_k)
    linked_before = audit_count('identity_linked', uid_k)
    st_del, _ = admin('DELETE', f'/auth/v1/admin/users/{uid_k}')
    after_by_user = counts(uid_k)
    ident_left = int(sql_scalar("select count(*) from auth.identities where id in (" + ','.join(f"'{i}'" for i in ident_ids) + ")")) if ident_ids else -1
    sess_left = int(sql_scalar("select count(*) from auth.sessions where id in (" + ','.join(f"'{i}'" for i in sess_ids) + ")")) if sess_ids else -1
    rt_left = int(sql_scalar("select count(*) from auth.refresh_tokens where id in (" + ','.join(str(i) for i in rt_ids) + ")")) if rt_ids else -1
    deleted_audit = audit_count('user_deleted', uid_k)
    linked_after = audit_count('identity_linked', uid_k)
    record('C9', 'E8', 'Admin hard delete cascade (auth tables)', 'user with 2 identities, 3 sessions, refresh tokens; Admin DELETE; read-back by captured ids',
           'all child rows gone', f'before {before}; ids captured identities={len(ident_ids)} sessions={len(sess_ids)} refresh={len(rt_ids)}; delete {st_del}; after by user {after_by_user}; left by id identities={ident_left} sessions={sess_left} refresh={rt_left}',
           'PASS' if st_del == 200 and ident_left == 0 and sess_left == 0 and rt_left == 0 and after_by_user['users'] == 0 else 'FAIL',
           'auth schema only; the lifecycle layer (Phase 1-3a) was not applied here')
    record('C10', 'E10', 'audit log after the Admin delete', 'identity_linked audit rows counted before and after the delete; user_deleted row looked up by user id',
           'identity_linked rows persist; a user_deleted row exists', f'identity_linked before={linked_before} after={linked_after}; user_deleted rows={deleted_audit}',
           'PASS' if linked_after == linked_before and linked_before >= 1 and deleted_audit >= 1 else 'PARTIAL',
           'GOTRUE_AUDIT default writes to Postgres in this stack; the managed setting is unknown')
    admin('DELETE', f'/auth/v1/admin/users/{uid}')



def upload(token, uid, name):
    body = f'p3h fake object {name}'.encode()
    headers = {'apikey': ANON, 'Authorization': f'Bearer {token}', 'Content-Type': 'text/plain', 'x-upsert': 'true'}
    status, hdrs, data, _ = Net().request('POST', f'http://127.0.0.1:55421/storage/v1/object/p3h-fake/{uid}/{name}', headers, body)
    return status


def blob_count(uid):
    out = subprocess.run(PODMAN + ['exec', 'supabase_storage_g5-p3h', 'sh', '-c', f"find /mnt -type f -path '*p3h-fake/{uid}/*' | wc -l"], capture_output=True, text=True)
    return int(out.stdout.strip() or 0)


def probe(token, uid, tag):
    pr = api('POST', '/rest/v1/p3h_notes', {'body': tag}, token=token, extra={'Prefer': 'return=minimal'})[0]
    st = upload(token, uid, f'{tag}.txt')
    au = api('GET', '/auth/v1/user', token=token)[0]
    return {'postgrest': pr, 'storage': st, 'auth_user': au}


def case_e9():
    states = {}
    for state in ('live', 'logout', 'ban', 'delete'):
        email = fresh_email('e9' + state)
        uid, pw = create_user(email)
        st, s = sign_in(email, pw)
        states[state] = {'uid': uid, 'access': s['access_token'], 'issued': time.time()}
    # the "delete" user owns one object before deletion (does an owned object block the Admin delete?)
    d = states['delete']
    pre_up = upload(d['access'], d['uid'], 'owned-before-delete.txt')
    api('POST', '/auth/v1/logout?scope=global', token=states['logout']['access'])
    ban(states['ban']['uid'])
    del_status, del_js = admin('DELETE', f"/auth/v1/admin/users/{d['uid']}")
    users_left = int(sql_scalar(f"select count(*) from auth.users where id = '{d['uid']}'"))
    owned_rows = int(sql_scalar(f"select count(*) from storage.objects where bucket_id = 'p3h-fake' and owner_id = '{d['uid']}'"))
    record('C11', 'E8/E9', 'Admin delete of a user that OWNS a Storage object', 'user uploaded one object, then Admin DELETE',
           'delete succeeds (storage.objects has no FK to auth.users) and the object remains',
           f'upload {pre_up}; delete {del_status}; auth.users left={users_left}; storage metadata rows with owner_id={owned_rows}; physical files={blob_count(d["uid"])}',
           'PASS' if del_status == 200 and users_left == 0 else 'FAIL',
           'no Storage cleanup happens on an Auth delete; the owner id is plain text (matches the repository assumption). Local OSS file backend, not S3')
    valid = {}
    for state, v in states.items():
        valid[state] = probe(v['access'], v['uid'], 'valid')
    notes = {s: int(sql_scalar(f"select count(*) from public.p3h_notes where user_id = '{v['uid']}'")) for s, v in states.items()}
    objs = {s: int(sql_scalar(f"select count(*) from storage.objects where bucket_id='p3h-fake' and owner_id = '{v['uid']}'")) for s, v in states.items()}
    record('C12', 'E9', 'still-valid old access token after logout / ban / delete (PostgREST, Storage, GET /user)',
           'four users signed in; logout global, Admin ban, Admin delete applied; the same pre-change access token replayed within its 120 s life',
           'GET /user refuses for logout/ban/delete; PostgREST and Storage (stateless JWT) behaviour is recorded as a fact',
           f'{json.dumps(valid)}; notes rows {notes}; object rows {objs}',
           'PASS' if valid['live']['auth_user'] == 200 and all(valid[s]['auth_user'] in (401, 403) for s in ('logout', 'ban', 'delete')) else 'FAIL',
           'access tokens are stateless JWTs: PostgREST/Storage do not look at the session or the user row')
    first_exp = min(v['issued'] for v in states.values()) + 120
    time.sleep(max(0.0, first_exp + 4 - time.time()))
    near = {s: probe(v['access'], v['uid'], 'near-expiry') for s, v in states.items()}
    record('C13a', 'E9', 'access token a few seconds past its expiry (skew tolerance observation)', 'the same four tokens replayed about 4-7 s after expiry',
           'recorded as a fact: which component still accepts a just-expired JWT', json.dumps(near), 'PARTIAL',
           'PostgREST v16.1 accepted a JWT up to 5 s past exp in a separate probe; the exact tolerance was not measured')
    last_exp = max(v['issued'] for v in states.values()) + 120
    time.sleep(max(0.0, last_exp + 90 - time.time()))
    expired = {s: probe(v['access'], v['uid'], 'expired') for s, v in states.items()}
    ok = all(all(code in (400, 401, 403) for code in r.values()) for r in expired.values())
    record('C13', 'E9', 'explicitly expired old access token (control, 90+ s past expiry)', 'the same four tokens replayed 90+ s after their 120 s expiry',
           'refused everywhere (400/401/403)', json.dumps(expired), 'PASS' if ok else 'FAIL')
    for s, v in states.items():
        admin('DELETE', f"/auth/v1/admin/users/{v['uid']}")
    left = {s: blob_count(v['uid']) for s, v in states.items()}
    record('C14', 'E8/E9', 'physical Storage objects remain after the owners are deleted', 'objects uploaded by the four users; Auth users deleted; file listing in the Storage container',
           'objects remain (nothing removes them)', f'physical files by owner state {left}', 'PASS' if sum(left.values()) > 0 else 'PARTIAL',
           'observed on the local file backend; the managed Storage backend is S3 and was not observed')


def link_flow(kc_user, token, hold=0.0, between=None):
    """Manual link as a signed-in user; returns (start_status, params, verifier, between_result)."""
    status, verifier, body = start_link(token)
    if status != 200 or 'url' not in body:
        return status, body, verifier, None
    kc = KeycloakLogin(kc_user)
    kc.open(body['url'])
    mid = between() if between else None
    if hold:
        time.sleep(hold)
    return status, parse_redirect(kc.submit()), verifier, mid


def case_b_manual():
    # C4: enabled, not banned (control)
    email = fresh_email('c4')
    uid, pw = create_user(email)
    st, s = sign_in(email, pw)
    status, params, verifier, _ = link_flow('kc-user-3', s['access_token'])
    ex = exchange(params['code'], verifier) if isinstance(params, dict) and 'code' in params else (0, {})
    record('C4', 'E3-control', 'manual link, manual linking enabled, user not banned', 'signed-in user starts /user/identities/authorize; Keycloak fake user with a DIFFERENT e-mail',
           'identity linked to the signed-in user', f'start {status}; exchange {ex[0]}; same user={ex[1].get("user", {}).get("id") == uid}; providers={providers(uid)}',
           'PASS' if providers(uid) == 'email,keycloak' else 'FAIL')
    admin('DELETE', f'/auth/v1/admin/users/{uid}')

    # C5: ban AFTER the pre-ban access token exists, then start a link with that token.
    email = fresh_email('c5')
    uid, pw = create_user(email)
    st, s = sign_in(email, pw)
    ban(uid)
    status, verifier, body = start_link(s['access_token'])
    record('C5', 'E3', 'manual link started AFTER the ban (pre-ban access token)', 'user signed in, Admin ban, then /user/identities/authorize with the pre-ban token',
           '403 user_banned', f'status {status} code={body.get("error_code")}', 'PASS' if status == 403 else 'FAIL')
    admin('DELETE', f'/auth/v1/admin/users/{uid}')


def case_c6_e4():
    email = fresh_email('c6')
    uid, pw = create_user(email)
    st, s = sign_in(email, pw)
    token = s['access_token']
    marker = {}

    def do_ban():
        t0 = sql_scalar('select clock_timestamp()')
        ban_status, ban_js = ban(uid)
        marker['ban_status'] = ban_status
        marker['banned_until'] = sql_scalar(f"select banned_until from auth.users where id = '{uid}'")
        marker['ban_updated_at'] = sql_scalar(f"select updated_at from auth.users where id = '{uid}'")
        return ban_status

    status, params, verifier, mid = link_flow('kc-user-4', token, between=do_ban)
    outcome = f'start {status}; ban {mid}'
    exch = None
    if isinstance(params, dict) and 'code' in params:
        exch = exchange(params['code'], verifier)
        outcome += f'; callback redirect=code; exchange {exch[0]}/{exch[1].get("error_code")}'
    elif isinstance(params, dict):
        outcome += f'; callback redirect error_code={params.get("error_code")}'
    ident = providers(uid)
    created = sql_scalar(f"select created_at from auth.identities where user_id='{uid}' and provider='keycloak'") or 'none'
    me = api('GET', '/auth/v1/user', token=token)[0]
    linked = 'keycloak' in ident
    record('C6', 'E4', 'manual link STARTED before the ban, completed after it (the V11 counterexample)',
           'user signed in; link started and the Keycloak login page opened; Admin ban; credentials submitted after the ban; callback; PKCE exchange',
           'to be observed (PR121 source reading predicts: LINKED)',
           f'{outcome}; providers={ident}; identity created_at={created}; user banned_until={marker.get("banned_until")}; ban updated_at={marker.get("ban_updated_at")}; GET /user with pre-ban token {me}',
           'LINKED_AFTER_BAN' if linked else 'REFUSED',
           'GoTrue v2.196.0, one run; not managed')
    admin('DELETE', f'/auth/v1/admin/users/{uid}')


def delayed_link(kc_user, delay, out, key):
    email = fresh_email(f'c7{key}')
    uid, pw = create_user(email)
    st, s = sign_in(email, pw)
    status, verifier, body = start_link(s['access_token'])
    kc = KeycloakLogin(kc_user)
    kc.open(body['url'])
    cb = kc.callback_url()          # credentials accepted by Keycloak; GoTrue callback NOT requested yet
    started = time.time()
    time.sleep(delay)
    loc = follow_callback(cb)
    params = parse_redirect(loc)
    out[key] = {'delay_s': round(time.time() - started), 'redirect': sorted(params), 'error_code': params.get('error_code'), 'providers': providers(uid)}
    admin('DELETE', f'/auth/v1/admin/users/{uid}')


def case_c15_e6_lite():
    shared = 'p3h.shared@example.test'
    rounds = []
    for rnd, ban_offset in enumerate((0.0, 0.05, 0.15), start=1):
        uid, pw = create_user(shared)
        callbacks = []
        for i in range(1, 9):
            verifier, loc = start_oauth()
            kc = KeycloakLogin(f'kc-share-{i}')
            kc.open(loc)
            callbacks.append(kc.callback_url())
        barrier = threading.Barrier(9)
        results = {}

        def attempt(i, url):
            barrier.wait()
            t0 = time.time()
            try:
                loc = follow_callback(url)
                p = parse_redirect(loc)
                results[i] = ('code' if 'code' in p else p.get('error_code', 'error'), round(time.time() - t0, 3))
            except Exception as e:  # noqa: BLE001
                results[i] = (type(e).__name__, round(time.time() - t0, 3))

        threads = [threading.Thread(target=attempt, args=(i + 1, u)) for i, u in enumerate(callbacks)]
        for th in threads:
            th.start()
        barrier.wait()
        time.sleep(ban_offset)
        ban_status, _ = ban(uid)
        for th in threads:
            th.join()
        ban_at = sql_scalar(f"select updated_at from auth.users where id = '{uid}'")
        rows = sql(f"select provider_id, created_at from auth.identities where user_id='{uid}' and provider='keycloak'")
        after_ban = sum(1 for r in rows if r[1] > ban_at)
        linked_n = len(rows)
        outcomes = {}
        for v in results.values():
            outcomes[v[0]] = outcomes.get(v[0], 0) + 1
        rounds.append({'round': rnd, 'ban_offset_s': ban_offset, 'ban_status': ban_status, 'outcomes': outcomes, 'identities_linked': linked_n,
                       'created_after_ban_update': after_ban})
        admin('DELETE', f'/auth/v1/admin/users/{uid}')
    any_after = any(r['created_after_ban_update'] > 0 for r in rounds)
    record('C15', 'E6-lite', '8 concurrent automatic-link callbacks around an Admin ban (3 rounds)',
           'Supabase user with a shared verified e-mail; 8 independent Keycloak fake identities with that e-mail; callbacks released together; ban at +0 / +50 / +150 ms',
           'each callback either links before the ban or is refused; any identity created after the ban update is a counterexample',
           json.dumps(rounds), 'PARTIAL_COUNTEREXAMPLE_OBSERVED' if any_after else 'PARTIAL',
           '24 attempts only, one machine, no way to force the in-request window; absence of a counterexample proves nothing')


HOOK_SQL = """create table if not exists public.p3h_state (user_id uuid primary key, state text not null);
create or replace function public.p3h_access_token_hook(event jsonb) returns jsonb language plpgsql stable as $$
declare st text;
begin
  select state into st from public.p3h_state where user_id = (event->>'user_id')::uuid;
  if st = 'raise' then raise exception 'p3h_hook_forced_error'; end if;
  if st = 'deleting' then
    return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'P3H_ACCOUNT_DELETING'));
  end if;
  return event;
end $$;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.p3h_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.p3h_access_token_hook(jsonb) from authenticated, anon, public;
grant select on public.p3h_state to supabase_auth_admin;"""


def set_state(uid, state):
    sql(f"insert into public.p3h_state values ('{uid}', '{state}') on conflict (user_id) do update set state = excluded.state")


def brief(status, js):
    return f'{status}/{js.get("error_code") or js.get("code") or "ok"}/{str(js.get("msg") or js.get("message") or "")[:60]}'


def case_hook():
    sql(HOOK_SQL)
    # latency: password grant median of 5 with the hook enabled and returning the event unchanged
    email = fresh_email('c16')
    uid, pw = create_user(email)
    times = []
    for _ in range(5):
        t0 = time.time()
        st, s = sign_in(email, pw)
        times.append(round((time.time() - t0) * 1000))
    times.sort()
    record('C16', 'E7', 'hook enabled, user not deleting: password grant works; latency', 'Custom Access Token hook (Postgres function) enabled; 5 password grants',
           '200 and a small added latency', f'status {st}; grant latency ms sorted {times}; median {times[2]}', 'PASS' if st == 200 else 'FAIL',
           'local machine, one hook, a lookup of one row; the 2 s Postgres-hook limit is a documented platform limit')
    # refused by the hook: password grant and refresh
    st_pre, s_pre = sign_in(email, pw)
    set_state(uid, 'deleting')
    st_pw, js_pw = sign_in(email, pw)
    st_rf, js_rf = api('POST', '/auth/v1/token?grant_type=refresh_token', {'refresh_token': s_pre['refresh_token']})
    record('C17', 'E7', 'hook refuses a "deleting" account: password and refresh grants', 'p3h_state = deleting for the user after a normal sign-in',
           'both grants refused with the hook message', f'password {brief(st_pw, js_pw)}; refresh {brief(st_rf, js_rf)}',
           'PASS' if st_pw >= 400 and st_rf >= 400 else 'FAIL')
    admin('DELETE', f'/auth/v1/admin/users/{uid}')

    # PKCE exchange after automatic link for a deleting account: is the identity committed although the token is refused?
    email2 = 'p3h.user2@example.test'
    uid2, pw2 = create_user(email2)
    set_state(uid2, 'deleting')
    params, verifier = kc_signin('kc-user-2')
    ex = exchange(params['code'], verifier) if 'code' in params else (0, params)
    record('C18', 'E7', 'hook refuses the PKCE exchange, but is the automatic link already committed?', 'deleting user; Keycloak fake user with the same verified e-mail; callback; exchange',
           'PR121 V10 predicts: identity committed at the callback, token refused at the exchange',
           f'callback redirect={sorted(params) if isinstance(params, dict) else params}; exchange {brief(*ex)}; providers={providers(uid2)}',
           'PASS_V10_CONFIRMED' if 'keycloak' in providers(uid2) and ex[0] >= 400 else 'REFUTED_OR_OTHER',
           'automatic link, one run')
    admin('DELETE', f'/auth/v1/admin/users/{uid2}')

    # manual link: the link started before the account became "deleting"
    email3 = fresh_email('c19')
    uid3, pw3 = create_user(email3)
    st, s = sign_in(email3, pw3)
    status, params, verifier, _ = link_flow('kc-user-3', s['access_token'], between=lambda: set_state(uid3, 'deleting'))
    ex = exchange(params['code'], verifier) if isinstance(params, dict) and 'code' in params else (0, params)
    record('C19', 'E7', 'manual link started before the account became "deleting": exchange refused, identity committed?', 'link started; p3h_state set to deleting; Keycloak login completed; exchange',
           'identity committed; exchange refused', f'start {status}; exchange {brief(*ex)}; providers={providers(uid3)}',
           'PASS_V10_CONFIRMED' if 'keycloak' in providers(uid3) and ex[0] >= 400 else 'REFUTED_OR_OTHER')
    admin('DELETE', f'/auth/v1/admin/users/{uid3}')

    # blast radius: the hook function errors for everyone (renamed away) -> unrelated users cannot sign in either
    email4 = fresh_email('c20')
    uid4, pw4 = create_user(email4)
    sql('alter function public.p3h_access_token_hook(jsonb) rename to p3h_access_token_hook_off')
    st_b, js_b = sign_in(email4, pw4)
    sql('alter function public.p3h_access_token_hook_off(jsonb) rename to p3h_access_token_hook')
    st_a, js_a = sign_in(email4, pw4)
    record('C20', 'E7', 'hook error blast radius (function missing)', 'the hook function is renamed away for one request, then restored',
           'sign-in of an UNRELATED user fails while the hook errors', f'while missing {brief(st_b, js_b)}; after restore {st_a}',
           'PASS_BLAST_RADIUS_CONFIRMED' if st_b >= 400 and st_a == 200 else 'OTHER')
    admin('DELETE', f'/auth/v1/admin/users/{uid4}')

def main():
    boot = sys.argv[1]
    setup_sql()
    cleanup_users()
    if boot == 'C':
        case_c0()
        case_hook()
    if boot == 'A9':
        case_e9()
    if boot == 'B':
        case_c0()
        case_b_manual()
        case_c6_e4()
        delayed = {}
        slow = threading.Thread(target=delayed_link, args=('kc-user-7', 330, delayed, 'slow'))
        slow.start()
        delayed_link('kc-user-8', 20, delayed, 'fast')
        case_c15_e6_lite()
        slow.join()
        record('C7', 'E4', 'flow-state lifetime: GoTrue callback delayed after the Keycloak login',
               'manual link; Keycloak credentials accepted; the GoTrue callback requested after 20 s and after 330 s (Keycloak code lifespan raised to 900 s)',
               '20 s links; 330 s is refused as expired (the flow-state lifetime floor is 300 s in the source)', json.dumps(delayed),
               'PASS' if delayed['fast']['providers'].endswith('keycloak') and 'flow_state' in str(delayed['slow']['error_code']) else 'PARTIAL',
               'two points only: 20 s links (lower bound 20 s) and the 330 s refusal gives an upper bound of 330 s for this version and configuration')
    if boot == 'A':
        case_c0()
        case_c1_c2()
        case_c3_default_disabled()
        case_c8_e5()
        case_c9_e8_e10()
        case_e9()
    out = WORK / f'results_boot_{boot}.json'
    out.write_text(json.dumps(RESULTS, indent=2, ensure_ascii=False))
    print(f'wrote {out}')


if __name__ == '__main__':
    main()
