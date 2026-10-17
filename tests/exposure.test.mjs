import assert from "node:assert/strict";
import test from "node:test";

import {
  createMockCtx,
  createMockPi,
  deepseekModel,
  openaiResponsesModel,
  unsupportedLocalModel,
} from "./helpers.mjs";

import piBetterWebSearch, {
  WEB_SEARCH_TOOL_NAME,
  createWebSearchToolManager,
} from "../extensions/index.ts";
import { WEB_SEARCH_DESCRIPTION } from "../lib/schema.ts";

function toolOf(pi) {
  return pi.tools.get(WEB_SEARCH_TOOL_NAME);
}

test("unsupported model with no available providers keeps the tool inactive", () => {
  const pi = createMockPi();
  pi.setActiveTools(["read"]);
  const manager = createWebSearchToolManager(pi);
  const ctx = createMockCtx({ model: unsupportedLocalModel() });

  const result = manager.sync(ctx);

  assert.deepEqual(result, { expose: false, allowUrls: false });
  assert.deepEqual(pi.getActiveTools(), ["read"]);
  assert.equal(toolOf(pi).defaultActive, false);
});

test("an available DeepSeek enables the tool and exposes optional urls", () => {
  const pi = createMockPi();
  pi.setActiveTools(["read"]);
  const manager = createWebSearchToolManager(pi);
  const ctx = createMockCtx({
    model: unsupportedLocalModel(),
    availableModels: [deepseekModel()],
  });

  const result = manager.sync(ctx);
  const tool = toolOf(pi);

  assert.deepEqual(result, { expose: true, allowUrls: true });
  assert.ok(pi.getActiveTools().includes(WEB_SEARCH_TOOL_NAME));
  assert.equal(tool.defaultActive, false);
  assert.equal(tool.parameters.required, undefined);
  assert.ok(tool.parameters.properties.urls);
  assert.equal(tool.parameters.properties.urls.optional, undefined);
  assert.equal(tool.parameters.properties.urls.minItems, 1);
  assert.equal(tool.parameters.properties.urls.maxItems, 20);
});

test("supported current OpenAI can search but has no urls field without a URL provider", () => {
  const pi = createMockPi();
  pi.setActiveTools(["read"]);
  const manager = createWebSearchToolManager(pi);
  const openai = openaiResponsesModel();
  const ctx = createMockCtx({ model: openai, availableModels: [openai] });

  const result = manager.sync(ctx);
  const tool = toolOf(pi);

  assert.deepEqual(result, { expose: true, allowUrls: false });
  assert.ok(pi.getActiveTools().includes(WEB_SEARCH_TOOL_NAME));
  assert.deepEqual(tool.parameters.required, ["query"]);
  assert.equal(tool.parameters.properties.urls, undefined);
});

test("adding and removing a URL-capable provider updates the schema variant", () => {
  const pi = createMockPi();
  pi.setActiveTools(["read"]);
  const manager = createWebSearchToolManager(pi);
  const openai = openaiResponsesModel();

  manager.sync(createMockCtx({ model: openai, availableModels: [openai] }));
  assert.equal(toolOf(pi).parameters.properties.urls, undefined);

  manager.sync(
    createMockCtx({
      model: openai,
      availableModels: [openai, deepseekModel()],
    }),
  );
  assert.ok(toolOf(pi).parameters.properties.urls);
  assert.equal(toolOf(pi).parameters.required, undefined);

  manager.sync(createMockCtx({ model: openai, availableModels: [openai] }));
  assert.equal(toolOf(pi).parameters.properties.urls, undefined);
  assert.deepEqual(toolOf(pi).parameters.required, ["query"]);
});

test("removing provider auth hides the tool and clears its active state", () => {
  const pi = createMockPi();
  pi.setActiveTools(["read"]);
  const manager = createWebSearchToolManager(pi);
  const current = unsupportedLocalModel();

  assert.deepEqual(
    manager.sync(createMockCtx({ model: current, availableModels: [deepseekModel()] })),
    { expose: true, allowUrls: true },
  );
  assert.ok(pi.getActiveTools().includes(WEB_SEARCH_TOOL_NAME));

  // Simulate the login/API key disappearing from the available model set.
  assert.deepEqual(
    manager.sync(createMockCtx({ model: current, availableModels: [] })),
    { expose: false, allowUrls: false },
  );
  assert.deepEqual(pi.getActiveTools(), ["read"]);
  assert.deepEqual(toolOf(pi).parameters.required, ["query"]);
  assert.equal(toolOf(pi).parameters.properties.urls, undefined);
});

test("manual active-set changes are preserved across later syncs", () => {
  const pi = createMockPi();
  pi.setActiveTools(["read"]);
  const manager = createWebSearchToolManager(pi);
  const ctx = createMockCtx({
    model: unsupportedLocalModel(),
    availableModels: [deepseekModel()],
  });

  manager.sync(ctx);
  assert.deepEqual(pi.getActiveTools(), ["read", WEB_SEARCH_TOOL_NAME]);

  // User removes web_search. Later discovery changes must not re-add it.
  pi.setActiveTools(["read"]);
  manager.sync(ctx);
  manager.sync(createMockCtx({
    model: unsupportedLocalModel(),
    availableModels: [deepseekModel()],
  }));
  assert.deepEqual(pi.getActiveTools(), ["read"]);

  // User adds it back; sync respects that and keeps it there.
  pi.setActiveTools(["read", WEB_SEARCH_TOOL_NAME]);
  manager.sync(ctx);
  manager.sync(ctx);
  assert.deepEqual(pi.getActiveTools(), ["read", WEB_SEARCH_TOOL_NAME]);
});

test("default export registers one well-formed tool and only schedules sync events", () => {
  const pi = createMockPi();
  const ctx = createMockCtx({ model: unsupportedLocalModel() });

  assert.equal(piBetterWebSearch(pi), undefined);
  assert.equal(pi.tools.size, 1);

  const tool = toolOf(pi);
  assert.equal(tool.name, WEB_SEARCH_TOOL_NAME);
  assert.equal(tool.label, "Web Search");
  assert.ok(tool.description.startsWith("Search the web or analyze specified URLs."));
  assert.equal(tool.description, WEB_SEARCH_DESCRIPTION);
  assert.equal(tool.exposure, "direct");
  assert.equal(tool.defaultActive, false);
  assert.deepEqual(tool.annotations, { readOnlyHint: true, openWorldHint: true });
  assert.equal(tool.promptSnippet, undefined);
  assert.equal(tool.promptGuidelines, undefined);
  assert.equal(tool.prepareLoadout, undefined);

  assert.deepEqual(
    [...pi.handlers.keys()].sort(),
    ["before_agent_start", "model_select", "session_start", "session_tree"],
  );

  const handler = pi.handlers.get("before_agent_start")[0];
  assert.equal(handler({ type: "before_agent_start" }, ctx), undefined);
});
