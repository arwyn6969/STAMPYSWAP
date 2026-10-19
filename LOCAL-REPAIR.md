# Contained review candidate — 7 October 2026

Base: `110dc3c3f3d55dcfa3b49001d9a365faf3b698d9`, the current Emblem application. This proposal carries forward the earlier identity, database-envelope and accounting repairs, integrates the released completion-response contract, tests schema retries, strengthens payload presence, and applies compatible dependencies. Maintenance/custody configuration is unchanged.

Validation: 93 application checks, four migration-copy checks, lint, an identical mainnet artifact, and five independent prevention assertions that fail on the deployed base. Runtime advisories remain sixteen affected package entries, including four high. The critical proxy-addr entry is removed by its patched 2.0.8 version. Node 23.3.0 was used locally; CI uses Node 22 and must independently verify this exact proposal.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run lint
npm test
python3 -m unittest discover -s test -p '*_test.py' -v
node gen-erc20-mainnet.js
npm audit --omit=dev --audit-level=high
```

The last command is expected to fail while the four high entries remain. It now blocks CI instead of being ignored. Tests use local SQLite/HTTP and mocked chain/indexer/signer effects; they do not establish actual staging journeys or validate SRC-20 semantics.

See `audits/2026-10-07-outstanding-items.md` and `migrations/README.md` for the remaining evidence and migration procedure. No production write or financial action was performed. Do not deploy or reopen custody based only on these local results.
