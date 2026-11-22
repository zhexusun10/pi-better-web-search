import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSelectableProviders, resolveResolutionContext } from "./candidates.ts";
import { isParallelActive } from "./dedicated-config.ts";
import { getPreferencesPath, readProviderPreferences, writeProviderPreferences } from "./preferences.ts";
import { describeRoute, routeFor } from "./routes.ts";

export const PROVIDER_COMMAND_NAME = "web-search-provider";

export function registerProviderCommand(pi: Pick<ExtensionAPI, "registerCommand">): void {
  pi.registerCommand(PROVIDER_COMMAND_NAME, {
    description: "Choose preferred search and URL fetch providers (automatic fallback stays enabled)",
    handler: async (args, ctx) => {
      const argument = args.trim();
      if (argument && argument !== "search" && argument !== "fetch") {
        ctx.ui.notify(`Usage: /${PROVIDER_COMMAND_NAME} [search|fetch]`, "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("Provider selection requires an interactive UI.", "warning");
        return;
      }
      if (isParallelActive(readProviderPreferences().apis)) {
        ctx.ui.notify(
          "Provider priority is locked to Parallel while Parallel Search is active (official schema, no fallback). Disable Parallel with /web-search-api parallel to adjust provider priority.",
          "info",
        );
        return;
      }

      let phase: "search" | "fetch";
      if (argument === "search" || argument === "fetch") {
        phase = argument;
      } else {
        const preferences = readProviderPreferences();
        const search = `Web Search — ${preferences.search ?? "Auto"}`;
        const fetch = `URL Fetch — ${preferences.fetch ?? "Auto"}`;
        const selected = await ctx.ui.select("Provider preferences (fallback always enabled)", [search, fetch]);
        if (selected !== search && selected !== fetch) return;
        phase = selected === search ? "search" : "fetch";
      }

      const resolution = resolveResolutionContext(ctx);
      const candidates = getSelectableProviders(resolution, phase);
      const preferred = resolution.preferences[phase];
      const label = phase === "search" ? "Web Search" : "URL Fetch";
      const unavailable = preferred && !candidates.some((candidate) => candidate.model.provider === preferred);
      const auto = `Auto — configured APIs, current provider, cache, then fallback${preferred ? "" : " (selected)"}`;
      const choices = candidates.map((candidate) => ({
        provider: candidate.model.provider,
        label: `${describeRoute(routeFor(candidate, phase))}${candidate.model.provider === preferred ? " (selected)" : ""}`,
      }));
      if (choices.length === 0) {
        ctx.ui.notify(`No eligible authenticated ${label} provider is available. You can still reset to Auto.`, "warning");
      }
      const selected = await ctx.ui.select(
        `${label} provider — ${preferred ?? "Auto"}${unavailable ? " (unavailable)" : ""}; fallback enabled`,
        [auto, ...choices.map((choice) => choice.label)],
      );
      if (selected === undefined) return;
      const provider = choices.find((choice) => choice.label === selected)?.provider;
      if (selected !== auto && provider === undefined) return;

      // Re-read after the dialog so changing one phase preserves the other.
      const preferences = readProviderPreferences();
      if (provider === undefined) delete preferences[phase];
      else preferences[phase] = provider;
      if (!writeProviderPreferences(preferences)) {
        ctx.ui.notify(`Could not save provider preferences to ${getPreferencesPath()}.`, "error");
        return;
      }
      ctx.ui.notify(`${label}: ${provider ?? "Auto"}. Automatic fallback remains enabled.`, "info");
    },
  });
}
