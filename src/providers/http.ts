export class HttpError extends Error {
  readonly status: number;
  readonly body?: string;

  constructor(status: number, message: string, body?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
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
  const body = await response.text().catch(() => "");
  let detail = body.trim();

  if (detail) {
    try {
      const parsed = JSON.parse(body) as {
        error?: { message?: unknown } | string;
        message?: unknown;
      };
      const nested = typeof parsed.error === "object" && parsed.error !== null ? parsed.error.message : undefined;
      const message = nested ?? (typeof parsed.error === "string" ? parsed.error : parsed.message);
      if (typeof message === "string" && message.trim()) {
        detail = message.trim();
      }
    } catch {
      // Keep the raw response body when it is not JSON.
    }
  }

  const statusText = response.statusText ? ` ${response.statusText}` : "";
  return new HttpError(
    response.status,
    `${label} API error (${response.status}${statusText}): ${detail || "no response body"}`,
    body || undefined,
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
