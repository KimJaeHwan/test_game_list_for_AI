# Checkpoint Campaign Contract Pack

## Constructor

`CheckpointCampaignOrchestrator` requires:

- `campaignId`: safe opaque identifier.
- `budget`: exact `{ turns, keyAttempts, frames, elapsedMs, checkpoints }`.
- `checkpointPolicy`: exact supervisor policy object.
- optional validated assisted `initialKnowledgeContext`.
- async `playSegment(request)`, `publishWiki(request)`, and
  `loadContext(request)` ports.

## Play request

Each call receives a frozen copy of:

```js
{
  sessionMode: "FRESH",
  campaignId,
  segmentOrdinal,
  knowledgeContext, // validated context or null
  remainingBudget,
  checkpointPolicy
}
```

The port must return an exact sealed segment:

```js
{
  status: "SEALED",
  reason: "COMPLETE" | "PARTIAL" | "ABORT",
  sourceDigest,
  sourceRef,
  accounting: { turns, keyAttempts, frames, elapsedMs },
  continuation // optional; only valid for PARTIAL
}
```

A PARTIAL result without `continuation` is a normal terminal PARTIAL outcome.
When present, a PARTIAL continuation must be an exact
`atlas/vision-checkpoint-continuation/1` receipt. Its counters must equal segment
accounting, and `sealDigests` must include `sourceDigest`.

## Publish and ACK

The publish request is the exact frozen object:

```js
{ sourceRef, sourceDigest, baseRevision, idempotencyKey }
```

`idempotencyKey` is a canonical SHA-256 of campaign ID, segment ordinal, source
digest, and base revision. The exact required ACK is:

```js
{
  schemaVersion: "atlas/wiki-checkpoint-ack/1",
  idempotencyKey,
  sourceArtifactDigest,
  baseRevision,
  revision,       // exactly baseRevision + 1
  snapshotSha256,
  playerContextSha256
}
```

Every binding must match. The context loader then receives
`{ revision, playerContextSha256 }`. Its result must pass the existing assisted
knowledge-context validator, have the ACK revision, and hash exactly to
`playerContextSha256`.

## Retry and failure guarantees

- Before a valid ACK, the count of later `playSegment` calls is zero.
- `WAITING_FOR_WIKI` retries only the same publish request.
- `WAITING_FOR_CONTEXT` retries only the same context request.
- Contract or budget violations become terminal `FAILED`.
- Port exception messages are discarded; only bounded coarse error codes enter
  the ledger.
- `run()` is single-flight and terminal results are idempotent.

## Sharding interfaces

`buildShardManifest({ revision, items })` accepts exact items
`{ id, kind, title, body, sourceOrdinal, namespace, pageKind }`. The last two
fields come from trusted Wiki ingestion. Structured page kind wins, namespace is
the fallback, and fixed multilingual vocabulary is used only when both are
general. The API rejects caller paths, topics, and ranks.

`createRelevantContextSelector({ topK }).select({ revision, items, currentText,
currentEpisodeOrdinal })` accepts no ranking controls. Selection is deterministic
and bounded to 32 items.

`createShardedKnowledgeContextBuilder({ topK })` composes the manifest and
selector, strips routing metadata, and emits the validated assisted player context
that the campaign's `loadContext` port can return.

## Durable ledger store

`CampaignLedgerStore({ read, createExclusive, compareAndSwap })` is the persistence
boundary. The adapter must make `createExclusive` and `compareAndSwap` atomic.
The store verifies every entry digest and predecessor link on load, rejects an
existing campaign during initialization, and rejects stale-head writes. The
orchestrator accepts it as optional `ledgerStore`; production callers should
provide one, while deterministic unit tests may use the private in-memory ledger.
