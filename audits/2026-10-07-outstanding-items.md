# StampySwap — outstanding-items worklist response (7 October 2026)

Work done this batch on top of the C01–C06 + read-order/redeem fixes, addressing the 2026-10-01
handoff's "retained gaps / deliver the verification package" and Codex's 7-Oct review. Custody stays
**closed** and maintenance **on**; nothing here reopens anything.

## Completed this batch (code + tests; `npm test` now 29 checks in audit-b + the rest, all green)

| Item (source) | What changed | Guard |
|---|---|---|
| Runtime `schema_ok=false` won't self-heal (7-Oct) | `ensureSchema()` re-runs the idempotent schema check on a background interval until it passes, so a transient boot-time `fetch failed` (DB API not up yet) heals in ~15s **without a manual restart**. `migrateSchema` was already idempotent. | existing B07 gate tests unchanged |
| C05 residual — recipient not bound (10-01) | SRC-20 guard now rejects a composed tx that does not pay the **requested** recipient (a dust output to a different address previously passed). Env `SRC20_REQUIRE_RECIPIENT` (default on). Explicitly **not** full semantic validation. | `C05-residual` (reject wrong recipient; still-signs when correct) |
| opComplete suppressed failures (10-01) | `opComplete` now retries + reads back, and **returns** whether it persisted; the mint response reports `op_completed:false`/`reconcile:true` instead of a clean success when it didn't. On-chain mint + accounting event remain durable (events authoritative) so it is non-insolvent and never re-mints. | `H4` |
| Maintenance UI buttons appear enabled (10-01) | `loadStatus` now disables an explicit id list of value-moving buttons (they bind via `addEventListener`, which the old handler-name matcher missed). Display-only; backend already 503s. | — (frontend) |
| Versioned schema/migration missing (10-01/7-Oct) | `migrations/001_custody_accounting.sql` + `migrations/README.md` — canonical idempotent DDL, apply procedure, the six uniqueness gates, rollback guidance. | matches verified live schema |
| Current-app CI missing (10-01) | `.github/workflows/ci.yml` — npm ci, lint, `npm test`, reproducible mainnet contract build, dep-advisory snapshot. | — |

## Enforced redeemability exclusion for the excess devnet supply (Codex 7-Oct)

**Policy (now documented + enforced):** redeemability is governed by the **ledger**
(`collateral_ledger` collateral − redeemed, and `accounting_events` circulation), **not** by raw
on-chain Solana-devnet SPL supply. The excess devnet SPL (1500 $BALD, 0.1 PUDSEC) is **unbacked and
not redeemable.** Enforcement points, all already live:

1. **Solvency invariant** — a mint/redeem is checked against ledger collateral; the excess has no ledger
   backing, so it cannot be issued/credited.
2. **Burn-verified, owner-bound, exact-amount redeem** — a non-operator redeem requires a verified
   on-chain burn of the representation, bound to the burner, for the exact amount, consumed once
   (`consumed_burns`). The excess devnet tokens sit in an uncontrolled throwaway test wallet; no such
   burn can be produced against the ledger.
3. **Reserve-first redeem** — in-flight + released redemptions are bounded by circulating (D02), so total
   releases can never exceed the ledger circulation (140500 / 0.9), regardless of raw SPL supply.
4. **Gating** — custody release is gated (`custody_live=false`) and maintenance is on.

Root cause (devnet-only): early testing minted the full deposit to a throwaway devnet wallet and the
BTC-side redeems released + decremented the ledger without burning the devnet SPL (keys not held;
valueless devnet tokens). On the mainnet track mint/redeem are symmetric. Clean remedy (deferred,
value/write action, explicit go required): a devnet reset or an operator reconcile realigning raw devnet
supply to the ledger. Independent tx references for verification are in the 7-Oct evidence reply
(deposit/mint/redeem txids for $BALD + PUDSEC on mempool.space / explorer.solana.com?cluster=devnet).

## Dependency advisory triage (17 entries: 1 critical, 4 high, 8 moderate, 4 low)

Cannot patch in this build sandbox (no registry access — `npm install` fetches nothing here); triage is
by advisory family + runtime reachability, to be remediated in the networked CI env (the new workflow
snapshots `npm audit` each run).

- **critical `proxy-addr`** (transitive via express `trust proxy`): our app does **not** derive auth or
  per-IP security from `req.ip` — auth is signature/operator-token based and rate-limiting is global
  behind the dashboard proxy — so the IP-trust advisory is **low reachability** here. Remediate by
  bumping the express line in a networked env; re-verify `npm test` after.
- **4 high / 8 moderate / 4 low**: predominantly transitive (Solana web3 deps, `bigint-buffer`, `qs`,
  crypto packages) per the prior report. Action: `npm audit` in CI, bump safe (non-breaking) versions,
  re-run the suite, and record justified residuals. **Not** auto-applying major bumps (they churn the
  Solana/ethers stacks). This is explicitly still open.

## Still outstanding / explicitly not done (honest)

- **Full SRC-20 semantic PSBT decode** (tick/amount/destination inside the protocol payload) — needs a
  real sanitized compose sample; recipient-binding above is a heuristic, not complete validation.
- **Dependency bumps** — need network; triaged only.
- **Multi-worker staging soak** + the complete deposit→issuance→burn→withdrawal staging journey — the app
  currently serves a single worker (per `/api/version` instance_id); the lock + fail-closed reads are
  designed for either single-writer or multi-worker, but a real soak is operational.
- **Independent chain-vs-ledger reconciliation** of on-chain vault balances vs recorded collateral.
- **Event-log compaction** — deferred (cannot drop a replayable event_key safely).
- **Lint** could not be run in this sandbox (devDeps pruned; network restricted); CI runs it.

No reopening, deploy of value actions, mint/burn/sign/broadcast, or balance rewrite was performed.
