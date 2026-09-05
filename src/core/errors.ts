/** Exit codes per the CLI contract. */
export const EXIT_CODES = {
  ok: 0,
  operationalFailure: 1,
  invalidOrAuthRequired: 2,
  safetyBlocked: 3
} as const;
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export class GmailAgentError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

export class AuthRequiredError extends GmailAgentError {
  constructor(message = "Authentication is required. Run `gmail` to sign in.") {
    super(message, EXIT_CODES.invalidOrAuthRequired);
  }
}

export class InvalidConfigError extends GmailAgentError {
  constructor(message: string) {
    super(message, EXIT_CODES.invalidOrAuthRequired);
  }
}

export class SafetyPreconditionError extends GmailAgentError {
  constructor(message: string) {
    super(message, EXIT_CODES.safetyBlocked);
  }
}

export class OperationalError extends GmailAgentError {
  constructor(message: string) {
    super(message, EXIT_CODES.operationalFailure);
  }
}

export class RuleConflictError extends GmailAgentError {
  constructor(message: string) {
    super(message, EXIT_CODES.safetyBlocked);
  }
}
