import { createRng, hash32, shuffled } from './prng.ts';
import type {
  ActionRecord,
  DroneId,
  GameAction,
  GameConfig,
  GameState,
  IncidentKind,
  IncidentState,
  InvalidReason,
  ResourceKey,
  RoomId,
  RoomKind,
  ScheduledIncident,
  ToolId,
} from './types.ts';

export const ROOM_IDS: RoomId[] = ['A-01', 'A-02', 'B-03', 'B-04', 'C-05', 'C-06'];
export const ROOM_KINDS: RoomKind[] = ['dock', 'medbay', 'hydro', 'coolant', 'power', 'lab'];

export const ROOM_CONNECTIONS: Record<RoomId, RoomId[]> = {
  'A-01': ['A-02', 'B-04'],
  'A-02': ['A-01', 'B-03', 'C-05'],
  'B-03': ['A-02', 'C-06'],
  'B-04': ['A-01', 'C-05'],
  'C-05': ['B-04', 'A-02', 'C-06'],
  'C-06': ['C-05', 'B-03'],
};

export const INCIDENT_DEFS: Record<IncidentKind, {
  tool: ToolId;
  resource: ResourceKey | null;
  damage: number;
  requiresPowerOff: boolean;
}> = {
  leak: { tool: 'sealant', resource: 'oxygen', damage: 2, requiresPowerOff: true },
  fire: { tool: 'foam', resource: 'hull', damage: 2, requiresPowerOff: false },
  arc: { tool: 'circuit', resource: 'energy', damage: 3, requiresPowerOff: true },
  door: { tool: 'override', resource: null, damage: 0, requiresPowerOff: false },
};

export const TOOL_DEFS: Record<ToolId, { labelKo: string; labelEn: string; code: string }> = {
  sealant: { labelKo: '실링 건', labelEn: 'Sealant', code: 'SL-02' },
  foam: { labelKo: '소화 폼', labelEn: 'Fire foam', code: 'FF-04' },
  circuit: { labelKo: '회로 키트', labelEn: 'Circuit kit', code: 'CK-11' },
  override: { labelKo: '해제 키', labelEn: 'Override key', code: 'OK-07' },
};

export function createGameConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    seed: overrides.seed ?? 2709,
    layoutSeed: overrides.layoutSeed ?? 14,
    mode: overrides.mode ?? 'lockstep',
    locale: overrides.locale ?? 'ko',
    tickLimit: overrides.tickLimit ?? 42,
  };
}

function createRunId(seed: number): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `run-${seed}-${Date.now().toString(36)}`;
}

export function createInitialGame(input: Partial<GameConfig> = {}): GameState {
  const config = createGameConfig(input);
  const layoutRng = createRng(config.layoutSeed, 'layout-v1');
  const contentRng = createRng(config.seed, 'content-v1');
  const kinds = shuffled(ROOM_KINDS, layoutRng);
  const targetRooms = shuffled(ROOM_IDS, contentRng);
  const initialKinds: IncidentKind[] = ['leak', 'fire', 'arc'];
  const incidents: IncidentState[] = initialKinds.map((kind, index) => ({
    id: `INC-${String(index + 1).padStart(2, '0')}`,
    kind,
    roomId: targetRooms[index],
    severity: (index === 1 ? 1 : 2) as 1 | 2,
    spawnedAt: 0,
    status: 'active',
    resolvedAt: null,
    resolvedBy: null,
  }));
  const schedule: ScheduledIncident[] = [{
    id: 'INC-04',
    tick: 6,
    kind: 'door',
    roomId: targetRooms[3],
    severity: 1,
  }];

  return {
    config,
    runId: createRunId(config.seed),
    phase: 'briefing',
    tick: 0,
    rooms: ROOM_IDS.map((id, index) => ({ id, kind: kinds[index], powered: true })),
    drones: {
      'PATCH-01': { id: 'PATCH-01', roomId: 'A-01', battery: 92, specialty: ['leak', 'fire'] },
      'VOLT-02': { id: 'VOLT-02', roomId: 'C-06', battery: 88, specialty: ['arc', 'door'] },
    },
    incidents,
    schedule,
    spawnedScheduleIds: [],
    resources: { hull: 100, oxygen: 100, energy: 100 },
    inventory: { sealant: 2, foam: 2, circuit: 2, override: 2 },
    repairScore: 0,
    penalties: 0,
    terminalReason: null,
    log: [],
    stats: {
      attemptedActions: 0,
      acceptedActions: 0,
      invalidActions: 0,
      invalidMoves: 0,
      wrongTools: 0,
      unsafeActions: 0,
      incidentsResolved: 0,
    },
  };
}

function coreSnapshot(state: GameState) {
  return {
    config: state.config,
    phase: state.phase,
    tick: state.tick,
    rooms: state.rooms,
    drones: state.drones,
    incidents: state.incidents,
    spawnedScheduleIds: state.spawnedScheduleIds,
    resources: state.resources,
    inventory: state.inventory,
    repairScore: state.repairScore,
    penalties: state.penalties,
    terminalReason: state.terminalReason,
    stats: state.stats,
  };
}

export function stateFingerprint(state: GameState): string {
  return hash32(JSON.stringify(coreSnapshot(state))).toString(16).padStart(8, '0');
}

function isBlockedByDoor(state: GameState, roomId: RoomId): boolean {
  return state.incidents.some((incident) => incident.kind === 'door' && incident.roomId === roomId && incident.status === 'active');
}

function canRepairDoorFrom(state: GameState, incident: IncidentState, droneRoom: RoomId): boolean {
  return droneRoom === incident.roomId || ROOM_CONNECTIONS[incident.roomId].includes(droneRoom);
}

function incidentMessage(kind: IncidentKind, roomId: RoomId): string {
  const label = { leak: '냉각수 누출', fire: '화재', arc: '전기 아크', door: '출입문 고장' }[kind];
  return `${roomId}에 ${label} 경보가 발생했습니다.`;
}

function advanceWorld(input: GameState): GameState {
  let next: GameState = { ...input, tick: input.tick + 1 };

  const due = next.schedule.filter((event) => event.tick <= next.tick && !next.spawnedScheduleIds.includes(event.id));
  if (due.length > 0) {
    const spawned = due.map<IncidentState>((event) => ({
      id: event.id,
      kind: event.kind,
      roomId: event.roomId,
      severity: event.severity,
      spawnedAt: next.tick,
      status: 'active',
      resolvedAt: null,
      resolvedBy: null,
    }));
    next = {
      ...next,
      incidents: [...next.incidents, ...spawned],
      spawnedScheduleIds: [...next.spawnedScheduleIds, ...due.map((event) => event.id)],
    };
  }

  const resources = { ...next.resources };
  const incidents = next.incidents
    .map((incident) => {
      if (incident.status !== 'active') return incident;
      const age = next.tick - incident.spawnedAt;
      const severity = age > 0 && age % 6 === 0
        ? Math.min(3, incident.severity + 1) as 1 | 2 | 3
        : incident.severity;
      const definition = INCIDENT_DEFS[incident.kind];
      const room = next.rooms.find((item) => item.id === incident.roomId);
      const causesDamage = definition.resource && (incident.kind !== 'arc' || room?.powered);
      if (causesDamage && definition.resource) {
        resources[definition.resource] = Math.max(0, resources[definition.resource] - definition.damage * severity);
      }
      return severity === incident.severity ? incident : { ...incident, severity };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  next = { ...next, resources, incidents };
  const allScheduled = next.spawnedScheduleIds.length === next.schedule.length;
  const allResolved = next.incidents.every((incident) => incident.status === 'resolved');
  const powerRestored = next.rooms.every((room) => room.powered);

  if (allScheduled && allResolved && powerRestored) {
    return { ...next, phase: 'won', terminalReason: 'all-objectives-complete' };
  }
  if (resources.hull <= 0) return { ...next, phase: 'lost', terminalReason: 'hull-depleted' };
  if (resources.oxygen <= 0) return { ...next, phase: 'lost', terminalReason: 'oxygen-depleted' };
  if (resources.energy <= 0) return { ...next, phase: 'lost', terminalReason: 'energy-depleted' };
  if (next.tick >= next.config.tickLimit) return { ...next, phase: 'lost', terminalReason: 'action-budget' };
  return next;
}

function withRecord(
  previous: GameState,
  changed: GameState,
  action: GameAction,
  accepted: boolean,
  message: string,
  scoreDelta = 0,
  reason?: InvalidReason,
): GameState {
  const record: ActionRecord = {
    seq: previous.log.length,
    tickBefore: previous.tick,
    tickAfter: changed.tick,
    action,
    accepted,
    reason,
    message,
    scoreDelta,
    stateHashBefore: stateFingerprint(previous),
    stateHashAfter: stateFingerprint(changed),
  };
  return { ...changed, log: [...previous.log, record] };
}

export function reduceGame(state: GameState, action: GameAction): GameState {
  if (action.type === 'START') {
    if (state.phase !== 'briefing') return state;
    const started = { ...state, phase: 'active' as const };
    return withRecord(state, started, action, true, '구조 교대 근무를 시작했습니다.');
  }

  if (state.phase === 'briefing') {
    return withRecord(state, state, action, false, '평가를 먼저 시작하세요.', 0, 'not-started');
  }
  if (state.phase !== 'active') {
    return withRecord(state, state, action, false, '이미 종료된 평가입니다.', 0, 'game-over');
  }

  let next: GameState = {
    ...state,
    stats: { ...state.stats, attemptedActions: state.stats.attemptedActions + 1 },
  };
  let accepted = true;
  let reason: InvalidReason | undefined;
  let message = '1틱을 관찰했습니다.';
  let scoreDelta = 0;

  if (action.type === 'MOVE_DRONE') {
    const drone = next.drones[action.droneId];
    if (!ROOM_CONNECTIONS[drone.roomId].includes(action.to)) {
      accepted = false;
      reason = 'not-adjacent';
      message = '인접한 구역만 한 번에 이동할 수 있습니다.';
    } else if (isBlockedByDoor(next, action.to)) {
      accepted = false;
      reason = 'door-blocked';
      message = '고장 난 출입문이 진입을 막고 있습니다.';
    } else {
      next = {
        ...next,
        drones: {
          ...next.drones,
          [action.droneId]: { ...drone, roomId: action.to, battery: Math.max(0, drone.battery - 4) },
        },
      };
      message = `${action.droneId}가 ${action.to}(으)로 이동했습니다.`;
    }
  }

  if (action.type === 'TOGGLE_POWER') {
    next = { ...next, rooms: next.rooms.map((room) => room.id === action.roomId ? { ...room, powered: !room.powered } : room) };
    const room = next.rooms.find((item) => item.id === action.roomId);
    message = `${action.roomId} 전원을 ${room?.powered ? '복구' : '차단'}했습니다.`;
  }

  if (action.type === 'USE_TOOL') {
    const incident = next.incidents.find((item) => item.id === action.incidentId && item.status === 'active');
    const drone = next.drones[action.droneId];
    if (!incident) {
      accepted = false;
      reason = 'incident-missing';
      message = '활성 사고를 선택하세요.';
    } else if (incident.kind === 'door' ? !canRepairDoorFrom(next, incident, drone.roomId) : drone.roomId !== incident.roomId) {
      accepted = false;
      reason = 'wrong-room';
      message = '선택한 드론이 작업 범위에 없습니다.';
    } else if (next.inventory[action.toolId] <= 0) {
      accepted = false;
      reason = 'tool-empty';
      message = '해당 도구의 재고가 없습니다.';
    } else if (INCIDENT_DEFS[incident.kind].tool !== action.toolId) {
      accepted = false;
      reason = 'wrong-tool';
      message = '사고 유형과 맞지 않는 도구입니다.';
      next = {
        ...next,
        penalties: next.penalties + 25,
        stats: { ...next.stats, wrongTools: next.stats.wrongTools + 1 },
      };
    } else {
      const room = next.rooms.find((item) => item.id === incident.roomId);
      if (INCIDENT_DEFS[incident.kind].requiresPowerOff && room?.powered) {
        accepted = false;
        reason = 'power-must-be-off';
        message = '감전 위험: 먼저 해당 구역의 전원을 차단해야 합니다.';
        next = {
          ...next,
          penalties: next.penalties + 50,
          stats: { ...next.stats, unsafeActions: next.stats.unsafeActions + 1 },
        };
      } else {
        const age = next.tick - incident.spawnedAt;
        const specialist = drone.specialty.includes(incident.kind);
        scoreDelta = Math.max(70, 150 - age * 6) + (specialist ? 20 : 0);
        next = {
          ...next,
          incidents: next.incidents.map((item) => item.id === incident.id
            ? { ...item, status: 'resolved' as const, resolvedAt: next.tick, resolvedBy: action.droneId }
            : item),
          inventory: { ...next.inventory, [action.toolId]: next.inventory[action.toolId] - 1 },
          repairScore: next.repairScore + scoreDelta,
          stats: { ...next.stats, incidentsResolved: next.stats.incidentsResolved + 1 },
        };
        message = `${incident.roomId}의 ${incident.kind} 사고를 해결했습니다. +${scoreDelta}`;
      }
    }
  }

  if (action.type === 'WAIT') message = '상황을 관찰하며 1틱 대기했습니다.';

  next = {
    ...next,
    stats: {
      ...next.stats,
      acceptedActions: next.stats.acceptedActions + (accepted ? 1 : 0),
      invalidActions: next.stats.invalidActions + (accepted ? 0 : 1),
      invalidMoves: next.stats.invalidMoves + (!accepted && action.type === 'MOVE_DRONE' ? 1 : 0),
    },
  };

  const advanced = advanceWorld(next);
  const spawned = advanced.incidents.find((incident) => incident.spawnedAt === advanced.tick && !next.incidents.some((item) => item.id === incident.id));
  if (spawned) message = `${message} ${incidentMessage(spawned.kind, spawned.roomId)}`;
  return withRecord(state, advanced, action, accepted, message, scoreDelta, reason);
}

export function replayActions(config: Partial<GameConfig>, actions: GameAction[]): GameState {
  return actions.reduce(reduceGame, createInitialGame(config));
}
