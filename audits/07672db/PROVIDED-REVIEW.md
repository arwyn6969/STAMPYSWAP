Re-audit of **`arwyn6969/STAMPYSWAP` @ `07672db`** (2026-09-21). Baseline was `2345961`. Eight hardening commits landed on `main`. This is written so you can paste it into the builder as-is.

---

**StampySwap re-audit — HEAD `07672db` (after 2345961 remediation)**

**Verdict:** containment is holding. Do **not** set `STAMPY_MAINTENANCE=0` yet. Custody stays **closed**. The original P0 vault-drain / fake-redeem / protocol-swap holes are no longer publicly reachable. The new durable-op work (`R05` part 1) is **incomplete and would crash the mint path if containment were lifted**.

---

### What improved since `2345961` (good)

- Default-deny maintenance: all non-GET `/api/*` return 503 unless `STAMPY_MAINTENANCE=0` **and** `SCHEMA_OK`. Operator header is the only write bypass. Path matching is normalized (`normPath`) so `/API/...`, trailing slash, and `//` no longer bypass the gate (R01).
- Permanently retired (410): `/api/redeem`, `/api/preview/confirm-deposit`, `/api/bridge/intent*`. Intent sweep is dead.
- Custody redeem requires on-chain burn + owner signature (`auth_sig`) binding burn → BTC dest. Shared `consumed_burns` PK across redeem and move. Pending ledger row before broadcast. Unknown broadcast errors stay `reconcile` (not retryable).
- XCP deposit-mint operator-only. ACME confirms default **3**. Precision guard (F09). Dest-chain mint capability check (F08).
- `/api/amm/swap` and `/api/move` operator-only. Key loaders fail-loud unless `STAMPY_ALLOW_KEYGEN=1`.
- Uniswap vault swap `minOut = quote − 50 bps`; addLiquidity mins 99%.
- Burn finality: Solana `finalized`; EVM depth (base 3 / eth 12 / base-mainnet 20).
- Wrap/status copy is honest while paused (`enabled=false`, `deposits_live=false`).
- Startup schema check for `consumed_burns`, `collateral_ledger.burn_txid`, `operations`. Missing schema keeps writes contained even if someone flips the env flag.
- No secret files in the tree.

Public Uniswap trading of already-minted Base mainnet TREES/ACME is unaffected (user-signed, not this server).

---

### Blocker — do not reopen until fixed

**R05 is broken in `mintCritical`.**  
Callers pass a 5th arg (`deposit-mint:…`, `move-mint:…`) but the function is still:

```js
async function mintCritical(asset, amount, receive_address, chain)
```

Body then reads undeclared `opKey`. In Node that is a `ReferenceError` on every mint. Durable reserve/complete never runs.

Worse: `/api/custody/verify-deposit` inserts the collateral row **then** calls `mintCritical`. If that throws, the outer `catch` returns 500 and **does not revert the credit**. Result: deposit marked confirmed, no tokens minted, retry hits “already credited”. User stuck; solvency oracle has phantom backing.

**Required before `STAMPY_MAINTENANCE=0`:**

```js
async function mintCritical(asset, amount, receive_address, chain, opKey)
```

and wrap the mint call so a throw after the INSERT reverts or marks `reconcile` the same way `m.status !== 200` already does.

Prove it with a unit test that `performMint` / verify-deposit does not throw and that a repeated `op_key` does not remint.

---

### Still open (contained-safe, still gates reopen)

| ID | Issue | Why it still matters |
|---|---|---|
| F04 | XCP still balance-delta | Frozen to operator. Do not unfreeze until per-tx attribution. |
| F05 move | `moveBindingMsg` exists, unused | Move is operator-only. Wire owner-sig before making it public. |
| SRC-20 PSBT | `custody.js` still signs stampchain `hex` with **no** echoed-field / payload decode | Compromised compose = vault signs arbitrary transfer once live. |
| ACME envelope | v1→v2 header rewrite + hardcoded 888-sat fee still empirical | Keep env overrides; canary before live redeem. |
| F08 / mainnet mint | `evm-mint.js` `CHAINS` is still Sepolia only | Cannot mint Base-mainnet reps through this server. Existing mainnet pool is a prior one-off. |
| srcOrigin / labels | mint still tags `bitcoin:src-20:…` and reports every EVM mint as `testnet` | Wrong provenance on new deploys. |
| R04 / F10 | Partial-burn entitlement; stamp-bridge exact-claim | Stamp-bridge execute still exists behind maintenance + custody gate. |
| Operator token | still `===`, not timing-safe | Fine while token is a long random secret; fix when reopening. |
| `redeemedBase` | counts `pending` **and** `reconcile` | Fail-closed (good) but a stuck reconcile row bricks further mints until manual cleanup. Need an operator reconcile tool. |
| UI | redeem form still does not send `burn_txid` / `auth_sig` / `chain` | Client work before public redeem. |
| Trust model | Emblem API key is still mint + BTC authority; solvency is off-chain | Multisig exists, not default. |

---

### Reopen checklist (all must be true)

1. `mintCritical(..., opKey)` wired; throw-after-credit cannot leave a confirmed deposit without a mint or a reconcile row.
2. Independent re-review of that path + a dry mint that does not hit mainnet.
3. SRC-20 PSBT decode-and-assert before `signPsbt`.
4. Client sends burn proof + owner binding.
5. XCP stays operator-only.
6. `STAMPY_CUSTODY_LIVE` stays off until (1)–(3).
7. Then, and only then: `STAMPY_MAINTENANCE=0` on a process that already has `SCHEMA_OK=true`.

---

**Builder action:** fix the `opKey` signature + verify-deposit catch first. Do not treat R05 as done because the commit message says it is. Custody remains gated. Uniswap market can stay up.