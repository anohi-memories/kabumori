"""Offline check of docs/common-account/m1-manual-x-publish-provenance.json: every external source the M1 contract cites is still the pinned
git blob (so the contract was written against exactly these bytes), still contains the raw contract names the contract quotes, and the one live
function that must NOT ask F5 still does not. It only runs `git rev-parse` / `git show` on objects that are already in the repository: no network,
no checkout of another branch. Usage: python3 -I supabase/tests/common_account_m1_provenance_check.py [<repository root>]"""
import json
import subprocess
import sys

root = sys.argv[1] if len(sys.argv) > 1 else subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True, check=True).stdout.strip()
doc = json.load(open(f'{root}/docs/common-account/m1-manual-x-publish-provenance.json', encoding='utf-8'))
failures = 0


def git(*args):
    return subprocess.run(['git', '-C', root, *args], capture_output=True, text=True)


def report(source_id, ok, detail=''):
    global failures
    print(f'M1_PROVENANCE|{source_id}|{"PASS" if ok else "FAIL"}{"|" + detail if detail else ""}')
    if not ok:
        failures += 1


for source in doc['sources']:
    blob = git('rev-parse', f"{source['commit']}:{source['path']}")
    if blob.returncode != 0 or blob.stdout.strip() != source['blob']:
        report(source['id'], False, 'the pinned blob is not at that commit and path')
        continue
    text = git('show', f"{source['commit']}:{source['path']}").stdout
    missing = [needle for needle in source.get('present', []) if needle not in text]
    if missing:
        report(source['id'], False, f'{len(missing)} contract name(s) no longer present')
        continue
    spec = source.get('absentInFunction')
    if spec:
        start = text.index(f"create function {spec['function']}(")
        body = text[start:text.index('\n$$;', start)]
        present = [needle for needle in spec['needles'] if needle in body]
        if present:
            report(source['id'], False, f'the function now mentions {len(present)} F5 name(s): the finding is out of date')
            continue
    report(source['id'], True, f"{source['pr']} {source['commit'][:8]}")
print(f"M1_PROVENANCE|ALL|{'PASS' if failures == 0 else 'FAIL'}")
sys.exit(0 if failures == 0 else 1)
