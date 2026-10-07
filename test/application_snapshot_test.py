import copy
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('snapshot', ROOT.parent / 'scripts/application-snapshot.py')
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)
EVIDENCE = json.loads((ROOT / 'fixtures/custody-schema-110dc3c.json').read_text())


def populate(path):
    db = sqlite3.connect(path)
    db.execute('PRAGMA journal_mode=WAL')
    for row in EVIDENCE['rows']:
        if row['type'] == 'table':
            db.execute(row['sql'])
    for row in EVIDENCE['rows']:
        if row['type'] == 'index':
            db.execute(row['sql'])
    db.execute('CREATE TABLE wallet_sessions(token TEXT)')
    db.execute("INSERT INTO wallet_sessions VALUES('DO_NOT_EXPORT')")
    db.execute('INSERT INTO canonical_assets(id,exact_ticker,metadata_json,updated_at) VALUES(?,?,?,?)',
               (9007199254740993, "A'\n雪", bytes.fromhex('00ff'), 9223372036854775807))
    db.execute('UPDATE canonical_assets SET decimals=2.125')
    db.execute('INSERT INTO collateral_ledger(canonical_id,direction,amount,btc_txid,status) VALUES(?,?,?,?,?)',
               (9007199254740993, 'deposit', '0.100000000000000001', 'fixed-deposit', 'confirmed'))
    db.execute('INSERT INTO representations(canonical_id,dest_chain,circulating_supply) VALUES(?,?,?)',
               (9007199254740993, 'testnet', '0.100000000000000001'))
    db.execute('UPDATE sqlite_sequence SET seq=999 WHERE name=?', ('collateral_ledger',))
    db.commit()
    return db


def capture(db):
    row = db.execute(snapshot.build_query(EVIDENCE)).fetchone()
    return {'rows': [{'snapshot_hex': row[0]}], 'rowCount': 1, 'truncated': False}


def alter(envelope, change):
    result = copy.deepcopy(envelope)
    value = json.loads(bytes.fromhex(result['rows'][0]['snapshot_hex']))
    change(value)
    result['rows'][0]['snapshot_hex'] = json.dumps(value).encode().hex()
    return result


class SnapshotTests(unittest.TestCase):
    def test_exact_roundtrip_retains_integer_text_blob_unicode_rowids_indexes_and_sequences(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = populate(Path(tmp) / 'source.db')
            envelope = capture(src)
            data = bytes.fromhex(envelope['rows'][0]['snapshot_hex'])
            self.assertNotIn(b'DO_NOT_EXPORT', data)
            self.assertNotIn(b'wallet_sessions', data)
            dest = Path(tmp) / 'copy.db'
            report = snapshot.restore(envelope, dest)
            with closing(sqlite3.connect(dest)) as copydb:
                for row in EVIDENCE['rows']:
                    if row['type'] == 'table':
                        table = snapshot.quote(row['name'])
                        self.assertEqual(src.execute('SELECT rowid,* FROM ' + table).fetchall(),
                                         copydb.execute('SELECT rowid,* FROM ' + table).fetchall())
                self.assertEqual(src.execute('SELECT name,seq FROM sqlite_sequence ORDER BY name').fetchall(),
                                 copydb.execute('SELECT name,seq FROM sqlite_sequence ORDER BY name').fetchall())
                self.assertEqual(report['row_counts']['canonical_assets'], 1)
                self.assertEqual(copydb.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            src.close()

    def test_refuses_truncation_incomplete_scope_dirty_reads_count_changes_and_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = populate(Path(tmp) / 'source.db')
            envelope = capture(src)
            for bad in (dict(envelope, truncated=True),
                        alter(envelope, lambda data: data['tables'].pop('operations')),
                        alter(envelope, lambda data: data.update(read_uncommitted=1)),
                        alter(envelope, lambda data: data['tables']['canonical_assets'].update(row_count=2))):
                dest = Path(tmp) / 'refused.db'
                with self.assertRaises(ValueError):
                    snapshot.restore(bad, dest)
                self.assertFalse(dest.exists())
            existing = Path(tmp) / 'existing.db'
            existing.write_bytes(b'preserve')
            with self.assertRaises(FileExistsError):
                snapshot.restore(envelope, existing)
            self.assertEqual(existing.read_bytes(), b'preserve')
            src.close()

    def test_single_statement_keeps_one_snapshot_during_a_concurrent_committed_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'source.db'
            src = populate(path)
            writer = sqlite3.connect(path)
            changed = []
            def commit_during_read():
                if not changed:
                    writer.execute('BEGIN')
                    writer.execute("UPDATE canonical_assets SET exact_ticker='new-version'")
                    writer.execute("UPDATE collateral_ledger SET amount='999'")
                    writer.commit()
                    changed.append(True)
                return 0
            query = snapshot.build_query(EVIDENCE)
            src.set_progress_handler(commit_during_read, 100)
            envelope = {'rows': [{'snapshot_hex': src.execute(query).fetchone()[0]}], 'rowCount': 1, 'truncated': False}
            src.set_progress_handler(None, 0)
            self.assertEqual(changed, [True])
            dest = Path(tmp) / 'copy.db'
            snapshot.restore(envelope, dest)
            with closing(sqlite3.connect(dest)) as copydb:
                self.assertEqual(copydb.execute('SELECT exact_ticker FROM canonical_assets').fetchone()[0], "A'\n雪")
                self.assertEqual(copydb.execute('SELECT amount FROM collateral_ledger').fetchone()[0], '0.100000000000000001')
            self.assertEqual(writer.execute('SELECT amount FROM collateral_ledger').fetchone()[0], '999')
            writer.close()
            src.close()

    def test_schema_change_or_invalid_foreign_key_never_yields_an_accepted_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = populate(Path(tmp) / 'source.db')
            src.execute('ALTER TABLE canonical_assets ADD COLUMN unexpected TEXT')
            envelope = capture(src)
            with self.assertRaises(ValueError):
                snapshot.restore(envelope, Path(tmp) / 'changed.db')
            self.assertFalse((Path(tmp) / 'changed.db').exists())
            src.close()
            orphan = populate(Path(tmp) / 'orphan.db')
            orphan.execute('UPDATE representations SET canonical_id=1234')
            orphan.commit()
            with self.assertRaisesRegex(ValueError, 'foreign key'):
                snapshot.restore(capture(orphan), Path(tmp) / 'orphan-copy.db')
            self.assertFalse((Path(tmp) / 'orphan-copy.db').exists())
            orphan.close()

    def test_roundtrips_finite_real_extremes_and_rejects_nonfinite_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = populate(Path(tmp) / 'source.db')
            values = (0.10000000000000002, float.fromhex('0x1.fffffffffffffp+1023'),
                      float.fromhex('0x0.0000000000001p-1022'))
            for index, value in enumerate(values):
                src.execute('UPDATE canonical_assets SET decimals=?', (value,))
                src.commit()
                dest = Path(tmp) / ('copy-' + str(index) + '.db')
                snapshot.restore(capture(src), dest)
                with closing(sqlite3.connect(dest)) as copydb:
                    self.assertEqual(copydb.execute('SELECT decimals FROM canonical_assets').fetchone()[0], value)
            src.execute('UPDATE canonical_assets SET decimals=?', (float('inf'),))
            src.commit()
            with self.assertRaises(ValueError):
                snapshot.restore(capture(src), Path(tmp) / 'infinite.db')
            self.assertFalse((Path(tmp) / 'infinite.db').exists())
            src.close()


if __name__ == '__main__':
    unittest.main()
