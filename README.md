# BTech DKGKit Next App

This folder is a Next.js app plus a Rust wallet-service layer that integrates
the local `../dkgkit` crates. Use Bun for the web app and Cargo for the Rust
DKGKit service.

It implements the local flow from `../dkgkit/docs/NEXT_APP_GUIDE.md`:

```text
create vault -> HTSS DKG complete -> Taproot address derived -> approval signed -> aggregate verifies
```

Run the Rust service directly:

```bash
cargo run
```

Run the Next app:

```bash
bun install
bun run dev
```

Then open:

```text
http://127.0.0.1:3000
```

The Next API route at `POST /api/demo` invokes:

```bash
cargo run --quiet -- --json
```

It returns the vault ID, regtest receive address, signer set, authorization
digest, aggregate signature, and `verified: true` when the grouped signer set
passes policy validation and the aggregate BIP340 signature verifies.

The group session proof route at `POST /api/session-proof` invokes:

```bash
cargo run --quiet -- --session-proof-json --session-id <id>
```

It returns invited participants, the vault policy for each company group chat,
a base `2-of-3` TSS/FROST keygen/signing proof, a grouped HTSS signing proof,
confirmation that an invalid HTSS signer set was rejected, and explicit proof
that high-rank signers cannot replace a missing lower-rank group quorum. Base
TSS is shown as a separate proof and is not merged into HTSS policy.

Verify everything:

```bash
cargo fmt --all --check
cargo test
bun run typecheck
bun run build
```

This is a local demo shell. It intentionally does not include production relay
networking, NIP-44 encryption, PSBT construction, transaction broadcast,
recovery, reshare, or mainnet custody claims.
