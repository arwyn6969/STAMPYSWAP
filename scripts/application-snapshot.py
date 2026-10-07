"""Prepare one read-only SQLite snapshot query; restore its result only to a NEW local copy."""
import argparse
from contextlib import closing
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import sqlite3


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def quote(value):
    return '"' + value.replace('"', '""') + '"'


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def build_query(evidence):
    manifest = module('prepare-backup-manifest').generate({'name': 'stampyswap'}, evidence)
    definitions = manifest['emblem_build']['tables']
    names = [table['name'] for table in definitions]
    scope = ','.join(literal(name) for name in names)
    terms = []
    with closing(sqlite3.connect(':memory:')) as db:
        for table in definitions:
            db.execute(table['schema'])
        for name in names:
            columns = [row[1] for row in db.execute('PRAGMA table_info(' + quote(name) + ')')]
            if any(col.lower() in ('rowid', '_rowid_', 'oid') for col in columns):
                raise ValueError('shadowed rowids require a separate reviewed export')
            cells = []
            for column in columns:
                col = quote(column)
                cells.append("json_array(typeof(" + col + "),CASE typeof(" + col + ") "
                             "WHEN 'integer' THEN CAST(" + col + " AS TEXT) "
                             "WHEN 'real' THEN printf('%!.26g'," + col + ") "
                             "WHEN 'text' THEN hex(CAST(" + col + " AS BLOB)) "
                             "WHEN 'blob' THEN hex(" + col + ") ELSE NULL END)")
            table = quote(name)
            terms.extend([literal(name), "json_object('columns',json((SELECT json_group_array(name) "
                "FROM pragma_table_info(" + literal(name) + "))),'row_count',(SELECT COUNT(*) FROM " + table + "),"
                "'rows',json((SELECT json_group_array(json_array(CAST(rowid AS TEXT),json_array(" + ','.join(cells) +
                "))) FROM (SELECT rowid,* FROM " + table + " ORDER BY rowid))))"])
    # One SQL statement: no BEGIN/COMMIT round trips, no data writes, no auth tables.
    return "SELECT hex(CAST(json_object('format','stampyswap-application-snapshot-v1'," \
        "'captured_at',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'sqlite_version',sqlite_version()," \
        "'read_uncommitted',(SELECT read_uncommitted FROM pragma_read_uncommitted)," \
        "'schema',json((SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql_hex'," \
        "hex(CAST(sql AS BLOB)))) FROM (SELECT type,name,tbl_name,sql FROM sqlite_master " \
        "WHERE sql IS NOT NULL AND tbl_name IN (" + scope + ") ORDER BY type DESC,name)))," \
        "'tables',json_object(" + ','.join(terms) + "),'sequences',json((SELECT json_group_array(" \
        "json_array(name,CAST(seq AS TEXT))) FROM sqlite_sequence WHERE name IN (" + scope + ")))) AS BLOB)) AS snapshot_hex;\n"


def decode_cell(cell):
    if not isinstance(cell, list) or len(cell) != 2:
        raise ValueError('invalid typed cell')
    kind, value = cell
    if kind == 'null' and value is None:
        return None
    if not isinstance(value, str):
        raise ValueError('cell value must be lossless text')
    if kind == 'integer' and re.fullmatch(r'-?(0|[1-9][0-9]*)', value):
        result = int(value)
        if -(2 ** 63) <= result < 2 ** 63:
            return result
    elif kind == 'real':
        result = float(value)
        if math.isfinite(result):
            return result
    elif kind in ('text', 'blob') and re.fullmatch(r'(?:[0-9A-Fa-f]{2})*', value):
        result = bytes.fromhex(value)
        return result.decode('utf8') if kind == 'text' else result
    raise ValueError('unsupported/invalid SQLite cell')


def restore(envelope, destination):
    if not isinstance(envelope, dict) or envelope.get('error') or envelope.get('success') is False:
        raise ValueError('failed snapshot envelope')
    rows = envelope.get('rows')
    if envelope.get('truncated') is not False or envelope.get('rowCount') != 1 or not isinstance(rows, list) or len(rows) != 1:
        raise ValueError('snapshot must be exactly one untruncated result row')
    encoded = rows[0].get('snapshot_hex') if isinstance(rows[0], dict) else None
    if not isinstance(encoded, str) or len(encoded) > 32 * 1024 * 1024 or not re.fullmatch(r'(?:[0-9A-Fa-f]{2})+', encoded):
        raise ValueError('invalid/oversized snapshot hex')
    raw = bytes.fromhex(encoded)
    snapshot = json.loads(raw)
    if snapshot.get('format') != 'stampyswap-application-snapshot-v1' or snapshot.get('read_uncommitted') != 0:
        raise ValueError('unsupported snapshot or dirty-read isolation')
    schema = [{'type': row['type'], 'name': row['name'], 'tbl_name': row['tbl_name'],
               'sql': bytes.fromhex(row['sql_hex']).decode('utf8')} for row in snapshot['schema']]
    manifest = module('prepare-backup-manifest').generate({'name': 'stampyswap'}, schema)
    names = [table['name'] for table in manifest['emblem_build']['tables']]
    if set(snapshot['tables']) != set(names):
        raise ValueError('snapshot table scope is incomplete or unexpected')
    destination = Path(destination)
    with destination.open('xb'):
        pass
    db = None
    try:
        db = sqlite3.connect(destination)
        db.execute('BEGIN')
        for row in schema:
            if row['type'] == 'table':
                db.execute(row['sql'])
        counts = {}
        for name in names:
            table = snapshot['tables'][name]
            columns = [row[1] for row in db.execute('PRAGMA table_info(' + quote(name) + ')')]
            if columns != table['columns'] or type(table['row_count']) is not int or table['row_count'] != len(table['rows']):
                raise ValueError('snapshot columns/count mismatch: ' + name)
            fields = ['rowid'] + columns
            statement = 'INSERT INTO ' + quote(name) + '(' + ','.join(map(quote, fields)) + ') VALUES (' + ','.join('?' for _ in fields) + ')'
            for row in table['rows']:
                if not isinstance(row, list) or len(row) != 2 or len(row[1]) != len(columns):
                    raise ValueError('invalid snapshot row')
                rowid = decode_cell(['integer', row[0]])
                values = [decode_cell(cell) for cell in row[1]]
                db.execute(statement, [rowid] + values)
                stored = db.execute('SELECT rowid,' + ','.join(map(quote, columns)) + ' FROM ' + quote(name) + ' WHERE rowid=?', (rowid,)).fetchone()
                if stored != tuple([rowid] + values):
                    raise ValueError('restore changed a typed cell: ' + name)
            counts[name] = db.execute('SELECT COUNT(*) FROM ' + quote(name)).fetchone()[0]
            if counts[name] != table['row_count']:
                raise ValueError('restored row count mismatch')
        for row in schema:
            if row['type'] == 'index':
                db.execute(row['sql'])
        db.execute('DELETE FROM sqlite_sequence')
        seen_sequences = set()
        for name, value in snapshot['sequences']:
            sequence = decode_cell(['integer', value])
            if name not in names or name in seen_sequences or sequence < 0:
                raise ValueError('unexpected/duplicate sequence')
            seen_sequences.add(name)
            db.execute('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)', (name, sequence))
        module('prepare-migration').validate(db)
        db.commit()
    except BaseException:
        if db is not None:
            db.close()
        destination.unlink(missing_ok=True)
        raise
    finally:
        if db is not None:
            db.close()
    return {'snapshot_sha256': hashlib.sha256(raw).hexdigest(), 'captured_at': snapshot['captured_at'],
            'row_counts': counts, 'snapshot_bytes': len(raw), 'sqlite_version': snapshot['sqlite_version'],
            'restored_copy': str(destination), 'seven_uniqueness_gates': 'pass'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('query', 'restore'))
    parser.add_argument('source', help='schema JSON for query; exact result-envelope JSON for restore')
    parser.add_argument('destination', help='NEW SQL file or NEW private SQLite copy')
    args = parser.parse_args()
    data = json.loads(Path(args.source).read_text())
    if args.mode == 'query':
        with Path(args.destination).open('x') as output:
            output.write(build_query(data))
    else:
        print(json.dumps(restore(data, args.destination), indent=2))
