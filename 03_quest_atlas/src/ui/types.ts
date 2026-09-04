/** UI-only contract. The deterministic engine maps its state into this shape. */
export type AppPhase = "title" | "briefing" | "explore" | "ledger" | "result";

export type QuestStatus = "locked" | "available" | "active" | "complete" | "failed";
export type ObservationKind = "dialogue" | "inspect" | "outcome" | "system" | "world";
export type NodeKind = "place" | "npc" | "resource" | "shop" | "workshop" | "landmark";
export type SidebarPanel = "quests" | "inventory" | "observations";

export interface SeedView {
  label: "SCENARIO" | "LAYOUT" | "VISUAL" | "SESSION" | string;
  value: string | number;
}

export interface SessionView {
  runId: string;
  phaseLabel: string;
  worldTime: string;
  actionCount: number;
  actionBudget?: number;
  observedCount: number;
  totalDiscoverable?: number;
}

export interface WorldNodeView {
  id: string;
  name: string;
  kind: NodeKind;
  /** Normalized map position in the inclusive 0..1 range. */
  x: number;
  y: number;
  visited: boolean;
  current?: boolean;
  available?: boolean;
  selected?: boolean;
  badge?: string;
}

export interface WorldEdgeView {
  from: string;
  to: string;
  locked?: boolean;
}

export interface TargetView {
  id: string;
  title: string;
  subtitle?: string;
  icon?: string;
  selected?: boolean;
  disabled?: boolean;
  stateLabel?: string;
}

export interface WorldView {
  areaName: string;
  locationName: string;
  description?: string;
  clock: string;
  tide?: string;
  weather?: string;
  nodes: WorldNodeView[];
  edges: WorldEdgeView[];
  targets?: TargetView[];
}

export interface DialogueChoiceView {
  id: string;
  key: string;
  text: string;
  selected?: boolean;
  disabled?: boolean;
}

export interface DialogueView {
  speaker: string;
  role?: string;
  text: string;
  observationId?: string;
  choices?: DialogueChoiceView[];
  canAdvance?: boolean;
}

export interface QuestView {
  id: string;
  title: string;
  kind: "main" | "side" | "hidden" | "repeatable" | string;
  status: QuestStatus;
  /** Only player-visible progress; never hidden prerequisites. */
  progressLabel?: string;
  selected?: boolean;
}

export interface InventoryItemView {
  id: string;
  name: string;
  icon?: string;
  count: number;
  category?: string;
  selected?: boolean;
  recent?: boolean;
}

export interface ObservationView {
  id: string;
  kind: ObservationKind;
  source: string;
  area: string;
  worldTime: string;
  /** Verbatim player-visible observation. The UI does not infer facts from it. */
  text: string;
  bookmarked?: boolean;
  fresh?: boolean;
  selected?: boolean;
}

export interface StateNoticeView {
  id: string;
  text: string;
  tone?: "neutral" | "positive" | "warning" | "negative";
  createdAt: number;
  durationMs?: number;
}

export interface InputFeedbackView {
  key: string;
  active: boolean;
  changedAt: number;
}

export interface BriefingView {
  page: number;
  totalPages: number;
  acknowledged?: boolean;
}

export interface LedgerView {
  cursor: number;
  filter?: ObservationKind | "all" | "bookmarked";
}

export interface ScoreLineView {
  label: string;
  value: number;
  max: number;
}

export interface ExportView {
  id: "knowledge" | "wiki" | "session" | string;
  label: string;
  filename: string;
  ready: boolean;
}

export interface ResultView {
  heading: string;
  summary: string;
  score?: number;
  scoreLines?: ScoreLineView[];
  exports: ExportView[];
  replayStatus?: string;
  transferStatus?: string;
}

export interface TitleView {
  title?: string;
  subtitle?: string;
  sessionLabel?: string;
}

export interface ThemeView {
  accent?: string;
  accentSoft?: string;
  mapTint?: string;
}

export interface AppViewModel {
  phase: AppPhase;
  title?: TitleView;
  seeds: SeedView[];
  session: SessionView;
  world?: WorldView;
  dialogue?: DialogueView;
  quests: QuestView[];
  inventory: InventoryItemView[];
  observations: ObservationView[];
  sidebarPanel?: SidebarPanel;
  briefing?: BriefingView;
  ledger?: LedgerView;
  result?: ResultView;
  notices?: StateNoticeView[];
  inputFeedback?: InputFeedbackView[];
  theme?: ThemeView;
  paused?: boolean;
}
