import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import {
  AgentLoopSupervisor,
  CodexHeadlessModelPort,
  DEFAULT_POLICY,
  PlayerRunnerStdioClient,
  validateKnowledgeContext,
} from "../src/index.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const HOST_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const TOOL_ROOT = resolve(HOST_ROOT, "..");
const REMOTE_CONFIRMATION = "--confirm-openai-upload";
const LONG_RUN_OPTION = "--long-run";
export const ROLLOVER_ENDURANCE_PROFILE = "ROLLOVER_ENDURANCE_2X";
const USAGE_RECORD_SCHEMA = "atlas/vision-model-usage/1";
const USAGE_FIELDS = Object.freeze([
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "totalTokens",
]);
const RUNNER_ENVIRONMENT_NAMES = new Set([
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATH",
  "PATHEXT",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "TEMP",
  "TMP",
  "DOTNET_ROOT",
  "ATLAS_TARGET_HWND",
  "ATLAS_CAPTURE_REGION",
  "ATLAS_ALLOWED_KEYS",
  "ATLAS_DESKTOP_BRIDGE_EXE",
]);

export function parseCommandLine(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    throw new TypeError("args must be an array of strings");
  }
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    return { help: true, confirmed: false };
  }
  const accepted = new Set([REMOTE_CONFIRMATION, LONG_RUN_OPTION]);
  const unknown = args.filter((value) => !accepted.has(value));
  const duplicate = [...accepted].some((option) => args.filter((value) => value === option).length > 1);
  if (unknown.length > 0 || duplicate) {
    const error = new Error("Unknown or duplicate command-line option.");
    error.code = "COMMAND_LINE_INVALID";
    throw error;
  }
  const command = {
    help: false,
    confirmed: args.includes(REMOTE_CONFIRMATION),
  };
  return args.includes(LONG_RUN_OPTION) ? { ...command, longRun: true } : command;
}

export function createRunnerEnvironment(source, trustedValues) {
  if (!source || typeof source !== "object" || !trustedValues || typeof trustedValues !== "object") {
    throw new TypeError("source and trustedValues must be objects");
  }
  const output = Object.create(null);
  for (const [name, value] of Object.entries(source)) {
    if (RUNNER_ENVIRONMENT_NAMES.has(name.toUpperCase()) && typeof value === "string") {
      output[name.toUpperCase()] = value;
    }
  }
  for (const [name, value] of Object.entries(trustedValues)) {
    if (!name.startsWith("ATLAS_") || typeof value !== "string" || value.length === 0) {
      throw new TypeError("trusted runner values must be non-empty ATLAS_ strings");
    }
    output[name] = value;
  }
  return output;
}

export function explorationTrackForKnowledgeContext(knowledgeContext) {
  return knowledgeContext === undefined ? "EXPLORATION" : "ASSISTED_EXPLORATION";
}

export function createEnduranceSummary(command, result) {
  if (!command?.longRun) return {};
  return {
    executionProfile: result.executionProfile,
    primaryScoreEligible: result.primaryScoreEligible,
    rolloverEndurance: result.rolloverEndurance,
  };
}

function regularFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function pathCandidates(source) {
  // The host always spawns with shell:false. A .cmd shim is therefore not a
  // portable executable target on Windows; require the native executable.
  const suffixes = process.platform === "win32" ? ["codex.exe"] : ["codex"];
  return String(source.PATH ?? "").split(delimiter).filter(Boolean)
    .flatMap((directory) => suffixes.map((name) => join(directory, name)));
}

function desktopCandidates(source) {
  const localAppData = source.LOCALAPPDATA;
  if (!localAppData) return [];
  const root = join(localAppData, "OpenAI", "Codex", "bin");
  let directories;
  try {
    directories = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
  return directories
    .map((entry) => join(root, entry.name, "codex.exe"))
    .filter(regularFile)
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
}

export function findCodexExecutable(source = process.env) {
  const configured = source.ATLAS_CODEX_EXE;
  if (configured !== undefined) {
    if (!isAbsolute(configured) || !regularFile(configured)) {
      const error = new Error("ATLAS_CODEX_EXE must name an existing absolute file.");
      error.code = "CODEX_NOT_FOUND";
      throw error;
    }
    return configured;
  }
  const candidate = [...pathCandidates(source), ...desktopCandidates(source)].find(regularFile);
  if (!candidate) {
    const error = new Error("Codex CLI executable was not found.");
    error.code = "CODEX_NOT_FOUND";
    throw error;
  }
  return candidate;
}

function requireTargetWindow(source) {
  if (typeof source.ATLAS_TARGET_HWND !== "string" || !/^[1-9][0-9]*$/u.test(source.ATLAS_TARGET_HWND)) {
    const error = new Error("ATLAS_TARGET_HWND must contain the selected positive window handle.");
    error.code = "TARGET_WINDOW_REQUIRED";
    throw error;
  }
}

export function visionArmDelay(source = process.env) {
  const raw = source.ATLAS_VISION_ARM_DELAY_MS ?? "5000";
  if (!/^[0-9]+$/u.test(raw)) {
    const error = new Error("ATLAS_VISION_ARM_DELAY_MS must be an integer from 0 to 30000.");
    error.code = "ARM_DELAY_INVALID";
    throw error;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 30_000) {
    const error = new Error("ATLAS_VISION_ARM_DELAY_MS must be an integer from 0 to 30000.");
    error.code = "ARM_DELAY_INVALID";
    throw error;
  }
  return value;
}

const POLICY_ENVIRONMENT = Object.freeze({
  ATLAS_VISION_MAX_TURNS: "turns",
  ATLAS_VISION_MAX_KEYS: "keys",
  ATLAS_VISION_MAX_OBSERVATIONS: "observations",
  ATLAS_VISION_MAX_ELAPSED_MS: "elapsedMs",
  ATLAS_VISION_MODEL_RESTARTS: "modelRestarts",
  ATLAS_VISION_MODEL_SESSION_INPUT_TOKENS: "modelSessionInputTokens",
});

const LONG_RUN_CONFLICTING_ENVIRONMENT = Object.freeze([
  "ATLAS_VISION_MAX_TURNS",
  "ATLAS_VISION_MAX_KEYS",
  "ATLAS_VISION_MAX_OBSERVATIONS",
  "ATLAS_VISION_MAX_ELAPSED_MS",
]);

export function createVisionPolicy(source = process.env, policyProfile) {
  if (policyProfile !== undefined && policyProfile !== ROLLOVER_ENDURANCE_PROFILE) {
    throw new TypeError("policyProfile is not supported");
  }
  if (
    policyProfile === ROLLOVER_ENDURANCE_PROFILE &&
    LONG_RUN_CONFLICTING_ENVIRONMENT.some((name) => source[name] !== undefined)
  ) {
    const error = new Error("--long-run cannot be combined with ATLAS_VISION_MAX_TURNS, ATLAS_VISION_MAX_KEYS, ATLAS_VISION_MAX_OBSERVATIONS, or ATLAS_VISION_MAX_ELAPSED_MS.");
    error.code = "LONG_RUN_POLICY_CONFLICT";
    throw error;
  }
  if (
    policyProfile === ROLLOVER_ENDURANCE_PROFILE &&
    source.ATLAS_VISION_MODEL_SESSION_INPUT_TOKENS !== undefined &&
    source.ATLAS_VISION_MODEL_SESSION_INPUT_TOKENS !== String(DEFAULT_POLICY.modelSessionInputTokens)
  ) {
    const error = new Error("--long-run requires ATLAS_VISION_MODEL_SESSION_INPUT_TOKENS to be unset or exactly 55000.");
    error.code = "VISION_POLICY_INVALID";
    throw error;
  }
  const policy = {};
  for (const [environmentName, policyName] of Object.entries(POLICY_ENVIRONMENT)) {
    if (policyProfile === ROLLOVER_ENDURANCE_PROFILE && LONG_RUN_CONFLICTING_ENVIRONMENT.includes(environmentName)) {
      continue;
    }
    const raw = source[environmentName];
    if (raw === undefined) continue;
    const allowsZero = new Set(["modelRestarts", "modelSessionInputTokens"]).has(policyName);
    const pattern = allowsZero ? /^(0|[1-9][0-9]*)$/u : /^[1-9][0-9]*$/u;
    if (typeof raw !== "string" || !pattern.test(raw)) {
      const error = new Error(`${environmentName} must be ${allowsZero ? "zero or a positive integer" : "a positive integer"}.`);
      error.code = "VISION_POLICY_INVALID";
      throw error;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > DEFAULT_POLICY[policyName]) {
      const error = new Error(`${environmentName} exceeds the fixed safety maximum.`);
      error.code = "VISION_POLICY_INVALID";
      throw error;
    }
    policy[policyName] = value;
  }
  return Object.freeze(policy);
}

export function loadKnowledgeContext(source = process.env) {
  const configured = source.ATLAS_WIKI_CONTEXT_FILE;
  if (configured === undefined) return undefined;
  const invalid = () => {
    const error = new Error("ATLAS_WIKI_CONTEXT_FILE must name a canonical bounded player context JSON file.");
    error.code = "KNOWLEDGE_CONTEXT_INVALID";
    throw error;
  };
  if (typeof configured !== "string" || configured.includes("\0") || !isAbsolute(configured)) invalid();
  const requested = resolve(configured);
  let entry;
  let canonical;
  let bytes;
  try {
    entry = lstatSync(requested);
    canonical = realpathSync(requested);
    bytes = readFileSync(canonical);
  } catch {
    invalid();
  }
  const samePath = process.platform === "win32"
    ? resolve(canonical).toLowerCase() === requested.toLowerCase()
    : resolve(canonical) === requested;
  if (!entry.isFile() || entry.isSymbolicLink() || !samePath || bytes.length === 0 || bytes.length > 8192) invalid();
  try {
    return validateKnowledgeContext(JSON.parse(bytes.toString("utf8")));
  } catch {
    invalid();
  }
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactlyKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

export function createUsageRecord(usage) {
  if (!hasExactlyKeys(usage, ["semantics", "completeness", "reportedTurns", "missingTurns", "knownTotals"])) {
    throw new TypeError("usage must match the sanitized Supervisor usage schema");
  }
  if (
    usage.semantics !== "TURN_DELTA" ||
    !["COMPLETE", "PARTIAL", "UNKNOWN"].includes(usage.completeness) ||
    !safeCount(usage.reportedTurns) ||
    !safeCount(usage.missingTurns)
  ) {
    throw new TypeError("usage metadata is invalid");
  }
  const expectedCompleteness = usage.reportedTurns === 0
    ? "UNKNOWN"
    : usage.missingTurns === 0 ? "COMPLETE" : "PARTIAL";
  if (usage.completeness !== expectedCompleteness) {
    throw new TypeError("usage completeness is inconsistent");
  }

  let knownTotals = null;
  if (usage.reportedTurns === 0) {
    if (usage.knownTotals !== null) throw new TypeError("unknown usage cannot contain totals");
  } else {
    if (!hasExactlyKeys(usage.knownTotals, USAGE_FIELDS)) {
      throw new TypeError("knownTotals must match the bounded token schema");
    }
    if (!USAGE_FIELDS.every((name) => safeCount(usage.knownTotals[name]))) {
      throw new TypeError("knownTotals must contain nonnegative safe integers");
    }
    if (
      usage.knownTotals.cachedInputTokens > usage.knownTotals.inputTokens ||
      !Number.isSafeInteger(usage.knownTotals.inputTokens + usage.knownTotals.outputTokens) ||
      usage.knownTotals.totalTokens !== usage.knownTotals.inputTokens + usage.knownTotals.outputTokens
    ) {
      throw new TypeError("knownTotals relationships are invalid");
    }
    knownTotals = Object.fromEntries(USAGE_FIELDS.map((name) => [name, usage.knownTotals[name]]));
  }

  return {
    schemaVersion: USAGE_RECORD_SCHEMA,
    tokens: {
      semantics: usage.semantics,
      completeness: usage.completeness,
      reportedTurns: usage.reportedTurns,
      missingTurns: usage.missingTurns,
      knownTotals,
    },
    monetaryCost: {
      status: "UNAVAILABLE",
      actualChargedAmount: null,
      estimatedAmount: null,
      currency: null,
      reason: "MONETARY_COST_NOT_REPORTED_BY_CODEX_CLI",
    },
  };
}

export function writeUsageRecord(filePath, usage) {
  if (typeof filePath !== "string" || !isAbsolute(filePath)) {
    throw new TypeError("usage file path must be absolute");
  }
  const record = createUsageRecord(usage);
  const handle = openSync(filePath, "wx", 0o600);
  try {
    writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  return record;
}

function requireCodexLogin(executablePath, environment) {
  const check = spawnSync(executablePath, ["login", "status"], {
    env: environment,
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (check.error || check.status !== 0) {
    const error = new Error("Codex CLI is not logged in.");
    error.code = "CODEX_LOGIN_REQUIRED";
    throw error;
  }
}

function printHelp() {
  process.stdout.write([
    "Usage: vision-player.cmd --confirm-openai-upload [--long-run]",
    "",
    "Required environment:",
    "  ATLAS_TARGET_HWND=<operator-selected window handle>",
    "",
    "Optional environment:",
    "  ATLAS_CAPTURE_REGION=x,y,width,height",
    "  ATLAS_ALLOWED_KEYS=ArrowUp,ArrowDown,Enter,...",
    "  ATLAS_CODEX_EXE=<absolute codex executable>",
    "  ATLAS_VISION_STATE_DIR=<absolute local output root>",
    "  ATLAS_VISION_ARM_DELAY_MS=5000",
    "  ATLAS_VISION_MAX_TURNS=40",
    "  ATLAS_VISION_MAX_KEYS=20",
    "  ATLAS_VISION_MAX_OBSERVATIONS=60",
    "  ATLAS_VISION_MAX_ELAPSED_MS=900000",
    "  ATLAS_VISION_MODEL_RESTARTS=1 (set 0 to disable)",
    "  ATLAS_VISION_MODEL_SESSION_INPUT_TOKENS=55000 (set 0 to disable rollover)",
    "  ATLAS_WIKI_CONTEXT_FILE=<absolute assisted player-context.json>",
    "",
    "--long-run selects the fixed ROLLOVER_ENDURANCE_2X profile:",
    "  120 turns, 60 keys, 180 observations, and 2700000 ms.",
    "  It cannot be combined with the four ATLAS_VISION_MAX_* variables above.",
    "",
    "The confirmation flag means every served game screenshot may be uploaded to OpenAI.",
    "",
  ].join("\n"));
}

function safeFailure(error) {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
    ? error.code
    : "VISION_HOST_FAILED";
  return { status: "FAILED", code };
}

function validatedEnvironment(source) {
  if (!isRecord(source)) throw new TypeError("source must be a plain environment object");
  const projected = Object.create(null);
  for (const [name, value] of Object.entries(source)) {
    if (
      typeof value !== "string" ||
      name.length === 0 ||
      name.length > 32_767 ||
      name.includes("=") ||
      name.includes("\0") ||
      value.includes("\0")
    ) {
      throw new TypeError("source must contain string environment entries");
    }
    projected[name] = value;
  }
  return Object.freeze(projected);
}

function validatedPolicy(policy, policyProfile) {
  if (!isRecord(policy)) throw new TypeError("policy must be a plain object");
  if (![undefined, "DEFAULT", ROLLOVER_ENDURANCE_PROFILE].includes(policyProfile)) {
    throw new TypeError("policyProfile is not supported");
  }
  const ceiling = policyProfile === ROLLOVER_ENDURANCE_PROFILE
    ? { ...DEFAULT_POLICY, turns: 120, keys: 60, observations: 180, elapsedMs: 2_700_000 }
    : DEFAULT_POLICY;
  const projected = {};
  for (const [name, value] of Object.entries(policy)) {
    if (!(name in ceiling)) throw new TypeError(`unknown policy field ${name}`);
    const minimum = ["modelRestarts", "modelSessionInputTokens"].includes(name) ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum || value > ceiling[name]) {
      throw new TypeError(`policy.${name} exceeds its profile safety boundary`);
    }
    projected[name] = value;
  }
  return Object.freeze(projected);
}

function validatedCheckpointPolicy(checkpointPolicy, policy, policyProfile) {
  if (checkpointPolicy === undefined) return undefined;
  if (!hasExactlyKeys(checkpointPolicy, ["modelInputTokens", "keyAttempts", "frames", "onMissingUsage"])) {
    throw new TypeError("checkpointPolicy has an invalid shape");
  }
  for (const name of ["modelInputTokens", "keyAttempts", "frames"]) {
    if (!safeCount(checkpointPolicy[name])) throw new TypeError(`checkpointPolicy.${name} is invalid`);
  }
  if (typeof checkpointPolicy.onMissingUsage !== "boolean") {
    throw new TypeError("checkpointPolicy.onMissingUsage must be a boolean");
  }
  if (
    checkpointPolicy.modelInputTokens === 0 &&
    checkpointPolicy.keyAttempts === 0 &&
    checkpointPolicy.frames === 0 &&
    checkpointPolicy.onMissingUsage === false
  ) {
    throw new TypeError("checkpointPolicy must enable a trigger");
  }
  const ceiling = policyProfile === ROLLOVER_ENDURANCE_PROFILE
    ? { ...DEFAULT_POLICY, turns: 120, keys: 60, observations: 180, elapsedMs: 2_700_000 }
    : DEFAULT_POLICY;
  const rolloverThreshold = policy.modelSessionInputTokens ?? ceiling.modelSessionInputTokens;
  if (rolloverThreshold > 0 && checkpointPolicy.modelInputTokens > rolloverThreshold) {
    throw new TypeError("checkpointPolicy.modelInputTokens exceeds the rollover threshold");
  }
  return Object.freeze({
    modelInputTokens: checkpointPolicy.modelInputTokens,
    keyAttempts: checkpointPolicy.keyAttempts,
    frames: checkpointPolicy.frames,
    onMissingUsage: checkpointPolicy.onMissingUsage,
  });
}

function validatedArmDelay(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 30_000) {
    throw new TypeError("armDelayMs must be an integer from 0 to 30000");
  }
  return value;
}

function safeOpaqueId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(value)) {
    throw new TypeError(`${label} must be a safe opaque identifier`);
  }
  return value;
}

export function createCampaignAccounting(result, supervisorUsage, elapsedMs) {
  if (!isRecord(result) || !isRecord(supervisorUsage)) {
    throw new TypeError("result and supervisorUsage must be objects");
  }
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
    throw new TypeError("elapsedMs must be a nonnegative safe integer");
  }
  const measured = {
    turns: supervisorUsage.turns,
    keyAttempts: supervisorUsage.keys,
    frames: supervisorUsage.observations,
  };
  if (!Object.values(measured).every(safeCount)) {
    throw new TypeError("Supervisor campaign counters are invalid");
  }
  if (result.continuation !== undefined) {
    const boundary = result.continuation?.boundary;
    if (!isRecord(boundary) ||
      boundary.completedTurns !== measured.turns ||
      boundary.keyAttempts !== measured.keyAttempts ||
      boundary.observations !== measured.frames) {
      const error = new Error("Continuation boundary does not match Supervisor measurements.");
      error.code = "SEGMENT_ACCOUNTING_INVALID";
      throw error;
    }
  }
  return Object.freeze({ ...measured, elapsedMs });
}

function segmentRuntime(overrides = {}) {
  return {
    randomUUID,
    clock: () => Date.now(),
    wait,
    beforeArmDelay: () => {},
    findCodexExecutable,
    requireCodexLogin,
    createModel: ({ executablePath, env }) => new CodexHeadlessModelPort({
      executablePath,
      env,
      timeoutMs: 85_000,
    }),
    startRunner: (options) => PlayerRunnerStdioClient.start(options),
    createSupervisor: (options) => new AgentLoopSupervisor(options),
    ...overrides,
  };
}

export async function runVisionSegment(options, dependencies = {}) {
  if (!isRecord(options)) throw new TypeError("segment options must be an object");
  const allowedOptionNames = new Set([
    "source",
    "openAIImageUploadConfirmed",
    "knowledgeContext",
    "policy",
    "policyProfile",
    "checkpointPolicy",
    "armDelayMs",
  ]);
  if (Object.keys(options).some((name) => !allowedOptionNames.has(name))) {
    throw new TypeError("segment options contain an unknown field");
  }
  const source = validatedEnvironment(options.source ?? process.env);
  if (options.openAIImageUploadConfirmed !== true) {
    const error = new Error("Explicit OpenAI screenshot upload confirmation is required.");
    error.code = "REMOTE_UPLOAD_NOT_CONFIRMED";
    throw error;
  }
  requireTargetWindow(source);
  const policyProfile = options.policyProfile;
  const policy = validatedPolicy(options.policy ?? {}, policyProfile);
  const checkpointPolicy = validatedCheckpointPolicy(options.checkpointPolicy, policy, policyProfile);
  const knowledgeContext = options.knowledgeContext === undefined
    ? undefined
    : validateKnowledgeContext(options.knowledgeContext);
  const armDelayMs = validatedArmDelay(options.armDelayMs ?? 0);
  const runtime = segmentRuntime(dependencies);

  const codexExecutable = runtime.findCodexExecutable(source);
  const startedAt = runtime.clock();
  let model;
  let runner;
  try {
    model = runtime.createModel({ executablePath: codexExecutable, env: source });
    if (!model || typeof model !== "object") throw new TypeError("createModel must return a model port");
    runtime.requireCodexLogin(codexExecutable, model.env);

  const configuredRoot = source.ATLAS_VISION_STATE_DIR;
  if (configuredRoot !== undefined && !isAbsolute(configuredRoot)) {
    const error = new Error("ATLAS_VISION_STATE_DIR must be absolute.");
    error.code = "STATE_DIRECTORY_INVALID";
    throw error;
  }
  const stateRoot = resolve(configuredRoot ?? join(TOOL_ROOT, ".local", "vision-agent"));
  mkdirSync(stateRoot, { recursive: true });
  const hostRunId = safeOpaqueId(runtime.randomUUID(), "hostRunId");
  const runRoot = join(stateRoot, hostRunId);
  const runnerStateRoot = join(runRoot, "runner");
  const supervisorRoot = join(runRoot, "host");
  mkdirSync(runRoot, { recursive: false });
  mkdirSync(runnerStateRoot, { recursive: false });
  writeFileSync(join(runRoot, "operator-consent.json"), `${JSON.stringify({
    schemaVersion: "atlas/vision-agent-operator-consent/1",
    hostRunId,
    openAIImageUploadConfirmed: true,
    confirmedAt: new Date().toISOString(),
  }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

  const launchTicket = safeOpaqueId(runtime.randomUUID(), "launchTicket");
  const runnerEnvironment = createRunnerEnvironment(source, {
    ATLAS_RUNNER_BOOTSTRAP: join(TOOL_ROOT, "04_desktop_bridge", "integration", "local-runner-bootstrap.mjs"),
    ATLAS_LAUNCH_TICKET: launchTicket,
    ATLAS_RUNNER_STATE_DIR: runnerStateRoot,
    ATLAS_EXPLORATION_TRACK: explorationTrackForKnowledgeContext(knowledgeContext),
    ...(policyProfile === ROLLOVER_ENDURANCE_PROFILE ? { ATLAS_RUNNER_PROFILE: ROLLOVER_ENDURANCE_PROFILE } : {}),
  });
    if (armDelayMs > 0) {
      runtime.beforeArmDelay(armDelayMs);
      await runtime.wait(armDelayMs);
    }
    runner = await runtime.startRunner({
      executable: process.execPath,
      args: [join(TOOL_ROOT, "01_player_runner", "src", "stdio-server.mjs")],
      env: runnerEnvironment,
      requestTimeoutMs: 15_000,
      closeGraceMs: 3_000,
    });
    const supervisor = runtime.createSupervisor({
      runner,
      model,
      workdir: supervisorRoot,
      idFactory: runtime.randomUUID,
      policy,
      policyProfile,
      checkpointPolicy,
      knowledgeContext,
    });
    if (!supervisor || typeof supervisor.run !== "function") {
      throw new TypeError("createSupervisor must return a Supervisor");
    }
    const result = await supervisor.run({ launchTicket });
    const finishedAt = runtime.clock();
    const elapsedMs = Math.max(0, Math.ceil(finishedAt - startedAt));
    if (!Number.isSafeInteger(elapsedMs)) throw new TypeError("segment elapsed time is invalid");
    const accounting = createCampaignAccounting(result, supervisor.usage, elapsedMs);
    const usageFile = join(supervisorRoot, "usage.json");
    let usageRecordStatus = "RECORDED";
    let usageRecord;
    try {
      usageRecord = writeUsageRecord(usageFile, result.usage);
    } catch {
      usageRecordStatus = "NOT_RECORDED";
      usageRecord = createUsageRecord(result.usage);
    }
    return Object.freeze({
      hostRunId,
      runDirectory: runRoot,
      supervisorResult: result,
      accounting,
      usageRecordStatus,
      usageRecord,
      ...(usageRecordStatus === "RECORDED" ? { usageFile } : {}),
      explorationTrack: explorationTrackForKnowledgeContext(knowledgeContext),
    });
  } finally {
    try {
      await runner?.close();
    } catch {}
    try {
      await model?.cancel?.();
    } catch {}
  }
}

export async function main(args = process.argv.slice(2), source = process.env, dependencies = {}) {
  const command = parseCommandLine(args);
  if (command.help) {
    printHelp();
    return { status: "HELP" };
  }
  if (!command.confirmed) {
    const error = new Error("Explicit OpenAI screenshot upload confirmation is required.");
    error.code = "REMOTE_UPLOAD_NOT_CONFIRMED";
    throw error;
  }
  const policyProfile = command.longRun ? ROLLOVER_ENDURANCE_PROFILE : undefined;
  const policy = createVisionPolicy(source, policyProfile);
  const knowledgeContext = loadKnowledgeContext(source);
  const armDelayMs = visionArmDelay(source);
  const segment = await runVisionSegment({
    source,
    openAIImageUploadConfirmed: true,
    knowledgeContext,
    policy,
    policyProfile,
    armDelayMs,
  }, {
    ...dependencies,
    beforeArmDelay: (milliseconds) => {
      process.stdout.write(`Focus the approved target window now (${milliseconds} ms).\n`);
    },
  });
  const result = segment.supervisorResult;
  const summary = {
    status: result.status,
    reason: result.reason,
    failures: result.failures,
    ...(result.stopCode ? { stopCode: result.stopCode } : {}),
    usage: segment.usageRecord.tokens,
    monetaryCost: segment.usageRecord.monetaryCost,
    usageRecord: segment.usageRecordStatus,
    ...(segment.usageRecordStatus === "RECORDED" ? { usageFile: segment.usageFile } : {}),
    hostRunId: segment.hostRunId,
    outputDirectory: segment.runDirectory,
    remoteImageUpload: "CONFIRMED",
    explorationTrack: segment.explorationTrack,
    knowledgeContext: knowledgeContext === undefined
      ? { status: "NONE" }
      : { status: "ASSISTED", revision: knowledgeContext.revision, itemCount: knowledgeContext.guidance.length },
    ...createEnduranceSummary(command, result),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(safeFailure(error))}\n`);
    process.exitCode = 1;
  });
}
