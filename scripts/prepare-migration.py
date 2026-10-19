"""Prepare and validate a migrated COPY of a supplied SQLite snapshot. Never alters the source."""
import argparse
from contextlib import closing
import hashlib
from pathlib import Path
import sqlite3


GATES = [('operations', 'op_key'), ('consumed_burns', 'burn_txid'),
         ('collateral_ledger', 'btc_txid'), ('bridge_ops', 'burn_txid'),
         ('asset_locks', 'asset_id'), ('accounting_events', 'event_key')]


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def unique_columns(db, table, expected, allow_nonnull=False):
    info = list(db.execute('PRAGMA table_info(' + quote(table) + ')'))
    primary = [row[1] for row in sorted(info, key=lambda r: r[5]) if row[5]]
    if primary == expected:
        return True
    for idx in db.execute('PRAGMA index_list(' + quote(table) + ')'):
        if not idx[2]:
            continue
        cols = [r[2] for r in db.execute('PRAGMA index_info(' + quote(idx[1]) + ')')]
        if cols != expected:
            continue
        if idx[4]:
            ddl = db.execute('SELECT sql FROM sqlite_master WHERE name=?', (idx[1],)).fetchone()[0]
            predicate = ddl.lower().split('where', 1)[-1].strip().rstrip(';')
            if not allow_nonnull or predicate != expected[0] + ' is not null':
                continue
        return True
    return False


def validate(db):
    for table, col in GATES:
        if not unique_columns(db, table, [col], allow_nonnull=(table == 'collateral_ledger')):
            raise ValueError('missing uniqueness gate: ' + table + '.' + col)
    if not (unique_columns(db, 'representations', ['canonical_id', 'dest_chain']) or
            unique_columns(db, 'representations', ['dest_chain', 'canonical_id'])):
        raise ValueError('representation identity constraint missing')
    if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        raise ValueError('SQLite integrity check failed')
    if db.execute('PRAGMA foreign_key_check').fetchone():
        raise ValueError('foreign key check failed')


def prepare(source, destination):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if not source.is_file():
        raise ValueError('source snapshot is missing')
    if destination.exists() or source == destination:
        raise ValueError('destination must be a new file; source cannot be overwritten')
    # Exclusive file creation prevents an accidental overwrite or following a supplied symlink.
    with destination.open('xb'):
        pass
    db = None
    try:
        with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as src:
            db = sqlite3.connect(destination)
            src.backup(db)
        db.execute('BEGIN IMMEDIATE')
        db.execute('CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, sha256 TEXT NOT NULL)')
        for migration in sorted((Path(__file__).resolve().parent.parent / 'migrations').glob('*.sql')):
            content = migration.read_text()
            digest = hashlib.sha256(content.encode()).hexdigest()
            prior = db.execute('SELECT sha256 FROM schema_migrations WHERE version=?', (migration.name,)).fetchone()
            if prior:
                if prior[0] != digest:
                    raise ValueError('an applied migration was changed: ' + migration.name)
                continue
            # SQLite decides where statements end: semicolons inside comments or string
            # literals must not split the canonical DDL, and executescript would commit
            # our outer transaction before the validation checks.
            statement = ''
            for char in content:
                statement += char
                if char == ';' and sqlite3.complete_statement(statement):
                    db.execute(statement)
                    statement = ''
            if statement.strip():
                db.execute(statement)
            db.execute('INSERT INTO schema_migrations VALUES(?,?)', (migration.name, digest))
        validate(db)
        db.commit()
    except BaseException:
        if db is not None:
            db.close()
        destination.unlink(missing_ok=True)
        raise
    finally:
        if db is not None:
            db.close()
    return destination


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', help='read-only SQLite snapshot of the known 110dc3c schema')
    parser.add_argument('destination', help='new local file for the migrated copy')
    args = parser.parse_args()
    print(prepare(args.source, args.destination))
