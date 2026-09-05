export class RunnerError extends Error {
  constructor(code, message, { retry = "DO_NOT_RETRY", details } = {}) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
    this.retry = retry;
    this.details = details;
  }
}

export function invariant(condition, code, message, options) {
  if (!condition) throw new RunnerError(code, message, options);
}
