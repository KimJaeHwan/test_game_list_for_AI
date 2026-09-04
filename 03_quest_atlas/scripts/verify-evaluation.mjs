import assert from "node:assert/strict";
import { generateWorld } from "../src/content/generator.ts";
import { availableTargets, createGameState, reduceGame } from "../src/engine/index.ts";
import {
  canonicalFactsFromWorld,
  evaluateSubmission,
  evaluationContextFromState,
  exportKnowledgeMarkdown,
  exportScoreMarkdown,
  validateKnowledgeSubmission,
} from "../src/eval/index.ts";
import { runVerifiedReplay } from "../src/replay/index.ts";

function activate(state, kind, entityId) {
  const targets = availableTargets(state);
  const index = targets.findIndex((target) => target.kind === kind && target.entityId === entityId);
  assert.notEqual(index, -1, "missing target " + kind + ":" + entityId);
  assert.equal(targets[index].disabled, false, "disabled target " + kind + ":" + entityId);
  const delta = index - state.selectedTargetIndex;
  if (delta !== 0) reduceGame(state, { type: "move-selection", delta });
  reduceGame(state, { type: "activate-selection" });
  if (state.dialogue) reduceGame(state, { type: "dismiss-dialogue" });
}

function playFirstMainQuest(world) {
  const state = createGameState(world);
  reduceGame(state, { type: "briefing-next" });
  reduceGame(state, { type: "briefing-next" });
  activate(state, "talk", "npc_mira");
  activate(state, "talk", "npc_jun");
  activate(state, "travel", "harbor_mosswood");
  activate(state, "talk", "npc_sori");
  activate(state, "travel", "mosswood_harbor");
  activate(state, "talk", "npc_mira");
  assert.equal(state.questStates.main_01_atlas, "complete");
  return state;
}

const sourceConfig = { scenarioSeed: 7301, layoutSeed: 11, visualSeed: 1, sessionSeed: 29 };
const sourceWorld = generateWorld(sourceConfig);
const sourcePlay = playFirstMainQuest(sourceWorld);
const transferConfig = { ...sourceConfig, layoutSeed: 12, visualSeed: 2, sessionSeed: 30 };
const transferWorld = generateWorld(transferConfig);
const transferPlay = playFirstMainQuest(transferWorld);

function verifiedRuns(procedureId) {
  const reproduction = runVerifiedReplay({
    track: "reproduction",
    procedureId,
    sourceConfig: sourceWorld.config,
    sourceScenarioHash: sourceWorld.scenarioHash,
    targetWorld: sourceWorld,
    actions: sourcePlay.actionLog,
    goal: { id: "goal-first-atlas", kind: "questComplete", questId: "main_01_atlas" },
    referenceActionCount: sourcePlay.actionCount,
  });
  const transfer = runVerifiedReplay({
    track: "transfer",
    procedureId,
    sourceConfig: sourceWorld.config,
    sourceScenarioHash: sourceWorld.scenarioHash,
    targetWorld: transferWorld,
    actions: transferPlay.actionLog,
    goal: { id: "goal-first-atlas-transfer", kind: "questComplete", questId: "main_01_atlas" },
    referenceActionCount: transferPlay.actionCount,
  });
  assert.equal(reproduction.success, true);
  assert.equal(transfer.success, true);
  assert.notEqual(reproduction.runId, transfer.runId);
  return { reproduction: [reproduction], transfer: [transfer] };
}

const truth = [
  { id: "f-quest", subject: "등대지기", predicate: "의뢰", object: "별빛 렌즈", conditions: [{ has: "낡은 지도" }], weight: 3, evidenceCueIds: ["cue-dialog-keeper"] },
  { id: "f-drop", subject: "해안 게", predicate: "드롭", object: "푸른 껍질", conditions: [], weight: 1, evidenceCueIds: ["cue-loot-shell"] },
  { id: "f-recipe", subject: "별빛 렌즈", predicate: "제작식", object: ["푸른 껍질", "수정 가루"], conditions: [{ station: "연금대" }], weight: 3, evidenceCueIds: ["cue-recipe-lens"] },
  { id: "f-unlock", subject: "별빛 렌즈", predicate: "해금", object: "침수 동굴", conditions: [{ time: "밤" }], weight: 3, evidenceCueIds: ["cue-cave-open"] },
];
const runId = "fixture-run";
const observations = truth.map((fact, index) => ({
  id: "obs-" + (index + 1),
  cueIds: [fact.evidenceCueIds[0]],
  runId,
  startTick: index * 100,
  endTick: index * 100 + 30,
}));
observations.push({ id: "obs-unrelated", cueIds: ["cue-weather"], runId, startTick: 600, endTick: 630 });

function makeOracleSubmission(procedureId = "proc-lens") {
  return {
    schemaVersion: "1.0",
    title: "별빛 렌즈 조사",
    scenarioId: "fixture",
    entities: [{ localId: "npc-keeper", type: "npc", name: "등대지기", attributes: {}, confidence: 1, evidenceIds: ["ev-1"] }],
    claims: truth.map((fact, index) => ({
      id: "claim-" + (index + 1),
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      conditions: fact.conditions,
      confidence: 1,
      evidenceIds: ["ev-" + (index + 1)],
    })),
    procedures: [{
      id: procedureId,
      name: "별빛 렌즈로 동굴 열기",
      goal: "침수 동굴 해금",
      preconditions: [{ has: "낡은 지도" }],
      steps: [{
        order: 1,
        action: "제작",
        target: "별빛 렌즈",
        requirements: ["푸른 껍질", "수정 가루"],
        expectedChange: [{ has: "별빛 렌즈" }],
        evidenceIds: ["ev-3"],
      }],
      successConditions: [{ unlocked: "침수 동굴" }],
      alternatives: [],
      failureModes: ["낮에는 열리지 않음"],
      recovery: ["밤까지 대기"],
      confidence: 1,
      evidenceIds: ["ev-4"],
    }],
    evidence: truth.map((_fact, index) => ({
      id: "ev-" + (index + 1),
      observationIds: ["obs-" + (index + 1)],
      note: "직접 관찰",
    })),
    unknowns: [],
    contradictions: [],
  };
}

const runs = verifiedRuns("proc-lens");
function evaluate(submission, observed = observations, reproduction = runs.reproduction, transfer = runs.transfer) {
  return evaluateSubmission({ runId, truth, submission, observations: observed, reproduction, transfer });
}

const oracleSubmission = makeOracleSubmission();
const schema = validateKnowledgeSubmission(oracleSubmission);
assert.equal(schema.valid, true, schema.errors.join("\n"));
const oracle = evaluate(oracleSubmission);
assert.equal(oracle.score.total, 100);
assert.equal(oracle.reproduction.rejectedOutcomes, 0);
assert.equal(oracle.transfer.rejectedOutcomes, 0);

const missingSubmission = structuredClone(oracleSubmission);
missingSubmission.claims = missingSubmission.claims.filter((claim) => claim.id !== "claim-4");
const missing = evaluate(missingSubmission);
assert.ok(missing.score.total < oracle.score.total);
assert.ok(missing.facts.missingFactIds.includes("f-unlock"));

const hallucinatedSubmission = structuredClone(oracleSubmission);
hallucinatedSubmission.claims.push({
  id: "claim-fake", subject: "유령 상인", predicate: "판매", object: "무료 별빛 렌즈",
  conditions: [], confidence: 1, evidenceIds: ["ev-fake"],
});
hallucinatedSubmission.evidence.push({ id: "ev-fake", observationIds: ["obs-unrelated"], note: "상관없는 관찰" });
const hallucinated = evaluate(hallucinatedSubmission);
assert.ok(hallucinated.score.hallucinationPenalty > 0);

const wrongConditionSubmission = structuredClone(oracleSubmission);
wrongConditionSubmission.claims[3].conditions = [{ time: "낮" }];
const wrongCondition = evaluate(wrongConditionSubmission);
assert.equal(wrongCondition.facts.conditionMismatches.length, 1);
assert.ok(wrongCondition.score.hallucinationPenalty > 0);

const invalidEvidenceSubmission = structuredClone(oracleSubmission);
invalidEvidenceSubmission.evidence[2].observationIds = ["obs-unrelated"];
const invalidEvidence = evaluate(invalidEvidenceSubmission);
assert.equal(invalidEvidence.facts.f1, oracle.facts.f1);
assert.ok(invalidEvidence.evidence.coverage < oracle.evidence.coverage);

const stuffedSubmission = structuredClone(oracleSubmission);
for (const evidence of stuffedSubmission.evidence) evidence.observationIds = observations.map((item) => item.id);
const stuffed = evaluate(stuffedSubmission);
assert.equal(stuffed.evidence.validLinks, 0);
assert.equal(stuffed.evidence.oversizedEvidenceIds.length, truth.length);
assert.ok(stuffed.score.components.evidenceAndCalibration < oracle.score.components.evidenceAndCalibration);

const mixedEvidenceSubmission = structuredClone(oracleSubmission);
mixedEvidenceSubmission.evidence[0].observationIds = ["obs-1", "obs-unrelated"];
const mixedEvidence = evaluate(mixedEvidenceSubmission);
assert.ok(mixedEvidence.evidence.invalidEvidenceIds.includes("ev-1"));
assert.equal(mixedEvidence.evidence.oversizedEvidenceIds.length, 0);

const crossRunSubmission = structuredClone(oracleSubmission);
crossRunSubmission.evidence[0].observationIds = ["obs-other-run"];
const crossRunObservations = [...observations, {
  id: "obs-other-run",
  cueIds: ["cue-dialog-keeper"],
  runId: "different-run",
  startTick: 0,
  endTick: 10,
}];
const crossRun = evaluate(crossRunSubmission, crossRunObservations);
assert.ok(crossRun.evidence.crossRunEvidenceIds.includes("ev-1"));
assert.ok(crossRun.evidence.coverage < 1);

const forgedOutcome = {
  track: "reproduction",
  runId: "forged",
  goalId: "goal-first-atlas",
  procedureId: "proc-lens",
  success: true,
  goalCompletion: 1,
  actionCount: 1,
  referenceActionCount: 1,
  invalidActions: 0,
  finalStateHash: "forged",
  sourceScenarioHash: sourceWorld.scenarioHash,
  targetScenarioHash: sourceWorld.scenarioHash,
};
const forged = evaluate(oracleSubmission, observations, [forgedOutcome], [structuredClone(runs.transfer[0])]);
assert.equal(forged.score.components.reproduction, 0);
assert.equal(forged.score.components.transfer, 0);
assert.equal(forged.reproduction.rejectedOutcomes, 1);
assert.equal(forged.transfer.rejectedOutcomes, 1);

const wrongProcedureSubmission = makeOracleSubmission("different-procedure");
const wrongProcedure = evaluate(wrongProcedureSubmission);
assert.equal(wrongProcedure.score.components.reproduction, 0);
assert.equal(wrongProcedure.score.components.transfer, 0);
assert.equal(wrongProcedure.reproduction.rejectedOutcomes, 1);

assert.throws(() => runVerifiedReplay({
  track: "transfer",
  procedureId: "proc-lens",
  sourceConfig: sourceWorld.config,
  sourceScenarioHash: sourceWorld.scenarioHash,
  targetWorld: sourceWorld,
  actions: sourcePlay.actionLog,
  goal: { id: "bad-transfer", kind: "questComplete", questId: "main_01_atlas" },
}), /must change/);

const realFacts = canonicalFactsFromWorld(sourceWorld);
assert.equal(realFacts.length, sourceWorld.facts.length);
assert.ok(realFacts.every((fact) => fact.weight > 0 && Array.isArray(fact.conditions)));
const routeFact = realFacts.find((fact) => fact.id === "route_harbor_mosswood");
assert.equal(routeFact?.subject, "잿빛 항구");
assert.equal(routeFact?.object, "이끼숲");
assert.equal(JSON.stringify([routeFact?.subject, routeFact?.object, routeFact?.conditions]).includes("mosswood"), false);

const context = evaluationContextFromState(sourcePlay);
assert.ok(context.observations.length > 0);
assert.ok(context.discoverableFactIds.length > 0);
assert.ok(context.observations.every((observation) => observation.runId === context.runId));
const factById = new Map(realFacts.map((fact) => [fact.id, fact]));
const discovered = context.discoverableFactIds.map((id) => factById.get(id)).filter(Boolean);
const realEvidence = discovered.map((fact, index) => {
  const observation = sourcePlay.observations.find((item) => item.factIds.includes(fact.id));
  assert.ok(observation, "missing real observation for " + fact.id);
  return { id: "real-ev-" + index, observationIds: [observation.id], note: "실제 플레이 관찰" };
});
const realSubmission = {
  schemaVersion: "1.0",
  title: "첫 항로 조사",
  scenarioId: sourceWorld.scenarioHash,
  entities: [{ localId: "mira", type: "npc", name: "미라", attributes: {}, confidence: 1, evidenceIds: [realEvidence[0].id] }],
  claims: discovered.map((fact, index) => ({
    id: "real-claim-" + index,
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    conditions: fact.conditions,
    confidence: 1,
    evidenceIds: [realEvidence[index].id],
  })),
  procedures: [{
    id: "proc-atlas",
    name: "빈 지도책 조사",
    goal: "첫 항로 퀘스트 완료",
    preconditions: [],
    steps: [{ order: 1, action: "NPC와 대화하고 이끼숲 조사", requirements: [], expectedChange: ["첫 항로 완료"], evidenceIds: [realEvidence[0].id] }],
    successConditions: ["첫 항로 완료"],
    alternatives: [],
    failureModes: [],
    recovery: [],
    confidence: 1,
    evidenceIds: [realEvidence[0].id],
  }],
  evidence: realEvidence,
  unknowns: [],
  contradictions: [],
};
const realRuns = verifiedRuns("proc-atlas");
const realReport = evaluateSubmission({
  runId: context.runId,
  truth: realFacts,
  submission: realSubmission,
  observations: context.observations,
  reproduction: realRuns.reproduction,
  transfer: realRuns.transfer,
  options: { discoverableFactIds: context.discoverableFactIds },
});
assert.equal(realReport.validationErrors.length, 0);
assert.equal(realReport.evidence.coverage, 1);
assert.equal(realReport.score.components.discoverableCompleteness, 15);
assert.equal(realReport.score.components.reproduction, 15);
assert.equal(realReport.score.components.transfer, 20);
assert.ok(Number.isFinite(realReport.score.total));

const wiki = exportKnowledgeMarkdown(oracleSubmission);
const scoreMarkdown = exportScoreMarkdown(oracle);
assert.match(wiki, /## 규칙과 관계/);
assert.match(scoreMarkdown, /총점 100\.00/);

console.log("QUEST ATLAS evaluation verification passed");
console.log(JSON.stringify({
  oracle: oracle.score.total,
  missing: Number(missing.score.total.toFixed(2)),
  hallucinated: Number(hallucinated.score.total.toFixed(2)),
  wrongCondition: Number(wrongCondition.score.total.toFixed(2)),
  invalidEvidence: Number(invalidEvidence.score.total.toFixed(2)),
  stuffedEvidence: Number(stuffed.score.total.toFixed(2)),
  mixedEvidence: Number(mixedEvidence.score.total.toFixed(2)),
  crossRunEvidence: Number(crossRun.score.total.toFixed(2)),
  forgedExecution: Number(forged.score.total.toFixed(2)),
  wrongProcedure: Number(wrongProcedure.score.total.toFixed(2)),
  realWorldIntegration: Number(realReport.score.total.toFixed(2)),
  realWorldDiscoveredFacts: context.discoverableFactIds.length,
}, null, 2));
