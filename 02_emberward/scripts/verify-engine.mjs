import assert from 'node:assert/strict';
import {
  RUNES,
  altarPosition,
  createGame,
  createReport,
  emptyInput,
  stateFingerprint,
  stepGame,
} from '../src/game.ts';

function recordStep(state, actions, overrides = {}) {
  const input = { ...emptyInput(), ...overrides };
  actions.push(input);
  stepGame(state, input);
}

function press(state, actions, field) {
  recordStep(state, actions, { [field]: true });
  recordStep(state, actions);
}

function moveTo(state, actions, target, options = {}) {
  const tolerance = options.tolerance ?? 16;
  const horizontalFirst = options.horizontalFirst ?? false;
  let guard = 0;
  while (Math.hypot(state.player.x - target.x, state.player.y - target.y) > tolerance) {
    guard += 1;
    assert.ok(guard < 5000, `moveTo stuck in ${state.scene} at ${state.player.x},${state.player.y}`);
    const dx = target.x - state.player.x;
    const dy = target.y - state.player.y;
    const input = {};
    if (horizontalFirst && Math.abs(dx) > tolerance) {
      input.right = dx > 0;
      input.left = dx < 0;
    } else if (!horizontalFirst && Math.abs(dy) > tolerance) {
      input.down = dy > 0;
      input.up = dy < 0;
    } else if (Math.abs(dx) > tolerance) {
      input.right = dx > 0;
      input.left = dx < 0;
    } else {
      input.down = dy > 0;
      input.up = dy < 0;
    }
    recordStep(state, actions, input);
  }
}

function solve(seed) {
  const state = createGame({ contentSeed: seed, visualSeed: 1, track: 'realtime' });
  const actions = [];

  moveTo(state, actions, { x: 480, y: 150 });
  press(state, actions, 'interactPressed');
  press(state, actions, 'interactPressed');
  press(state, actions, 'interactPressed');
  assert.equal(state.scene, 'forest');

  const correct = state.items.find((item) => item.sigil === state.correctItem);
  assert.ok(correct);
  moveTo(state, actions, { x: state.player.x, y: 505 });
  moveTo(state, actions, { x: correct.x, y: 505 }, { horizontalFirst: true });
  moveTo(state, actions, correct);
  press(state, actions, 'interactPressed');
  assert.equal(state.scene, 'mural');

  moveTo(state, actions, { x: 480, y: 145 });
  press(state, actions, 'interactPressed');
  assert.equal(state.muralVisible, true);
  press(state, actions, 'interactPressed');
  assert.equal(state.scene, 'altar');

  for (const sigil of state.muralSequence) {
    const target = altarPosition(sigil);
    moveTo(state, actions, { x: target.x, y: 455 }, { horizontalFirst: true, tolerance: 4 });
    moveTo(state, actions, target);
    press(state, actions, 'interactPressed');
  }
  assert.equal(state.scene, 'rune');

  const runeIndex = RUNES.indexOf(state.weakness);
  for (let index = 0; index < runeIndex; index += 1) press(state, actions, 'menuNextPressed');
  press(state, actions, 'interactPressed');
  assert.equal(state.scene, 'boss');

  let bossGuard = 0;
  while (state.scene === 'boss') {
    bossGuard += 1;
    assert.ok(bossGuard < 9000, `boss solver timed out for seed ${seed}`);
    const cue = state.bossCue;
    const input = {};
    if (cue?.kind === 'wave') input.guard = true;
    else if (cue?.kind === 'cone') {
      const goLeft = cue.targetX >= 480;
      if (Math.abs(state.player.x - cue.targetX) < 150) {
        input.left = goLeft;
        input.right = !goLeft;
      }
    } else if (cue?.kind === 'open' && !cue.responded) input.attackPressed = true;
    else if (cue?.kind === 'rune' && !cue.responded) input.runePressed = true;
    recordStep(state, actions, input);
  }
  assert.equal(state.scene, 'beacon');

  moveTo(state, actions, { x: 480, y: 155 });
  press(state, actions, 'interactPressed');
  assert.equal(state.scene, 'result');
  assert.equal(state.success, true);
  return { state, actions };
}

const sameA = createGame({ contentSeed: 4201, visualSeed: 2 });
const sameB = createGame({ contentSeed: 4201, visualSeed: 2 });
assert.equal(stateFingerprint(sameA), stateFingerprint(sameB), 'same configuration must create the same state');

const changed = createGame({ contentSeed: 4202, visualSeed: 2 });
assert.notDeepEqual(
  [sameA.correctItem, sameA.muralSequence, sameA.weakness, sameA.bossPattern],
  [changed.correctItem, changed.muralSequence, changed.weakness, changed.bossPattern],
  'content seed must change at least one meaningful element',
);

for (let seed = 4201; seed <= 4220; seed += 1) {
  const solved = solve(seed);
  const report = createReport(solved.state);
  assert.equal(report.progress, 100, `seed ${seed} must reach all milestones`);
  assert.ok(report.vcs >= 70, `oracle VCS should be healthy for seed ${seed}`);

  const replay = createGame({ contentSeed: seed, visualSeed: 1, track: 'realtime' });
  for (const input of solved.actions) stepGame(replay, input);
  assert.equal(
    stateFingerprint(replay),
    stateFingerprint(solved.state),
    `replay hash must match for seed ${seed}`,
  );
}

const recovery = createGame({ contentSeed: 4201 });
const wrong = recovery.items.find((item) => item.sigil !== recovery.correctItem);
recovery.scene = 'forest';
recovery.player = { x: wrong.x, y: wrong.y };
stepGame(recovery, { ...emptyInput(), interactPressed: true });
assert.equal(recovery.scene, 'forest', 'a wrong item must not block later evaluation');
assert.equal(recovery.stats.wrongItems, 1, 'a wrong item must be logged');

console.log('EMBERWARD verification passed: 20 deterministic seeds, oracle completion, replay hashes, and recovery.');
