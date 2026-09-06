const ACTION_NAMES = ["press_key", "refresh_frame", "bookmark", "finish"];
const FINISH_REASON_VALUES = ["COMPLETE", "PARTIAL", "ABORT"];
const FINISH_REASONS = new Set(FINISH_REASON_VALUES);
const FRAME_ID_PATTERN = /^F\d{6}$/;
const FRAME_ID_PATTERN_SOURCE = "^F\\d{6}$";
const WIRE_KEYS = ["action"];
const SCHEMA_KEYS = [
  "$schema",
  "title",
  "type",
  "additionalProperties",
  "required",
  "properties",
];

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactlyKeys(value, expectedKeys) {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function arraysEqual(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function normalizeAllowedKeys(allowedKeys) {
  if (!Array.isArray(allowedKeys)) {
    throw new TypeError("allowedKeys must be an array of non-empty strings");
  }

  const normalized = [];
  const seen = new Set();
  for (const key of allowedKeys) {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("allowedKeys must contain only non-empty strings");
    }
    if (!seen.has(key)) {
      normalized.push(key);
      seen.add(key);
    }
  }
  return normalized;
}

function assertExactSchemaObject(value, keys, label) {
  if (!isPlainObject(value) || !hasExactlyKeys(value, keys)) {
    throw new TypeError(`${label} has an invalid shape`);
  }
}

export function createModelActionSchema(allowedKeys) {
  const normalizedAllowedKeys = normalizeAllowedKeys(allowedKeys);
  const branches = [];
  if (normalizedAllowedKeys.length > 0) {
    branches.push({
      type: "object",
      additionalProperties: false,
      required: ["action", "code"],
      properties: {
        action: { type: "string", enum: ["press_key"] },
        code: { type: "string", enum: [...normalizedAllowedKeys] },
      },
    });
  }
  branches.push(
    {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["refresh_frame"] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "frameIds"],
      properties: {
        action: { type: "string", enum: ["bookmark"] },
        frameIds: {
          type: "array",
          minItems: 1,
          items: { type: "string", pattern: FRAME_ID_PATTERN_SOURCE },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "reason"],
      properties: {
        action: { type: "string", enum: ["finish"] },
        reason: { type: "string", enum: [...FINISH_REASON_VALUES] },
      },
    },
  );
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "ModelAction",
    type: "object",
    additionalProperties: false,
    required: [...WIRE_KEYS],
    properties: {
      action: { anyOf: branches },
    },
  };
}

export function validateModelAction(action, allowedKeys) {
  if (!isPlainObject(action) || typeof action.action !== "string") {
    return false;
  }

  switch (action.action) {
    case "press_key": {
      let normalizedAllowedKeys;
      try {
        normalizedAllowedKeys = normalizeAllowedKeys(allowedKeys);
      } catch {
        return false;
      }
      return (
        hasExactlyKeys(action, ["action", "code"]) &&
        typeof action.code === "string" &&
        normalizedAllowedKeys.includes(action.code)
      );
    }
    case "refresh_frame":
      return hasExactlyKeys(action, ["action"]);
    case "bookmark":
      return (
        hasExactlyKeys(action, ["action", "frameIds"]) &&
        Array.isArray(action.frameIds) &&
        action.frameIds.length > 0 &&
        action.frameIds.every(
          (frameId) =>
            typeof frameId === "string" && FRAME_ID_PATTERN.test(frameId),
        ) &&
        new Set(action.frameIds).size === action.frameIds.length
      );
    case "finish":
      return (
        hasExactlyKeys(action, ["action", "reason"]) &&
        FINISH_REASONS.has(action.reason)
      );
    default:
      return false;
  }
}

export function projectModelActionEnvelope(envelope, allowedKeys) {
  if (!isPlainObject(envelope) || !hasExactlyKeys(envelope, WIRE_KEYS)) {
    throw new TypeError("model action envelope has an invalid shape");
  }
  if (!validateModelAction(envelope.action, allowedKeys)) {
    throw new TypeError("model action envelope has an invalid nested action");
  }
  return {
    ...envelope.action,
    ...(Array.isArray(envelope.action.frameIds)
      ? { frameIds: [...envelope.action.frameIds] }
      : {}),
  };
}

export function allowedKeysFromModelActionSchema(schema) {
  assertExactSchemaObject(schema, SCHEMA_KEYS, "model action schema");
  if (
    schema.$schema !== "https://json-schema.org/draft/2020-12/schema" ||
    schema.title !== "ModelAction" ||
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    !arraysEqual(schema.required, WIRE_KEYS)
  ) {
    throw new TypeError("model action schema has invalid root constraints");
  }

  assertExactSchemaObject(schema.properties, WIRE_KEYS, "model action properties");
  const actionWrapper = schema.properties.action;
  assertExactSchemaObject(actionWrapper, ["anyOf"], "action wrapper schema");
  if (!Array.isArray(actionWrapper.anyOf) || ![3, 4].includes(actionWrapper.anyOf.length)) {
    throw new TypeError("action wrapper must contain three or four exact branches");
  }

  const branches = new Map();
  for (const branch of actionWrapper.anyOf) {
    if (
      !isPlainObject(branch) ||
      !isPlainObject(branch.properties) ||
      !isPlainObject(branch.properties.action) ||
      !arraysEqual(branch.properties.action.enum, [branch.properties.action.enum?.[0]]) ||
      typeof branch.properties.action.enum[0] !== "string" ||
      branches.has(branch.properties.action.enum[0])
    ) {
      throw new TypeError("provider action schema has invalid branches");
    }
    branches.set(branch.properties.action.enum[0], branch);
  }
  const expectedActions = actionWrapper.anyOf.length === 4
    ? ACTION_NAMES
    : ACTION_NAMES.filter((name) => name !== "press_key");
  if (
    branches.size !== expectedActions.length ||
    expectedActions.some((name) => !branches.has(name)) ||
    [...branches.keys()].some((name) => !expectedActions.includes(name))
  ) {
    throw new TypeError("provider action schema has invalid actions");
  }

  const assertProviderBranch = (actionName, required, propertyKeys) => {
    const branch = branches.get(actionName);
    assertExactSchemaObject(
      branch,
      ["type", "additionalProperties", "required", "properties"],
      actionName + " provider branch",
    );
    if (
      branch.type !== "object" ||
      branch.additionalProperties !== false ||
      !arraysEqual(branch.required, required)
    ) {
      throw new TypeError(actionName + " provider branch has invalid object constraints");
    }
    assertExactSchemaObject(branch.properties, propertyKeys, actionName + " provider properties");
    assertExactSchemaObject(branch.properties.action, ["type", "enum"], actionName + " discriminator");
    if (
      branch.properties.action.type !== "string" ||
      !arraysEqual(branch.properties.action.enum, [actionName])
    ) {
      throw new TypeError(actionName + " provider discriminator is invalid");
    }
    return branch;
  };

  let normalizedAllowedKeys = [];
  if (branches.has("press_key")) {
    const pressKey = assertProviderBranch("press_key", ["action", "code"], ["action", "code"]);
    assertExactSchemaObject(pressKey.properties.code, ["type", "enum"], "press_key code schema");
    const code = pressKey.properties.code;
    if (code.type !== "string" || !Array.isArray(code.enum) || code.enum.length === 0) {
      throw new TypeError("press_key code schema is invalid");
    }
    normalizedAllowedKeys = normalizeAllowedKeys(code.enum);
    if (!arraysEqual(code.enum, normalizedAllowedKeys)) {
      throw new TypeError("press_key code schema contains duplicate allowed keys");
    }
  }

  assertProviderBranch("refresh_frame", ["action"], ["action"]);
  const bookmark = assertProviderBranch("bookmark", ["action", "frameIds"], ["action", "frameIds"]);
  const frameIds = bookmark.properties.frameIds;
  assertExactSchemaObject(
    frameIds,
    ["type", "minItems", "items"],
    "bookmark frameIds schema",
  );
  assertExactSchemaObject(frameIds.items, ["type", "pattern"], "bookmark frameId schema");
  if (
    frameIds.type !== "array" ||
    frameIds.minItems !== 1 ||
    frameIds.items.type !== "string" ||
    frameIds.items.pattern !== FRAME_ID_PATTERN_SOURCE
  ) {
    throw new TypeError("bookmark frameIds schema is invalid");
  }

  const finish = assertProviderBranch("finish", ["action", "reason"], ["action", "reason"]);
  assertExactSchemaObject(finish.properties.reason, ["type", "enum"], "finish reason schema");
  if (
    finish.properties.reason.type !== "string" ||
    !arraysEqual(finish.properties.reason.enum, FINISH_REASON_VALUES)
  ) {
    throw new TypeError("finish reason schema is invalid");
  }

  return normalizedAllowedKeys;
}

function assertLegacyActionProperty(property, actionName) {
  assertExactSchemaObject(property, ["const"], `${actionName} action schema`);
  if (property.const !== actionName) {
    throw new TypeError("legacy action schema has an invalid discriminator");
  }
}

function assertLegacyBranch(branch, actionName, required, propertyKeys) {
  assertExactSchemaObject(
    branch,
    ["type", "additionalProperties", "required", "properties"],
    `${actionName} branch`,
  );
  if (
    branch.type !== "object" ||
    branch.additionalProperties !== false ||
    !arraysEqual(branch.required, required)
  ) {
    throw new TypeError("legacy action branch has invalid object constraints");
  }
  assertExactSchemaObject(
    branch.properties,
    propertyKeys,
    `${actionName} properties`,
  );
  assertLegacyActionProperty(branch.properties.action, actionName);
}

export function allowedKeysFromCompactModelActionSchema(schema) {
  if (!isPlainObject(schema) || !Array.isArray(schema.oneOf)) {
    throw new TypeError("legacy model action schema must contain oneOf");
  }
  const profile = schema.title;
  const expectedRootKeys =
    profile === "ModelAction"
      ? ["$schema", "title", "oneOf"]
      : profile === "VisionAgentModelAction"
        ? ["title", "oneOf"]
        : null;
  if (
    expectedRootKeys === null ||
    !hasExactlyKeys(schema, expectedRootKeys) ||
    schema.oneOf.length !== ACTION_NAMES.length
  ) {
    throw new TypeError("legacy model action schema has an invalid root shape");
  }
  if (
    profile === "ModelAction" &&
    schema.$schema !== "https://json-schema.org/draft/2020-12/schema"
  ) {
    throw new TypeError("legacy model action schema has an invalid dialect");
  }

  const branches = new Map();
  for (const branch of schema.oneOf) {
    if (
      !isPlainObject(branch) ||
      !isPlainObject(branch.properties) ||
      !isPlainObject(branch.properties.action) ||
      typeof branch.properties.action.const !== "string" ||
      branches.has(branch.properties.action.const)
    ) {
      throw new TypeError("legacy model action schema has invalid branches");
    }
    branches.set(branch.properties.action.const, branch);
  }
  if (
    branches.size !== ACTION_NAMES.length ||
    ACTION_NAMES.some((actionName) => !branches.has(actionName))
  ) {
    throw new TypeError("legacy model action schema has invalid actions");
  }

  const pressKey = branches.get("press_key");
  assertLegacyBranch(
    pressKey,
    "press_key",
    ["action", "code"],
    ["action", "code"],
  );
  const code = pressKey.properties.code;
  let allowedKeys;
  if (
    profile === "ModelAction" &&
    isPlainObject(code) &&
    hasExactlyKeys(code, ["type", "enum"])
  ) {
    if (code.type !== "string" || !Array.isArray(code.enum)) {
      throw new TypeError("legacy press_key code schema is invalid");
    }
    allowedKeys = normalizeAllowedKeys(code.enum);
    if (!arraysEqual(code.enum, allowedKeys)) {
      throw new TypeError("legacy press_key code enum contains duplicates");
    }
  } else if (
    profile === "ModelAction" &&
    isPlainObject(code) &&
    hasExactlyKeys(code, ["type", "not"])
  ) {
    if (
      code.type !== "string" ||
      !isPlainObject(code.not) ||
      Object.keys(code.not).length !== 0
    ) {
      throw new TypeError("legacy press_key disabled schema is invalid");
    }
    allowedKeys = [];
  } else if (
    profile === "VisionAgentModelAction" &&
    isPlainObject(code) &&
    hasExactlyKeys(code, ["enum"]) &&
    Array.isArray(code.enum)
  ) {
    allowedKeys = normalizeAllowedKeys(code.enum);
    if (!arraysEqual(code.enum, allowedKeys)) {
      throw new TypeError("legacy press_key code enum contains duplicates");
    }
  } else {
    throw new TypeError("legacy press_key code schema has an invalid shape");
  }

  const refreshFrame = branches.get("refresh_frame");
  assertLegacyBranch(
    refreshFrame,
    "refresh_frame",
    ["action"],
    ["action"],
  );

  const bookmark = branches.get("bookmark");
  assertLegacyBranch(
    bookmark,
    "bookmark",
    ["action", "frameIds"],
    ["action", "frameIds"],
  );
  const frameIds = bookmark.properties.frameIds;
  assertExactSchemaObject(
    frameIds,
    ["type", "minItems", "uniqueItems", "items"],
    "legacy bookmark frameIds schema",
  );
  assertExactSchemaObject(
    frameIds.items,
    profile === "ModelAction"
      ? ["type", "minLength"]
      : ["type", "pattern"],
    "legacy bookmark frameId schema",
  );
  if (
    frameIds.type !== "array" ||
    frameIds.minItems !== 1 ||
    frameIds.uniqueItems !== true ||
    frameIds.items.type !== "string" ||
    (profile === "ModelAction"
      ? frameIds.items.minLength !== 1
      : frameIds.items.pattern !== FRAME_ID_PATTERN_SOURCE)
  ) {
    throw new TypeError("legacy bookmark schema is invalid");
  }

  const finish = branches.get("finish");
  assertLegacyBranch(
    finish,
    "finish",
    ["action", "reason"],
    ["action", "reason"],
  );
  assertExactSchemaObject(
    finish.properties.reason,
    ["enum"],
    "legacy finish reason schema",
  );
  if (!arraysEqual(finish.properties.reason.enum, FINISH_REASON_VALUES)) {
    throw new TypeError("legacy finish reason schema is invalid");
  }

  return allowedKeys;
}
