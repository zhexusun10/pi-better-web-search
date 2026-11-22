import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dedicatedState, DEDICATED_INFO, DEDICATED_PROVIDERS, type DedicatedProvider } from "./dedicated-config.ts";
import { getPreferencesPath, readProviderPreferences, writeProviderPreferences } from "./preferences.ts";

export const API_COMMAND_NAME = "web-search-api";

/** Enable/disable menu. Masked credential entry lives in the login command. */
export function registerApiCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  onChanged?: (ctx: ExtensionContext) => void,
): void {
  pi.registerCommand(API_COMMAND_NAME, {
    description: "Configure dedicated search APIs (saved/environment keys; automatic priority and fallback)",
    handler: async (args, ctx) => {
      const argument = args.trim();
      if (argument && !DEDICATED_PROVIDERS.includes(argument as DedicatedProvider)) {
        ctx.ui.notify(`Usage: /${API_COMMAND_NAME} [${DEDICATED_PROVIDERS.join("|")}]`, "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("API configuration requires an interactive UI. Open pi's local terminal and use /pi-better-web-search login.", "warning");
        return;
      }
      let provider = argument as DedicatedProvider;
      if (!argument) {
        const settings = readProviderPreferences().apis;
        const choices = DEDICATED_PROVIDERS.map(id => {
          const state = dedicatedState(id, settings);
          return { id, label: `${DEDICATED_INFO[id].name} — ${state.available ? "ready" : state.enabled ? "key missing" : "disabled"}; ${state.hasKey ? `${state.keySource} key present` : "no key"}` };
        });
        const selected = await ctx.ui.select("Dedicated search APIs — configured APIs precede automatic model routing", choices.map(choice => choice.label));
        const choice = choices.find(item => item.label === selected);
        if (!choice) return;
        provider = choice.id;
      }
      const info = DEDICATED_INFO[provider];
      const settings = readProviderPreferences().apis;
      const state = dedicatedState(provider, settings);
      const auto = "Automatic — enable when a saved or environment key is present";
      const enable = provider === "keenable" ? "Enable — use key, or public/keyless access" : "Enable — requires a saved or environment key";
      const disable = "Disable — exclude this API, even when a key is present";
      const setup = "Show setup instructions (never paste a key into chat)";
      const capability = provider === "parallel" ? "Search: advanced + objective + search_queries; Extract: urls + objective; locks priority, no fallback"
        : provider === "deepseek" ? "Native Search + Fetch; no chat model"
        : provider === "perplexity" ? "Search only; standard web, fast off; no effort/model"
        : provider === "exa" ? "Search: 10 results + highlights; URL Fetch: /contents full text"
        : "Search pro + live URL Fetch";
      const selected = await ctx.ui.select(
        `${info.name}: ${capability}; ${state.available ? "ready" : "not available"}`,
        [auto, enable, disable, setup],
      );
      if (selected === undefined) return;
      if (selected === setup) {
        ctx.ui.notify(`Run /pi-better-web-search login to save a key in the hidden terminal dialog. Create a key at ${info.setup}; alternatively set ${info.env} in your terminal and restart pi. Never paste keys into chat. ${provider === "keenable" ? "Explicit keyless access is also available." : provider === "parallel" ? "This uses POST /v1/search (mode: advanced) and POST /v1/extract with Parallel's official schema, locks provider priority to Parallel, and disables fallback." : provider === "deepseek" ? "This uses /v1/tools/search and /v1/tools/fetch without a chat model." : provider === "exa" ? "This uses POST /search and POST /contents, not Answer or Agent APIs." : "This uses POST /search, not Agent or Orchestrator APIs."}`, "info");
        return;
      }
      if (![auto, enable, disable].includes(selected)) return;
      if (selected === enable && provider === "keenable" && !state.hasKey) {
        const confirmed = await ctx.ui.confirm("Enable Keenable public/keyless access?", "Queries, URLs and page results are sent to Keenable under its public data policy and IP rate limits. Do not send secrets or personal data. Continue?");
        if (!confirmed) return;
      }
      const preferences = readProviderPreferences();
      const apis = { ...preferences.apis };
      if (selected === auto) delete apis[provider];
      else apis[provider] = selected === enable;
      if (provider === "keenable") {
        if (selected === enable && state.hasKey) apis.keenableKeyRequired = true;
        else if (selected === auto || (selected === enable && !state.hasKey)) {
          delete apis.keenableKeyRequired; // Explicit public consent above, or automatic key-only mode.
        }
      }
      preferences.apis = apis;
      if (!writeProviderPreferences(preferences)) {
        ctx.ui.notify(`Could not save API configuration to ${getPreferencesPath()}.`, "error");
        return;
      }
      onChanged?.(ctx);
      const updated = dedicatedState(provider, apis);
      if (provider === "parallel" && updated.available) {
        ctx.ui.notify(
          `${info.name}: ready. Provider priority is locked to Parallel with its official schema; fallback to other providers is disabled.`,
          "info",
        );
        return;
      }
      ctx.ui.notify(
        `${info.name}: ${updated.available ? "ready" : updated.enabled ? `enabled, but ${info.env} is missing and no saved key exists; run /pi-better-web-search login or create a key at ${info.setup}` : "disabled"}. Manual /web-search-provider choices win; automatic fallback remains enabled.`,
        updated.enabled && !updated.available ? "warning" : "info",
      );
    },
  });
}
