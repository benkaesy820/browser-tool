import type { ErrorCode } from "./errors.js";
import { PROTOCOL_VERSION } from "./errors.js";
import type { ErrorResult } from "./schema.js";

/**
 * Wire error contract shared by the JSONL and daemon transports.
 * Every engine/validation failure becomes a stable envelope; HTTP and
 * stdio framing never leak raw stacks.
 */
export const ERROR_CONTRACT: Record<
  ErrorCode,
  { outcomeUnknown: boolean; retryable: boolean }
> = {
  INVALID_REQUEST: { outcomeUnknown: false, retryable: false },
  VERSION_UNSUPPORTED: { outcomeUnknown: false, retryable: false },
  SESSION_NOT_FOUND: { outcomeUnknown: false, retryable: false },
  TAB_NOT_FOUND: { outcomeUnknown: false, retryable: false },
  STALE_OBSERVATION: { outcomeUnknown: false, retryable: true },
  TARGET_AMBIGUOUS: { outcomeUnknown: false, retryable: true },
  TARGET_NOT_ACTIONABLE: { outcomeUnknown: false, retryable: true },
  TARGET_NOT_FOUND: { outcomeUnknown: false, retryable: true },
  POSTCONDITION_TIMEOUT: { outcomeUnknown: false, retryable: true },
  POLICY_DENIED: { outcomeUnknown: false, retryable: false },
  SESSION_PAUSED: { outcomeUnknown: false, retryable: true },
  BROWSER_CRASHED: { outcomeUnknown: true, retryable: false },
  CANCELLED: { outcomeUnknown: false, retryable: false },
  OUTCOME_UNKNOWN: { outcomeUnknown: true, retryable: false },
};

export function toErrorResult(
  code: ErrorCode,
  message: string,
  ids: {
    requestId?: string | undefined;
    sessionId?: string | undefined;
    tabId?: string | undefined;
  } = {},
): ErrorResult {
  const contract = ERROR_CONTRACT[code];
  return {
    protocolVersion: PROTOCOL_VERSION,
    ...(ids.requestId !== undefined
      ? { requestId: ids.requestId }
      : { requestId: "" }),
    ...(ids.sessionId !== undefined ? { sessionId: ids.sessionId } : {}),
    ...(ids.tabId !== undefined ? { tabId: ids.tabId } : {}),
    status: "error",
    code,
    message,
    outcomeUnknown: contract.outcomeUnknown,
    retryable: contract.retryable,
  };
}

/** Version negotiation precedes schema validation: unknown versions fail explicitly. */
export function negotiateVersion(raw: unknown): {
  requestId?: string | undefined;
  error?: ErrorResult;
} {
  if (typeof raw !== "object" || raw === null) {
    return {
      error: toErrorResult("INVALID_REQUEST", "Request must be a JSON object"),
    };
  }
  const rec = raw as Record<string, unknown>;
  const requestId =
    typeof rec["requestId"] === "string"
      ? (rec["requestId"] as string)
      : undefined;
  if (rec["protocolVersion"] !== PROTOCOL_VERSION) {
    return {
      requestId,
      error: toErrorResult(
        "VERSION_UNSUPPORTED",
        `Unsupported protocolVersion ${JSON.stringify(rec["protocolVersion"])}; this service speaks ${PROTOCOL_VERSION}`,
        { requestId },
      ),
    };
  }
  return { requestId };
}
