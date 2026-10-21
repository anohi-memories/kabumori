"""G5-12 read-only inventory (Issue #320 G5-01 task 12; Supabase Data API change of 2026-10-30): for every table / view / sequence a migration
CREATES in schema public, report whether some migration also states its access explicitly -- a GRANT naming the object for anon / authenticated /
service_role, a REVOKE naming it, RLS enabled, a policy -- or whether access depended on Supabase's DEFAULT privileges (which stop granting new public
tables and sequences to the API roles on 2026-10-30, also for db reset and preview branches rebuilt after that day).

A text scan of SQL, not a database read: it can miss dynamic SQL and grants on whole schemas ("all tables in schema public"), which it reports
separately. Its rows are LEADS for each owner to confirm, not findings. Usage:
  python3 -B supabase/tests/common_account_data_api_grants_scan.py <migrations directory> [--json]"""
import json
import os
import re
import sys

root = sys.argv[1]
as_json = '--json' in sys.argv[2:]
IDENT = r'(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?'
# public.<name>, "public"."<name>", or an unqualified <name> (the migrations run with search_path public); another schema is skipped
CREATE = re.compile(r'^\s*create\s+(?:or\s+replace\s+)?(?:unlogged\s+)?(table|view|materialized\s+view|sequence)\s+(?:if\s+not\s+exists\s+)?((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?)(?=\s*[\s(]|$)', re.I)
SERIAL = re.compile(r'\b(bigserial|smallserial|serial)\b', re.I)
IDENTITY = re.compile(r'\bgenerated\s+(?:always|by\s+default)\s+as\s+identity\b', re.I)
API = ('anon', 'authenticated', 'service_role')


def strip_comments(sql):
    sql = re.sub(r'/\*.*?\*/', ' ', sql, flags=re.S)
    return '\n'.join(re.sub(r'--.*$', '', line) for line in sql.split('\n'))


def statements(sql):
    # dollar-quoted bodies are function / DO bodies: GRANTs inside them are dynamic and reported apart
    out, body, depth = [], [], None
    for part in re.split(r'(\$[a-z_]*\$)', sql, flags=re.I):
        if re.fullmatch(r'\$[a-z_]*\$', part, flags=re.I):
            depth = None if depth == part else (depth or part)
            continue
        if depth:
            body.append(part)
            continue
        out.extend(s.strip() for s in part.split(';') if s.strip())
    return out, ' '.join(body)


objects = {}
touched = {}  # public objects a migration alters / grants / revokes / polices / references without any migration creating them
schema_wide = []
dynamic = []
for name in sorted(os.listdir(root)):
    if not name.endswith('.sql'):
        continue
    text = strip_comments(open(os.path.join(root, name), encoding='utf-8').read())
    stmts, bodies = statements(text)
    # a GRANT statement inside a body (`grant <privileges> on <object> to <role>`); a mere 'with grant option' / 'grant option' text is not one
    if re.search(r"\bgrant\s+(?!option\b)[a-z_, ()]+\s+on\s+[^;']*?\s+to\s+", bodies, re.I):
        dynamic.append(name)
    for s in stmts:
        low = ' '.join(s.lower().split())
        m = CREATE.search(s)
        if m:
            kind, obj = m.group(1).lower(), m.group(2).replace('"', '').lower().removeprefix('public.')
            o = objects.setdefault(obj, {'kind': kind, 'created_in': name, 'grants': {}, 'revoked_from_api': False, 'rls': False, 'policies': 0,
                                         'serial': False, 'identity': False})
            if kind.endswith('table') and SERIAL.search(s):
                o['serial'] = True
            if kind.endswith('table') and IDENTITY.search(s):
                o['identity'] = True
        if re.match(r'(grant|revoke)\b.*\bon\s+all\s+(tables|sequences)\s+in\s+schema\s+public\b', low) or re.match(r'alter default privileges\b.*\bin schema public\b', low):
            schema_wide.append((name, low[:160]))
        g = re.match(r'grant\s+(.+?)\s+on\s+(?:table\s+|sequence\s+)?(.+?)\s+to\s+(.+)$', low)
        if g:
            privs, targets, roles = g.groups()
            for t in re.split(r'\s*,\s*', targets):
                t = t.replace('"', '').removeprefix('public.')
                if t in objects:
                    for r in re.split(r'\s*,\s*', roles.split(' with ')[0]):
                        if r in API:
                            objects[t]['grants'].setdefault(r, []).append(f'{privs} ({name})')
        r = re.match(r'revoke\s+.+?\s+on\s+(?:table\s+|sequence\s+)?(.+?)\s+from\s+(.+)$', low)
        if r:
            for t in re.split(r'\s*,\s*', r.group(1)):
                t = t.replace('"', '').removeprefix('public.')
                if t in objects and any(x in r.group(2) for x in API):
                    objects[t]['revoked_from_api'] = True
        e = re.match(r'alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(\S+)\s+enable\s+row\s+level\s+security', low)
        if e:
            t = e.group(1).replace('"', '').removeprefix('public.')
            if t in objects:
                objects[t]['rls'] = True
        d = re.match(r'drop\s+(?:table|view|materialized\s+view|sequence)\s+(?:if\s+exists\s+)?(.+?)(?:\s+cascade|\s+restrict)?$', low)
        if d:
            for t in re.split(r'\s*,\s*', d.group(1)):
                t = t.replace('"', '').removeprefix('public.')
                if t in objects:
                    objects[t]['dropped_in'] = name
        for ref in re.findall(r'(?:alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?|\bon\s+(?:table\s+)?|references\s+)public\.([a-z_][a-z0-9_]*)', low):
            touched.setdefault(ref, name)
        for many in re.findall(r'\bon\s+table\s+((?:public\.[a-z_][a-z0-9_]*\s*,\s*)+public\.[a-z_][a-z0-9_]*)', low):
            for ref in re.findall(r'public\.([a-z_][a-z0-9_]*)', many):
                touched.setdefault(ref, name)
        p = re.match(r'create\s+policy\s+\S+\s+on\s+(\S+)', low)
        if p:
            t = p.group(1).replace('"', '').removeprefix('public.')
            if t in objects:
                objects[t]['policies'] += 1

rows = []
for obj, o in sorted(objects.items()):
    explicit = bool(o['grants']) or o['revoked_from_api']
    if o.get('dropped_in'):
        verdict = f'DROPPED ({o["dropped_in"][:14]})'
    elif o['kind'] in ('view', 'materialized view'):
        verdict = 'VIEW (not in the change; check its own grants)' if not explicit else 'explicit'
    elif explicit:
        verdict = 'explicit'
    else:
        verdict = 'IMPLICIT (default privileges only)'
    rows.append({'object': obj, **o, 'verdict': verdict})

base = sorted(t for t in touched if t not in objects)
if as_json:
    print(json.dumps({'objects': rows, 'schema_wide': schema_wide, 'dynamic_grant_files': dynamic, 'not_created_by_any_migration': base}, indent=1))
    sys.exit(0)
print(f'{"object":48} {"kind":8} {"verdict":36} {"rls":4} {"pol":3} {"col":8} created_in')
for r in rows:
    col = 'serial' if r.get('serial') else 'identity' if r.get('identity') else ''
    print(f'{r["object"]:48} {r["kind"][:8]:8} {r["verdict"][:36]:36} {"yes" if r["rls"] else "no":4} {r["policies"]:3} {col:8} {r["created_in"]}')
print(f'\nobjects: {len(rows)}; explicit: {sum(r["verdict"] == "explicit" for r in rows)}; implicit: {sum(r["verdict"].startswith("IMPLICIT") for r in rows)}; '
      f'dropped: {sum(r["verdict"].startswith("DROPPED") for r in rows)}; '
      f'views: {sum(r["verdict"].startswith("VIEW") for r in rows)}; serial (needs sequence USAGE to insert): {sum(bool(r.get("serial")) for r in rows)}; identity: {sum(bool(r.get("identity")) for r in rows)}')
print(f'schema-wide grant / default-privilege statements: {len(schema_wide)}')
for f, s in schema_wide:
    print(f'  {f}: {s}')
print(f'files with GRANT inside a dollar-quoted body (dynamic, not parsed): {len(dynamic)} {dynamic}')
print(f'public objects changed / granted / referenced but created by NO migration (a db reset or preview cannot rebuild them): {len(base)}')
for t in base:
    print(f'  {t} (first touched in {touched[t]})')
