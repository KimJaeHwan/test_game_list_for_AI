import type { RunOutcome, RunSetScore } from "../eval/types.ts";
import { isVerifiedRunOutcome } from "./verified-replay.ts";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function scoreRunSet(
  outcomes: readonly RunOutcome[],
  completionWeight: number,
  expectedTrack?: RunOutcome["track"],
  acceptedProcedureIds?: ReadonlySet<string>,
): RunSetScore {
  if (outcomes.length === 0) return { completion: 0, efficiency: 0, composite: 0, completedGoals: 0, totalGoals: 0, rejectedOutcomes: 0 };
  const verified = outcomes.filter((outcome) =>
    isVerifiedRunOutcome(outcome, expectedTrack)
    && (acceptedProcedureIds === undefined || acceptedProcedureIds.has(outcome.procedureId))
  );
  let completionTotal = 0;
  let efficiencyTotal = 0;
  let completedGoals = 0;
  for (const outcome of verified) {
    const completion = clamp01(outcome.goalCompletion ?? (outcome.success ? 1 : 0));
    completionTotal += completion;
    if (outcome.success) completedGoals += 1;
    if (outcome.success) {
      if (outcome.referenceActionCount !== undefined) {
        const reference = Math.max(1, outcome.referenceActionCount);
        const actions = Math.max(1, outcome.actionCount);
        const routeEfficiency = Math.min(1, reference / actions);
        const invalidActionFactor = 1 / (1 + Math.max(0, outcome.invalidActions ?? 0) * 0.1);
        efficiencyTotal += routeEfficiency * invalidActionFactor;
      }
    }
  }
  const completion = completionTotal / outcomes.length;
  const efficiency = efficiencyTotal / outcomes.length;
  return {
    completion,
    efficiency,
    composite: clamp01(completionWeight * completion + (1 - completionWeight) * efficiency),
    completedGoals,
    totalGoals: outcomes.length,
    rejectedOutcomes: outcomes.length - verified.length,
  };
}
