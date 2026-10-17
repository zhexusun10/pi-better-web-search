import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  hasExposedCandidate,
  hasUrlCandidate,
  resolveResolutionContext,
} from "../lib/candidates.ts";
import { buildWebSearchSchema, buildWebSearchToolDescription, WEB_SEARCH_TOOL_NAME } from "../lib/schema.ts";
import { runWebSearch } from "../lib/search.ts";

export { WEB_SEARCH_TOOL_NAME } from "../lib/schema.ts";

export function createWebSearchToolManager(
  pi: Pick<ExtensionAPI, "registerTool" | "getActiveTools" | "setActiveTools">,
) {
  let lastSignature: string | undefined;
  let preferredActive = true;
  let lastAppliedPresence: boolean | undefined;

  const register = (allowUrls: boolean, exposed = false): void => {
    pi.registerTool({
      name: WEB_SEARCH_TOOL_NAME,
      label: "Web Search",
      description: buildWebSearchToolDescription({ allowUrls }),
      parameters: buildWebSearchSchema({ allowUrls }),
      exposure: "direct",
      defaultActive: false,
      annotations: { readOnlyHint: true, openWorldHint: true },
      execute: async (_toolCallId, params, signal, onUpdate, ctx) =>
        runWebSearch(params, ctx, signal, onUpdate),
    });
    lastSignature = `${exposed}|${allowUrls}`;
  };

  const sync = (
    ctx: Parameters<typeof resolveResolutionContext>[0],
    model?: Model<Api>,
  ): { expose: boolean; allowUrls: boolean } => {
    const resolution = resolveResolutionContext(ctx, model);
    const expose = hasExposedCandidate(resolution);
    const allowUrls = expose && hasUrlCandidate(resolution);
    const signature = `${expose}|${allowUrls}`;

    if (signature !== lastSignature) {
      // pi replaces a same-name definition, so this updates the schema
      // without ever registering a second tool.
      register(allowUrls, expose);
    }

    const current = pi.getActiveTools();
    const currentPresence = current.includes(WEB_SEARCH_TOOL_NAME);

    if (lastAppliedPresence === undefined) {
      // Establish the baseline without interpreting the initial state as a
      // user preference change.
      lastAppliedPresence = currentPresence;
    } else if (currentPresence !== lastAppliedPresence) {
      // The user changed the active set outside sync. Remember that choice.
      preferredActive = currentPresence;
    }

    const desiredPresence = expose && preferredActive;
    if (desiredPresence !== currentPresence) {
      const next = current.filter((name) => name !== WEB_SEARCH_TOOL_NAME);
      if (desiredPresence) next.push(WEB_SEARCH_TOOL_NAME);
      pi.setActiveTools(next);
    }

    lastAppliedPresence = desiredPresence;
    return { expose, allowUrls };
  };

  return { register, sync };
}

export default function piBetterWebSearch(pi: ExtensionAPI): void {
  const manager = createWebSearchToolManager(pi);
  manager.register(false);

  pi.on("session_start", (_event, ctx) => {
    manager.sync(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    manager.sync(ctx);
  });
  pi.on("model_select", (event, ctx) => {
    manager.sync(ctx, event.model);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    manager.sync(ctx);
  });
}
