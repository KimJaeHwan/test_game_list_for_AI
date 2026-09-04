export type Locale = 'ko' | 'en';
export type RunMode = 'lockstep' | 'realtime';
export type GamePhase = 'briefing' | 'active' | 'won' | 'lost';
export type RoomId = 'A-01' | 'A-02' | 'B-03' | 'B-04' | 'C-05' | 'C-06';
export type RoomKind = 'dock' | 'medbay' | 'hydro' | 'coolant' | 'power' | 'lab';
export type DroneId = 'PATCH-01' | 'VOLT-02';
export type ToolId = 'sealant' | 'foam' | 'circuit' | 'override';
export type IncidentKind = 'leak' | 'fire' | 'arc' | 'door';
export type ResourceKey = 'hull' | 'oxygen' | 'energy';

export interface RoomState {
  id: RoomId;
  kind: RoomKind;
  powered: boolean;
}

export interface DroneState {
  id: DroneId;
  roomId: RoomId;
  battery: number;
  specialty: IncidentKind[];
}

export interface IncidentState {
  id: string;
  kind: IncidentKind;
  roomId: RoomId;
  severity: 1 | 2 | 3;
  spawnedAt: number;
  status: 'active' | 'resolved';
  resolvedAt: number | null;
  resolvedBy: DroneId | null;
}

export interface ScheduledIncident {
  id: string;
  tick: number;
  kind: IncidentKind;
  roomId: RoomId;
  severity: 1 | 2 | 3;
}

export interface ResourceState {
  hull: number;
  oxygen: number;
  energy: number;
}

export interface InventoryState {
  sealant: number;
  foam: number;
  circuit: number;
  override: number;
}

export type InvalidReason =
  | 'not-started'
  | 'game-over'
  | 'not-adjacent'
  | 'door-blocked'
  | 'incident-missing'
  | 'wrong-room'
  | 'wrong-tool'
  | 'power-must-be-off'
  | 'tool-empty';

export type GameAction =
  | { type: 'START' }
  | { type: 'MOVE_DRONE'; droneId: DroneId; to: RoomId }
  | { type: 'TOGGLE_POWER'; roomId: RoomId }
  | { type: 'USE_TOOL'; droneId: DroneId; toolId: ToolId; incidentId: string }
  | { type: 'WAIT' };

export interface ActionRecord {
  seq: number;
  tickBefore: number;
  tickAfter: number;
  action: GameAction;
  accepted: boolean;
  reason?: InvalidReason;
  message: string;
  scoreDelta: number;
  stateHashBefore: string;
  stateHashAfter: string;
}

export interface GameStats {
  attemptedActions: number;
  acceptedActions: number;
  invalidActions: number;
  invalidMoves: number;
  wrongTools: number;
  unsafeActions: number;
  incidentsResolved: number;
}

export interface GameConfig {
  seed: number;
  layoutSeed: number;
  mode: RunMode;
  locale: Locale;
  tickLimit: number;
}

export interface GameState {
  config: GameConfig;
  runId: string;
  phase: GamePhase;
  tick: number;
  rooms: RoomState[];
  drones: Record<DroneId, DroneState>;
  incidents: IncidentState[];
  schedule: ScheduledIncident[];
  spawnedScheduleIds: string[];
  resources: ResourceState;
  inventory: InventoryState;
  repairScore: number;
  penalties: number;
  terminalReason: string | null;
  log: ActionRecord[];
  stats: GameStats;
}

export interface ScoreBreakdown {
  repair: number;
  survival: number;
  efficiency: number;
  safety: number;
  victory: number;
  penalties: number;
  total: number;
}

export interface CapabilityScore {
  id: 'ocr-icon' | 'spatial' | 'precision' | 'planning' | 'recovery' | 'safety';
  score: number;
  labelKo: string;
  labelEn: string;
}

export interface RunReport {
  score: ScoreBreakdown;
  success: boolean;
  terminalReason: string;
  tick: number;
  seed: number;
  mode: RunMode;
  capabilities: CapabilityScore[];
  stats: GameStats;
}

export interface StoredReplay {
  schemaVersion: 1;
  runId: string;
  savedAt: string;
  config: GameConfig;
  actions: GameAction[];
  finalStateHash: string;
  report: RunReport;
}
