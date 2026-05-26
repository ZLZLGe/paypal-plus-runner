export class RunnerError extends Error {
  constructor(message, { code = "RUNNER_ERROR", retryable = true } = {}) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class WorkflowNotImplementedError extends Error {
  constructor(step) {
    super(`browser automation step is not implemented yet: ${step}`);
    this.name = "WorkflowNotImplementedError";
    this.step = step;
  }
}
