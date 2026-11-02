export class HttpError extends Error {
  readonly status: number;
  readonly body?: string;
  readonly code?: string;

  constructor(status: number, message: string, body?: string, code?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

/** Bound untrusted HTTP error bodies before storing or forwarding them. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

async function readErrorBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let done = false;
  let truncated = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        break;
      }
      const remaining = MAX_ERROR_BODY_BYTES - bytes;
      const part = chunk.value.subarray(0, remaining);
      bytes += part.byteLength;
      text += decoder.decode(part, { stream: true });
      // Stop reading even if this chunk exactly fills the budget; the stream
      // might be unbounded and waiting for another chunk could hang the call.
      if (bytes >= MAX_ERROR_BODY_BYTES) {
        truncated = true;
        break;
      }
    }
    text += decoder.decode();
    return truncated ? `${text}\n[truncated]` : text;
  } finally {
    if (!done) {
      try {
        await reader.cancel();
      } catch {
        // An interrupted response may already be closed.
      }
    }
    reader.releaseLock();
  }
}

export async function readJson<T = unknown>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new HttpError(
      response.status,
      `Invalid JSON response (HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}): ${errorMessage(error)}`,
      text,
    );
  }
}

export async function responseError(response: Response, label: string): Promise<HttpError> {
  const body = await readErrorBody(response).catch(() => "");
  let detail = body.trim();
  let code: string | undefined;

  if (detail) {
    try {
      const parsed = JSON.parse(body) as {
        error?: { message?: unknown; code?: unknown } | string;
        message?: unknown;
        code?: unknown;
      };
      const nestedError = typeof parsed.error === "object" && parsed.error !== null ? parsed.error : undefined;
      const message = nestedError?.message ?? (typeof parsed.error === "string" ? parsed.error : parsed.message);
      const errorCode = nestedError?.code ?? parsed.code;
      if (typeof errorCode === "string") code = errorCode;
      if (typeof message === "string" && message.trim()) {
        detail = message.trim();
      }
    } catch {
      // Keep the bounded raw response body when it is not complete JSON.
    }
  }

  const statusText = response.statusText ? ` ${response.statusText}` : "";
  return new HttpError(
    response.status,
    `${label} API error (${response.status}${statusText}): ${detail || "no response body"}`,
    body || undefined,
    code,
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error === undefined) return "Unknown error";
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof Error) {
    return error.name === "AbortError" || /abort/i.test(error.message);
  }
  if (typeof error === "object" && error !== null) {
    const candidate = error as { name?: unknown; message?: unknown };
    return candidate.name === "AbortError"
      || (typeof candidate.message === "string" && /abort/i.test(candidate.message));
  }
  return false;
}
