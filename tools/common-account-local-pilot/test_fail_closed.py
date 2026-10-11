"""Offline tests of the G5 local pilot tooling (Phase 3h): it must fail closed and never reach anything but the two
loopback routes. No stack, no Podman, no network. Run: python3 -m unittest -v tools/common-account-local-pilot/test_fail_closed.py"""
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


def run(script, *args, env_extra=None, drop=()):
    env = {k: v for k, v in os.environ.items() if k not in drop}
    env.update(env_extra or {})
    return subprocess.run([sys.executable, '-I', str(HERE / script), *args], capture_output=True, text=True, env=env, cwd=tempfile.gettempdir())


def python_in_core(code, work):
    env = dict(os.environ, P3H_OFFLINE_TEST='1', P3H_WORK=str(work))
    return subprocess.run([sys.executable, '-I', '-c', f'import sys; sys.path.insert(0, {str(HERE)!r})\n{code}'], capture_output=True, text=True, env=env)


MINIMAL_CONFIG = """project_id = "x"
[api]
port = 54321
[db]
port = 54322
shadow_port = 54320
[realtime]
enabled = true
[studio]
enabled = true
[edge_runtime]
enabled = true
[analytics]
enabled = true
[auth]
site_url = "http://127.0.0.1:3000"
additional_redirect_urls = ["https://127.0.0.1:3000"]
jwt_expiry = 3600
enable_manual_linking = false
enable_signup = true
"""


class FailClosed(unittest.TestCase):
    def test_core_refuses_without_the_confirmation(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = run('core.py', env_extra={'P3H_WORK': tmp}, drop=('G5_LOCAL_PILOT_CONFIRM', 'P3H_OFFLINE_TEST'))
            self.assertNotEqual(r.returncode, 0)
            self.assertIn('REFUSED', r.stderr + r.stdout)

    def test_core_refuses_a_workdir_inside_the_repository(self):
        env = {'P3H_WORK': str(REPO / 'tools'), 'G5_LOCAL_PILOT_CONFIRM': 'G5_OWNED_PODMAN_MACHINE_g5-local-pilot'}
        r = run('core.py', env_extra=env, drop=('P3H_OFFLINE_TEST',))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('outside the repository', r.stderr + r.stdout)

    def test_http_client_only_reaches_the_two_loopback_routes(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, 'fake_passwords.json').write_text('{}')
            code = (
                'import core\n'
                'assert set(core.ROUTES) == {"keycloak:8080", "127.0.0.1:55421"}, core.ROUTES\n'
                'assert all(host == "127.0.0.1" for host, port in core.ROUTES.values())\n'
                'for url in ("https://example.com/", "http://127.0.0.1:55422/", "http://169.254.169.254/", "http://localhost:55421/", "http://keycloak:9999/"):\n'
                '    try:\n'
                '        core.Net().request("GET", url)\n'
                '    except core.Refused:\n'
                '        continue\n'
                '    raise SystemExit("NOT REFUSED: " + url)\n'
                'print("REFUSED_ALL")\n'
            )
            r = python_in_core(code, tmp)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn('REFUSED_ALL', r.stdout)

    def test_prepare_refuses_a_workdir_inside_the_repository_or_without_init(self):
        r = run('prepare.py', str(REPO / 'tools'), 'manual_off', '120', 'hook_off')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('outside the repository', r.stderr + r.stdout)
        with tempfile.TemporaryDirectory() as tmp:
            r = run('prepare.py', tmp, 'manual_off', '120', 'hook_off')
            self.assertNotEqual(r.returncode, 0)
            self.assertIn('supabase init', r.stderr + r.stdout)

    def test_prepare_writes_only_fake_values_and_private_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, 'supabase').mkdir()
            Path(tmp, 'supabase', 'config.toml').write_text(MINIMAL_CONFIG)
            r = run('prepare.py', tmp, 'manual_on', '120', 'hook_on')
            self.assertEqual(r.returncode, 0, r.stderr)
            cfg = Path(tmp, 'supabase', 'config.toml').read_text()
            self.assertIn('enable_manual_linking = true', cfg)
            self.assertIn('jwt_expiry = 120', cfg)
            self.assertIn('url = "http://keycloak:8080/realms/g5test"', cfg)
            self.assertIn('secret = "env(G5_PILOT_KEYCLOAK_SECRET)"', cfg)
            self.assertIn('pg-functions://postgres/public/p3h_access_token_hook', cfg)
            for section in ('realtime', 'studio', 'edge_runtime', 'analytics'):
                self.assertRegex(cfg, rf'\[{section}\]\nenabled = false')
            realm = json.loads(Path(tmp, 'realm-g5test.json').read_text())
            self.assertEqual(len(realm['users']), 16)
            self.assertTrue(all(u['email'].endswith('@example.test') for u in realm['users']))
            self.assertEqual(realm['clients'][0]['redirectUris'], ['http://127.0.0.1:55421/auth/v1/callback'])
            for name in ('env.keycloak', 'fake_passwords.json', 'realm-g5test.json'):
                self.assertEqual(Path(tmp, name).stat().st_mode & 0o777, 0o600, name)

    def test_sources_hold_no_remote_host_secret_or_shell_execution(self):
        for name in ('core.py', 'cases.py', 'extra.py', 'prepare.py'):
            src = (HERE / name).read_text()
            self.assertNotRegex(src, r'shell\s*=\s*True', name)
            self.assertNotRegex(src, r'https://', name)
            self.assertNotRegex(src, r'eyJ[A-Za-z0-9_-]{10,}', name)
            self.assertNotRegex(src, r'sb_(secret|publishable)_', name)
            self.assertNotIn('supabase.co', src, name)
            self.assertNotRegex(src, r'\.supabase\.(co|in|com)', name)
            hosts = set(re.findall(r'https?://([A-Za-z0-9_.-]+)', src))
            self.assertLessEqual(hosts, {'127.0.0.1', 'keycloak'}, f'{name}: {hosts}')

    def test_no_default_execution_path_for_destructive_sql(self):
        for name in ('cases.py', 'extra.py', 'core.py'):
            src = (HERE / name).read_text().lower()
            self.assertNotIn('delete from auth.users', src, name)  # E11 / Option D is deliberately not part of the pilot
            self.assertNotIn('drop schema', src, name)
            self.assertNotIn('--project-ref', src, name)
            self.assertNotIn('supabase link', src, name)
            self.assertNotIn('db push', src, name)


if __name__ == '__main__':
    unittest.main()
