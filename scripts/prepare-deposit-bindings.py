"""Add reviewed historical deposit aliases ONLY to a NEW private SQLite copy.

This tool does not credit/mint, change original rows, or lift the application's gates.
A pinned proposal is an operator review input, not independent on-chain verification.
"""
import argparse
from contextlib import closing
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3

TABLES = {'canonical_assets', 'representations', 'collateral_ledger', 'operations',
          'consumed_burns', 'asset_locks', 'accounting_events', 'bridge_ops',
          'stamp_bridges', 'pools', 'supported_chains', 'schema_migrations',
          'consumed_deposits', 'sqlite_sequence'}
SCHEMA = """CREATE TABLE consumed_deposits (
 claim_key TEXT PRIMARY KEY NOT NULL,
 legacy_ledger_id INTEGER NOT NULL UNIQUE REFERENCES collateral_ledger(id),
 canonical_id INTEGER NOT NULL REFERENCES canonical_assets(id),
 source_chain TEXT NOT NULL CHECK(source_chain='bitcoin'),
 source_protocol TEXT NOT NULL CHECK(source_protocol='counterparty'),
 asset TEXT NOT NULL,
 legacy_key TEXT NOT NULL,
 source_address TEXT NOT NULL,
 vault_address TEXT NOT NULL,
 amount TEXT NOT NULL,
 source_decimals INTEGER NOT NULL CHECK(source_decimals BETWEEN 0 AND 18),
 quantity_base TEXT NOT NULL,
 block_index INTEGER NOT NULL CHECK(block_index>0),
 evidence_sha256 TEXT NOT NULL,
 proposal_sha256 TEXT NOT NULL
)"""
TRIGGERS = (
 "CREATE TRIGGER consumed_deposits_no_update BEFORE UPDATE ON consumed_deposits BEGIN SELECT RAISE(ABORT, 'consumed deposit aliases are immutable'); END",
 "CREATE TRIGGER consumed_deposits_no_delete BEFORE DELETE ON consumed_deposits BEGIN SELECT RAISE(ABORT, 'consumed deposit aliases are immutable'); END",
 "CREATE TRIGGER consumed_deposits_no_replace BEFORE INSERT ON consumed_deposits WHEN EXISTS(SELECT 1 FROM consumed_deposits WHERE claim_key=NEW.claim_key OR legacy_ledger_id=NEW.legacy_ledger_id) BEGIN SELECT RAISE(ABORT, 'consumed deposit aliases cannot be replaced'); END",
)
FIELDS = ('claim_key', 'legacy_ledger_id', 'canonical_id', 'source_chain',
          'source_protocol', 'asset', 'legacy_key', 'source_address', 'vault_address',
          'amount', 'source_decimals', 'quantity_base', 'block_index',
          'evidence_sha256', 'proposal_sha256')
HASH = re.compile(r'[0-9a-f]{64}')


def quote(value):
    return '"' + value.replace('"', '""') + '"'


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def migration():
    spec = importlib.util.spec_from_file_location('migration', Path(__file__).with_name('prepare-migration.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def objects(db):
    return list(db.execute("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='consumed_deposits' ORDER BY type,name"))


def validate_schema(db):
    with closing(sqlite3.connect(':memory:')) as expected:
        expected.execute(SCHEMA)
        for statement in TRIGGERS:
            expected.execute(statement)
        if objects(db) != objects(expected):
            raise ValueError('consumed-deposit schema/immutability mismatch')


def base_units(value, decimals):
    if not isinstance(value, str) or len(value) > 256 or not re.fullmatch(r'(0|[1-9][0-9]*)(\.[0-9]+)?', value):
        raise ValueError('amount must be an exact positive decimal string')
    whole, _, fraction = value.partition('.')
    if len(fraction) > decimals:
        raise ValueError('amount exceeds source precision')
    result = int(whole) * 10 ** decimals + int((fraction + '0' * decimals)[:decimals] or '0')
    if result <= 0:
        raise ValueError('amount must be positive')
    return str(result)


def reviewed_claims(proposal_path, expected_hash):
    raw = Path(proposal_path).read_bytes()
    if not isinstance(expected_hash, str) or not HASH.fullmatch(expected_hash) or hashlib.sha256(raw).hexdigest() != expected_hash:
        raise ValueError('reviewed proposal hash mismatch')
    proposal = json.loads(raw)
    evidence = proposal.get('evidence_sha256')
    if not isinstance(evidence, str) or not HASH.fullmatch(evidence):
        raise ValueError('reviewed public-evidence digest required')
    claims = proposal.get('claims')
    if not isinstance(claims, list) or not claims or len(claims) > 100:
        raise ValueError('bounded nonempty reviewed claims required')
    keys, ids, result = set(), set(), []
    for claim in claims:
        if not isinstance(claim, dict):
            raise ValueError('invalid claim')
        for field in ('legacy_ledger_id', 'canonical_id', 'block_index'):
            if type(claim.get(field)) is not int or not 0 < claim[field] < 2**63:
                raise ValueError('invalid positive identity/block')
        dec = claim.get('source_decimals')
        if type(dec) is not int or not 0 <= dec <= 18:
            raise ValueError('invalid source decimals')
        for field in ('asset', 'source_address', 'vault_address', 'legacy_key'):
            if not isinstance(claim.get(field), str) or not claim[field] or len(claim[field]) > 256:
                raise ValueError('missing bounded binding field')
        tx = claim.get('tx_hash')
        if not isinstance(tx, str) or not HASH.fullmatch(tx) or claim.get('claim_key') != 'xcp:' + tx:
            raise ValueError('exact lowercase Counterparty tx identity required')
        if claim.get('source_chain') != 'bitcoin' or claim.get('source_protocol') != 'counterparty' or claim.get('preserve_original_row') is not True:
            raise ValueError('unexpected protocol or historical rewrite requested')
        if claim.get('legacy_key') != 'xcp:' + claim['asset'] + ':' + claim.get('amount', ''):
            raise ValueError('legacy identity differs from reviewed amount/asset')
        if base_units(claim.get('amount'), dec) != claim.get('quantity_base'):
            raise ValueError('reviewed quantity does not match exact amount')
        if claim['claim_key'] in keys or claim['legacy_ledger_id'] in ids:
            raise ValueError('duplicate claim/legacy identity in proposal')
        keys.add(claim['claim_key']); ids.add(claim['legacy_ledger_id'])
        result.append({**claim, 'evidence_sha256': evidence, 'proposal_sha256': expected_hash})
    return result


def verify_credit(db, claim):
    db.row_factory = sqlite3.Row
    row = db.execute('SELECT * FROM collateral_ledger WHERE id=?', (claim['legacy_ledger_id'],)).fetchone()
    asset = db.execute('SELECT * FROM canonical_assets WHERE id=?', (claim['canonical_id'],)).fetchone()
    db.row_factory = None
    if not row or not asset:
        raise ValueError('reviewed historical credit or canonical asset missing')
    if row['canonical_id'] != claim['canonical_id'] or row['direction'] != 'deposit' or row['status'] != 'confirmed' or row['btc_txid'] != claim['legacy_key'] or row['vault_address'] != claim['vault_address']:
        raise ValueError('historical credit binding mismatch')
    if asset['source_chain'] != claim['source_chain'] or asset['source_protocol'] != claim['source_protocol'] or asset['exact_ticker'] != claim['asset'] or type(asset['decimals']) is not int or asset['decimals'] != claim['source_decimals']:
        raise ValueError('canonical identity/precision mismatch')
    if base_units(row['amount'], claim['source_decimals']) != claim['quantity_base']:
        raise ValueError('historical amount mismatch')
    if db.execute('SELECT 1 FROM collateral_ledger WHERE btc_txid=?', (claim['claim_key'],)).fetchone():
        raise ValueError('real send already has a collateral record')
    key = 'deposit-mint:' + claim['claim_key']
    if db.execute('SELECT 1 FROM operations WHERE op_key=? OR op_key LIKE ?', (key, key + ':%')).fetchone():
        raise ValueError('real send already has an operation')


def table_state(db, excluded=()):
    names = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name") if r[0] not in excluded]
    return {name: (db.execute('SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=?', (name,)).fetchone()[0],
                   sorted(db.execute('SELECT * FROM ' + quote(name)).fetchall(), key=repr)) for name in names}


def prepare(source, destination, proposal_path, source_sha256, proposal_sha256):
    claims = reviewed_claims(proposal_path, proposal_sha256)
    source = Path(source).resolve(strict=True)
    destination = Path(os.path.abspath(destination))
    if not isinstance(source_sha256, str) or not HASH.fullmatch(source_sha256) or digest(source) != source_sha256:
        raise ValueError('immutable source-copy hash mismatch')
    if any(Path(str(source) + suffix).exists() for suffix in ('-wal', '-shm', '-journal')):
        raise ValueError('source must be a closed immutable copy, without journal sidecars')
    if source == destination.resolve():
        raise ValueError('source cannot be overwritten')
    fd = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    db = None
    try:
        with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as src:
            names = {r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if names - TABLES or not TABLES.difference({'schema_migrations', 'consumed_deposits', 'sqlite_sequence'}).issubset(names):
                raise ValueError('source must be application-only; auth/unexpected/missing tables refused')
            migration().validate(src)
            before = table_state(src, ('consumed_deposits',))
            before_objects = list(src.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name<>'consumed_deposits' ORDER BY type,name"))
            db = sqlite3.connect(destination)
            src.backup(db)
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('BEGIN IMMEDIATE')
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='consumed_deposits'").fetchone():
            db.execute(SCHEMA)
            for statement in TRIGGERS:
                db.execute(statement)
        validate_schema(db)
        for claim in claims:
            verify_credit(db, claim)
            prior = db.execute('SELECT ' + ','.join(FIELDS) + ' FROM consumed_deposits WHERE claim_key=? OR legacy_ledger_id=?',
                               (claim['claim_key'], claim['legacy_ledger_id'])).fetchall()
            values = tuple(claim[field] for field in FIELDS)
            if prior:
                if prior != [values]:
                    raise ValueError('conflicting existing consumed identity')
            else:
                db.execute('INSERT INTO consumed_deposits(' + ','.join(FIELDS) + ') VALUES(' + ','.join('?' for _ in FIELDS) + ')', values)
            if db.execute('SELECT ' + ','.join(FIELDS) + ' FROM consumed_deposits WHERE claim_key=?', (claim['claim_key'],)).fetchone() != values:
                raise ValueError('consumed identity readback mismatch')
        # No affected confirmed synthetic credit may be left unmapped. Existing mappings
        # are accepted only when their full exact reviewed values are in this proposal.
        for cid in {c['canonical_id'] for c in claims}:
            historic = {r[0] for r in db.execute("SELECT id FROM collateral_ledger WHERE canonical_id=? AND direction='deposit' AND status='confirmed' AND btc_txid LIKE 'xcp:%:%'", (cid,))}
            proposed = {c['legacy_ledger_id'] for c in claims if c['canonical_id'] == cid}
            if historic != proposed:
                raise ValueError('an affected asset has unreviewed synthetic credits')
        after_objects = list(db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name<>'consumed_deposits' ORDER BY type,name"))
        if table_state(db, ('consumed_deposits',)) != before or after_objects != before_objects:
            raise ValueError('original application rows/schema/sequences changed')
        migration().validate(db)
        if digest(source) != source_sha256 or any(Path(str(source) + suffix).exists() for suffix in ('-wal', '-shm', '-journal')):
            raise ValueError('source changed during copy preparation')
        if db.execute('SELECT count(*) FROM consumed_deposits').fetchone()[0] != len(claims):
            raise ValueError('unreviewed extra consumed identity')
        db.commit()
        validate_schema(db)
        if db.execute('SELECT count(*) FROM consumed_deposits').fetchone()[0] != len(claims):
            raise ValueError('post-commit readback failed')
        db.close(); db = None
        return {'source_sha256': source_sha256, 'proposal_sha256': proposal_sha256,
                'output_sha256': digest(destination), 'reviewed_bindings': len(claims),
                'original_rows_schema_and_sequences': 'unchanged', 'seven_uniqueness_gates': 'pass',
                'application_gate_lifted': False, 'production_write': False}
    except BaseException:
        if db is not None:
            db.close(); db = None
        destination.unlink(missing_ok=True)
        raise
    finally:
        if db is not None:
            db.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', help='closed immutable application-only private SQLite copy')
    parser.add_argument('proposal', help='already reviewed exact historical binding proposal JSON')
    parser.add_argument('destination', help='NEW private review-copy database; never installed')
    parser.add_argument('--source-sha256', required=True)
    parser.add_argument('--proposal-sha256', required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.source, args.destination, args.proposal, args.source_sha256, args.proposal_sha256), indent=2))
