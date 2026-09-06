export class SupervisorError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "SupervisorError";
    this.code = code;
    this.state = options.state;
    this.details = options.details;
  }
}
