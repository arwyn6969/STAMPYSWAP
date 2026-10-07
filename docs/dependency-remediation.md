# Dependency remediation

The locked runtime graph removes all previously reported npm runtime advisories. This is dependency removal/upgrading with compatibility tests, not advisory suppression.

- Upgrade BIP-322 from 3 to 4.0.0, retaining synchronous sign/verify calls and testing genuine P2WPKH signatures plus changed-message/address rejection. Its internal Bitcoin 7 dependency is isolated; custody explicitly depends on BitcoinJS 6.1.7, whose numeric output-value API the custody code uses.
- Override jayson with 5.0.0. Solana's browser JSON-RPC client imports remain compatible; a mock transport checks request IDs, result parsing and error propagation. This removes its vulnerable UUID/stream dependency graph.
- Replace vulnerable native `bigint-buffer` with the private, project-owned `@stampyswap/bigint-buffer` in `vendor/bigint-buffer`. The package has its own name/version and no native binding or install script. The original transitive dependency name resolves to this replacement through an explicit npm override. It is not mislabeled as a patched upstream release. The four used conversion exports operate on unsigned integers with bounded widths and reject overflow rather than silently truncating it.

The actual consumer is `@solana/buffer-layout-utils`. Compatibility tests exercise both byte orders at 64/128/192/256 bits, maximum values, overflow/invalid lengths and real SPL MintLayout/AccountLayout decoding. The entire existing custody suite also passes with these upgrades. A clean npm 10 installation verifies the lockfile/override on the CI package-manager family. Production requires Node 22.12 or later; CI uses the current Node 22 distribution.

The adapter is maintained by this project. Future dependency upgrades must retain these conversion and RPC/authentication checks. The npm advisory database is a point-in-time signal, not proof that every dependency is safe. Runtime and full dependency audit evidence are saved separately by the reviewer; both report zero vulnerabilities at this revision.
