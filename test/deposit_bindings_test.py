import copy
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


bindings = module('prepare-deposit-bindings')
snapshot = module('application-snapshot')
manifest = module('prepare-backup-manifest')
EVIDENCE = json.loads((ROOT / 'test/fixtures/custody-schema-110dc3c.json').read_text())


def fixture(path):
    with closing(sqlite3.connect(path)) as db, db:
        for row in EVIDENCE['rows']:
            db.execute(row['sql'])
        db.execute("INSERT INTO canonical_assets(id,source_protocol,exact_ticker,decimals) VALUES(1,'counterparty','COIN',8)")
        db.execute("INSERT INTO collateral_ledger(id,canonical_id,direction,amount,btc_txid,status,vault_address) VALUES(70,1,'deposit','1.25','xcp:COIN:1.25','confirmed','vault')")
        db.execute("INSERT INTO representations(id,canonical_id,dest_chain,circulating_supply) VALUES(1,1,'testnet','1')")
        db.execute("INSERT INTO accounting_events VALUES('baseline:1',1,'1000000000000000000',1)")
        db.execute("INSERT INTO consumed_burns VALUES('unrelated-burn','testnet',1,'redeem','owner','1',1)")
        db.execute("UPDATE sqlite_sequence SET seq=9999 WHERE name='collateral_ledger'")
    return {'evidence_sha256': 'ab' * 32, 'claims': [{
        'legacy_ledger_id': 70, 'canonical_id': 1, 'asset': 'COIN',
        'legacy_key': 'xcp:COIN:1.25', 'claim_key': 'xcp:' + '35' * 32,
        'tx_hash': '35' * 32, 'source_chain': 'bitcoin', 'source_protocol': 'counterparty',
        'source_address': 'source', 'vault_address': 'vault', 'amount': '1.25',
        'source_decimals': 8, 'quantity_base': '125000000', 'block_index': 123,
        'preserve_original_row': True}]}


class BindingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        self.src, self.out, self.proposal_path = [self.folder / name for name in ('source.db', 'review.db', 'proposal.json')]
        self.proposal = fixture(self.src)

    def prepare(self, source=None, destination=None):
        self.proposal_path.write_text(json.dumps(self.proposal, indent=2))
        source = source or self.src
        return bindings.prepare(source, destination or self.out, self.proposal_path,
                                bindings.digest(source), bindings.digest(self.proposal_path))

    def test_copy_adds_only_aliases_preserving_rows_events_burns_sequences_and_source(self):
        original = self.src.read_bytes()
        report = self.prepare()
        self.assertEqual(self.src.read_bytes(), original)
        self.assertFalse(report['application_gate_lifted'])
        self.assertFalse(report['production_write'])
        self.assertEqual(report['reviewed_bindings'], 1)
        with closing(sqlite3.connect(self.src)) as source, closing(sqlite3.connect(self.out)) as result:
            self.assertEqual(bindings.table_state(source), bindings.table_state(result, ('consumed_deposits',)))
            self.assertEqual(result.execute("SELECT seq FROM sqlite_sequence WHERE name='collateral_ledger'").fetchone()[0], 9999)
            self.assertEqual(result.execute('SELECT claim_key,legacy_ledger_id,amount FROM consumed_deposits').fetchall(), [('xcp:' + '35' * 32, 70, '1.25')])
            self.assertEqual(result.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertEqual(result.execute('PRAGMA foreign_key_check').fetchall(), [])
        self.assertEqual(self.out.stat().st_mode & 0o777, 0o600)

    def test_repeat_from_bound_copy_is_idempotent_without_recredit(self):
        self.prepare()
        repeat = self.folder / 'repeat.db'
        self.prepare(source=self.out, destination=repeat)
        with closing(sqlite3.connect(self.out)) as a, closing(sqlite3.connect(repeat)) as b:
            self.assertEqual(bindings.table_state(a), bindings.table_state(b))

    def test_aliases_cannot_be_updated_deleted_or_duplicated_across_connections(self):
        self.prepare()
        with closing(sqlite3.connect(self.out)) as a, closing(sqlite3.connect(self.out)) as b:
            row = a.execute('SELECT * FROM consumed_deposits').fetchone()
            for statement in ("UPDATE consumed_deposits SET quantity_base='999'", 'DELETE FROM consumed_deposits'):
                with self.assertRaises(sqlite3.IntegrityError):
                    a.execute(statement)
                a.rollback()
            for values in (row, ('xcp:' + '36' * 32,) + row[1:]):
                with self.assertRaises(sqlite3.IntegrityError):
                    b.execute('INSERT INTO consumed_deposits VALUES(' + ','.join('?' for _ in row) + ')', values)
                b.rollback()
            # REPLACE normally suppresses DELETE triggers when recursive_triggers is off.
            # A BEFORE INSERT conflict guard must prevent that immutability bypass too.
            altered = list(row)
            altered[7] = 'changed-source'
            with self.assertRaises(sqlite3.IntegrityError):
                b.execute('INSERT OR REPLACE INTO consumed_deposits VALUES(' + ','.join('?' for _ in row) + ')', altered)
            b.rollback()
            self.assertEqual(a.execute('SELECT * FROM consumed_deposits').fetchall(), [row])

    def test_hash_pins_refuse_unreviewed_proposal_and_changed_source(self):
        self.proposal_path.write_text(json.dumps(self.proposal))
        for source_hash, proposal_hash in (('00' * 32, bindings.digest(self.proposal_path)), (bindings.digest(self.src), '00' * 32)):
            with self.assertRaises(ValueError):
                bindings.prepare(self.src, self.out, self.proposal_path, source_hash, proposal_hash)
            self.assertFalse(self.out.exists())

    def test_missing_or_changed_credit_asset_precision_amount_and_vault_refuse(self):
        changes = [
            "DELETE FROM collateral_ledger", "UPDATE collateral_ledger SET status='failed'",
            "UPDATE collateral_ledger SET direction='withdraw'", "UPDATE collateral_ledger SET amount='1.25000001'",
            "UPDATE collateral_ledger SET vault_address='other'", "UPDATE collateral_ledger SET btc_txid='xcp:OTHER:1.25'",
            "UPDATE canonical_assets SET source_protocol='acme'", "UPDATE canonical_assets SET decimals=0",
            "UPDATE canonical_assets SET exact_ticker='OTHER'", "UPDATE canonical_assets SET source_chain='other'",
        ]
        for i, statement in enumerate(changes):
            with self.subTest(statement=statement):
                src = self.folder / ('mismatch-' + str(i) + '.db')
                fixture(src)
                with closing(sqlite3.connect(src)) as db, db:
                    db.execute(statement)
                original = src.read_bytes()
                with self.assertRaises(ValueError):
                    self.prepare(source=src)
                self.assertFalse(self.out.exists())
                self.assertEqual(src.read_bytes(), original)

    def test_real_credit_or_reserved_completed_or_legacy_operation_refuses(self):
        identity = self.proposal['claims'][0]['claim_key']
        for i, state in enumerate(('real-credit', 'reserved', 'completed', 'legacy')):
            with self.subTest(state=state):
                src = self.folder / ('conflict-' + str(i) + '.db')
                fixture(src)
                with closing(sqlite3.connect(src)) as db, db:
                    if state == 'real-credit':
                        db.execute("INSERT INTO collateral_ledger(canonical_id,direction,amount,btc_txid,status) VALUES(1,'deposit','1.25',?,'failed')", (identity,))
                    else:
                        db.execute('INSERT INTO operations(op_key,state) VALUES(?,?)',
                                   ('deposit-mint:' + identity + (':testnet:other' if state == 'legacy' else ''), state))
                with self.assertRaises(ValueError):
                    self.prepare(source=src)
                self.assertFalse(self.out.exists())

    def test_duplicate_conflicting_or_malformed_review_proposals_refuse(self):
        original = copy.deepcopy(self.proposal)
        mutations = [
            lambda p: p['claims'].append(copy.deepcopy(p['claims'][0])),
            lambda p: p['claims'][0].update(tx_hash='A' * 64),
            lambda p: p['claims'][0].update(source_decimals=True),
            lambda p: p['claims'][0].update(amount='1e3'),
            lambda p: p['claims'][0].update(quantity_base='125000001'),
            lambda p: p['claims'][0].update(preserve_original_row=False),
            lambda p: p['claims'][0].update(source_protocol='acme'),
        ]
        for mutate in mutations:
            self.proposal = copy.deepcopy(original)
            mutate(self.proposal)
            with self.assertRaises((ValueError, TypeError)):
                self.prepare()
            self.assertFalse(self.out.exists())

    def test_additional_unmapped_synthetic_credit_refuses_partial_reconciliation(self):
        with closing(sqlite3.connect(self.src)) as db, db:
            db.execute("INSERT INTO collateral_ledger(canonical_id,direction,amount,btc_txid,status,vault_address) VALUES(1,'deposit','2','xcp:COIN:2','confirmed','vault')")
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.out.exists())

    def test_exception_after_alias_write_discards_output_and_preserves_original(self):
        before = self.src.read_bytes()
        with patch.object(bindings, 'table_state', side_effect=[{}, RuntimeError('injected after inserts')]):
            with self.assertRaises(RuntimeError):
                self.prepare()
        self.assertFalse(self.out.exists())
        self.assertEqual(self.src.read_bytes(), before)

    def test_refuses_original_existing_destination_and_dangling_symlink(self):
        with self.assertRaises(ValueError):
            self.prepare(destination=self.src)
        self.out.write_bytes(b'preserve')
        with self.assertRaises(FileExistsError):
            self.prepare()
        self.assertEqual(self.out.read_bytes(), b'preserve')
        self.out.unlink()
        target = self.folder / 'must-not-create.db'
        self.out.symlink_to(target)
        with self.assertRaises(FileExistsError):
            self.prepare()
        self.assertFalse(target.exists())

    def test_authentication_tables_and_journal_sidecars_refused(self):
        with closing(sqlite3.connect(self.src)) as db, db:
            db.execute('CREATE TABLE wallet_sessions(token TEXT)')
            db.execute("INSERT INTO wallet_sessions VALUES('DO_NOT_EXPORT')")
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.out.exists())
        with closing(sqlite3.connect(self.src)) as db, db:
            db.execute('DROP TABLE wallet_sessions')
        Path(str(self.src) + '-wal').write_bytes(b'not-a-closed-copy')
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.out.exists())

    def test_conflicting_existing_alias_or_weakened_schema_refuses(self):
        self.prepare()
        bad = self.folder / 'weakened.db'
        with closing(sqlite3.connect(self.out)) as source, closing(sqlite3.connect(bad)) as db, db:
            source.backup(db)
            db.execute('DROP TRIGGER consumed_deposits_no_update')
            db.execute("UPDATE consumed_deposits SET source_address='other'")
        with self.assertRaises(ValueError):
            self.prepare(source=bad, destination=self.folder / 'refused.db')
        self.assertFalse((self.folder / 'refused.db').exists())
        with closing(sqlite3.connect(bad)) as db, db:
            db.execute(bindings.TRIGGERS[0])
        with self.assertRaises(ValueError):
            self.prepare(source=bad, destination=self.folder / 'conflict.db')
        self.assertFalse((self.folder / 'conflict.db').exists())

    def test_lossless_snapshot_preserves_aliases_immutability_and_high_sequences(self):
        self.prepare()
        with closing(sqlite3.connect(self.out)) as source:
            rows = [dict(zip(('type', 'name', 'tbl_name', 'sql'), row)) for row in source.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name<>'sqlite_sequence' ORDER BY type,name")]
            evidence = {'rows': rows, 'rowCount': len(rows), 'truncated': False}
            package = manifest.generate({'name': 'stampyswap'}, evidence)
            self.assertIn('consumed_deposits', [t['name'] for t in package['emblem_build']['tables']])
            envelope = {'rows': [{'snapshot_hex': source.execute(snapshot.build_query(evidence)).fetchone()[0]}], 'rowCount': 1, 'truncated': False}
            restored = self.folder / 'restored.db'
            snapshot.restore(envelope, restored)
            with closing(sqlite3.connect(restored)) as result:
                self.assertEqual(bindings.table_state(source), bindings.table_state(result))
                bindings.validate_schema(result)
                with self.assertRaises(sqlite3.IntegrityError):
                    result.execute('DELETE FROM consumed_deposits')

    def test_incomplete_schema_export_or_missing_triggers_cannot_drop_alias_history(self):
        self.prepare()
        with closing(sqlite3.connect(self.out)) as source:
            # An old eleven-table schema must not yield an accepted capture of a bound DB.
            envelope = {'rows': [{'snapshot_hex': source.execute(snapshot.build_query(EVIDENCE)).fetchone()[0]}], 'rowCount': 1, 'truncated': False}
            with self.assertRaises(ValueError):
                snapshot.restore(envelope, self.folder / 'missing-aliases.db')
            rows = [dict(zip(('type', 'name', 'tbl_name', 'sql'), row)) for row in source.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name<>'sqlite_sequence' AND type<>'trigger'")]
            with self.assertRaises(ValueError):
                manifest.generate({'name': 'stampyswap'}, rows)


if __name__ == '__main__':
    unittest.main()
