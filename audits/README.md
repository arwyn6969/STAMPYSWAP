# STAMPYSWAP audit evidence

Start with the **30 September 2026 release readiness audit** of source revision `9689964dac19f4b45c5532a744bd3fd8dfe0daea`.

- [Detailed release readiness report](2026-09-30-9689964/AUDIT.md)
- [Emblem repair handoff and acceptance criteria](2026-09-30-9689964/EMBLEM-HANDOFF.md)
- [Downloadable current audit bundle](2026-09-30-9689964/STAMPYSWAP-2026-09-30-9689964-audit-handoff.zip)
- [Current audit register and review history](AUDIT-REGISTER.md)
- [Consolidated remediation plan](REMEDIATION-PLAN.md)

The current verdict is **not ready for public custody or full mainnet release**. The project tests pass, but the additional fault-injection checks reproduce remaining accounting, recovery, schema, user-flow and signing-validation problems. OPEN tests pass when they reproduce a defect; they are not release approval.

The current folder contains the runnable independent fixture and checks, source hashes, recorded test/build/install results, dependency advisories and saved GitHub state. Its handoff explains how to reproduce the results against the exact source revision without production credentials or funded wallets.

## Historical evidence

Earlier reports remain preserved to explain the repair history and prevent an old finding from being confused with current status:

- [21 September audit at 457dc9a](457dc9a/AUDIT.md)
- [Earlier review at 621499e](621499e/AUDIT.md)
- [Original audit at 2345961](2345961/AUDIT.md)
- [Previously supplied review at 07672db](07672db/PROVIDED-REVIEW.md)

The `b164086` directory contains an unfinished historical harness, not a completed audit or current test result. Consult the register for provenance.

Published for the project owner to share with Emblem. This publication contains documentation and local audit evidence; application fixes and deployment approval are separate work.
