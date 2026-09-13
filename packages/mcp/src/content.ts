import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ErrorCode } from "@browser-bridge/protocol";
import { ERROR_CONTRACT } from "@browser-bridge/protocol";

/**
 * Error text carries the stable protocol code first, so MCP clients see
 * exactly what JSONL/daemon clients see for the same failure.
 * Example: `TARGET_AMBIGUOUS: Ambiguous target: 2 controls match ...`
 */
export function toolError(code: string, message: string): CallToolResult {
  const contract = (ERROR_CONTRACT as Record<string, { retryable: boolean }>)[
    code
  ];
  const hint =
    contract?.retryable === true
      ? " Take a fresh observation and retry with a current ref."
      : " Do not blindly retry; fix the request first.";
  return {
    content: [{ type: "text", text: `${code}: ${message}.${hint}` }],
    isError: true,
  };
}

export function engineCodeOf(err: unknown): ErrorCode {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && code in ERROR_CONTRACT)
    return code as ErrorCode;
  return "BROWSER_CRASHED";
}

export function textResult(
  payload: unknown,
  extra?: { imageBase64?: string },
): CallToolResult {
  const content: CallToolResult["content"] = [
    { type: "text", text: JSON.stringify(payload) },
  ];
  if (extra?.imageBase64) {
    content.push({
      type: "image",
      data: extra.imageBase64,
      mimeType: "image/png",
    });
  }
  return { content };
}
