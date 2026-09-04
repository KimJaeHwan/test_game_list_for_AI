import assert from 'node:assert/strict';
import {
  createInitialGame,
  INCIDENT_DEFS,
  reduceGame,
  replayActions,
  ROOM_CONNECTIONS,
  stateFingerprint,
} from '../lib/game/index.ts';

function act(state, action) {
  return reduceGame(state, action);
}

function blockedRooms(state) {
  return new Set(state.incidents.filter((item) => item.kind === 'door' && item.status === 'active').map((item) => item.roomId));
}

function route(from, targets, state) {
  const blocked = blockedRooms(state);
  const queue = [[from]];
  const visited = new Set([from]);
  while (queue.length) {
    const path = queue.shift();
    const current = path.at(-1);
    if (targets.includes(current)) return path;
    for (const next of ROOM_CONNECTIONS[current]) {
      if (blocked.has(next) || visited.has(next)) continue;
      visited.add(next);
      queue.push([...path, next]);
    }
  }
  throw new Error('No route found');
}

function solve(input) {
  let state = act(input, { type: 'START' });
  let guard = 0;
  while (state.phase === 'active' && guard < 80) {
    guard += 1;
    const incident = state.incidents.find((item) => item.status === 'active');
    if (!incident) {
      const offRoom = state.rooms.find((room) => !room.powered);
      state = offRoom ? act(state, { type: 'TOGGLE_POWER', roomId: offRoom.id }) : act(state, { type: 'WAIT' });
      continue;
    }
    const droneId = incident.kind === 'leak' || incident.kind === 'fire' ? 'PATCH-01' : 'VOLT-02';
    const drone = state.drones[droneId];
    const repairTargets = incident.kind === 'door' ? [incident.roomId, ...ROOM_CONNECTIONS[incident.roomId]] : [incident.roomId];
    if (!repairTargets.includes(drone.roomId)) {
      const path = route(drone.roomId, repairTargets, state);
      state = act(state, { type: 'MOVE_DRONE', droneId, to: path[1] });
      continue;
    }
    const room = state.rooms.find((item) => item.id === incident.roomId);
    if (INCIDENT_DEFS[incident.kind].requiresPowerOff && room.powered) {
      state = act(state, { type: 'TOGGLE_POWER', roomId: room.id });
      continue;
    }
    state = act(state, { type: 'USE_TOOL', droneId, toolId: INCIDENT_DEFS[incident.kind].tool, incidentId: incident.id });
  }
  return state;
}

const first = createInitialGame({ seed: 2709, layoutSeed: 14 });
const second = createInitialGame({ seed: 2709, layoutSeed: 14 });
assert.equal(stateFingerprint(first), stateFingerprint(second), 'same seeds must create the same world');

const otherLayout = createInitialGame({ seed: 2709, layoutSeed: 29 });
assert.notDeepEqual(first.rooms.map((room) => room.kind), otherLayout.rooms.map((room) => room.kind), 'layout seed must change room roles');

let unsafe = act(createInitialGame({ seed: 2709 }), { type: 'START' });
const arc = unsafe.incidents.find((item) => item.kind === 'arc');
const circuitBefore = unsafe.inventory.circuit;
unsafe = act(unsafe, { type: 'USE_TOOL', droneId: 'VOLT-02', toolId: 'circuit', incidentId: arc.id });
assert.equal(unsafe.inventory.circuit, circuitBefore, 'unsafe or out-of-range work must not consume inventory');

const solved = solve(createInitialGame({ seed: 2709, layoutSeed: 14 }));
assert.equal(solved.phase, 'won', `oracle must solve seed 2709, got ${solved.phase}: ${solved.terminalReason}`);
assert.ok(solved.stats.incidentsResolved >= 4, 'all scheduled incidents must be resolved');
assert.ok(solved.rooms.every((room) => room.powered), 'power must be restored');

const replayed = replayActions(solved.config, solved.log.map((entry) => entry.action));
assert.equal(stateFingerprint(replayed), stateFingerprint(solved), 'replay must reproduce final state');
assert.equal(replayed.log.length, solved.log.length, 'replay must preserve action count');

for (let seed = 2710; seed < 2720; seed += 1) {
  const run = solve(createInitialGame({ seed, layoutSeed: 14 }));
  assert.equal(run.phase, 'won', `oracle must solve seed ${seed}`);
}

console.log('SHIFT//RESCUE engine verification passed: 11 deterministic seeds, safety, replay, and layout checks.');
