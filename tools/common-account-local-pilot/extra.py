"""Follow-ups to C6 (what the post-ban exchange returns) and finer E6-lite offsets. Boot B stack."""
import json
import sys
import threading
import time

sys.path.insert(0, __import__('os').path.dirname(__file__))
import cases as C  # noqa: E402
from core import *  # noqa: E402,F401,F403

OUT = {}


def slow_expiry():
    email = C.fresh_email('c7x')
    uid, pw = create_user(email)
    st, s = sign_in(email, pw)
    status, verifier, body = start_link(s['access_token'])
    kc = KeycloakLogin('kc-user-7')
    kc.open(body['url'])
    cb = kc.callback_url()
    time.sleep(310)
    loc = follow_callback(cb)
    p = parse_redirect(loc)
    OUT['c7x'] = {'delay_s': 310, 'params': {k: p[k][:140] for k in p}, 'providers': providers(uid)}
    admin('DELETE', f'/auth/v1/admin/users/{uid}')


def c6_detail():
    email = C.fresh_email('c6d')
    uid, pw = create_user(email)
    st, s = sign_in(email, pw)
    token, refresh = s['access_token'], s['refresh_token']
    status, verifier, body = start_link(token)
    kc = KeycloakLogin('kc-user-4')
    kc.open(body['url'])
    ban(uid)
    params = parse_redirect(kc.submit())
    st_ex, js_ex = exchange(params['code'], verifier)
    new_access = js_ex.get('access_token')
    new_refresh = js_ex.get('refresh_token')
    sessions = counts(uid)['sessions']
    d = {'exchange_status': st_ex, 'token_fields': sorted(k for k in js_ex if k in ('access_token', 'refresh_token', 'expires_in', 'token_type', 'user')),
         'sessions_after': sessions, 'providers': providers(uid)}
    if new_access:
        d['new_token_GET_user'] = api('GET', '/auth/v1/user', token=new_access)[0]
        d['new_token_postgrest_insert'] = api('POST', '/rest/v1/p3h_notes', {'body': 'c6d'}, token=new_access, extra={'Prefer': 'return=minimal'})[0]
        d['refresh_with_new_refresh_token'] = api('POST', '/auth/v1/token?grant_type=refresh_token', {'refresh_token': new_refresh})[0]
        d['logout_with_new_token'] = api('POST', '/auth/v1/logout?scope=global', token=new_access)[0]
        claims = json.loads(base64.urlsafe_b64decode(new_access.split('.')[1] + '=='))
        d['new_token_has_session_id'] = 'session_id' in claims
    d['password_grant_after'] = sign_in(email, pw)[0]
    OUT['c6_detail'] = d
    admin('DELETE', f'/auth/v1/admin/users/{uid}')


def e6_finer():
    shared = 'p3h.shared@example.test'
    rounds = []
    for offset in (0.01, 0.02, 0.03, 0.05, 0.08, 0.12):
        uid, pw = create_user(shared)
        callbacks = []
        for i in range(1, 9):
            verifier, loc = start_oauth()
            kc = KeycloakLogin(f'kc-share-{i}')
            kc.open(loc)
            callbacks.append(kc.callback_url())
        barrier = threading.Barrier(9)
        res = {}

        def attempt(i, url):
            barrier.wait()
            try:
                p = parse_redirect(follow_callback(url))
                res[i] = 'code' if 'code' in p else p.get('error_code', 'error')
            except Exception as e:  # noqa: BLE001
                res[i] = type(e).__name__

        ths = [threading.Thread(target=attempt, args=(i + 1, u)) for i, u in enumerate(callbacks)]
        for th in ths:
            th.start()
        barrier.wait()
        time.sleep(offset)
        ban_st, _ = ban(uid)
        for th in ths:
            th.join()
        ban_at = sql_scalar(f"select updated_at from auth.users where id = '{uid}'")
        rows = sql(f"select created_at from auth.identities where user_id='{uid}' and provider='keycloak'")
        outcomes = {}
        for v in res.values():
            outcomes[v] = outcomes.get(v, 0) + 1
        rounds.append({'offset_s': offset, 'ban': ban_st, 'outcomes': outcomes, 'identities': len(rows),
                       'created_after_ban_update': sum(1 for r in rows if r[0] > ban_at)})
        admin('DELETE', f'/auth/v1/admin/users/{uid}')
    OUT['e6_finer'] = rounds


if __name__ == '__main__':
    C.setup_sql()
    slow = threading.Thread(target=slow_expiry)
    slow.start()
    c6_detail()
    e6_finer()
    slow.join()
    print(json.dumps(OUT, indent=1))
    (WORK / 'results_boot_B_extra.json').write_text(json.dumps(OUT, indent=1))
