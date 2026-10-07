"""Prepare a NEW package.json copy with Emblem backup metadata from actual read-only schema evidence."""
import argparse
from contextlib import closing
import copy
import importlib.util
import json
from pathlib import Path
import re
import sqlite3

TABLES = ('canonical_assets', 'representations', 'collateral_ledger', 'operations',
          'consumed_burns', 'asset_locks', 'accounting_events', 'bridge_ops',
          'stamp_bridges', 'pools', 'supported_chains')
OPTIONAL = ('schema_migrations',)


def generate(package, evidence):
    if package.get('name') != 'stampyswap':
        raise ValueError('this preparer is scoped to the stampyswap package')
    if isinstance(evidence, dict):
        if evidence.get('error') or evidence.get('success') is False or evidence.get('truncated'):
            raise ValueError('schema export is failed or truncated')
        rows = evidence.get('rows')
        if not isinstance(rows, list) or evidence.get('rowCount', len(rows)) != len(rows):
            raise ValueError('incomplete schema export envelope')
    else:
        rows = evidence
    if not isinstance(rows, list):
        raise ValueError('schema evidence must contain rows')
    tables, indexes = {}, []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('sql'), str):
            raise ValueError('invalid schema row')
        if row.get('type') == 'table':
            name = row.get('name')
            if name not in TABLES + OPTIONAL or name in tables:
                raise ValueError('unexpected or duplicate backup table: ' + str(name))
            sql = row['sql'].strip()
            pattern = r'^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"' + re.escape(name) + r'"|`' + re.escape(name) + r'`|\[' + re.escape(name) + r'\]|' + re.escape(name) + r')\s*\('
            if not re.match(pattern, sql, re.IGNORECASE):
                raise ValueError('table DDL does not match its declared name')
            if not re.match(r'^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+', sql, re.IGNORECASE):
                sql = re.sub(r'^CREATE\s+TABLE\s+', 'CREATE TABLE IF NOT EXISTS ', sql, count=1, flags=re.IGNORECASE)
            tables[name] = sql
        elif row.get('type') == 'index':
            if row.get('tbl_name') not in TABLES + OPTIONAL or not re.match(r'^CREATE\s+(?:UNIQUE\s+)?INDEX\s+', row['sql'].strip(), re.IGNORECASE):
                raise ValueError('unexpected index DDL')
            indexes.append(row['sql'])
        else:
            raise ValueError('only table/index schema evidence is accepted')
    missing = set(TABLES) - tables.keys()
    if missing:
        raise ValueError('missing application tables: ' + ', '.join(sorted(missing)))
    # Parse only exported DDL in an empty in-memory DB. Never execute it against production.
    # execute() rejects multiple statements; validate() checks all seven financial uniqueness gates.
    spec = importlib.util.spec_from_file_location('migration', Path(__file__).with_name('prepare-migration.py'))
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    with closing(sqlite3.connect(':memory:')) as db:
        for sql in tables.values():
            db.execute(sql)
        for sql in indexes:
            db.execute(sql)
        migration.validate(db)
    result = copy.deepcopy(package)
    existing = result.setdefault('emblem_build', {})
    if not isinstance(existing, dict) or 'tables' in existing:
        raise ValueError('an existing backup manifest requires explicit review')
    existing['tables'] = [{'name': name, 'schema': tables[name]}
                          for name in TABLES + OPTIONAL if name in tables]
    return result


def prepare(package_path, evidence_path, destination):
    result = generate(json.loads(Path(package_path).read_text()), json.loads(Path(evidence_path).read_text()))
    # Exclusive creation refuses overwrite and symlink destinations, including the input package.
    with Path(destination).open('x') as output:
        output.write(json.dumps(result, indent=2) + '\n')
    return Path(destination)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package', help='existing package.json, preserved unchanged')
    parser.add_argument('schema', help='read-only sqlite_master rows (tables and explicit indexes)')
    parser.add_argument('destination', help='NEW package.json copy for review; not installed automatically')
    args = parser.parse_args()
    print(prepare(args.package, args.schema, args.destination))
