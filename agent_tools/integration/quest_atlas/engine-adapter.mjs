import { generateWorld } from "../../../03_quest_atlas/src/content/generator.ts";
import { reduceGame } from "../../../03_quest_atlas/src/engine/reducer.ts";
import { createGameState, stateFingerprint } from "../../../03_quest_atlas/src/engine/state.ts";

const ALLOWED_CODES = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "Tab",
  "KeyB", "KeyF", "KeyC", "KeyE", "KeyR", "KeyN", "Escape",
]);

/**
 * Trusted integration adapter for the real Quest Atlas reducer.
 * It deliberately receives a private config object and exposes only the generic
 * apply/snapshot port expected by Replay Judge.
 */
export class QuestAtlasReplayEngine {
  #state;
  #titleMode = true;

  constructor(config) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new TypeError("Quest Atlas replay requires a trusted WorldConfig.");
    }
    this.#state = createGameState(generateWorld(structuredClone(config)));
  }

  apply(action) {
    if (!action || action.kind !== "keyTap" || !ALLOWED_CODES.has(action.code)) {
      throw new TypeError("Quest Atlas adapter accepts only allowlisted keyTap actions.");
    }
    const code = action.code;
    if (this.#titleMode) {
      if (code === "Enter") this.#titleMode = false;
      return;
    }

    if (this.#state.phase === "briefing") {
      if (code === "Enter" || code === "ArrowRight") reduceGame(this.#state, { type: "briefing-next" });
      else if (code === "ArrowLeft") reduceGame(this.#state, { type: "briefing-previous" });
      else if (code === "Escape") this.#titleMode = true;
      return;
    }
    if (this.#state.phase === "result") return;
    if (code === "Tab") reduceGame(this.#state, { type: "toggle-ledger" });
    else if (this.#state.phase === "ledger") {
      if (code === "ArrowUp" || code === "ArrowLeft") reduceGame(this.#state, { type: "move-ledger", delta: -1 });
      else if (code === "ArrowDown" || code === "ArrowRight") reduceGame(this.#state, { type: "move-ledger", delta: 1 });
      else if (code === "KeyB" || code === "Enter") reduceGame(this.#state, { type: "toggle-bookmark" });
      else if (code === "KeyF") reduceGame(this.#state, { type: "cycle-ledger-filter" });
    } else if (this.#state.dialogue) {
      if (code === "Enter" || code === "Escape") reduceGame(this.#state, { type: "dismiss-dialogue" });
    } else if (code === "ArrowLeft" || code === "ArrowUp") {
      reduceGame(this.#state, { type: "move-selection", delta: -1 });
    } else if (code === "ArrowRight" || code === "ArrowDown") {
      reduceGame(this.#state, { type: "move-selection", delta: 1 });
    } else if (code === "Enter") {
      reduceGame(this.#state, { type: "activate-selection" });
    } else if (code === "KeyC") {
      reduceGame(this.#state, { type: "cycle-sidebar", delta: 1 });
    }
  }

  snapshot() {
    const state = this.#state;
    return structuredClone({
      titleMode: this.#titleMode,
      phase: state.phase,
      briefingPage: state.briefingPage,
      currentRegionId: state.currentRegionId,
      selectedTargetIndex: state.selectedTargetIndex,
      sidebarPanel: state.sidebarPanel,
      ledgerCursor: state.ledgerCursor,
      ledgerFilter: state.ledgerFilter,
      time: state.time,
      tide: state.tide,
      inventory: state.inventory,
      questStates: state.questStates,
      questProgress: state.questProgress,
      questCompletions: state.questCompletions,
      flags: state.flags,
      unlockedRegions: state.unlockedRegions,
      visitedRegions: state.visitedRegions,
      completedEncounters: state.completedEncounters,
      craftedRecipes: state.craftedRecipes,
      talkedTo: state.talkedTo,
      rumorsHeard: state.rumorsHeard,
      branch: state.branch,
      reputation: state.reputation,
      actionCount: state.actionCount,
      success: state.success,
      terminalReason: state.terminalReason,
      stateFingerprint: stateFingerprint(state),
    });
  }
}

export function questAtlasAllowedCodes() {
  return Object.freeze([...ALLOWED_CODES]);
}
