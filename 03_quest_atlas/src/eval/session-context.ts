import { sessionRunId } from "../engine/state.ts";
import type { GameState } from "../engine/types.ts";
import type { ObservedEvidence } from "./types.ts";

export interface EvaluationSessionContext {
  readonly runId: string;
  readonly observations: readonly ObservedEvidence[];
  readonly discoverableFactIds: readonly string[];
}

/** Private evaluator adapter. Do not serialize this object into the agent-visible session bundle. */
export function evaluationContextFromState(state: GameState): EvaluationSessionContext {
  const runId = sessionRunId(state);
  const discoverableFactIds = new Set<string>();
  const observations = state.observations.map((observation): ObservedEvidence => {
    for (const factId of observation.factIds) discoverableFactIds.add(factId);
    return {
      id: observation.id,
      cueIds: [observation.cueId],
      runId,
      startTick: observation.actionIndex,
      endTick: observation.actionIndex,
    };
  });
  return {
    runId,
    observations,
    discoverableFactIds: [...discoverableFactIds].sort(),
  };
}
