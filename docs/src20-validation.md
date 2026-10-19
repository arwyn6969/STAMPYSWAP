# SRC-20 release validation

The current Stampchain composer uses OLGA: the recipient is output zero, followed by contiguous P2WSH data outputs and optional vault change. The data is a two-byte big-endian length, `stamp:`, compact transfer JSON, and zero padding to 32-byte chunks. Its dust constant is 333 satoshis. An arbitrary OP_RETURN is not proof of this transfer. The previous structural check rejected valid OLGA transactions while allowing unrelated data.

Independent source references, inspected 7 October 2026:

- [Composer at 7702cf49](https://github.com/stampchain-io/stampchain.io/blob/7702cf49a2d74c9005a2accc2ead9c40edfceb7e/server/services/src20/psbt/src20PSBTService.ts).
- [CIP33 encoding at that same revision](https://github.com/stampchain-io/stampchain.io/blob/7702cf49a2d74c9005a2accc2ead9c40edfceb7e/lib/utils/bitcoin/encoding/fileToAddressUtils.ts).
- [Independent indexer at 8a7365bf](https://github.com/stampchain-io/btc_stamps/blob/8a7365bf951a66f3a5e25dc15e8702f65b5d23d8/indexer/src/index_core/transaction_utils.py), including its first-output destination and ordered P2WSH decoder.

`src20-validator.js` requires the requested token, exact decimal quantity and TRANSFER operation; rejects extra/duplicate fields and ambiguous payloads; verifies the first recipient and all remaining outputs; bounds dust, total non-vault value and fees; and independently obtains each funding transaction from the public Bitcoin reader. Funding transaction IDs bind their actual output scripts and values. Every input must be a vault P2WPKH output, with no duplicate outpoints, foreign signing data or unsafe sighash. Signing instructions are derived locally and always use SIGHASH_ALL.

Before broadcast, the returned signed transaction must preserve the unsigned transaction ID, contain the expected vault key and SIGHASH_ALL witnesses, and pass independent ECDSA signature verification against the actual funding values. A broadcast response must report that exact transaction ID with a successful HTTP status. No composer or signer result can override these checks. Configured limits may be tightened, but values above the hard maximum or invalid values fail closed.

The checked-in public fixture records redemption `fccbd6f45d48ead0947188bcb46fb20890fe128333f547159e23a2d3f932e858` and funding transaction `f949a8e7f3e82b251dff75fe6e6cda0c56160735e5d22653ff53a6bdfaf48e1f`. The independent indexer records a 1000 $bald TRANSFER from the vault to the fixture recipient; the 426-satoshi fee and vault signature verify independently. The test PSBT is reconstructed from those public transactions, not an original composer response. All test fetch/sign/broadcast effects are mocks; the fixture is never rebroadcast.

Supported scope is deliberately the current compact-JSON OLGA TRANSFER, ASCII tickers up to five characters, mainnet P2WPKH custody inputs and standard recipient addresses. Legacy multisig, compressed payloads, other input types and malformed/unrecognized layouts fail closed. A real unsigned response from the deployed composer and the managed signer's integration still need isolated staging verification. Validation of transaction intent does not prove confirmation, indexer credit or successful accounting; those remain separate journey acceptance checks.
