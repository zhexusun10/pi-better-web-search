# pi-better-web-search

**一个工具，所有 provider，原始结果。**

这是一个 [pi](https://pi.dev) 扩展，只新增一个模型可调用的工具：
`web_search`。它使用各家 provider 的原生搜索接口，在可用 provider 支持时
分析 URL，自动在已登录的 provider 之间切换，并把 provider 数据原样返回。

[English](../README.md) · [架构说明](architecture.md) · [Provider 细节](providers.md) · [测试](testing.md) · [源码](../extensions/index.ts)

![pi-better-web-search 架构](https://raw.githubusercontent.com/zhexusun10/pi-better-web-search/main/assets/architecture.svg)

```bash
pi install npm:pi-better-web-search
```

安装后重新启动 pi，或在当前会话输入 `/reload`。

也可以从 GitHub 或本地安装：

```bash
pi install git:github.com/zhexusun10/pi-better-web-search
pi install ./path/to/pi-better-web-search
```

> 不要和 `pi-web-search` 同时加载。两者都注册 `web_search`，后注册的会覆盖
> 先注册的。

要求：**pi 1.3+**，**Node.js 22.19+**。

## 它解决什么问题

这个项目从 `pi-web-search` 提取了 `web_search`，并修正了原项目的几个问题：

- **只保留一个工具。** 没有单独的 `url_context`；URL 分析是 `web_search`
  的可选 `urls` 字段。
- **正确的暴露规则。** 当前模型不支持搜索，且没有任何已登录/已配置 API key
  的兼容 provider 时，工具隐藏。只要有一个兼容 provider 可用，就会暴露。
- **自动 fallback。** 当前模型不能搜索，或某个 provider 调用失败时，自动尝试
  其他已认证的 provider 接口，直到成功。
- **记住成功接口。** 搜索和 URL 抓取的成功 provider 分别缓存。下次当前模型
  不能搜索时，优先使用记住的接口。
- **provider 变化后重新探测。** 新增/删除 provider、登录、API key 或可用模型
  会改变缓存指纹，旧偏好不会盲目复用。
- **动态 `urls` 字段。** 只有至少一个可用 provider 支持 URL 分析时才暴露
  `urls`。`urls` 可以单独使用，也可以和 `query` 一起使用。
- **原始结果。** provider 数据放在 JSON 外层中返回，不去重、不规范化 URL、
  不过滤垃圾 URL、不重排、不总结、不插入 citation 标记、不追加 Sources。
  只有超出最终字符数限制时才进行结构化截断。
- **正确语义。** 工具描述是 `Search the web or analyze specified URLs.`；
  schema 明确说明 `urls` 不依赖 `query`。
- **不碰系统提示词。** 不添加 prompt snippet、guideline、loadout hook、
  命令、provider、MCP server 或其他工具。
- **DeepSeek 原生 Search/Fetch。** 使用文档中的 `/v1/tools/search` 和
  `/v1/tools/fetch`，Bearer 鉴权。

## 工具语义

运行时 schema 逻辑上为：

```ts
{
  query?: string;
  urls?: string[];
}
```

- `query` 搜索网页。`site:`、引号、`AND`、`OR`、`-term` 等搜索语法原样传给
  provider，只去掉首尾空白。
- `urls` 分析指定页面。可以**单独使用**，也可以和 `query` 一起使用。两者同时
  提供时，先搜索，再分析 URL。
- 最多 **20** 个 URL。
- 必须至少有一个非空 `query` 或一个合法 URL。该规则在运行时检查，不使用
  顶层 `anyOf`，以兼容所有模型 provider。
- 没有可用 URL 分析接口时，`urls` 字段隐藏，`query` 必填。
- 同一次调用中，搜索和 URL 分析可以使用不同的 provider。

没有可用 query/URL、提供了 URL 但没有可用抓取接口、或所有搜索/URL-only
provider 都失败时，工具返回错误（`isError: true`），不会静默丢弃工作。
如果只有部分 URL 非法，非法项会在 `fetched` 中单独报错，合法的 URL 继续处理。

## Provider 支持

`pi-better-web-search` 原生支持 **10 类主流 Provider**（及 Anthropic Messages），通过各家原生 API 协议接入，兼具最原汁原味的模型能力与极速体验：

| # | Provider 类别 | 网页搜索 | URL 分析 | 原生协议与端点接口 |
|:---:|---|:---:|:---:|---|
| 1 | **DeepSeek** | 是 | 是 | 原生 REST `/v1/tools/search` 与 `/v1/tools/fetch` |
| 2 | **Google Gemini** | 是 | 是 | `google-generative-ai` SSE `google_search` 与 `url_context` |
| 3 | **Google Antigravity** | 是 | 是 | Antigravity 企业级 Vertex 端点与专属包装体 |
| 4 | **Ollama Cloud** | 是 | 是 | 托管独立 REST `/api/web_search` 与 `/api/web_fetch`（`ollama.com`） |
| 5 | **OpenAI** | 是 | 否 | 官方 Responses API `web_search` 工具（`openai-responses`） |
| 6 | **Azure OpenAI** | 是 | 否 | Azure Responses API 专用端点（`azure-openai-responses`） |
| 7 | **OpenAI Codex** | 是 | 否 | 专有 `/codex/responses` 端点，支持 Codex 账号 Token 与 Originator 协议 |
| 8 | **GitHub Copilot** | 是 | 否 | Copilot 鉴权凭证路由与兼容代理端点 Responses 搜索 |
| 9 | **OpenCode** | 是 | 否 | 携带 Pi 会话追踪请求头的 Responses 搜索 |
| 10 | **xAI (Grok)** | 是 | 否 | 原生 Grok 方言 Responses API（`web_search_call.action.sources`） |
| * | **Anthropic Messages** | 是 | 否 | Messages API `web_search_20260209` 工具及 Claude Code OAuth 凭据 |

只有至少一个可用接口支持 URL 分析时，`urls` 才会暴露。例如：当前模型是
OpenAI 且只有 OpenAI 凭据时，schema 只有 `query`；同一会话只要还有
DeepSeek、Google Gemini、Antigravity 或 Ollama Cloud 凭据，就会出现 `urls`。

Provider 识别顺序：

1. `deepseek` provider（DeepSeek 原生 search/fetch）
2. Antigravity 或 Google Generative AI（Google Gemini 与 Google Antigravity）
3. Ollama Cloud（`ollama-cloud` provider，或 host 精确为 `ollama.com`）
4. xAI + `openai-responses`（xAI Grok）
5. OpenAI-compatible Responses API（OpenAI、Azure OpenAI、OpenAI Codex、GitHub Copilot、OpenCode）
6. Anthropic Messages（Claude）

各 provider 的请求形状、鉴权细节和 URL 支持见 [Provider 细节](providers.md)。

## 自动选择与 fallback

搜索顺序：

1. 当前模型支持搜索时，优先当前模型。
2. 缓存指纹有效时，使用记住的搜索 provider。
3. 其余 provider family 按固定顺序尝试：
   **DeepSeek → Ollama → Google → OpenAI → xAI → Anthropic**。
4. 同一 family 内先按能力等级排序（便宜的等级优先，未知等级排最后）：
   OpenAI 为 `luna → sol → astra`，Claude 为 `haiku → sonnet → opus → fable`；
   其他 family 没有命名等级，直接按版本号从新到旧排序。同级内版本号大的优先。
5. 除当前模型的 provider id 外，其他 provider 的备用模型会按 round-robin 继续尝试，
   这样即使某个账号拒绝某个具体模型，也能换用同 provider 的其他模型。
   同一 family 下不同 provider id（如 `openai` 与 `openai-codex`）仍会尝试。
   provider 级失败（鉴权、余额、网络、超时、请求头异常）会跳过该 provider 的
   其余模型；模型级失败则继续尝试同 provider 的其他模型。

URL 抓取使用同样的思路，但只考虑实现了 URL 抓取的 provider。

当前模型支持搜索时始终优先当前模型；缓存不会覆盖它。缓存主要用于当前模型
不支持搜索时，让下一次调用直接使用之前成功的兼容 provider。

Provider 报错时记录 attempt 并继续下一个接口。取消会立即停止。每次尝试有
超时（默认 60 秒，`PI_BETTER_WEB_SEARCH_TIMEOUT_MS` 可调）。所有尝试都失败时，
工具返回错误，列出尝试过的 provider/model 和错误。URL-only 调用还会报告每个
URL 的失败原因。

### 缓存指纹失效

缓存带有已认证 chat 模型的指纹，由排序后的 `provider/model@baseUrl` 计算。
新增/删除 provider、登录、API key 或可用模型都会改变指纹。指纹变化时：

- 旧缓存 provider 不作为第一选择；
- 从当前模型和 family 优先级重新探测；
- 只有下一次搜索/抓取成功后才会重写缓存；
- 未验证的旧偏好不会带入新指纹。

缓存条目只是提示。每次调用都会重新解析凭据，provider 必须仍然可用并支持
对应操作。

## 缓存

默认路径：

```text
~/.pi/agent/better-web-search.json
```

遵循 pi 的 `PI_CODING_AGENT_DIR`。也可以直接覆盖：

```bash
export PI_BETTER_WEB_SEARCH_CACHE=/path/to/better-web-search.json
```

示例：

```json
{
  "version": 1,
  "fingerprint": "0123456789abcdef0123456789abcdef",
  "search": { "provider": "deepseek", "model": "deepseek-chat" },
  "fetch": { "provider": "ollama-cloud", "model": "gpt-oss:120b" }
}
```

只保存 provider/model 标识和指纹，不保存 API key、OAuth token 或其他凭据。

清空缓存：

```bash
rm ~/.pi/agent/better-web-search.json
```

缓存缺失、不可读或损坏时按空缓存处理，不会让工具调用失败。

## 原始结果

Provider 数据放在 JSON 外层中返回，不做清理。示例：

```json
{
  "query": "the query",
  "search": {
    "answer": "provider text when available",
    "results": "the provider's raw results",
    "citations": "the provider's raw citations",
    "searchQueries": ["provider query"],
    "groundingMetadata": "raw provider metadata"
  },
  "fetched": [
    {
      "url": "https://example.com",
      "data": "the provider's raw fetch payload"
    }
  ]
}
```

- 重复 URL 不去重。
- 跟踪参数和看起来像垃圾的 URL 不规范化、不过滤。
- 结果不重排、不总结。
- 不插入 citation 标记，不追加 "Sources" 或 "Additional results"。
- 不解析 redirect，不派生 sources。
- 未超出大小限制时，provider 的未知字段也会保留。

最终大小保护默认限制成功结果不超过 **96,000 个 Unicode code point**。
未超限时保留原始字段及格式；如果只是缩进导致超限，会先压缩 JSON，
不丢失数据，也不标记为截断。

压缩后仍超限时，按字段和数组条目分配预算，未用完的额度会重新分配。
已识别的链接及标识字段（包括 `url`、`uri`、`href`、`link`、`title`、
`name`、`id` 和常见别名）保持完整；放不下时省略对应条目或分支，而不是
返回半截值。独立 URL 和链接、引用数组中的条目也保持完整；正文截断点
若落在可识别的 URL（如 `https://`、`mailto:` 或 `www.`）中间，会省略该
未完整显示的 URL。未知字段中的相对链接或裸域名无法保证都能识别。
其他长字符串可能被缩短，字段或数组末尾的条目可能被省略；
不对结果重排或总结。

JSON 部分仍然合法，末尾仅追加一行 `[truncated]`。不会向模型可见的 JSON
中添加截断元数据，也不会逐个标记缩短的字符串。由于末尾追加了这一行，
整个文本不再是合法 JSON。确实丢失数据时，`details.truncated` 也会设为
`true`。

可在**启动 pi 之前**通过环境变量调整：

```bash
export PI_BETTER_WEB_SEARCH_MAX_CHARS=100000
```

PowerShell 使用 `$env:PI_BETTER_WEB_SEARCH_MAX_CHARS = "100000"`。
上限是 code point，**不是 token**，不会根据当前模型的上下文窗口自动调整。
标记也计入上限。需要截断且上限为 11–13 字符时，只返回 `[truncated]`；
少于 11 字符时放不下标记，只返回一个最小 JSON 值。这两种情况仍会通过
`details.truncated` 报告截断。当前没有续读或分页缓存；需要更多内容时可
单独重新抓取 URL 或提高上限。

## 暴露规则

满足以下任一条件时暴露 `web_search`：

- 当前对话模型支持 provider 原生搜索接口；或
- 至少一个已认证的可用模型映射到支持的 provider family。

当前模型不支持搜索，且没有兼容的登录/API key 时，工具保持隐藏（从 active
tool set 移除）。扩展不会调用未认证的 provider。可用 provider 或凭据集合变化
时，会重新评估，并以相同的 `web_search` 名称和合适的 schema 变体重新注册。

## DeepSeek 原生 Search/Fetch API

```text
POST https://api.deepseek.com/v1/tools/search
POST https://api.deepseek.com/v1/tools/fetch
Authorization: Bearer <DeepSeek API Key>
Content-Type: application/json
```

搜索使用 `query`、`count: 10`、`need_content: true`。原始 `results` 数组原样
返回，包括 `rerank_score`、`title`、`url`、`snippet`、`summary`、`content`、
`site_name`、`site_icon`、`date`、`authority` 和未知字段。

Fetch 发送 `{ "url": "..." }`，原样保存 `{ title, content }`。URL 最长 8192
字符，必须为 HTTP/HTTPS、包含 host、不能带用户名/密码。

DeepSeek 错误使用 OpenAI-compatible 格式。搜索错误和全局 fetch 错误会切换
provider；`403`/`404` 作为单个 URL 的错误上报，orchestrator 只重试该 URL。

完整字段、错误码和行为见 [Provider 细节](providers.md#deepseek)。

## 安全与隐私

- 每次调用通过 pi 的 model registry 解析凭据；扩展不保存 API key 或 OAuth token。
- 缓存只保存 provider/model 标识和指纹。
- 搜索 query 和 URL 会发送到所选 provider 的 API。
- 扩展没有自己的遥测、分析或第三方服务。
- 调用可能使用当前会话模型之外的已认证 provider，可能产生该 provider 的用量。
- Provider 错误文本和工具结果可能包含 request id 或页面内容。分享日志或会话导出前
  请先脱敏。

漏洞报告见 [SECURITY.md](../SECURITY.md)。

## 已验证

- **116 个单元/集成测试**：暴露规则、schema 变体、provider 请求形状、SSE 解析、
  原始结果保留、fallback、缓存失效、URL 处理、截断和取消。
- **真实 DeepSeek Search/Fetch**：使用真实 API key，返回 10 条原始搜索结果、
  summary/content、合法 fetch 页面，以及文档中的 404/非法 URL 错误。
- **真实 pi 进程端到端**：mock 一个不支持搜索的当前模型，配置 DeepSeek 凭据后
  自动暴露 `web_search`，模型调用工具后扩展自动切换到 DeepSeek 原生 API，
  返回 10 条原始结果并完成最终回答。
- 其他 provider family 使用 mock 请求/流的单元/集成测试覆盖，不要求每个 provider
  都有真实凭据。

可复现的 opt-in DeepSeek 测试：

```bash
DEEPSEEK_API_KEY=... npm run test:live:deepseek
```

## 兼容性

- **pi 1.3+**。使用当前 extension tool 和 model registry API。
- **Node.js 22.19+**。pi 直接加载 TypeScript，无需构建。
- `@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`、`typebox` 由 pi
  提供，作为 peer dependency，不打包。
- 上游 provider API 变化可能需要更新 adapter。未知 provider 字段保留，不重写。

## 开发

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run verify:package
npm run build
```

`npm run build` 会运行检查、测试、包内容验证，并生成
`dist/pi-better-web-search-0.1.7.tgz`。不会自动发布。

测试是 `.mjs` 文件，直接导入 `.ts` 源码，mock `globalThis.fetch`，使用临时缓存
目录。详见 [测试](testing.md) 和 [发布](publishing.md)。

## 贡献

Issue、PR 和主要文档使用英文，欢迎中文翻译。修改 provider 行为、暴露规则或
输出处理前，请阅读 [CONTRIBUTING.md](../CONTRIBUTING.md)。

最重要的约束：**信任 provider 结果**。不要添加重写、过滤、重排、总结或重建
provider 数据的清理逻辑。

## License

MIT。独立社区项目，不是 Pi 官方产品。

`web_search` 提取自 MIT 许可的
[`pi-web-search`](https://github.com/ttttmr/pi-web-search)。仓库结构和文档约定
参考了 [`pi-trim`](https://github.com/zhexusun10/pi-trim)。
