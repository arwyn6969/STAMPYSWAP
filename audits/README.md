# STAMPYSWAP audit evidence

Start with the **1 October 2026 independent repair audit** of revision `80963563fc7eb3ce1b30bd87d2c1dcb096393418`.

- [Latest finding-by-finding repair audit](2026-10-01-8096356/AUDIT.md)
- [Latest Emblem repair handoff](2026-10-01-8096356/EMBLEM-HANDOFF.md)
- [Latest runnable evidence bundle](2026-10-01-8096356/STAMPYSWAP-8096356-repair-audit-handoff.zip)
- [Audit register and review history](AUDIT-REGISTER.md)
- [Consolidated remediation plan](REMEDIATION-PLAN.md)

The B06/B07 reported failures and B08 local authorization flow are verified fixed, and the clean build and 37 project tests pass. Broader checks still reproduce accounting, reservation, restart and Bitcoin output-validation failures. This is a repair audit, **not release clearance**. The public application reports maintenance and release gated; backend configuration and deployment identity remain unverified.

The latest independent suite contains 39 evidence checks: 31 verify protections and eight reproduce defects or retained limitations. An OPEN test passing demonstrates a defect. Follow the report's pinned-source reproduction instructions; the audit publication branch is documentation, not the repaired application checkout.

## Previous reviews

- [30 September baseline audit at 9689964](2026-09-30-9689964/AUDIT.md)
- [30 September handoff](2026-09-30-9689964/EMBLEM-HANDOFF.md)
- [21 September audit at 457dc9a](457dc9a/AUDIT.md)
- [Earlier review at 621499e](621499e/AUDIT.md)
- [Original audit at 2345961](2345961/AUDIT.md)
- [Previously supplied review at 07672db](07672db/PROVIDED-REVIEW.md)

The `b164086` directory contains an unfinished historical harness, not a completed audit. Earlier evidence is preserved. No application repair, deployment approval or live transaction is part of this publication.
