# Replay Judge MVP Contract Pack

## Charter

This module validates signed evaluation artifacts, redeems opaque capabilities, executes authorized action transcripts against a fresh synthetic engine twice, and emits separated aggregate reports. It never trusts an agent-reported success value.

## Owned path

Only `agent_tools/03_replay_judge/**` is writable. Runtime code may import only the public exports of `../packages/atlas_protocol/src/index.mjs` plus Node built-ins.

## Public module entry point

`src/index.mjs` exports the verifier, registry, cohort-plan/authorization, receipt-chain, replay, probe, sanitizer, leakage, collector, and report APIs.

`verifyNormalizedDocumentArtifact({ envelope, verifier, expected })` is the only signed NormalizedDocument ingress. `expected` must bind campaign, track, arm, target run, contract digest, and exact parent digests; optional `canaries` are rescanned during ingestion.

## Security invariants

- Every accepted artifact has a valid Ed25519 signature from a key authorized for its artifact type.
- A nonce may identify one artifact digest only; idempotent re-verification of the same artifact is allowed.
- Parent digests, campaign, track, arm, target run, document, build, probe set, and repetition are exact-match bindings.
- A NormalizedDocument must have an authorized signature and a payload already byte-canonical under the local sanitizer; sanitization may not silently rewrite a signed payload.
- A replay authorization is consumed once. Its action transcript is replayed internally twice in separate fresh engine instances.
- Input and frame receipts form gap-free, run-bound hash chains.
- Probe IDs match the signed fixed ProbeSet exactly; missing, duplicate, and extra probes fail.
- A completed cohort contains every planned target × arm × repetition cell exactly once.
- `STRICT` and `ASSISTED` cohorts are never combined into one score.
- Leakage detection quarantines output instead of returning a score.

## Synthetic fixture vocabulary

The public tests use only `Room A`, `Room B`, and `Token B`. They contain no game names, live seeds, production keys, or holdout facts.

## Commands

Run `node scripts/verify.mjs` from this directory.
