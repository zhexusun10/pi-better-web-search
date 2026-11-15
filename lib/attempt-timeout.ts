import { createRequestErrorRedactor } from "./providers/http.ts";

/** Separate response-header and first-output deadlines for a provider attempt. */
interface AttemptDeadline {
  headers: () => void;
  output: () => void;
  dispose: () => void;
}

const attempts = new WeakMap<AbortSignal, AttemptDeadline>();

export function createAttemptSignal(external: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
  let deadline: AbortSignal | undefined;
  let disposed = false;
  const onTimeout = () => controller.abort(deadline?.reason ?? new DOMException("The operation timed out", "TimeoutError"));
  const stopDeadline = () => {
    deadline?.removeEventListener("abort", onTimeout);
    deadline = undefined;
  };
  const armDeadline = () => {
    if (disposed || signal.aborted) return;
    stopDeadline();
    deadline = AbortSignal.timeout(timeoutMs);
    if (deadline.aborted) onTimeout();
    else deadline.addEventListener("abort", onTimeout, { once: true });
  };
  const state: AttemptDeadline = {
    headers: () => {
      if (!signal.aborted) armDeadline();
    },
    output: () => {
      if (signal.aborted) return;
      armDeadline();
    },
    dispose: () => {
      disposed = true;
      stopDeadline();
      attempts.delete(signal);
    },
  };
  attempts.set(signal, state);
  armDeadline();
  return { signal, dispose: state.dispose };
}

/** Provider output or non-empty response bytes renew the inactivity deadline. */
export function markAttemptOutput(signal: AbortSignal | undefined): void {
  if (signal) attempts.get(signal)?.output();
}

/** Track response headers and first body bytes without buffering a stream. */
export async function providerFetch(input: string | URL, init: RequestInit & { signal?: AbortSignal }): Promise<Response> {
  const redactError = createRequestErrorRedactor(init.headers);
  let response: Response;
  try { response = await fetch(input, init); }
  catch (error) { throw redactError(error, init.signal ?? undefined); }
  const signal = init.signal;
  // A custom transport can deliver headers after the orchestrator has already
  // timed out. Release its body without waiting for arbitrary source cleanup.
  if (signal?.aborted) {
    void response.body?.cancel(signal.reason).catch(() => {});
    signal.throwIfAborted();
  }
  const state = signal ? attempts.get(signal) : undefined;
  if (!state) return response;
  state.headers();
  if (!response.body || response.status === 0) return response;
  const isSse = /^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get("Content-Type") ?? "");
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // SSE comments/keepalives are not output; the SSE parser reports events.
      if (!isSse && chunk.byteLength > 0) state.output();
      controller.enqueue(chunk);
    },
  }), { signal: signal ?? undefined });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
