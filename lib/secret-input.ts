import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input, matchesKey, Text, type Component } from "@earendil-works/pi-tui";

/** Use Input's keyboard/paste support, but NEVER call its plaintext renderer. */
export class SecretInput implements Component {
  focused = false;
  #input: Input | undefined;
  #finished = false;
  private title: string;
  private theme: Theme;
  private done: (value: string | undefined) => void;

  constructor(title: string, theme: Theme, done: (value: string | undefined) => void) {
    this.title = title;
    this.theme = theme;
    this.done = done;
    const input = new Input();
    input.onSubmit = value => this.finish(value);
    input.onEscape = () => this.finish(undefined);
    this.#input = input;
  }

  private finish(value: string | undefined): void {
    if (this.#finished) return;
    this.#finished = true;
    this.dispose();
    this.done(value);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) { this.finish(undefined); return; }
    this.#input?.handleInput(data);
  }

  render(width: number): string[] {
    const length = this.#input?.getValue().length ?? 0;
    const masked = "*".repeat(Math.min(length, Math.max(1, width - 4)));
    return new Text([
      this.theme.fg("toolTitle", this.title),
      this.theme.fg("muted", "Hidden input. Saved locally with restricted permissions, not encrypted."),
      `> ${masked}${this.focused ? CURSOR_MARKER : ""}`,
      this.theme.fg("muted", "Enter: save    Esc/Ctrl+C: cancel. Never paste a key into chat or a slash-command argument."),
    ].join("\n"), 0, 0).render(width);
  }

  invalidate(): void {}

  dispose(): void {
    if (this.#input) {
      this.#input.setValue("");
      this.#input.onSubmit = undefined;
      this.#input.onEscape = undefined;
      this.#input = undefined;
    }
  }
}

/** Do not fall back to ui.input: it displays plaintext and may run over RPC. */
export function promptApiKey(ctx: ExtensionContext, provider: string): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((_tui, theme, _keys, done) =>
    new SecretInput(`${provider} API key`, theme, done),
  );
}
