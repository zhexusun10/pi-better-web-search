import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCredentialsPath, isValidApiKey, LOGIN_LABELS, LOGIN_PROVIDERS, savedApiKey, saveApiKey, removeApiKey, type LoginProvider } from "./credentials.ts";
import { readProviderPreferences, writeProviderPreferences } from "./preferences.ts";
import { clearProviderHealth } from "./health.ts";
import { promptApiKey } from "./secret-input.ts";

export const LOGIN_COMMAND_NAME = "pi-better-web-search";

const COMMAND_HELP = [
  "Usage:",
  `/${LOGIN_COMMAND_NAME} [help] — show all web search commands`,
  `/${LOGIN_COMMAND_NAME} login|logout|status — manage saved API keys`,
  "/web-search-provider search — choose the preferred search provider",
  "/web-search-provider fetch — choose the preferred URL fetch provider",
  "/web-search-api [deepseek|exa|keenable|perplexity] — enable/disable standalone APIs",
  "Search and fetch preferences are independent. Manual preferences are tried first; automatic fallback remains enabled.",
  "Enter keys only in the hidden terminal dialog, never in a command argument.",
].join("\n");

export function registerLoginCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  onChanged?: (ctx: ExtensionContext) => void,
): void {
  pi.registerCommand(LOGIN_COMMAND_NAME, {
    description: "Web search help and API login/logout/status; discover provider preferences and API settings",
    handler: async (args, ctx) => {
      const action = args.trim();
      // Never accept an API key as an argument: arguments can enter history.
      if (!["login", "logout", "status"].includes(action)) {
        ctx.ui.notify(COMMAND_HELP, !action || action === "help" ? "info" : "warning");
        return;
      }
      if (!ctx.hasUI || ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
        ctx.ui.notify("API login requires the local interactive pi terminal (TUI), not RPC/print mode.", "warning");
        return;
      }
      if (action === "status") {
        ctx.ui.notify(LOGIN_PROVIDERS.map(provider => `${LOGIN_LABELS[provider]}: ${savedApiKey(provider) ? "saved key present" : "no saved key"}`).join("\n"), "info");
        return;
      }
      const choices = LOGIN_PROVIDERS.map(provider => ({
        provider,
        label: `${LOGIN_LABELS[provider]}${savedApiKey(provider) ? " (saved key present)" : ""}`,
      }));
      const selected = await ctx.ui.select(`Web search API ${action} — choose provider`, choices.map(choice => choice.label));
      const provider: LoginProvider | undefined = choices.find(choice => choice.label === selected)?.provider;
      if (!provider) return;
      const label = LOGIN_LABELS[provider];
      if (action === "logout") {
        if (!savedApiKey(provider)) { ctx.ui.notify(`${label}: no saved key to remove. Environment/pi credentials are unchanged; use /web-search-api to disable standalone access.`, "info"); return; }
        if (!await ctx.ui.confirm(`Remove saved ${label} key?`, "This removes only this extension's saved key and disables its standalone API. Environment and pi conversation-provider credentials are unchanged.")) return;
        // Disable first: Keenable must not silently downgrade to public access.
        const preferences = readProviderPreferences();
        preferences.apis = { ...preferences.apis, [provider]: false };
        if (!writeProviderPreferences(preferences)) {
          ctx.ui.notify("Could not disable the API; the saved key was not removed.", "error"); return;
        }
        if (!await removeApiKey(provider)) {
          onChanged?.(ctx);
          ctx.ui.notify("API disabled, but the saved key could not be removed. Fix credential-file permissions and retry logout.", "error"); return;
        }
        clearProviderHealth(provider);
        onChanged?.(ctx);
        ctx.ui.notify(`${label}: saved key removed and standalone API disabled. Other pi/environment credentials are unchanged.`, "info");
        return;
      }

      let value: string | undefined;
      try { value = await promptApiKey(ctx, label); }
      catch { ctx.ui.notify("Could not open the hidden API-key dialog. No credentials changed.", "error"); return; }
      if (value === undefined) return;
      let key = value.trim();
      value = undefined;
      if (!isValidApiKey(key)) {
        key = "";
        ctx.ui.notify("Invalid API key: use 1–8192 printable ASCII characters without internal whitespace. Nothing was saved.", "warning");
        return;
      }
      const saved = await saveApiKey(provider, key);
      key = "";
      if (!saved) {
        ctx.ui.notify(`Could not save credentials to ${getCredentialsPath()}. Existing keys were left unchanged.`, "error");
        return;
      }
      clearProviderHealth(provider);
      const preferences = readProviderPreferences();
      preferences.apis = { ...preferences.apis, [provider]: true };
      if (provider === "keenable") preferences.apis.keenableKeyRequired = true;
      const enabled = writeProviderPreferences(preferences);
      onChanged?.(ctx);
      if (!enabled) {
        ctx.ui.notify(`${label}: key saved, but the API enable setting could not be saved. Fix settings permissions and retry login.`, "warning");
        return;
      }
      ctx.ui.notify(`${label}: API key saved locally (not encrypted) and enabled. It takes precedence over the environment key. Existing provider preferences and fallback are unchanged. No validation request was sent.`, "info");
    },
  });
}
