export class RunnerError extends Error {
  constructor(message, { code = "RUNNER_ERROR", retryable = true } = {}) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
    this.retryable = retryable;
  }
}
