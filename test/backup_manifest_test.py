import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('manifest', ROOT / 'scripts/prepare-backup-manifest.py')
manifest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manifest)


def schema():
    ddl = {
        'canonical_assets': 'id INTEGER PRIMARY KEY',
        'representations': 'id INTEGER PRIMARY KEY, canonical_id INTEGER, dest_chain TEXT, UNIQUE(canonical_id,dest_chain)',
        'collateral_ledger': 'id INTEGER PRIMARY KEY, btc_txid TEXT',
        'operations': 'op_key TEXT PRIMARY KEY', 'consumed_burns': 'burn_txid TEXT PRIMARY KEY',
        'asset_locks': 'asset_id INTEGER PRIMARY KEY', 'accounting_events': 'event_key TEXT PRIMARY KEY',
        'bridge_ops': 'id INTEGER PRIMARY KEY,burn_txid TEXT UNIQUE',
        'stamp_bridges': 'id INTEGER PRIMARY KEY', 'pools': 'id INTEGER PRIMARY KEY',
        'supported_chains': 'chain TEXT PRIMARY KEY'
    }
    rows = [{'type': 'table', 'name': name, 'tbl_name': name, 'sql': f'CREATE TABLE {name} ({columns})'}
            for name, columns in ddl.items()]
    rows.append({'type': 'index', 'name': 'btc_once', 'tbl_name': 'collateral_ledger',
                 'sql': 'CREATE UNIQUE INDEX btc_once ON collateral_ledger(btc_txid) WHERE btc_txid IS NOT NULL'})
    return rows


class BackupManifestTests(unittest.TestCase):
    def test_prepares_complete_copy_without_changing_source_or_overwriting(self):
        with tempfile.TemporaryDirectory() as tmp:
            original, evidence, dest = [Path(tmp) / name for name in ['package.json', 'schema.json', 'review.json']]
            original.write_text(json.dumps({'name': 'stampyswap', 'scripts': {'start': 'node server.js'}}))
            before = original.read_bytes()
            evidence.write_text(json.dumps({'rows': schema(), 'rowCount': len(schema()), 'truncated': False}))
            manifest.prepare(original, evidence, dest)
            result = json.loads(dest.read_text())
            self.assertEqual([t['name'] for t in result['emblem_build']['tables']], list(manifest.TABLES))
            self.assertTrue(all(t['schema'].startswith('CREATE TABLE IF NOT EXISTS') for t in result['emblem_build']['tables']))
            self.assertEqual(original.read_bytes(), before)
            with self.assertRaises(FileExistsError):
                manifest.prepare(original, evidence, original)
            self.assertEqual(original.read_bytes(), before)

    def test_rejects_truncated_or_missing_table_evidence(self):
        package = {'name': 'stampyswap'}
        with self.assertRaises(ValueError):
            manifest.generate(package, {'rows': schema(), 'truncated': True})
        with self.assertRaises(ValueError):
            manifest.generate(package, schema()[1:])

    def test_rejects_missing_financial_index_and_additional_sql_statements(self):
        with self.assertRaises(ValueError):
            manifest.generate({'name': 'stampyswap'}, schema()[:-1])
        rows = schema(); rows[-1]['sql'] += '; DROP TABLE operations;'
        with self.assertRaises(Exception):
            manifest.generate({'name': 'stampyswap'}, rows)

    def test_refuses_authentication_tables_and_existing_manifest_replacement(self):
        rows = schema() + [{'type': 'table', 'name': 'wallet_sessions', 'sql': 'CREATE TABLE wallet_sessions (token TEXT)'}]
        with self.assertRaises(ValueError):
            manifest.generate({'name': 'stampyswap'}, rows)
        with self.assertRaises(ValueError):
            manifest.generate({'name': 'stampyswap', 'emblem_build': {'tables': []}}, schema())
