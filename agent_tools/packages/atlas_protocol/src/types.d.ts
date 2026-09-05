export type DeliveryStatus = "DELIVERED" | "NOT_DELIVERED" | "DELIVERY_UNKNOWN";
export type ChangeClass = "UNCHANGED" | "TRANSIENT_ONLY" | "PERSISTENT_CHANGE" | "UNCERTAIN";
export type PublicRunStatus = "COMPLETE" | "PARTIAL" | "INVALID";
export type PublicValidity = "OFFICIAL" | "ASSISTED" | "INVALID";
export type ActionState = "READY" | "BUSY" | "PAUSED" | "ENDED";

export interface PublicFrame {
  frameId: string;
  ordinal: number;
  mediaRef: string;
  sha256: string;
  evidenceRole: "CITEABLE";
  sourceActionRefs: string[];
}

export interface PublicObservation {
  observationId: string;
  ordinal: number;
  frameRefs: string[];
  precedingActionRefs: string[];
}

export interface PublicAction {
  actionId: string;
  ordinal: number;
  input: { kind: "keyTap"; code: string } | { kind: "opaqueActivate" };
  delivery: DeliveryStatus;
  beforeFrameRef: string;
  afterFrameRefs: string[];
  changeClass: ChangeClass;
}

export interface PublicPlayHandoff {
  manifest: {
    schemaVersion: "atlas/public-play-handoff/1";
    artifactId: string;
    runId: string;
    status: PublicRunStatus;
    validity: PublicValidity;
    framePolicyVersion: string;
    inputPolicyVersion: string;
    capture: { width: number; height: number; format: "png"; colorSpace: "srgb" };
    counts: { frames: number; observations: number; actions: number; interventions: number };
    files: Array<{
      role: "frames" | "observations" | "actions";
      relativeName: string;
      bytes: number;
      sha256: string;
    }>;
    payloadDigest: string;
  };
  frames: PublicFrame[];
  observations: PublicObservation[];
  actions: PublicAction[];
}

export interface EvidenceComparisonPlan {
  schemaVersion: "atlas/evidence-comparison-plan/1";
  planId: string;
  groups: Array<{ groupRef: string; handoffDigests: string[] }>;
  signature: string;
}

export type NormalizedDocumentNode =
  | { type: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { type: "paragraph" | "emphasis" | "strong"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "link"; label: string; targetTitle: string };

export interface NormalizedDocument {
  schemaVersion: "atlas/normalized-document/1";
  pages: Array<{ title: string; nodes: NormalizedDocumentNode[] }>;
}

export interface SignedEnvelope<T = unknown> {
  header: {
    artifactType: string;
    schemaVersion: string;
    artifactId: string;
    campaignId: string;
    track: string;
    arm: string;
    targetRunId: string;
    issuer: string;
    keyId: string;
    nonce: string;
    parentDigests: string[];
    payloadDigest: string;
    contractDigest: string;
  };
  payload: T;
  signature: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}
