# Bitcoin release validation: Counterparty and ACME

This candidate adds a bounded Counterparty signing guard. It does not enable a mainnet launch, establish independent Bitcoin signing policy, or prove confirmation/settlement of a release.

## Supported Counterparty policy

The custody path requests `encoding=opreturn` and `use_enhanced_send=true`. Before obtaining a signer it decodes the actual PSBT and accepts only one zero-value OP_RETURN enhanced send, a canonical definite CBOR array with four fields, exact asset ID and positive base-unit quantity, the requested packed recipient, an empty memo, and at most one change output to the vault. Only XCP and canonical uppercase named assets are supported. Numeric/subasset identity mappings, legacy sends, Taproot commit/reveal, multisig data, memos and other message types are refused.

All inputs must spend P2WPKH outputs belonging to the vault. Bare PSBT inputs are populated from separately fetched raw previous transactions after checking the transaction hash, outpoint, script and value. Composer `params`, `lock_scripts` and `inputs_values` are not proof. The validator checks duplicates, signing metadata, sighash, sequence, locktime, absolute fee and a conservative fee-rate bound. Counterparty JSON responses are streamed with a 1,000,000-byte limit before parsing. Funding responses are streamed with a 500,000-byte hex-body limit and a 2,000,000-character aggregate limit before decoding/caching. Larger funding transactions are unsupported. Fee limits default to 50,000 sats and 200 sats/vbyte; configuration may only tighten them.

The signed transaction must retain the approved non-witness transaction, use vault-key P2WPKH witnesses and SIGHASH_ALL, and pass independent secp256k1 signature verification. The broadcast acknowledgement must succeed and equal the validated transaction ID. Existing ambiguous-outcome reservations remain necessary; no retry/finality permission is implied.

Primary reference: [Counterparty Core v11.5.0, pinned commit](https://github.com/CounterpartyXCP/counterparty-core/tree/8aab989157019e62423cd959b8571c7daf748d56). The relevant files are:

- [Enhanced-send CBOR fields and validation](https://github.com/CounterpartyXCP/counterparty-core/blob/8aab989157019e62423cd959b8571c7daf748d56/counterparty-core/counterpartycore/lib/messages/versions/enhancedsend.py).
- [Composer OP_RETURN and ARC4 construction](https://github.com/CounterpartyXCP/counterparty-core/blob/8aab989157019e62423cd959b8571c7daf748d56/counterparty-core/counterpartycore/lib/api/composer.py).
- [Message-type encoding](https://github.com/CounterpartyXCP/counterparty-core/blob/8aab989157019e62423cd959b8571c7daf748d56/counterparty-core/counterpartycore/lib/parser/messagetype.py).
- [Asset-ID rules](https://github.com/CounterpartyXCP/counterparty-core/blob/8aab989157019e62423cd959b8571c7daf748d56/counterparty-core/counterpartycore/lib/ledger/issuances.py).
- [Current packed-address rules](https://github.com/CounterpartyXCP/counterparty-core/blob/8aab989157019e62423cd959b8571c7daf748d56/counterparty-rs/src/utils.rs).
- [Official data-encoding specification](https://docs.counterparty.io/docs/advanced/specifications/counterparty-data-encoding/).

The positive fixture is the previously published PUDSEC redemption `c1bbd31050e77011d667a0035bbe60ae0b0d02a658430fe8fb39e4e4cff6fbeb`, with full previous transaction `045717d76d70d41f04db28ec5ee72198576f05d4d224333d80832b209bbe8c6d`. Its bytes were reconstructed from saved public 7 October 2026 observations, both transaction IDs matched, and the existing public witness verifies. No key or signature was generated and no new transaction/API call was made to obtain this fixture. Malicious fixtures mutate those transaction bytes rather than trusting composer metadata.

## Still open

Bitcoin prevout ownership alone does not prove that a coin is free of attached assets, inscriptions or other protocol claims. A reviewed funding inventory/coin-selection policy is still required. Raw previous-transaction lookup is not an SPV proof of canonical inclusion or unspent status. Source-protocol balances, node version/consensus health, continuous reorg handling, outgoing Bitcoin confirmation, pending customer claims, independent signer enforcement and host isolation remain separate release gates. Local validation protects honest execution; a compromised host retaining unrestricted custody API credentials can bypass it.

## ACME remains closed

No stable primary ACME envelope specification/reference implementation was available in this review. The previous release path rewrote an empirical v1 header to v2, accepted opaque composer JSON as authorization, and inferred a fee address/amount from examples. That path has been removed. `redeemAcme` always refuses before vault lookup, composer, signer or broadcast, including when custody-live and former header/fee environment settings are present.

Reopening requires a pinned authoritative specification and implementation covering envelope versions/activation, compression limits and canonical decoding, message and asset identity, exact integer quantity, source and recipient attribution, fee address/amount rules, and negative consensus fixtures. It also requires independently reviewed full PSBT/signed-transaction/input/output/fee validation and signer policy. Historical examples or an agent's assurance do not close this gate.
