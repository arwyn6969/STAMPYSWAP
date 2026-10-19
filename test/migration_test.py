import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('migration', Path(__file__).resolve().parent.parent / 'scripts/prepare-migration.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationTests(unittest.TestCase):
    def fixture(self, path, duplicate=False, missing_gate=False):
        with sqlite3.connect(path) as db:
            db.executescript('''
                CREATE TABLE operations(op_key TEXT PRIMARY KEY);
                CREATE TABLE consumed_burns(burn_txid TEXT PRIMARY KEY);
                CREATE TABLE collateral_ledger(btc_txid TEXT);
                CREATE UNIQUE INDEX btc_identity ON collateral_ledger(btc_txid) WHERE btc_txid IS NOT NULL;
                CREATE TABLE bridge_ops(burn_txid TEXT UNIQUE);
                CREATE TABLE asset_locks(asset_id INTEGER PRIMARY KEY);
                CREATE TABLE accounting_events(event_key TEXT PRIMARY KEY,rep_id INTEGER,delta_base TEXT);
                CREATE TABLE representations(id INTEGER PRIMARY KEY,canonical_id INTEGER,dest_chain TEXT);
                INSERT INTO representations VALUES(1,1,'base');
                INSERT INTO accounting_events VALUES('baseline:1',1,'100000000000000000000');
            ''')
            if duplicate:
                db.execute("INSERT INTO representations VALUES(2,1,'base')")
            if missing_gate:
                db.execute('DROP TABLE operations')
                db.execute('CREATE TABLE operations(op_key TEXT)')

    def test_preserves_source_and_events_and_is_repeatable(self):
        with tempfile.TemporaryDirectory() as folder:
            src, out, repeat = [Path(folder) / n for n in ['source.db', 'out.db', 'repeat.db']]
            self.fixture(src)
            original = src.read_bytes()
            migration.prepare(src, out)
            self.assertEqual(src.read_bytes(), original)
            with sqlite3.connect(out) as db:
                self.assertEqual(db.execute('SELECT * FROM accounting_events').fetchall(), [('baseline:1',1,'100000000000000000000')])
                self.assertEqual(db.execute('SELECT count(*) FROM schema_migrations').fetchone()[0], 2)
            migration.prepare(out, repeat)
            with sqlite3.connect(repeat) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM schema_migrations').fetchone()[0], 2)

    def test_refuses_duplicate_identities_and_cleans_failed_copy(self):
        with tempfile.TemporaryDirectory() as folder:
            src, out = [Path(folder) / n for n in ['source.db', 'out.db']]
            self.fixture(src, duplicate=True)
            with self.assertRaises(sqlite3.IntegrityError):
                migration.prepare(src, out)
            self.assertFalse(out.exists())

    def test_missing_gate_refuses_migration(self):
        with tempfile.TemporaryDirectory() as folder:
            src, out = [Path(folder) / n for n in ['source.db', 'out.db']]
            self.fixture(src, missing_gate=True)
            with self.assertRaises(ValueError):
                migration.prepare(src, out)
            self.assertFalse(out.exists())

    def test_never_overwrites_destination(self):
        with tempfile.TemporaryDirectory() as folder:
            src, out = [Path(folder) / n for n in ['source.db', 'out.db']]
            self.fixture(src)
            out.write_bytes(b'preserve me')
            with self.assertRaises(ValueError):
                migration.prepare(src, out)
            self.assertEqual(out.read_bytes(), b'preserve me')


if __name__ == '__main__':
    unittest.main()
