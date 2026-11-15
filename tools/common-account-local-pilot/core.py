"""Core helpers of the G5 local OSS pilot driver (Phase 3h). Loopback endpoints only; fake data only.

Fail closed: importing this module refuses to run unless G5_LOCAL_PILOT_CONFIRM names the G5-owned Podman
machine, and the HTTP client only ever talks to the two allowlisted loopback ROUTES. P3H_OFFLINE_TEST=1 is
for the unit tests only: it skips the stack lookup and the confirmation, and still cannot reach anything.
"""
import base64
import hashlib
import html
import http.client
import json
import os
import re
import secrets
import subprocess
import time
import urllib.parse
from pathlib import Path

CONFIRM = 'G5_OWNED_PODMAN_MACHINE_g5-local-pilot'
OFFLINE = os.environ.get('P3H_OFFLINE_TEST') == '1'
if not OFFLINE and os.environ.get('G5_LOCAL_PILOT_CONFIRM') != CONFIRM:
    raise SystemExit('REFUSED: set G5_LOCAL_PILOT_CONFIRM=' + CONFIRM + ' (only for the G5-owned, isolated Podman machine)')
WORK = Path(os.environ['P3H_WORK'])
if not OFFLINE and Path(__file__).resolve().parents[2] in WORK.resolve().parents:
    raise SystemExit('REFUSED: P3H_WORK must be outside the repository (secrets are generated there)')
API = ('127.0.0.1', 55421)
KC = ('127.0.0.1', 55480)
PODMAN = ['podman', '--connection', 'g5-local-pilot']
DB = 'supabase_db_g5-p3h'
# The ONLY hosts this driver will talk to (logical host:port -> loopback target).
ROUTES = {'keycloak:8080': KC, '127.0.0.1:55421': API}
APP_REDIRECT = 'http://127.0.0.1:3000/cb'  # never fetched: the Location header is read instead


class Refused(Exception):
    pass


def _keys():
    env = dict(os.environ, CONTAINER_CONNECTION='g5-local-pilot')
    out = subprocess.run(['supabase', 'status', '--workdir', str(WORK), '-o', 'json'], capture_output=True, text=True, env=env, cwd=WORK)
    d = json.loads(out.stdout)
    return d['ANON_KEY'], d['SERVICE_ROLE_KEY']


ANON, SERVICE = ('offline-test-anon', 'offline-test-service') if OFFLINE else _keys()
PASSWORDS = json.loads((WORK / 'fake_passwords.json').read_text())


def h(value) -> str:
    """Run-independent short hash used in evidence instead of raw ids."""
    return 'id:' + hashlib.sha256(str(value).encode()).hexdigest()[:8]


class Net:
    """One fresh 'browser' (own cookie jar). Never follows redirects on its own."""

    def __init__(self):
        self.cookies = {}

    def request(self, method, url, headers=None, body=None, timeout=40):
        u = urllib.parse.urlsplit(url)
        target = ROUTES.get(u.netloc)
        if target is None:
            raise Refused(f'host not allowlisted: {u.netloc}')
        hdrs = {'Host': u.netloc}
        hdrs.update(headers or {})
        jar = self.cookies.get(u.hostname)
        if jar:
            hdrs['Cookie'] = '; '.join(f'{k}={v}' for k, v in jar.items())
        path = u.path + (('?' + u.query) if u.query else '')
        conn = http.client.HTTPConnection(*target, timeout=timeout)
        started = time.time()
        conn.request(method, path, body=body, headers=hdrs)
        r = conn.getresponse()
        data = r.read()
        for sc in r.msg.get_all('Set-Cookie') or []:
            name, _, rest = sc.partition('=')
            self.cookies.setdefault(u.hostname, {})[name] = rest.split(';', 1)[0]
        conn.close()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, data, time.time() - started


def api(method, path, body=None, token=None, key=None, extra=None, net=None):
    net = net or Net()
    headers = {'apikey': key or ANON, 'Content-Type': 'application/json'}
    headers['Authorization'] = f'Bearer {token}' if token else f'Bearer {key or ANON}'
    headers.update(extra or {})
    payload = json.dumps(body).encode() if body is not None else None
    status, hdrs, data, took = net.request(method, f'http://127.0.0.1:55421{path}', headers, payload)
    try:
        js = json.loads(data) if data else {}
    except ValueError:
        js = {'_raw': data[:200].decode('utf-8', 'replace')}
    return status, js


def admin(method, path, body=None):
    return api(method, path, body, token=SERVICE, key=SERVICE)


def sql(query: str) -> list[list[str]]:
    out = subprocess.run(PODMAN + ['exec', DB, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-tA', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', query],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError('sql failed: ' + out.stderr.strip()[:300])
    return [line.split('|') for line in out.stdout.strip().splitlines() if line.strip()]


def sql_scalar(query: str) -> str:
    rows = sql(query)
    return rows[0][0] if rows else ''


def pkce():
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).decode().rstrip('=')
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    return verifier, challenge


def parse_redirect(location: str) -> dict:
    """Query and fragment parameters of a redirect to the app (code or error)."""
    u = urllib.parse.urlsplit(location)
    out = dict(urllib.parse.parse_qsl(u.query))
    out.update(dict(urllib.parse.parse_qsl(u.fragment)))
    return out


FORM_ACTION = re.compile(r'<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"', re.S)
FORM_ACTION_ALT = re.compile(r'<form[^>]*action="([^"]+)"[^>]*id="kc-form-login"', re.S)


class KeycloakLogin:
    """Two-stage login so a case can act between 'login page shown' and 'credentials submitted'."""

    def __init__(self, username: str):
        self.net = Net()
        self.username = username
        self.action = None

    def open(self, authorize_location: str):
        url = authorize_location
        for _ in range(6):
            status, hdrs, data, _ = self.net.request('GET', url)
            if status in (301, 302, 303):
                url = urllib.parse.urljoin(url, hdrs['location'])
                continue
            break
        text = data.decode('utf-8', 'replace')
        m = FORM_ACTION.search(text) or FORM_ACTION_ALT.search(text)
        if status != 200 or not m:
            raise RuntimeError(f'keycloak login page not found (status {status})')
        self.action = html.unescape(m.group(1))

    def submit(self) -> str:
        """POST the credentials; follow redirects until the app redirect; return its Location."""
        body = urllib.parse.urlencode({'username': self.username, 'password': PASSWORDS[self.username], 'credentialId': ''}).encode()
        status, hdrs, data, _ = self.net.request('POST', self.action, {'Content-Type': 'application/x-www-form-urlencoded'}, body)
        url = self.action
        for _ in range(8):
            if status not in (301, 302, 303):
                raise RuntimeError(f'unexpected status {status} during login submit')
            loc = urllib.parse.urljoin(url, hdrs['location'])
            if urllib.parse.urlsplit(loc).netloc not in ROUTES:
                return loc
            url = loc
            status, hdrs, data, _ = self.net.request('GET', url)
        raise RuntimeError('too many redirects')

    def callback_url(self) -> str:
        """POST the credentials and stop at the GoTrue callback URL (not yet requested)."""
        body = urllib.parse.urlencode({'username': self.username, 'password': PASSWORDS[self.username], 'credentialId': ''}).encode()
        status, hdrs, data, _ = self.net.request('POST', self.action, {'Content-Type': 'application/x-www-form-urlencoded'}, body)
        if status not in (301, 302, 303):
            raise RuntimeError(f'unexpected status {status} during login submit')
        return urllib.parse.urljoin(self.action, hdrs['location'])


def follow_callback(url: str, net=None) -> str:
    """Request the GoTrue callback; return the redirect Location to the app."""
    net = net or Net()
    status, hdrs, data, _ = net.request('GET', url)
    if status not in (301, 302, 303):
        raise RuntimeError(f'callback returned {status}')
    return urllib.parse.urljoin(url, hdrs['location'])


def start_oauth(provider='keycloak'):
    """GET /authorize with PKCE; return (verifier, keycloak authorize URL)."""
    verifier, challenge = pkce()
    q = urllib.parse.urlencode({'provider': provider, 'redirect_to': APP_REDIRECT, 'code_challenge': challenge, 'code_challenge_method': 's256', 'scopes': 'openid'})
    status, hdrs, data, _ = Net().request('GET', f'http://127.0.0.1:55421/auth/v1/authorize?{q}', {'apikey': ANON})
    if status not in (301, 302, 303):
        raise RuntimeError(f'authorize returned {status}: {data[:120]!r}')
    return verifier, hdrs['location']


def start_link(access_token):
    """GET /user/identities/authorize (manual link). Returns (status, verifier, url_or_error_json)."""
    verifier, challenge = pkce()
    q = urllib.parse.urlencode({'provider': 'keycloak', 'redirect_to': APP_REDIRECT, 'code_challenge': challenge,
                                'code_challenge_method': 's256', 'skip_http_redirect': 'true', 'scopes': 'openid'})
    status, js = api('GET', f'/auth/v1/user/identities/authorize?{q}', token=access_token)
    return status, verifier, js


def exchange(code, verifier):
    return api('POST', '/auth/v1/token?grant_type=pkce', {'auth_code': code, 'code_verifier': verifier})


def create_user(email, password=None):
    password = password or secrets.token_urlsafe(14)
    status, js = admin('POST', '/auth/v1/admin/users', {'email': email, 'password': password, 'email_confirm': True})
    if status != 200:
        raise RuntimeError(f'create_user failed {status}')
    return js['id'], password


def sign_in(email, password):
    status, js = api('POST', '/auth/v1/token?grant_type=password', {'email': email, 'password': password})
    return status, js


def ban(user_id, duration='24h'):
    return admin('PUT', f'/auth/v1/admin/users/{user_id}', {'ban_duration': duration})


def counts(user_id: str) -> dict:
    """Row counts of GoTrue tables for one user id (read-back, counts only)."""
    q = f"""select 'users', count(*) from auth.users where id = '{user_id}'
 union all select 'identities', count(*) from auth.identities where user_id = '{user_id}'
 union all select 'sessions', count(*) from auth.sessions where user_id = '{user_id}'
 union all select 'refresh_tokens', count(*) from auth.refresh_tokens where user_id = '{user_id}'
 union all select 'mfa_factors', count(*) from auth.mfa_factors where user_id = '{user_id}'
 union all select 'one_time_tokens', count(*) from auth.one_time_tokens where user_id = '{user_id}'"""
    return {k: int(v) for k, v in sql(q)}


def providers(user_id: str) -> str:
    return ','.join(sorted(r[0] for r in sql(f"select provider from auth.identities where user_id = '{user_id}'")))


def audit_count(action: str, actor_id: str) -> int:
    return int(sql_scalar(f"select count(*) from auth.audit_log_entries where payload->>'action' = '{action}' and (payload->>'actor_id' = '{actor_id}' or payload->'traits'->>'user_id' = '{actor_id}')"))
