import type {
  BranchId,
  CueId,
  FactValue,
  GeneratedWorld,
  ItemId,
  NpcId,
  QuestId,
  RegionId,
  Tide,
  TimeOfDay,
} from '../content/schema.ts';

export type QuestRuntimeState = 'locked' | 'available' | 'active' | 'complete' | 'failed';
export type SidebarPanel = 'quests' | 'inventory' | 'observations';

export interface ObservationRecord {
  id: string;
  cueId: CueId;
  kind: 'dialogue' | 'inspect' | 'outcome' | 'system' | 'world';
  sourceId: string;
  sourceName: string;
  regionId: RegionId;
  regionName: string;
  worldTime: TimeOfDay;
  tide: Tide;
  text: string;
  actionIndex: number;
  factIds: string[];
  bookmarked: boolean;
  fresh: boolean;
}

export interface RuntimeEvent {
  seq: number;
  actionIndex: number;
  type: string;
  detail: string;
  stateHash: string;
}

export type PublicObservationRecord = Omit<
  ObservationRecord,
  'cueId' | 'factIds' | 'sourceId' | 'regionId' | 'fresh'
>;

export type PublicRuntimeEvent = Omit<RuntimeEvent, 'detail'>;

export interface Notice {
  id: string;
  text: string;
  tone: 'neutral' | 'positive' | 'warning' | 'negative';
  createdAt: number;
}

export interface DialogueState {
  npcId: NpcId;
  lineId: string;
  text: string;
  observationId?: string;
}

export interface GameState {
  world: GeneratedWorld;
  phase: 'briefing' | 'explore' | 'ledger' | 'result';
  briefingPage: number;
  currentRegionId: RegionId;
  selectedTargetIndex: number;
  sidebarPanel: SidebarPanel;
  ledgerCursor: number;
  ledgerFilter: 'all' | 'bookmarked' | ObservationRecord['kind'];
  dialogue: DialogueState | null;
  time: TimeOfDay;
  tide: Tide;
  inventory: Record<ItemId, number>;
  questStates: Record<QuestId, QuestRuntimeState>;
  questProgress: Record<QuestId, Record<string, number>>;
  questCompletions: Record<QuestId, number>;
  flags: Record<string, FactValue>;
  unlockedRegions: RegionId[];
  visitedRegions: RegionId[];
  completedEncounters: Record<string, number>;
  craftedRecipes: Record<string, number>;
  talkedTo: Record<string, number>;
  rumorsHeard: string[];
  branch: BranchId | null;
  reputation: Record<BranchId, number>;
  observations: ObservationRecord[];
  actionLog: GameAction[];
  actionCount: number;
  actionBudget: number;
  eventSeq: number;
  events: RuntimeEvent[];
  notices: Notice[];
  success: boolean | null;
  terminalReason: 'archive-complete' | 'budget-exhausted' | 'abandoned' | null;
}

export type TargetKind = 'travel' | 'talk' | 'encounter' | 'craft' | 'offer' | 'rest' | 'finish';

export interface ActionTarget {
  id: string;
  kind: TargetKind;
  entityId: string;
  title: string;
  subtitle: string;
  disabled: boolean;
  stateLabel?: string;
}

export type GameAction =
  | { type: 'briefing-next' }
  | { type: 'briefing-previous' }
  | { type: 'move-selection'; delta: number }
  | { type: 'activate-selection' }
  | { type: 'dismiss-dialogue' }
  | { type: 'cycle-sidebar'; delta: number }
  | { type: 'toggle-ledger' }
  | { type: 'move-ledger'; delta: number }
  | { type: 'toggle-bookmark' }
  | { type: 'cycle-ledger-filter' }
  | { type: 'finish-session'; reason?: 'archive-complete' | 'abandoned' };

export interface SessionBundle {
  schemaVersion: 1;
  runId: string;
  stateHash: string;
  actionCount: number;
  terminalReason: GameState['terminalReason'];
  success: boolean;
  observations: PublicObservationRecord[];
  events: PublicRuntimeEvent[];
  actions: GameAction[];
}
