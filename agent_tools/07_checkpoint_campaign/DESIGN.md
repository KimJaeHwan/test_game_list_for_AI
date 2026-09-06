# Checkpoint Campaign Design

This package coordinates long-running assisted play without depending on a model's
automatic context compaction. It contains no OS or model implementation. Callers
inject three ports: `playSegment`, `publishWiki`, and `loadContext`.

## State machine

`CREATED -> RUNNING -> FINISHED` is the terminal path. A checkpoint takes the
strict path below:

`RUNNING -> SEALED PARTIAL with continuation -> publish -> exact ACK -> load and verify context -> RUNNING`

Every segment receives `sessionMode: "FRESH"`. The orchestrator will not issue
the next play call until the sealed source is published and the ACK-bound context
has been loaded and verified. A transient publish failure returns
`WAITING_FOR_WIKI`; retrying `run()` reuses the same idempotency key and never
replays the segment. A transient load failure returns `WAITING_FOR_CONTEXT`;
retrying loads only that context. Malformed receipts, ACKs, contexts, or exceeded
budgets fail closed.

## Separation and atomicity

- The sealed segment remains the source evidence. The orchestrator stores only
  its opaque reference, digest, accounting, and continuation receipt while work is
  pending.
- The Wiki publisher owns Wiki materialization and returns a commit ACK.
- The loaded knowledge context is a bounded, validated projection for the next
  fresh player session.
- The deterministic private ledger stores lifecycle metadata only. Its
  `CampaignLedgerStore` delegates to a trusted adapter providing exclusive
  creation and atomic compare-and-swap. Reload verifies the full hash chain, and a
  failed CAS leaves memory unchanged. The ledger never stores model plans, raw
  errors, key names, coordinates, screenshots, or source paths.
- Publication is the atomic boundary. A publish exception cannot advance the Wiki
  revision, activate a context, or start another player. Exact ACK binding prevents
  an ACK from another source, revision, or retry from crossing that boundary.

## Campaign accounting

`turns`, `keyAttempts`, `frames`, and `elapsedMs` are deducted from one
campaign-wide budget after every valid sealed segment. `checkpoints` is deducted
for each PARTIAL continuation. Values never refill at a fresh-session boundary.
Any underflow ends the campaign with a stable failure code.

## Automatic sharding and context selection

`buildShardManifest` is a pure deterministic router. It derives a topic first
from trusted page kind, then trusted namespace, and only then a fixed English and
Korean vocabulary. It derives an episode from trusted `sourceOrdinal`, then emits only
generated `topics/*.json` and `episodes/eNNNNNN.json` paths.

`createRelevantContextSelector` takes `topK` from trusted construction config.
Its selection input contains current text and episode metadata only. It computes
fixed lexical, topic, and episode scores with stable tie-breaking. Exact-shape
validation rejects any attempted model-provided path, topic, rank, or topK.
`createShardedKnowledgeContextBuilder` joins routing and selection and returns
the validated context that a `loadContext` adapter supplies to the next play.

## Relationship to in-session rollover

Model-session rollover remains useful below a checkpoint threshold, but it is not
the durable knowledge boundary. The player supervisor must evaluate checkpoint
policy before rollover. Once it emits a sealed PARTIAL continuation, this package
owns the publish/ACK/context/fresh-session sequence.
