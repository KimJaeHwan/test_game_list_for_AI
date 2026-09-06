const ALLOWED_EXPLORATION_TRACKS = new Set([
  "EXPLORATION",
  "ASSISTED_EXPLORATION",
]);

export function validateExplorationTrack(track) {
  if (!ALLOWED_EXPLORATION_TRACKS.has(track)) {
    throw new TypeError("explorationTrack must be exactly EXPLORATION or ASSISTED_EXPLORATION.");
  }
  return track;
}

export function validityForExplorationTrack(track) {
  return validateExplorationTrack(track) === "ASSISTED_EXPLORATION" ? "ASSISTED" : "OFFICIAL";
}
