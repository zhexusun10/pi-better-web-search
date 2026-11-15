import { redactSecrets } from "../redact.ts";

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
      // The byte guard must release the caller even if an underlying source's
      // cancellation never settles. Observe rejections without awaiting it.
      void reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}

function requestSecrets(headers?: RequestInit["headers"]): Set<string> {
  const secrets = new Set<string>();
  const entries = headers instanceof Headers ? headers.entries()
    : Array.isArray(headers) ? headers : Object.entries(headers ?? {});
  for (const [name, value] of entries) {
    if (!/(?:authorization|api[-_]?key|token|cookie)/i.test(name) || !value) continue;
    const values = typeof value === "string" ? [value] : [value.join(","), ...value];
    for (const text of values) {
      if (!text.trim()) continue;
      secrets.add(text);
      secrets.add(text.trim());
      if (/^(?:Bearer|Basic)\s+/i.test(text)) secrets.add(text.replace(/^(?:Bearer|Basic)\s+/i, "").trim());
    }
  }
  return secrets;
}

/** Capture sent credentials before awaiting transport/stream work. Only error
 * fields are copied; successful provider payloads are never rewritten. */
export function createRequestErrorRedactor(headers?: RequestInit["headers"]): (error: unknown, signal?: AbortSignal) => unknown {
  const secrets = requestSecrets(headers);
  const redact = (text: string) => redactSecrets(text, secrets);
  return (error, signal) => {
    if (signal?.aborted) return signal.reason ?? error;
    if (secrets.size === 0) return error;
    const details = typeof error === "object" && error !== null
      ? error as { name?: unknown; status?: unknown; code?: unknown; body?: unknown } : {};
    const message = redact(errorMessage(error));
    const code = typeof details.code === "string" ? redact(details.code) : details.code;
    if (error instanceof HttpError) {
      return new HttpError(error.status, message, error.body === undefined ? undefined : redact(error.body), typeof code === "string" ? code : undefined);
    }
    const failure = new Error(message);
    if (typeof details.name === "string") failure.name = redact(details.name);
    const status = typeof details.status === "string" ? redact(details.status) : details.status;
    let body: unknown;
    if (typeof details.body === "string") body = redact(details.body);
    else if (details.body !== undefined) {
      try {
        const serialized = JSON.stringify(details.body);
        if (serialized !== undefined) body = JSON.parse(redact(serialized));
      } catch { /* Do not forward an unserializable, potentially secret body. */ }
    }
    return Object.assign(failure, {
      ...(typeof status === "number" || typeof status === "string" ? { status } : {}),
      ...(typeof code === "number" || typeof code === "string" ? { code } : {}),
      ...(body !== undefined ? { body } : {}),
    });
  };
}

export async function readJson<T = unknown>(response: Response, headers?: RequestInit["headers"], signal?: AbortSignal): Promise<T> {
  const redactError = createRequestErrorRedactor(headers);
  try {
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      // V8 snippets can contain only a prefix of a key, defeating literal
      // redaction. Keep the provider body separately, without parser excerpts.
      const detail = headers ? "response body is not valid JSON" : errorMessage(error);
      throw new HttpError(response.status,
        `Invalid JSON response (HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}): ${detail}`, text);
    }
  } catch (error) { throw redactError(error, signal); }
}

/** Parse HTTP Retry-After delta-seconds or an HTTP date. Invalid/past values are ignored. */
export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const delay = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

/** Keep the bounded provider body and Retry-After header, redacting sent credentials. */
export async function responseError(response: Response, label: string, requestHeaders?: RequestInit["headers"]): Promise<HttpError> {
  const body = await readErrorBody(response).catch(() => "");
  let code: string | undefined;
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown }; code?: unknown };
    const errorCode = parsed?.error?.code ?? parsed?.code;
    if (typeof errorCode === "string") code = errorCode;
  } catch { /* Preserve non-JSON and truncated bodies. */ }

  const secrets = requestSecrets(requestHeaders);
  const redact = (text: string) => redactSecrets(text, secrets);
  const safeBody = redact(body);
  const retryAfter = response.headers.get("Retry-After");
  const header = retryAfter === null ? "" : `Retry-After: ${retryAfter.slice(0, 512)}\n`;
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  return new HttpError(
    response.status,
    redact(`${label} API error (${response.status}${statusText}): ${header}${body || "no response body"}`),
    safeBody || undefined,
    code === undefined ? undefined : redact(code),
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
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  if (candidate.name === "AbortError" || candidate.code === "ABORT_ERR") return true;
  // Compatibility for transports using a plain Error, but never classify an
  // HTTP body, URL or arbitrary prose merely containing "abort" as cancellation.
  return !(error instanceof HttpError) && typeof candidate.message === "string"
    && /^(?:(?:(?:the|this) )?(?:operation|request) (?:was |has been )?aborted|(?:the )?user aborted (?:a |the )?request)[.!]?$/i.test(candidate.message);
}
