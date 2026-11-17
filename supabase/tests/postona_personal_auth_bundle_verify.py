"""G5-40: static check of supabase/candidates/postona_personal_auth_bundle/ against its MANIFEST.tsv (no database, no network).
  * every listed file exists and its blob is the manifest's; every copied file is BYTE-IDENTICAL to its source at the stated commit (git objects);
  * the directory holds nothing unlisted; each install step 10..70 has exactly one rollback; the one NEW file is the guard.
Usage: python3 supabase/tests/postona_personal_auth_bundle_verify.py <repository root with the source commits fetched>"""
import os
import subprocess
import sys

repo = sys.argv[1] if len(sys.argv) > 1 else '.'
BUNDLE = os.path.join(repo, 'supabase/candidates/postona_personal_auth_bundle')
rows = [line.split('\t') for line in open(os.path.join(BUNDLE, 'MANIFEST.tsv'), encoding='utf-8').read().splitlines() if line and not line.startswith('#')]
fail = 0


def check(ok, label):
    global fail
    fail += 0 if ok else 1
    print(f'{"PASS" if ok else "FAIL"}  {label}', flush=True)


def hash_object(path):
    return subprocess.run(['git', 'hash-object', path], capture_output=True, text=True, check=True).stdout.strip()


listed = set()
for step, kind, name, commit, path, pr, blob in rows:
    listed.add(name)
    file = os.path.join(BUNDLE, name)
    check(os.path.isfile(file) and hash_object(file) == blob, f'{name}: present, blob {blob[:8]}')
    if commit != 'NEW':
        src = subprocess.run(['git', '-C', repo, 'rev-parse', f'{commit}:{path}'], capture_output=True, text=True)
        check(src.returncode == 0 and src.stdout.strip() == blob, f'{name}: byte-identical to {path} @ {commit[:8]} ({pr})')
    else:
        check(kind == 'guard', f'{name}: the only new file is the guard')
check(set(os.listdir(BUNDLE)) - {'MANIFEST.tsv', 'README.md'} == listed, 'nothing unlisted in the bundle directory')
installs = sorted(r[0] for r in rows if r[1] == 'install')
rollbacks = sorted(r[0] for r in rows if r[1] == 'rollback')
check(installs == rollbacks == ['10', '20', '30', '40', '50', '60', '70'], 'each install step 10..70 has exactly one rollback')
print(f'BUNDLE    {"PASS" if fail == 0 else "FAIL"} ({fail} failure(s))', flush=True)
sys.exit(1 if fail else 0)
