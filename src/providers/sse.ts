import { TextDecoder } from "node:util";

export type SseEvent = {
  event: string;
  data: any;
};

/**
 * Read server-sent events from a fetch Response.
 *
 * `onEvent` may return true to stop reading early. Malformed JSON frames are
 * skipped because providers occasionally emit comments or non-JSON keepalives.
 */
export async function readSseEvents(
  response: Response,
  signal: AbortSignal | undefined,
  onEvent: (event: SseEvent) => boolean | void | Promise<boolean | void>,
): Promise<void> {
  if (!response.body) {
    throw new Error("No response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEventData = "";
  let currentEventName = "";
  let stopRequested = false;
  let reachedEof = false;

  const flushEvent = async (): Promise<boolean> => {
    if (!currentEventData) return false;
    const raw = currentEventData.trim();
    currentEventData = "";
    const eventName = currentEventName;
    currentEventName = "";
    if (!raw || raw === "[DONE]") return false;

    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      return false;
    }
    return (await onEvent({ event: eventName, data })) === true;
  };

  try {
    readLoop: while (true) {
      if (signal?.aborted) {
        throw new Error("Request was aborted");
      }

      const { done, value } = await reader.read();
      if (done) {
        reachedEof = true;
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line === "" || line === "\r") {
          if (await flushEvent()) {
            stopRequested = true;
            break readLoop;
          }
          continue;
        }

        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          currentEventData = currentEventData ? `${currentEventData}\n${data}` : data;
        } else if (line.startsWith("event:")) {
          currentEventName = line.slice(6).trim();
        }
      }
    }

    if (!stopRequested && buffer.trim()) {
      const line = buffer.trim();
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        currentEventData = currentEventData ? `${currentEventData}\n${data}` : data;
      }
    }
    if (!stopRequested) stopRequested = await flushEvent();
  } finally {
    if (!reachedEof) {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation failures while cleaning up an interrupted stream.
      }
    }
    reader.releaseLock();
  }
}
