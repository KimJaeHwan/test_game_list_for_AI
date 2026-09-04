export type Seed = string | number;
export type EntityId = string;
export type RegionId = EntityId;
export type NpcId = EntityId;
export type QuestId = EntityId;
export type ItemId = EntityId;
export type EncounterId = EntityId;
export type RecipeId = EntityId;
export type ShopId = EntityId;
export type CueId = EntityId;

export type TimeOfDay = "day" | "night";
export type Tide = "low" | "high";
export type BranchId = "wardens" | "salvagers";
export type Direction = "north" | "east" | "south" | "west";

export interface WorldConfig { scenarioSeed: Seed; layoutSeed: Seed; visualSeed: Seed; sessionSeed: Seed }
export interface Point { x: number; y: number }
export type FactValue = string | number | boolean;

export type Predicate =
  | { kind: "hasItem"; itemId: ItemId; count?: number }
  | { kind: "questState"; questId: QuestId; state: "available" | "active" | "complete" }
  | { kind: "worldFlag"; flag: string; value: FactValue }
  | { kind: "time"; value: TimeOfDay }
  | { kind: "tide"; value: Tide }
  | { kind: "branch"; value: BranchId }
  | { kind: "rumorHeard"; rumorId: string };

export type Effect =
  | { kind: "giveItem"; itemId: ItemId; count?: number }
  | { kind: "takeItem"; itemId: ItemId; count?: number }
  | { kind: "startQuest"; questId: QuestId }
  | { kind: "completeQuest"; questId: QuestId }
  | { kind: "setFlag"; flag: string; value: FactValue }
  | { kind: "setTime"; value: TimeOfDay }
  | { kind: "setTide"; value: Tide }
  | { kind: "chooseBranch"; value: BranchId }
  | { kind: "unlockRegion"; regionId: RegionId }
  | { kind: "reputation"; faction: BranchId; amount: number };

export interface EvidenceCue { id: CueId; kind: "dialogue" | "visual" | "system" | "result"; ko: string; sourceId: EntityId; factIds: string[] }
export interface Exit { id: string; to: RegionId; direction: Direction; conditions: Predicate[]; blockedKo?: string; evidenceCueIds: CueId[] }
export interface Region { id: RegionId; nameKo: string; summaryKo: string; mapPosition: Point; exits: Exit[]; landmarkNamesKo: string[]; visualKey: string }
export type NpcRole = "quest" | "shop" | "exchange" | "craft" | "inn" | "information";
export interface DialogueLine { id: string; ko: string; conditions: Predicate[]; effects: Effect[]; evidenceCueIds: CueId[] }
export interface NPC { id: NpcId; nameKo: string; titleKo: string; regionId: RegionId; roles: NpcRole[]; dialogue: DialogueLine[]; visualKey: string }

export type ItemCategory = "resource" | "drop" | "crafted" | "tool" | "quest" | "token" | "currency" | "decoy";
export interface ItemSource { kind: "gather" | "encounter" | "quest" | "shop" | "exchange" | "craft"; sourceId: EntityId; conditions: Predicate[]; evidenceCueIds: CueId[] }
export interface Item { id: ItemId; nameKo: string; descriptionKo: string; category: ItemCategory; sources: ItemSource[]; useKo: string[]; visualKey: string }
export interface Drop { itemId: ItemId; count: number; conditions: Predicate[]; evidenceCueIds: CueId[] }
export interface Encounter { id: EncounterId; kind: "gather" | "monster"; nameKo: string; descriptionKo: string; regionId: RegionId; spawnConditions: Predicate[]; requiredItemId?: ItemId; drops: Drop[]; respawns: boolean; evidenceCueIds: CueId[]; visualKey: string }

export type Objective =
  | { kind: "talk"; npcId: NpcId; count?: number }
  | { kind: "collect"; itemId: ItemId; count: number }
  | { kind: "craft"; recipeId: RecipeId; count?: number }
  | { kind: "encounter"; encounterId: EncounterId; count?: number }
  | { kind: "visit"; regionId: RegionId }
  | { kind: "setFlag"; flag: string; value: FactValue }
  | { kind: "chooseBranch"; branch: BranchId };

export interface Quest { id: QuestId; titleKo: string; summaryKo: string; category: "main" | "side" | "hidden" | "repeatable"; giverNpcId: NpcId; turnInNpcId: NpcId; prerequisites: Predicate[]; objectives: Objective[]; rewards: Effect[]; branchGroup?: string; repeatable?: boolean; evidenceCueIds: CueId[] }
export interface IngredientOption { itemId: ItemId; count: number }
export interface IngredientGroup { alternatives: IngredientOption[] }
export interface Recipe { id: RecipeId; nameKo: string; stationNpcId: NpcId; inputs: IngredientGroup[]; outputs: { itemId: ItemId; count: number }[]; conditions: Predicate[]; evidenceCueIds: CueId[] }
export interface Offer { id: string; kind: "buy" | "exchange"; costs: { itemId: ItemId; count: number }[]; rewards: { itemId: ItemId; count: number }[]; conditions: Predicate[]; evidenceCueIds: CueId[] }
export interface Shop { id: ShopId; nameKo: string; npcId: NpcId; offers: Offer[] }
export interface Rumor { id: string; speakerNpcId: NpcId; claimKo: string; truth: "true" | "false" | "partial"; correctionKo: string; evidenceCueIds: CueId[] }
export interface TruthFact { id: string; subject: EntityId; predicate: string; object: FactValue | EntityId[]; importance: "core" | "supporting" | "exception"; evidenceCueIds: CueId[] }
export interface VisualTheme { palette: { ink: string; panel: string; accent: string; water: string; danger: string }; iconVariant: number }
export interface SessionInitialState { time: TimeOfDay; tide: Tide; repeatRotation: EncounterId[]; startingItems: { itemId: ItemId; count: number }[] }

export interface GeneratedWorld {
  config: WorldConfig;
  scenarioHash: string;
  regions: Region[];
  npcs: NPC[];
  quests: Quest[];
  items: Item[];
  encounters: Encounter[];
  recipes: Recipe[];
  shops: Shop[];
  rumors: Rumor[];
  evidenceCues: EvidenceCue[];
  facts: TruthFact[];
  theme: VisualTheme;
  session: SessionInitialState;
}

export interface ContentCounts { regions: number; npcs: number; quests: number; mainQuests: number; sideQuests: number; hiddenQuests: number; repeatableQuests: number; items: number; encounters: number; recipes: number; shops: number; offers: number; rumors: number; facts: number; evidenceCues: number }
export interface ValidationIssue { severity: "error" | "warning"; code: string; message: string; entityId?: EntityId }
export interface ValidationResult { valid: boolean; issues: ValidationIssue[] }
