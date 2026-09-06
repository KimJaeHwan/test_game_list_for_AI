# Checkpoint campaign integration

This adapter turns a long play campaign into sealed, finite episodes:

1. start a fresh player/model segment;
2. seal at the proactive checkpoint boundary;
3. verify the signed play artifact;
4. publish every frame in batches of at most 12;
5. verify the Wiki ACK and published file digests;
6. derive topic and episode shards;
7. load only the selected bounded context into the next fresh segment.

Filesystem paths never enter the campaign contract. The adapter gives the
orchestrator an opaque S000001-style source reference and resolves it through an
in-memory private map.

## Storage layout

Every play segment is published into its own physical Wiki. Episode artifacts
are below episodes/e000001/revisions/r000001. Small global indexes and selected
contexts are below routing/r000001, including manifest.json, topics/*.json, and
episodes/*.json.

The episode Wikis do not accumulate into one global assisted-Wiki snapshot.
Therefore the old 256-source and 2 MiB snapshot limits are per checkpoint
episode, not lifetime campaign limits. The global routing revision contains only
bounded knowledge items and generated shard indexes.

An individual episode still accepts at most 120 verified frames. Wiki analysis
uses one fresh model call per batch of at most 12 frames, so one episode can use
up to 10 Wiki calls. The live checkpoint defaults (24 frames or 12 key attempts)
normally seal well before that boundary.

## Live command

From agent_tools run:

    campaign-player.cmd --confirm-openai-upload
    campaign-player.cmd --confirm-openai-upload --checkpoints 5

The checkpoints option accepts 1 through 10 (default 3), which keeps the run
finite. The upload confirmation applies to screenshots sent to both the player
and Wiki model. ATLAS_TARGET_HWND is required.
ATLAS_CHECKPOINT_STATE_DIR can select an absolute parent directory; otherwise
output is written below .local/checkpoint-campaign/<campaign-id>.

The default proactive threshold is 45,000 model input tokens, 12 key attempts,
24 frames, or missing usage. It runs before the existing 55,000-token rollover.
Campaign budgets remain cumulative across fresh segments.

The final sealed segment is also published when the campaign reaches FINISHED,
even though terminal publication is outside the orchestrator's checkpoint
ledger. This fact and its ACK are recorded separately in
terminal-evidence-receipt.json. Failed or waiting campaigns do not perform that
post-campaign publication.

The final JSON preserves per-segment player usage, per-episode Wiki usage and
model-call counts, aggregates both token streams with safe-integer checks, and
continues to report monetary cost as unavailable because Codex CLI does not
report the charged amount.

## Current routing boundary

The adapter physically writes topic and episode shards and feeds the selected
context into the next segment. The live bridge currently has no trusted screen
semantic summary, so it uses the fixed text current episode; selection is
therefore driven conservatively by episode recency. A future trusted visual
classifier can supply a richer routing hint without exposing paths or accepting
model-selected shard names or ranks.

The private opaque source map and routed-context cache live for one process.
Crash-resume across a live campaign is not implemented yet; sealed episode
artifacts and receipts remain on disk for recovery tooling.

## Offline verification

From agent_tools run:

    node integration\checkpoint_campaign\verify.mjs

The test uses no remote model. It creates a real signed 25-frame synthetic play
run, verifies a 12/12/1 Wiki batch split, checks the exact ACK and routed-context
digest, starts a distinct fresh next player session, publishes terminal
evidence once, and verifies command safety.
