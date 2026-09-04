import type { FactValue, GeneratedWorld, WorldConfig } from "../content/schema.ts";
import { createGameState, sessionRunId, stateFingerprint } from "../engine/state.ts";
import { reduceGame } from "../engine/reducer.ts";
import type { GameAction, GameState } from "../engine/types.ts";
import type { RunOutcome } from "../eval/types.ts";

export type ReplayGoal =
  | { readonly id: string; readonly kind: "questComplete"; readonly questId: string }
  | { readonly id: string; readonly kind: "flagEquals"; readonly flag: string; readonly value: FactValue }
  | { readonly id: string; readonly kind: "hasItem"; readonly itemId: string; readonly count: number }
  | { readonly id: string; readonly kind: "sessionSuccess" };

export interface VerifiedReplaySpec {
  readonly track: "reproduction" | "transfer";
  readonly procedureId: string;
  readonly sourceConfig: WorldConfig;
  readonly sourceScenarioHash: string;
  readonly targetWorld: GeneratedWorld;
  readonly actions: readonly GameAction[];
  readonly goal: ReplayGoal;
  readonly referenceActionCount?: number;
}

const verifiedOutcomes = new WeakSet<object>();

function seed(value: string | number): string {
  return String(value);
}

function sameConfig(left: WorldConfig, right: WorldConfig): boolean {
  return seed(left.scenarioSeed) === seed(right.scenarioSeed)
    && seed(left.layoutSeed) === seed(right.layoutSeed)
    && seed(left.visualSeed) === seed(right.visualSeed)
    && seed(left.sessionSeed) === seed(right.sessionSeed);
}

function validateTrack(spec: VerifiedReplaySpec): void {
  const target = spec.targetWorld;
  if (target.scenarioHash !== spec.sourceScenarioHash) {
    throw new Error("Replay target does not have the source scenario rule graph.");
  }
  if (seed(target.config.scenarioSeed) !== seed(spec.sourceConfig.scenarioSeed)) {
    throw new Error("Replay target changed scenarioSeed.");
  }
  if (spec.track === "reproduction" && !sameConfig(target.config, spec.sourceConfig)) {
    throw new Error("Reproduction must use the exact source configuration.");
  }
  if (spec.track === "transfer" && sameConfig(target.config, spec.sourceConfig)) {
    throw new Error("Transfer must change layout, visual, or session seed.");
  }
  if (!spec.procedureId.trim()) throw new Error("A verified replay must identify the submitted procedure.");
}

function goalResult(state: GameState, goal: ReplayGoal): { success: boolean; completion: number } {
  switch (goal.kind) {
    case "questComplete": {
      if (!state.world.quests.some((quest) => quest.id === goal.questId)) throw new Error("Unknown replay quest goal: " + goal.questId);
      const status = state.questStates[goal.questId];
      return { success: status === "complete", completion: status === "complete" ? 1 : status === "active" ? 0.5 : status === "available" ? 0.25 : 0 };
    }
    case "flagEquals": {
      const success = state.flags[goal.flag] === goal.value;
      return { success, completion: success ? 1 : 0 };
    }
    case "hasItem": {
      if (!state.world.items.some((item) => item.id === goal.itemId)) throw new Error("Unknown replay item goal: " + goal.itemId);
      const count = Math.max(1, goal.count);
      const held = Math.max(0, state.inventory[goal.itemId] ?? 0);
      return { success: held >= count, completion: Math.min(1, held / count) };
    }
    case "sessionSuccess":
      return { success: state.success === true, completion: state.success === true ? 1 : 0 };
  }
}

/**
 * Replays actual engine actions from a fresh target world and mints the only RunOutcome
 * objects accepted by scoreRunSet. The WeakSet mark deliberately does not survive cloning.
 */
export function runVerifiedReplay(spec: VerifiedReplaySpec): RunOutcome {
  validateTrack(spec);
  const state = createGameState(spec.targetWorld);
  for (const action of spec.actions) reduceGame(state, action);
  const goal = goalResult(state, spec.goal);
  const outcome: RunOutcome = Object.freeze({
    track: spec.track,
    runId: sessionRunId(state),
    goalId: spec.goal.id,
    procedureId: spec.procedureId,
    success: goal.success,
    goalCompletion: goal.completion,
    actionCount: state.actionCount,
    ...(spec.referenceActionCount === undefined ? {} : { referenceActionCount: Math.max(1, spec.referenceActionCount) }),
    invalidActions: state.events.filter((event) => event.type === "blocked").length,
    finalStateHash: stateFingerprint(state),
    sourceScenarioHash: spec.sourceScenarioHash,
    targetScenarioHash: spec.targetWorld.scenarioHash,
  });
  verifiedOutcomes.add(outcome);
  return outcome;
}

export function isVerifiedRunOutcome(
  value: RunOutcome,
  expectedTrack?: RunOutcome["track"],
): boolean {
  return verifiedOutcomes.has(value) && (expectedTrack === undefined || value.track === expectedTrack);
}
