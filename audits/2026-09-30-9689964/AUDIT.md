# STAMPYSWAP release readiness audit

**30 September 2026. Verdict: further engineering and verification are required before public custody or a full mainnet release.** The latest work makes several earlier fixes real and testable, but it does not establish safe recovery or a working end-to-end product. This is a completed independent follow-up audit, not release clearance.

The reviewed revision is **`9689964dac19f4b45c5532a744bd3fd8dfe0daea`**, published **22 September 2026 at 13:19:06 UTC**. GitHub main was checked again during this review and still points to it. Nine commits have landed since the previous completed audit at `457dc9a` on 21 September. No newer published implementation was visible. Private Emblem work may exist but was not available to this review. [Reviewed commit](https://github.com/arwyn6969/STAMPYSWAP/commit/9689964dac19f4b45c5532a744bd3fd8dfe0daea).

For the project owner, the decision is:

| Decision | Assessment |
|---|---|
| Continue implementation and isolated testing | Yes |
| Conduct another independent development audit | Yes; this report completes that pass |
| Treat this as a final release candidate | No |
| Enable public wrapping, custody withdrawals or moves | No |
| Treat existing external trading as proof of bridge readiness | No; trading existing tokens does not exercise custody issuance and recovery |
| Commit to a release date from current evidence | No; scope and production evidence are still missing |

There is no finding here that the live vault is already insolvent or that a live exploit occurred. The loss scenarios below were reproduced locally with mocked blockchain effects. The deployed version, configuration, database, vault balances and signer policies remain unverified.

## What has improved

The nine commits cover operation identities, recovery state, exact burn amounts, checked-in handler tests, public holder authorization, Counterparty attribution, Solana precision selection, database locking and partial Bitcoin transaction validation. Eight files changed, including 489 changed lines in the server and a new 251-line handler test file. The complete commit list is in [GitHub evidence](github-evidence.json).

The following results are supported by executed tests:

- A fresh locked dependency installation succeeds. Lint passes. The project test command now runs **23 deterministic tests**, including 11 handler tests, instead of counting the optional ACME network smoke script as a successful assertion.
- Direct operator mint requests require an operation key. Completed deposit-mint records are recognized before attempting another mint in the tested scenario.
- The modeled legacy deposit-mint key is recognized and blocks an uncertain repeat issuance.
- Public Counterparty claims use a specific matching send transaction; the checked-in test verifies successful attribution, replay rejection and an unmatched transaction.
- Public moves require the burn owner's signature; missing and wrong-owner signatures fail, and a correctly signed move succeeds in the checked-in test.
- Partial representation-burn and stamp-burn claims are rejected. Exact indivisible ACME claims work; excess precision fails before minting.
- An uncertain stamp broadcast retains its reservation; retry produces no second release in the tested scenario.
- Successfully failed redemption reconciliation remains retryable after startup backfill in the tested case.
- Maintenance path normalization, retired routes and schema-failure containment continue to block the tested writes.

These are substantial improvements. However, some tests prove only a narrow recovery schedule. For example, the existing transient database failure test throws **before** an update commits. It does not cover an update that commits and then loses its response, which is central to B02.

## The current blockers

P1 means repair before enabling the affected value-moving feature. P2 means a material correctness, availability or product issue that must be resolved or explicitly excluded from release. These B identifiers group related failures and overlap prior A, F and R findings; they are not additional independent totals to add to the historical register.

| Finding | Priority | Confirmed result and release consequence |
|---|---|---|
| B01 | P1, multiple workers | A live mint can outlast its 30-second lock lease. Another worker takes the lock, both issue, and 10 units of collateral back 20 units. |
| B02 | P1 | A committed circulation decrement with a lost response is retried as a new decrement. Accounting can understate outstanding tokens and allow extra issuance. |
| B03 | P1 | A failed first representation insert can be swallowed. The mint is reported complete without recording its supply. |
| B04 | P1 | An uncertain mint blocks its own operation key but does not reserve its potential supply against other operations. |
| B05 | P2, release blocker | Failed circulation updates can be reported as completed reconciliation or a completed move phase, leaving inconsistent records and no normal repair path. |
| B06 | P1/P2, historical data dependent | Startup reconsumes an aborted move burn, while historical redemption rows with a NULL status are omitted from backfill and can permit a repeated release. |
| B07 | P1, schema dependent | Readiness accepts a lock table without a unique asset key and an operation index that only protects completed rows. |
| B08 | P2, product blocker | The withdrawal and move forms omit required authorization. Both receive 401 from enabled eligible handlers. |
| B09 | P1 for SRC-20 release | The new Bitcoin output guard still passes a transaction with a 999,454-satoshi miner fee and no transfer payload to the signer. |

### B01 A lock can expire while its owner is still issuing tokens

The database lock defaults to a 30-second lease. There is no renewal or mechanism that prevents an old holder from continuing after a new holder takes over. A slow external signer or confirmation request can therefore outlive ownership.

**Reproduction:** two isolated server contexts share one SQLite database. Worker A passes the solvency check against 10 collateral and pauses at the mocked mint adapter. Advance the fixture clock by 31 seconds. Worker B steals the expired lease and mints 10; A then resumes and also mints 10. Both requests return 200 and recorded circulation is 20 against collateral of 10. This requires independent workers, not a second request sharing the same in-process lock.

**Required outcome:** durable allocation of the backing before execution, safe handling of unresolved execution, and ownership that remains valid for the complete operation. Increasing the lease alone does not prove correctness. An enforced single-worker deployment can contain this particular interleaving temporarily; it does not address B02–B04 or safely settle a crashed worker's uncertain effect.

Source: [lock lifecycle, server.js 1197–1215](https://github.com/arwyn6969/STAMPYSWAP/blob/9689964dac19f4b45c5532a744bd3fd8dfe0daea/server.js#L1197-L1215).

### B02 A lost database response can apply the same debit twice

`bumpCirculating` treats every update exception as zero changed rows. It then rereads the new balance and applies the delta again. An HTTP database service can commit an update before its response is lost; the exception does not establish that nothing happened.

**Reproduction:** start with circulation 100 and a released 10-unit redemption awaiting accounting. Commit the first decrement to 90, then inject a lost-response exception. The retry writes 80. A subsequent 10-unit mint is accepted. In the modeled chain state, this permits 100 actual outstanding tokens against 90 remaining collateral.

**Required outcome:** an operation-specific accounting event that can be applied only once, coupled atomically to circulation and recovery state. Ambiguous responses must be resolved by reading that event's identity, not by reapplying an arithmetic delta. This is a remaining A01/R05 failure despite the new terminal-status gate.

Source: [server.js 1170–1188](https://github.com/arwyn6969/STAMPYSWAP/blob/9689964dac19f4b45c5532a744bd3fd8dfe0daea/server.js#L1170-L1188).

### B03 Creating a representation can fail without failing the mint

The new-representation insert catches every exception as though it were a uniqueness race. If no competing row exists, execution still reaches the mint ledger and operation-complete writes. The catch also ignores an unsuccessful circulation increment when a row does exist.

**Reproduction:** issue 10 on a destination without a representation row, then fail its insert before commit. The API returns 200 and marks the operation completed, but no destination supply is recorded. A different operation issues another 10 against the same backing; only one of the two mint effects appears in circulation.

**Required outcome:** distinguish a verified uniqueness conflict from other database failures. Never mark an operation complete until its accounting is durably proven. Preserve the first external effect for recovery and prevent further use of its backing.

Source: [server.js 1028–1051](https://github.com/arwyn6969/STAMPYSWAP/blob/9689964dac19f4b45c5532a744bd3fd8dfe0daea/server.js#L1028-L1051).

### B04 Uncertain issuance leaves backing available to other operations

A reserved/reconcile operation prevents the **same key** from reminting. The solvency calculation still uses recorded circulation alone; it does not include possible supply from other uncertain operations.

**Reproduction:** the first mocked mint records an accepted external effect and throws a lost-response error. The operation becomes `reconcile`, circulation stays zero and the asset lock is released. A different key can then mint another 10 against the same 10 collateral.

**Required outcome:** unresolved issuance must retain a durable claim on backing until its outcome is established. Implement an audited repair path for mint operations and record sufficient transaction identity to resolve uncertainty. The current reconciliation GET lists operations, but POST handles only redeem, move, stamp and orphan burn dispositions.

Sources: [solvency and operation handling, server.js 938–982](https://github.com/arwyn6969/STAMPYSWAP/blob/9689964dac19f4b45c5532a744bd3fd8dfe0daea/server.js#L938-L982), [mint failure handling](https://github.com/arwyn6969/STAMPYSWAP/blob/9689964dac19f4b45c5532a744bd3fd8dfe0daea/server.js#L997-L1024), [reconciliation actions](https://github.com/arwyn6969/STAMPYSWAP/blob/9689964dac19f4b45c5532a744bd3fd8dfe0daea/server.js#L1867-L1950).

### B05 A successful response can conceal unfinished accounting

Release finalization changes the ledger to `released` before the circulation decrement and ignores the decrement's result. Move processing also ignores the source decrement's failure before marking it `decremented`.

Two independent checks reproduce the consequences:

- Make every circulation update fail. Redemption reconciliation returns 200 with `finalized:true`, but circulation stays 100. The terminal row vanishes from the stuck-redemption list and a repair retry returns 409.
- With spare collateral available, make the move's source decrement fail. The destination mint proceeds, the API returns 200 and the source phase is labelled `decremented` despite unchanged circulation.

These cases overstate circulation rather than directly demonstrating excess issuance. They still break recovery and make the system's status claims unreliable.

**Required outcome:** atomic or explicitly resumable accounting phases, truthful completion responses and repair visibility for every incomplete effect. Do not solve B02 merely by moving the irreversible status write earlier.

Sources: [release finalization](https://github.com/arwyn6969/STAMPYSWAP/blob/9689964dac19f4b45c5532a744bd3fd8dfe0daea/server.js#L1183-L1188), [move accounting](https://github.com/arwyn6969/STAMPYSWAP/blob/9689964dac19f4b45c5532a744bd3fd8dfe0daea/server.js#L1276-L1288).

### B06 Recovery dispositions and startup history disagree

An operator can abort a move whose source debit did not happen, freeing its burn. Startup then backfills **all** move-out rows, including that aborted row, and consumes the burn again. The test confirms that retry is blocked after restart.

Conversely, redemption backfill uses `status != 'failed'`, which excludes SQL NULL. The live collateral calculation explicitly counts NULL-status redemptions as obligations. A modeled historical redemption with a burn and NULL status is not restored to the burn registry; the same valid burn can trigger another release.

**Qualification:** the NULL-status replay requires relevant historical rows and an absent consumed-burn record. Their existence in production was not established. This is a migration contract failure, not a claim about current live data.

**Required outcome:** define the meaning of every historical status; preserve uncertainty and completed consumption while respecting deliberate retryable dispositions. Test fresh installs, upgrades, aborted moves and NULL statuses together, then reconcile actual historical rows before opening.

Sources: [startup backfill](https://github.com/arwyn6969/STAMPYSWAP/blob/9689964dac19f4b45c5532a744bd3fd8dfe0daea/server.js#L2459-L2470), [move abort](https://github.com/arwyn6969/STAMPYSWAP/blob/9689964dac19f4b45c5532a744bd3fd8dfe0daea/server.js#L1873-L1887), [legacy redemption treatment](https://github.com/arwyn6969/STAMPYSWAP/blob/9689964dac19f4b45c5532a744bd3fd8dfe0daea/server.js#L810-L815).

### B07 The schema gate does not prove the constraints it relies on

The new four-table uniqueness checks are better than column-existence checks, but incomplete:

- `asset_locks.asset_id` is never checked for uniqueness. A same-column table without a primary key passes readiness, and two acquisitions both succeed.
- The index parser ignores a partial index's predicate. `UNIQUE(op_key) WHERE state='completed'` passes the gate while allowing duplicate reserved keys. The test obtains two fresh reservations for the same key.

**Qualification:** these checks intentionally supply malformed schemas. They establish fail-open readiness, not that production currently has these schemas.

**Required outcome:** versioned schema/migration files and verification of all required constraints, including full predicate coverage, the asset lock and the representation identity constraint assumed by mint creation. Supply the actual deployment's redacted schema and upgrade results.

Source: [server.js 2416–2457](https://github.com/arwyn6969/STAMPYSWAP/blob/9689964dac19f4b45c5532a744bd3fd8dfe0daea/server.js#L2416-L2457).

### B08 The public forms cannot complete withdrawals or moves

The withdrawal form sends ticker, amount, address and hard-coded `chain:'solana'`. It sends neither a burn transaction nor the required owner signature. The move form includes the burn transaction but omits the required signature.

The independent test executes the actual browser function bodies and submits their generated payloads to the real Express handlers with eligible fixture holdings and maintenance disabled. Both return 401. The signature protections are correct; the user experience has not caught up.

**Required outcome:** complete wallet-based burn and signing flows, explicit network/asset identity, supported route selection, transaction status and resumable recovery. Verify the full user journey in a browser on the intended staging deployment. This audit tested request construction, not visual layout or wallet extensions.

Source: [public/index.html 711–750](https://github.com/arwyn6969/STAMPYSWAP/blob/9689964dac19f4b45c5532a744bd3fd8dfe0daea/public/index.html#L711-L750).

### B09 Bitcoin output caps do not validate the fee or transfer intent

The new SRC-20 guard rejects undecodable transactions and caps value sent to non-vault outputs. It never establishes the miner fee from independently verified inputs, and it does not verify the requested SRC-20 asset, amount and recipient.

**Reproduction:** a valid PSBT declares a 1,000,000-satoshi input and only 546 satoshis of vault change. It contains no transfer payload or recipient output. The application passes it to the mocked signer and accepts the mocked broadcast, despite a 999,454-satoshi implied fee.

The test proves the application's validation boundary is insufficient. It does not establish that Emblem's production signer would approve this transaction; any independent signer policy needs evidence.

**Required outcome:** validate input ownership and values against trusted chain data, absolute fee and fee rate, allowed signing flags, all outputs, and decoded protocol intent before signing. Retain the new caps as additional checks. Obtain a real sanitized composition sample for semantic tests; no funded transaction is necessary for these checks.

Source: [custody.js 174–217](https://github.com/arwyn6969/STAMPYSWAP/blob/9689964dac19f4b45c5532a744bd3fd8dfe0daea/custody.js#L174-L217).

## Where the previous audit now stands

| Previous finding | Current assessment |
|---|---|
| A01 double-decrement recovery | Earlier repeat-finalizer schedule is guarded; lost committed responses still double-decrement, and persistent failures strand accounting. B02/B05 remain. |
| A02 historical operation identities | Tested legacy deposit alias now blocks retry. This is containment, not proof that all historical effects have been reconciled. |
| A03 credit deletion across workers | Completed-operation recognition and cleanup guards improved; the checked-in scenario passes. No blanket multiple-worker clearance: B01/B04 remain. |
| A04 failed-redemption recovery | Tested normal failure resolution survives startup. Broader history/disposition problems remain in B06. |
| A05 move recovery | Pending versus decremented phases and cached completion improved. Failed debit outcomes are still mislabelled in B05. |
| A06 missing operation key | Direct mint omission is rejected; the demo swap now also requires a key by source inspection. Different-key uncertain liability remains B04. |
| A07 unknown stamp broadcast | Reservation now precedes broadcast; tested retry does not release twice. Durable signed-transaction recovery still needs completion. |
| A08 schema constraints | Four required uniqueness gates added, but B07 prevents full closure. |
| A09 installation and tests | Locked install, lint and deterministic test command are fixed. Current CI, complete contract build and release evidence remain open. |
| R04/F10 partial entitlement | Tested partial representation and stamp claims are rejected. |
| F04/F05 public claims and moves | Backend attribution/signature tests pass. Current UI still fails B08. |
| F09 source precision | Exact ACME claim and excess-precision checks pass. |

## Additional release requirements

**Mainnet scope and build.** EVM minting is wired to Base Sepolia and Ethereum Sepolia; Solana issuance uses devnet. The deposit handler rejects unsupported Base-mainnet destinations before consuming a claim, which is useful containment but not a completed mainnet wrapping feature. Existing mainnet representations and pools mentioned by the builder are separate from a proven custody lifecycle. Running `node gen-erc20-mainnet.js` after the locked install fails because `@openzeppelin/contracts/utils/Context.sol` is missing. OpenZeppelin contracts are not declared in the package manifest. [Build output](contract-build.txt), [mint networks](https://github.com/arwyn6969/STAMPYSWAP/blob/9689964dac19f4b45c5532a744bd3fd8dfe0daea/evm-mint.js#L8-L12), [unsupported destination check](https://github.com/arwyn6969/STAMPYSWAP/blob/9689964dac19f4b45c5532a744bd3fd8dfe0daea/server.js#L1607-L1611).

**Solana identity and finality.** The new burn precision uses the current asset supply policy instead of hard-coded nine decimals. It does not independently establish the deployed mint's actual decimals. Also, any error fetching an existing mint sets it to null and creates a new mint, so a transient lookup failure can change token identity. These are retained source-review concerns, not newly exercised Solana adapter reproductions in this pass. Define per-chain finality/reorg behavior and test against actual mint metadata. [sol-mint.js 53–79](https://github.com/arwyn6969/STAMPYSWAP/blob/9689964dac19f4b45c5532a744bd3fd8dfe0daea/sol-mint.js#L53-L79).

**Durable execution and repair.** A shared in-process Bitcoin lock still does not reserve UTXOs across workers. Persist transaction identity before ambiguous execution where supported, provide chain-evidence-based repair, and expose incomplete mint accounting. `opComplete` still logs and suppresses persistence exceptions. Recovery actions need atomic state changes and evidence, not only an operator's declared resolution.

**Dependency exposure.** The fresh advisory query reports **21 affected dependency entries: 5 high, 11 moderate and 5 low**. These include transitive Solana dependencies, `bigint-buffer`, `tmp`, `qs` and cryptographic packages. Counts include dependency propagation and do not mean 21 demonstrated application exploits. Review runtime reachability and safe updates; do not blindly apply the suggested major-version changes/downgrades. [Saved dependency report](dependency-audit.json).

**Release automation.** GitHub reports zero check runs and zero commit statuses for the reviewed revision. The visible Actions history belongs to the older frontend, not this server. The combined status API's empty `pending` result is not an executing test suite. No published GitHub release was returned. Add an actual current-application workflow with a supported pinned runtime, locked installation, tests, lint, schema fixtures and contract build.

**Production state.** The builder notes claim custody is closed, schema was provisioned out of band, and runtime checks were solvent. Those are inputs to verify, not independently inspected results. Request the deployed SHA, staging URL, redacted flags including the `.custody-live` file, schema/index definitions, instance count, outstanding operation inventory and reconciliation of real deposits, chain supply and releases. Also verify signer ownership, approval policy, authority changes, monitoring and recovery. No secrets or seed phrases are needed.

## How far from release

This is beyond a bare prototype in API capability and regression testing, but still in **recovery repair and product integration**, before a release candidate. Turning maintenance off would expose unresolved safety and usability failures.

A useful completion measure is the following four gates, rather than a percentage based on code volume:

| Gate | Work and exit evidence | Current status |
|---|---|---|
| 1 Safe accounting and recovery | Resolve B01–B07 with durable backing reservations, one-time accounting events, complete schema/history migration and prevention tests that cover committed-but-lost responses and restarts | Not passed |
| 2 Complete the chosen user journeys | Decide supported assets/chains; fix B08; validate B09 for enabled SRC-20 routes; finish mainnet wiring/build and relevant identity/finality checks | Not passed |
| 3 Reproducible staged release | Current CI; clean build; real staging wallet journeys; deployment/flag/schema evidence; historical and chain reconciliation; tested operational recovery | Not passed |
| 4 Independent release-candidate review | Review one frozen revision plus deployment evidence, resolve findings, then approve a deliberately limited launch scope | Not started |

At least three engineering/validation gates remain before the final review. These are not three small edits, nor do they all need to run sequentially. A narrow first release with one explicitly supported asset/chain and disabled unfinished routes would reduce the scope. A full multichain custody release requires all supported paths to meet the same standard.

A calendar estimate would be unreliable without Emblem's implementation proposal, staffing and an agreed first-release scope. The evidence supports **several substantive repair batches plus a final verification cycle**, not a launch toggle or a promise that one small fix finishes the work. Ask Emblem to estimate each gate against the acceptance criteria in the [handoff](EMBLEM-HANDOFF.md).

## Verification and limits

| Check | Result |
|---|---|
| Fresh `npm ci --ignore-scripts --no-audit --no-fund` | Passed, 387 packages installed; lifecycle scripts intentionally not executed |
| `npm run lint` | Passed |
| `npm test` | 23/23 passed |
| Independent fault and regression checks | 18/18 completed: 12 defect reproductions, six positive regression checks |
| Standalone root JS/MJS syntax | 20/20 passed |
| Mainnet contract generation | Failed: undeclared/missing OpenZeppelin source |
| Fresh dependency advisories | 21 affected entries, including five high |
| GitHub checks for exact revision | None returned |
| Deployed application, wallet integration and real chain custody lifecycle | Not independently tested |

**OPEN tests pass when they reproduce a defect. Their green output is evidence of the problem, not approval.** The six positive checks contain multiple assertions and are not an exhaustive rerun of all 41 checks in the preceding audit.

The harness executes the complete hash-pinned server using real Express routing, real EIP-191/BIP-322 verification and SQLite. It models separate workers sharing a database and failures both before and after commits. Blockchain effects and indexers are fixed local fixtures; lease expiry uses a controlled clock. The SRC-20 check exercises real PSBT parsing but replaces signing and broadcast. The UI checks execute request-building functions without browser extensions.

The clean reviewed checkout is `/private/tmp/stampyswap-review-20260930`. The older edited local workspace at `77dea9b` was preserved and is not the reviewed application. Audit tests ran on Node v23.3.0; the local standalone syntax/build checks used the sandbox's Node v23.4.0. This records the environment, not a production runtime recommendation. No production startup, custody signing, live asset movement, deployment, application repair or message to Emblem was performed.

Evidence: [independent checks](release-readiness.test.cjs), [fixture](fixture.cjs), [results](release-readiness-results.txt), [repository tests](repository-tests.txt), [installation](npm-ci.txt), [lint](lint.txt), [syntax](syntax-results.json), [contract build](contract-build.txt), [dependencies](dependency-audit.json), [source hashes](source-sha256.json), [GitHub state](github-evidence.json), [runtime](runtime-test-environment.json). The [Emblem handoff](EMBLEM-HANDOFF.md) gives ordered implementation and acceptance requirements.
