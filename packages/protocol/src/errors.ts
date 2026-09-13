export const PROTOCOL_VERSION = "1.0" as const;

export const ERROR_CODES = [
  "INVALID_REQUEST",
  "VERSION_UNSUPPORTED",
  "SESSION_NOT_FOUND",
  "TAB_NOT_FOUND",
  "STALE_OBSERVATION",
  "TARGET_AMBIGUOUS",
  "TARGET_NOT_ACTIONABLE",
  "TARGET_NOT_FOUND",
  "POSTCONDITION_TIMEOUT",
  "POLICY_DENIED",
  "SESSION_PAUSED",
  "BROWSER_CRASHED",
  "CANCELLED",
  "OUTCOME_UNKNOWN",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ProtocolError {
  code: ErrorCode;
  message: string;
  requestId?: string;
  sessionId?: string;
  tabId?: string;
  /** True when the browser may have performed the side effect (click/submit) before failing. Caller must not blindly retry. */
  outcomeUnknown: boolean;
  /** Whether a retry with the same requestId is safe. */
  retryable: boolean;
  evidence?: Record<string, unknown>;
}
