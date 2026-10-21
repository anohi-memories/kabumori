"""G5-14 read-only evidence (Issue #320 G5-01 task 14): every reference to the four POSTONA base tables that no migration creates --
public.brands, public.social_accounts, public.social_account_oauth_states, public.published_content_fingerprints -- in a source tree: migrations
(by statement kind), Edge functions / app code (Data API calls), and test fixtures (the shapes the tests assume). A text scan, not a database read:
dynamic SQL built from fragments, views and code that names a table through a variable are reported as such or missed. Usage:
  python3 -B supabase/tests/common_account_base_tables_refs.py <repository root> [--json]"""
import json
import os
import re
import sys

root = sys.argv[1]
as_json = '--json' in sys.argv[2:]
TABLES = ('brands', 'social_accounts', 'social_account_oauth_states', 'published_content_fingerprints')
NAME = {t: re.compile(r'(?<![a-z0-9_])(?:public\.)?' + t + r'(?![a-z0-9_])', re.I) for t in TABLES}
KINDS = [  # first match wins, on the statement text around the reference (a CREATE of THIS table is decided apart, in kind_of)
    ('foreign key', re.compile(r'\breferences\s+(?:public\.)?[a-z_]+', re.I)),
    ('grant / revoke', re.compile(r'^\s*(grant|revoke)\b', re.I)),
    ('policy', re.compile(r'\b(create|drop|alter)\s+policy\b', re.I)),
    ('alter table', re.compile(r'^\s*alter\s+table\b', re.I)),
    ('rls', re.compile(r'row\s+level\s+security', re.I)),
    ('index', re.compile(r'\bcreate\s+(?:unique\s+)?index\b', re.I)),
    ('trigger', re.compile(r'\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\b', re.I)),
    ('write (insert / update / delete)', re.compile(r'\b(insert\s+into|update|delete\s+from)\b', re.I)),
    ('catalog assertion', re.compile(r"pg_catalog|regclass|pg_get_constraintdef|information_schema|'[a-z]\s*\|", re.I)),
    ('read', re.compile(r'\b(select|from|join|exists)\b', re.I)),
]
CODE_EXT = ('.ts', '.tsx', '.js', '.mjs')


def statement_at(text, pos):
    start = text.rfind(';', 0, pos) + 1
    end = text.find(';', pos)
    return text[start:end if end >= 0 else len(text)]


def kind_of(stmt, table):
    if re.search(r'\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?' + table + r'"?\s*\(', stmt, re.I):
        return 'create table'
    for label, rx in KINDS:
        if rx.search(stmt):
            return label
    return 'other'


def scan_sql(path, area):
    out = []
    text = open(path, encoding='utf-8', errors='replace').read()
    for t, rx in NAME.items():
        for m in rx.finditer(text):
            line = text.count('\n', 0, m.start()) + 1
            src = text.splitlines()[line - 1].strip()
            if src.startswith('--'):
                continue
            stmt = statement_at(text, m.start())
            out.append({'table': t, 'area': area, 'file': os.path.relpath(path, root), 'line': line, 'kind': kind_of(stmt, t), 'text': src[:160]})
    return out


def scan_code(path, area):
    out = []
    lines = open(path, encoding='utf-8', errors='replace').read().splitlines()
    for i, src in enumerate(lines, 1):
        for t in TABLES:
            if re.search(r"""\.from\(\s*['"`]""" + t + r"""['"`]\s*\)""", src):
                out.append({'table': t, 'area': area, 'file': os.path.relpath(path, root), 'line': i, 'kind': 'data api .from()', 'text': src.strip()[:160]})
            elif re.search(r"""(tableUrl\(\s*['"`]""" + t + r"""['"`]|/rest/v1/""" + t + r"""(?![a-z0-9_]))""", src):
                out.append({'table': t, 'area': area, 'file': os.path.relpath(path, root), 'line': i, 'kind': 'data api rest', 'text': src.strip()[:160]})
            elif re.search(r'(?<![a-z0-9_])(?:public\.)?' + t + r'(?![a-z0-9_])', src) and re.search(r'\b(select|insert|update|delete|from|join)\b', src, re.I):
                out.append({'table': t, 'area': area, 'file': os.path.relpath(path, root), 'line': i, 'kind': 'sql in code', 'text': src.strip()[:160]})
    return out


refs = []
areas = [('supabase/migrations', 'migration', 'sql'), ('supabase/tests', 'test fixture / test', 'sql'), ('supabase/functions', 'edge function', 'code'),
         ('apps', 'app', 'code'), ('supabase/candidates', 'candidate', 'sql')]
for rel, area, kind in areas:
    base = os.path.join(root, rel)
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in ('node_modules', '.expo', 'ios', 'android', 'dist', 'build')]
        for f in sorted(filenames):
            p = os.path.join(dirpath, f)
            if kind == 'sql' and f.endswith('.sql'):
                refs.extend(scan_sql(p, area))
            elif kind == 'code' and f.endswith(CODE_EXT):
                refs.extend(scan_code(p, area))
            elif kind == 'sql' and f.endswith(CODE_EXT) and area == 'test fixture / test':
                refs.extend(scan_code(p, area))

if as_json:
    print(json.dumps(refs, indent=1))
    sys.exit(0)
for t in TABLES:
    mine = [r for r in refs if r['table'] == t]
    print(f'== public.{t}: {len(mine)} references')
    created = [r for r in mine if r['kind'] == 'create table']
    print(f'   created in: {sorted({r["file"] for r in created}) or "NOWHERE"}')
    for area in ('migration', 'candidate', 'edge function', 'app', 'test fixture / test'):
        sub = [r for r in mine if r['area'] == area]
        if not sub:
            continue
        counts = {}
        for r in sub:
            counts[r['kind']] = counts.get(r['kind'], 0) + 1
        print(f'   {area}: {len(sub)} in {len({r["file"] for r in sub})} files; ' + ', '.join(f'{k} {v}' for k, v in sorted(counts.items())))
