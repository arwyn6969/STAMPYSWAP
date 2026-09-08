# ACME × StampySwap — Phase 1 prep (answers to the StampySwap agent's 3 review items)

Phase 0 is **complete** (confirmed in StampySwap's DB: `acme:SOAP` → canonical id 21,
source_protocol='acme', decimals 8, max_supply 1490000000; `HERESY.ED` unqualified → acme;
no regression to SRC-20/Counterparty). Protocol-qualified search (`?protocol=acme` / `acme:TICKER`)
is live so collided tickers (ACME, SOAP) are reachable as ACME.

The StampySwap agent asked for three things before wiring custody. Answers, verified live:

## 1. Deposit attribution — SOLVED (per-tx, not best-effort)
`/api/assets/{asset}/sends` returns full per-tx records:
`{ tx_hash, block_index, source, destination, asset, quantity, status, memo }`.
Added `findDeposits(asset, vault, {source?, minQtyBase?, sinceBlock?})` to acme.js — returns the
specific confirmed send(s) into the vault, filterable by source/amount/block, so two depositors
of the same asset can't be conflated. (Same rigor the Counterparty side still wants; here the
data is present and precise.)

## 2. Redemption format — IMPORTANT: envelope, NOT a ready PSBT (differs from Counterparty)
`POST /api/compose/send` returns:
- `envelope` { hex, base64 } — the ACME protocol data payload (zlib-compressed, magic "ACME")
- `transaction` — **fee/size metadata only**: { estimated_size, min_fee_rate, recommended_fee, dust_limit }
- `message` — decoded { type:'send', source, destination, params:{asset,quantity,memo} }
- `validation` — { status:'valid', balance_required, balance_available }

So unlike Counterparty (which returns a signable `rawtransaction`), **ACME hands back the envelope
+ fee params, not a constructed/ signable Bitcoin tx.** Redemption therefore needs a real
tx-construction step BEFORE the vault signs:
  1. select the vault's BTC UTXOs (inputs),
  2. embed the ACME `envelope` per ACME's encoding (Taproot witness / OP_RETURN — confirm which),
  3. add destination + change outputs, set fee from `recommended_fee`,
  4. sign with the Emblem vault signer, broadcast.
**This is the biggest remaining Phase-4 item** and heavier than the Counterparty redeem. It does
NOT block Phase 1 (custody detection is deposit-read only). Open question for the ACME team:
is there an endpoint that returns a full unsigned PSBT (envelope already embedded), or is
client-side tx construction expected? (The acme.pics web app must do this somewhere.)

## 3. Confirmation / reorg semantics — CLEAR
acme.pics surfaces **confirmed sends only** (`status:'valid'`; `?status=pending` returns empty).
A visible balance ⇒ the send is in a block. Reorg model (per CORTEX whitepaper) undoes affected
ops on a fork. Added `confirmations(blockIndex)` = tip − block + 1. For custody, credit a deposit
only after **N confirmations** (recommend ≥1–3, configurable) to be reorg-safe.

## Net for Phase 1
Custody DETECTION is fully supported and low-risk: `findDeposits` (attribution) + `checkDeposit`
(holders-based balance) + `confirmations` (finality). The heavy lift is **Phase 4 redemption tx
construction**, which we can design/spike independently. Nothing here should be wired custody-side
until the StampySwap head dev signs off (correct gate).
