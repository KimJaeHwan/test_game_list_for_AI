import assert from 'node:assert/strict';
import { contentCounts, generateWorld, scenarioOptionsFromSeed } from '../src/content/generator.ts';
import { validateWorld } from '../src/content/validator.ts';
import { availableTargets, createGameState, createSessionBundle, createViewModel, reduceGame, stateFingerprint } from '../src/engine/index.ts';

function activate(state, kind, entityId) {
  const targets = availableTargets(state);
  const index = targets.findIndex((target) => target.kind === kind && target.entityId === entityId);
  assert.notEqual(index, -1, `missing target ${kind}:${entityId} in ${state.currentRegionId}`);
  assert.equal(targets[index].disabled, false, `disabled target ${kind}:${entityId} (${targets[index].stateLabel ?? 'unknown'})`);
  const delta = index - state.selectedTargetIndex;
  if (delta !== 0) reduceGame(state, { type: 'move-selection', delta });
  reduceGame(state, { type: 'activate-selection' });
  if (state.dialogue) reduceGame(state, { type: 'dismiss-dialogue' });
}

const talk = (state, npcId) => activate(state, 'talk', npcId);
const encounter = (state, encounterId) => activate(state, 'encounter', encounterId);
const craft = (state, recipeId) => activate(state, 'craft', recipeId);
const offer = (state, shopId, offerId) => activate(state, 'offer', `${shopId}:${offerId}`);
const travel = (state, exitId) => activate(state, 'travel', exitId);

function ensureTime(state, desired) {
  assert.equal(state.currentRegionId, 'ashen_harbor');
  if (state.time !== desired) activate(state, 'rest', 'time');
  assert.equal(state.time, desired);
}

function ensureTide(state, desired) {
  assert.equal(state.currentRegionId, 'tidal_flats');
  if (state.tide !== desired) talk(state, 'npc_neri');
  assert.equal(state.tide, desired);
}

function finishOracle(config, branchChoice = 'wardens') {
  const world = generateWorld(config);
  const options = scenarioOptionsFromSeed(config.scenarioSeed);
  const state = createGameState(world);
  reduceGame(state, { type: 'briefing-next' });
  reduceGame(state, { type: 'briefing-next' });
  assert.equal(state.phase, 'explore');

  talk(state, 'npc_mira');
  talk(state, 'npc_jun');
  travel(state, 'harbor_mosswood');
  talk(state, 'npc_sori');
  travel(state, 'mosswood_harbor');
  talk(state, 'npc_mira');
  assert.equal(state.questStates.main_01_atlas, 'complete');

  offer(state, 'shop_bora_supply', 'buy_copper');
  offer(state, 'shop_bora_supply', 'buy_kelp');
  talk(state, 'npc_bora');
  ensureTime(state, 'day');
  travel(state, 'harbor_mosswood');
  talk(state, 'npc_sena');
  encounter(state, 'salt_herb_patch');
  encounter(state, 'resin_tree');
  encounter(state, 'resin_tree');
  encounter(state, 'resin_tree');
  craft(state, 'recipe_herbal_tonic');
  talk(state, 'npc_sena');
  assert.equal(state.questStates.side_01_tonic, 'complete');

  if (options.lampBinder === 'moon_dust') {
    travel(state, 'mosswood_harbor');
    ensureTime(state, 'night');
    travel(state, 'harbor_mosswood');
    encounter(state, 'moon_moth');
  }
  craft(state, 'recipe_diving_lamp');
  talk(state, 'npc_sena');
  assert.equal(state.questStates.main_02_lamp, 'complete');

  travel(state, 'mosswood_harbor');
  if (options.wispWard === 'signal_flare') offer(state, 'shop_bora_supply', 'buy_lichen');
  offer(state, 'shop_bora_supply', 'buy_copper');
  offer(state, 'shop_bora_supply', 'buy_copper');
  if (options.wispWard === 'signal_flare') craft(state, 'recipe_signal_flare');
  travel(state, 'harbor_flats');
  talk(state, 'npc_neri');
  for (let index = 0; index < 3 && state.flags.sluice_open !== true; index += 1) talk(state, 'npc_neri');
  assert.equal(state.flags.sluice_open, true);
  if (state.questStates.main_03_sluice !== 'complete') talk(state, 'npc_neri');
  assert.equal(state.questStates.main_03_sluice, 'complete');
  ensureTide(state, options.mineTide);
  travel(state, 'flats_mine');
  talk(state, 'npc_moha');
  encounter(state, 'rust_sentinel');
  travel(state, 'mine_flats');
  travel(state, 'flats_harbor');
  talk(state, 'npc_mira');
  assert.equal(state.questStates.main_04_ledger, 'complete');
  if (branchChoice === 'wardens') {
    talk(state, 'npc_hael');
    travel(state, 'harbor_flats');
    talk(state, 'npc_rato');
    assert.equal(state.inventory.salvagers_mark ?? 0, 0, 'opposite branch reward leaked');
    travel(state, 'flats_harbor');
  } else {
    travel(state, 'harbor_flats');
    talk(state, 'npc_rato');
    travel(state, 'flats_harbor');
    talk(state, 'npc_hael');
    assert.equal(state.inventory.wardens_seal ?? 0, 0, 'opposite branch reward leaked');
  }
  assert.equal(state.branch, branchChoice);
  talk(state, 'npc_mira');
  assert.equal(state.questStates.main_05_divided, 'complete');
  assert.equal(state.questStates.main_06_beacon, 'active');

  if (options.prismCatalyst === 'true_pearl') {
    travel(state, 'harbor_flats');
    ensureTide(state, 'high');
    encounter(state, 'tidal_crab');
    encounter(state, 'tidal_crab');
    encounter(state, 'tidal_crab');
    travel(state, 'flats_harbor');
    talk(state, 'npc_bora');
    offer(state, 'exchange_shell_counter', 'exchange_true_pearl');
  }

  travel(state, 'harbor_flats');
  ensureTide(state, 'low');
  travel(state, 'flats_harbor');
  travel(state, 'harbor_mosswood');
  travel(state, 'mosswood_marsh');
  encounter(state, 'glass_reed_bed');
  if (options.prismCatalyst === 'wisp_dust') encounter(state, 'mire_wisp');
  travel(state, 'marsh_mosswood');
  travel(state, 'mosswood_harbor');
  craft(state, 'recipe_lens_blank');
  craft(state, 'recipe_star_prism');
  craft(state, 'recipe_beacon_core');
  travel(state, 'harbor_observatory');
  talk(state, 'npc_echo');
  talk(state, 'npc_echo');
  assert.equal(state.questStates.main_06_beacon, 'complete');
  assert.equal(state.flags.atlas_complete, true);
  activate(state, 'finish', 'archive');
  assert.equal(state.phase, 'result');
  assert.equal(state.success, true);
  assert.ok(state.actionCount < state.actionBudget);
  assert.ok(state.observations.length >= 20);
  const publicBundle = createSessionBundle(state);
  const publicJson = JSON.stringify(publicBundle);
  for (const privateKey of ['cueId', 'factIds', 'sourceId', 'regionId', 'detail', 'scenarioSeed', 'layoutSeed', 'visualSeed', 'sessionSeed', 'scenarioHash']) {
    assert.equal(publicJson.includes(`\"${privateKey}\"`), false, `public session leaked ${privateKey}`);
  }
  return state;
}

for (let index = 0; index < 50; index += 1) {
  const config = {
    scenarioSeed: 7301 + index,
    layoutSeed: 110 + index * 3,
    visualSeed: 1 + index,
    sessionSeed: 290 + index * 7,
  };
  const world = generateWorld(config);
  const validation = validateWorld(world);
  assert.equal(validation.valid, true, `invalid world seed ${index}: ${JSON.stringify(validation.issues)}`);
  const counts = contentCounts(world);
  assert.deepEqual(
    { regions: counts.regions, npcs: counts.npcs, quests: counts.quests, items: counts.items, encounters: counts.encounters, recipes: counts.recipes },
    { regions: 6, npcs: 12, quests: 14, items: 29, encounters: 7, recipes: 7 },
  );
  const transfer = generateWorld({ ...config, layoutSeed: Number(config.layoutSeed) + 1, visualSeed: Number(config.visualSeed) + 1, sessionSeed: Number(config.sessionSeed) + 1 });
  assert.equal(transfer.scenarioHash, world.scenarioHash, 'non-scenario seeds changed rule graph');
  assert.deepEqual(generateWorld(config), world, 'same config must generate identical world');
}

const repeatState = createGameState(generateWorld());
repeatState.phase = 'explore';
repeatState.currentRegionId = 'tidal_flats';
repeatState.questStates.side_03_shell_trade = 'complete';
repeatState.questStates.repeat_01_tide_sample = 'active';
repeatState.inventory.crab_claw = 2;
talk(repeatState, 'npc_neri');
assert.equal(repeatState.questCompletions.repeat_01_tide_sample, 1);
assert.equal(repeatState.inventory.crab_claw ?? 0, 0, 'repeatable turn-in must consume samples');
assert.equal(repeatState.questStates.repeat_01_tide_sample, 'active');
repeatState.inventory.crab_claw = 2;
talk(repeatState, 'npc_neri');
assert.equal(repeatState.questCompletions.repeat_01_tide_sample, 2);

const viewState = createGameState(generateWorld());
reduceGame(viewState, { type: 'briefing-next' });
reduceGame(viewState, { type: 'briefing-next' });
talk(viewState, 'npc_mira');
travel(viewState, 'harbor_mosswood');
const discoveryView = createViewModel(viewState);
assert.ok((discoveryView.world?.nodes.length ?? 0) < viewState.world.regions.length, 'map exposed undiscovered regions');
for (const privateKey of ['scenarioSeed', 'layoutSeed', 'visualSeed', 'sessionSeed', 'scenarioHash']) {
  assert.equal(JSON.stringify(discoveryView).includes(`\"${privateKey}\"`), false, `player view leaked ${privateKey}`);
}
reduceGame(viewState, { type: 'toggle-ledger' });
reduceGame(viewState, { type: 'cycle-ledger-filter' });
reduceGame(viewState, { type: 'cycle-ledger-filter' });
const dialogueView = createViewModel(viewState);
assert.ok(dialogueView.observations.length > 0);
assert.ok(dialogueView.observations.every((observation) => observation.kind === 'dialogue'));
const selectedEvidenceId = dialogueView.observations[0].id;
reduceGame(viewState, { type: 'toggle-bookmark' });
assert.equal(viewState.observations.find((observation) => observation.id === selectedEvidenceId)?.bookmarked, true, 'ledger bookmarked a different filtered observation');

const oracleRuns = [];
for (let index = 0; index < 16; index += 1) {
  const config = { scenarioSeed: 9001 + index, layoutSeed: 40 + index, visualSeed: 2 + index, sessionSeed: 80 + index };
  const completed = finishOracle(config, index % 2 === 0 ? 'wardens' : 'salvagers');
  const replay = createGameState(generateWorld(config));
  for (const action of completed.actionLog) reduceGame(replay, action);
  assert.equal(stateFingerprint(replay), stateFingerprint(completed), `replay mismatch for scenario ${config.scenarioSeed}`);
  oracleRuns.push({ scenario: config.scenarioSeed, actions: completed.actionCount, observations: completed.observations.length, hash: stateFingerprint(completed) });
}

console.log('QUEST ATLAS game verification passed');
console.log(JSON.stringify({ generatedSeeds: 50, oracleRuns: oracleRuns.length, sample: oracleRuns.slice(0, 4) }, null, 2));
