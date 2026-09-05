export class JudgeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "JudgeError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function invariant(condition, code, message, details = undefined) {
  if (!condition) throw new JudgeError(code, message, details);
}

export function exactKeys(value, keys, code, path) {
  invariant(value && typeof value === "object" && !Array.isArray(value), code, `${path} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  invariant(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    code,
    `${path} has unexpected or missing fields`,
    { actual, expected },
  );
}

export function nonEmptyText(value, code, path, max = 256) {
  invariant(typeof value === "string" && value.length > 0 && value.length <= max, code, `${path} must be non-empty text`);
  return value;
}

export function digestText(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
