export class RunnerError extends Error {
  constructor(message, { code = "RUNNER_ERROR", retryable = true } = {}) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class WorkflowStepRetryError extends RunnerError {
  constructor(message, { retryFromStep, retryReason = "", retryMax = 0, code = "WORKFLOW_STEP_RETRY" } = {}) {
    super(message, { code, retryable: true });
    this.name = "WorkflowStepRetryError";
    this.retryFromStep = retryFromStep;
    this.retryReason = retryReason;
    this.retryMax = retryMax;
  }
}

export class WorkflowNotImplementedError extends Error {
  constructor(step) {
    super(`browser automation step is not implemented yet: ${step}`);
    this.name = "WorkflowNotImplementedError";
    this.step = step;
  }
}

export function isClosedPageError(error) {
  const text = [
    error?.name,
    error?.code,
    error?.message,
    error?.stack,
    String(error || ""),
  ].filter(Boolean).join(" ");
  return /Target page, context or browser has been closed|Target closed|browser has been closed|context has been closed|page has been closed|Session closed|Connection closed|Protocol error.*closed/i
    .test(text);
}
