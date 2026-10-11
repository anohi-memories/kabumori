"""Prepare the scratch Supabase project config and the Keycloak realm for the G5 local pilot (fake values only).

Usage: prepare.py <workdir> manual_on|manual_off <jwt_expiry_seconds> hook_on|hook_off
The workdir must already hold `supabase init` output (supabase/config.toml) and must be OUTSIDE the repository:
generated secrets and fake passwords are written there (0600) and never anywhere else.
"""
import json
import re
import secrets
import sys
from pathlib import Path

work = Path(sys.argv[1]).resolve()
repo = Path(__file__).resolve().parents[2]
if repo == work or repo in work.parents:
    raise SystemExit('REFUSED: the workdir must be outside the repository')
if not (work / 'supabase' / 'config.toml').is_file():
    raise SystemExit('REFUSED: run `supabase init --workdir <workdir>` first')
manual_linking = sys.argv[2] == 'manual_on'
jwt_expiry = int(sys.argv[3])
hook = sys.argv[4] == 'hook_on'
cfg_path = work / 'supabase' / 'config.toml'
text = cfg_path.read_text()


def set_in_section(src: str, section: str, key: str, value: str) -> str:
    m = re.search(rf'^\[{re.escape(section)}\]\n', src, re.M)
    assert m, section
    start = m.end()
    nxt = re.search(r'^\[', src[start:], re.M)
    end = start + nxt.start() if nxt else len(src)
    block = src[start:end]
    pat = re.compile(rf'^{re.escape(key)}\s*=.*$', re.M)
    assert pat.search(block), f'{section}.{key}'
    block = pat.sub(f'{key} = {value}', block, count=1)
    return src[:start] + block + src[end:]


text = re.sub(r'^project_id = ".*"$', 'project_id = "g5-p3h"', text, count=1, flags=re.M)
text = set_in_section(text, 'api', 'port', '55421')
text = set_in_section(text, 'db', 'port', '55422')
text = set_in_section(text, 'db', 'shadow_port', '55420')
for section in ('realtime', 'studio', 'edge_runtime', 'analytics'):
    text = set_in_section(text, section, 'enabled', 'false')
text = set_in_section(text, 'auth', 'site_url', '"http://127.0.0.1:3000"')
text = set_in_section(text, 'auth', 'additional_redirect_urls', '["http://127.0.0.1:3000/cb"]')
text = set_in_section(text, 'auth', 'jwt_expiry', str(jwt_expiry))
text = set_in_section(text, 'auth', 'enable_manual_linking', 'true' if manual_linking else 'false')
text = set_in_section(text, 'auth', 'enable_signup', 'true')

# Keycloak as a built-in provider (URL inside the isolated container network).
kc = (
    '\n[auth.external.keycloak]\nenabled = true\nclient_id = "g5-pilot"\n'
    'secret = "env(G5_PILOT_KEYCLOAK_SECRET)"\nredirect_uri = ""\n'
    'url = "http://keycloak:8080/realms/g5test"\nskip_nonce_check = true\n'
)
if '[auth.external.keycloak]' not in text:
    text += kc

if hook:
    text += (
        '\n[auth.hook.custom_access_token]\nenabled = true\n'
        'uri = "pg-functions://postgres/public/p3h_access_token_hook"\n'
    )
cfg_path.write_text(text)

# Fake secrets: generated here, kept only in the scratch directory.
secret_file = work / 'env.keycloak'
if not secret_file.exists():
    secret_file.write_text(f'G5_PILOT_KEYCLOAK_SECRET={secrets.token_urlsafe(24)}\n')
kc_secret = secret_file.read_text().split('=', 1)[1].strip()
pw_file = work / 'fake_passwords.json'
if not pw_file.exists():
    pw_file.write_text(json.dumps({**{f'kc-user-{i}': secrets.token_urlsafe(12) for i in range(1, 9)}, **{f'kc-share-{i}': secrets.token_urlsafe(12) for i in range(1, 9)}}))
passwords = json.loads(pw_file.read_text())

users = []
for i in range(1, 9):
    users.append({
        'username': f'kc-user-{i}',
        'enabled': True,
        'emailVerified': True,
        'email': f'p3h.user{i}@example.test',
        'firstName': f'Pilot{i}',
        'lastName': 'Fake',
        'credentials': [{'type': 'password', 'value': passwords[f'kc-user-{i}'], 'temporary': False}],
    })
# kc-share-1..8: eight independent identities that share ONE verified e-mail (E6-lite).
for i in range(1, 9):
    users.append({
        'username': f'kc-share-{i}',
        'enabled': True,
        'emailVerified': True,
        'email': 'p3h.shared@example.test',
        'firstName': f'Share{i}',
        'lastName': 'Fake',
        'credentials': [{'type': 'password', 'value': passwords[f'kc-share-{i}'], 'temporary': False}],
    })
realm = {
    'realm': 'g5test',
    'enabled': True,
    'sslRequired': 'none',
    'accessCodeLifespan': 900,
    'accessCodeLifespanLogin': 1800,
    'accessCodeLifespanUserAction': 900,
    'registrationAllowed': False,
    'duplicateEmailsAllowed': True,
    'loginWithEmailAllowed': False,
    'clients': [{
        'clientId': 'g5-pilot',
        'enabled': True,
        'publicClient': False,
        'secret': kc_secret,
        'standardFlowEnabled': True,
        'directAccessGrantsEnabled': True,
        'redirectUris': ['http://127.0.0.1:55421/auth/v1/callback'],
        'webOrigins': [],
        'defaultClientScopes': ['openid', 'email', 'profile'],
    }],
    'users': users,
}
(work / 'realm-g5test.json').write_text(json.dumps(realm, indent=2))
for name in ('env.keycloak', 'fake_passwords.json', 'realm-g5test.json'):
    (work / name).chmod(0o600)
print('prepared', cfg_path, 'manual_linking=', manual_linking, 'jwt_expiry=', jwt_expiry, 'hook=', hook)
