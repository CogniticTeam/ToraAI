<p align="right"><b>English</b> | <a href="README.md">简体中文</a></p>

<div align="center">

<img src="logo.PNG" width="120" alt="CoCode logo" />

# CoCode — A Comprehensive Coding Agent

**Bring Your Own Model · Low-Token, High-Efficiency · Electron + CLI**

</div>

A self-hosting-friendly coding agent. The frontend adopts an [agentscope](https://github.com/agentscope-ai/agentscope)-style UI (sidebar session list + tool call cards + streaming chat + permission confirmation cards), while the core engine is **zero-dependency**, protocol-complete, and works with any OpenAI-compatible model.

## ✨ Features

- **Bring your own model**: any OpenAI-compatible endpoint (OpenAI / DeepSeek / Zhipu / Moonshot / Ollama / vLLM…); when the model doesn't support `tool_calls`, it automatically falls back to text-based ReAct instead of breaking entirely
- **Do more with fewer tokens**: repo map + local code index (symbol / semantic inverted) + automatic context management (evicting old tool outputs + history summarization) + tool output truncation + prompt cache + change-aware context
- **Zero-dependency core**: the core package depends on no npm modules — pure Node.js (≥18) + fetch
- **18 built-in tools**: `Bash` `Read` `Write` `Edit` `Glob` `Grep` `WebFetch` `WebSearch` `Git` `RepoMap` `Checkpoint` `Lsp` `Search` `Browser` (built-in browser, supports `screenshot` so the model can see the page) + `TaskCreate` `TaskUpdate` `TaskGet` `TaskList` (structured tasks, shown live in the "Plan" panel) + `Subagent` (spawn sub-agents for parallel research; permissions can only go down, never up)
- **MCP server support**: `mcpServers` in `config.json` (stdio transport, same shape as Claude Desktop); tools enter the session as `mcp__server__tool`; visual add/remove and probing in Settings → Advanced
- **Built-in browser**: the right-side "Browser" panel is a real browser built into the app (Electron `<webview>`) — you can type URLs, log in, and read docs yourself; the Agent can use the `Browser` tool to open pages, read content, click, and type in the very same view
- **Human-in-the-loop (HITL)**: 5 permission modes + ask-confirmation cards + an allowlist ("always allow" persists in one click)
- **Lifecycle hooks**: four hook points — `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` — driven by arbitrary commands for decisions and context injection
- **Rollback-able**: a checkpoint is created automatically before every write/execution round; one-click rollback via CLI `/restore` or the desktop "Checkpoints" panel
- **Debuggable**: every run leaves a replayable timeline (requests / tool calls / permission decisions / context compaction) — CLI `/trace`, desktop "Run History" panel
- **Two editions**:
  - **CLI** — terminal REPL with ANSI streaming output and interactive permission confirmations
  - **Electron desktop** — agentscope-style web UI, local server + Electron shell

## 📸 Screenshots

| | |
|---|---|
| ![Chat home](docs/screenshots/01-聊天主页-导航栏展开.png) | ![Dark theme](docs/screenshots/19-深色主题.png) |
| *Chat home · sidebar session list* | *Dark theme* |
| ![Settings window](docs/screenshots/03-设置窗口.png) | ![Add model](docs/screenshots/12-表单字段顺序-密钥在前.png) |
| *Settings · connection / advanced options* | *Add model · OpenAI-compatible form* |

## 📦 Architecture (monorepo)

```
packages/
├── core/              # Engine + ASAPI protocol adapter (zero-dependency)
│   ├── src/
│   │   ├── config.js           Model wiring & low-token config (COCODE_HOME redirects the data root)
│   │   ├── model.js            OpenAI-compatible streaming Chat Completions + SSE parsing + capability probing
│   │   ├── security.js         Path sandbox / subprocess env sanitization / secret redaction
│   │   ├── prompt.js           Project instruction injection (COCODE.md / AGENTS.md) + system prompt assembly
│   │   ├── react.js            Text ReAct action parsing (used when the model lacks function calling)
│   │   ├── discover.js         Local model auto-discovery (Ollama / LM Studio / vLLM …)
│   │   ├── commands.js         Custom slash commands (~/.cocode/commands/*.md)
│   │   ├── tools/
│   │   │   ├── builtin.js      Bash / Read / Write / Edit / Glob / Grep (+ image reading)
│   │   │   ├── shell.js        Persistent shell sessions (cd / export survive across calls)
│   │   │   ├── web.js          WebFetch / WebSearch
│   │   │   ├── git.js          Git tool + repo status probing
│   │   │   ├── repomap.js      Repository symbol skeleton (proactively saves tokens)
│   │   │   └── checkpoint.js   Content-addressed checkpoints and rollback
│   │   ├── context.js          Token estimation + eviction + summarization compaction
│   │   ├── agent.js            Agent loop (permission gates / parallel tools / HITL / fallback)
│   │   ├── session.js          Session persistence (CLI)
│   │   ├── server.js           Simplified CLI HTTP server (backward compatible)
│   │   ├── asapi/              agentscope frontend protocol adapter
│   │   │   ├── store.js        agents / credentials / sessions (dual-track storage) + search/branch/export
│   │   │   ├── protocol.js     AgentEvent factories + Msg building + incremental merging
│   │   │   ├── bridge.js       runAgent event stream → AgentEvent protocol + SSE broadcast
│   │   │   └── server.js       Full routing (including frontend SPA hosting)
│   │   └── index.js
│   └── test/                   End-to-end integration tests (mock SSE, 161 cases)
├── cli/               # Terminal edition
│   └── src/{index,repl,render,config-wizard}.js
├── desktop/           # Desktop edition
│   ├── main.js                Electron main process (starts ASAPI + seeds localStorage)
│   └── frontend/              agentscope frontend (upstream + light customization: expanded navbar, settings window)
└── auth-worker/       # Optional cloud service: accounts, model sync, and free speech recognition (Cloudflare Worker + D1)
    ├── src/index.js           Sign-up / login / model-config sync / free speech recognition
    └── wrangler.toml          Deployment config (D1 binding, Resend email, Turnstile)
```

> Pure local use (with your own model credentials) requires **no auth-worker deployment and no account**; auth-worker provides accounts, multi-device model-config sync, and free speech recognition.

## 🚀 Quick Start

### 0. Prepare a model

```bash
# Config location: ~/.cocode/config.json (COCODE_HOME relocates the entire data root)
# Use COCODE_* environment variables; they take priority over the config file
# First launch copies legacy data to ~/.cocode, preserving the original; existing new data is not overwritten
export COCODE_BASE_URL="https://api.deepseek.com/v1"
export COCODE_API_KEY="sk-xxx"
export COCODE_MODEL="deepseek-flash"
```

Or run the interactive wizard (it can also probe model services already running on your machine):

```bash
node packages/cli/src/index.js config
node packages/cli/src/index.js models   # scans Ollama 11434 / LM Studio 1234 / vLLM 8000
```

### 1. CLI edition

```bash
# One-shot task (bypass permissions by default; only the interactive REPL asks)
node packages/cli/src/index.js "Analyze this project's code structure"

# Interactive REPL (default permission mode: reads auto-approved, writes/executions ask first)
node packages/cli/src/index.js
```

REPL commands:

| Command | Description |
|---|---|
| `/help` | Help |
| `/mode [mode]` | View/switch permission mode (default / accept_edits / explore / bypass / dont_ask) |
| `/rules [add\|rm\|clear]` | View/manage the allowlist, e.g. `/rules add Bash "npm install"` |
| `/repomap [subdir]` | Print the repository symbol skeleton (the token-saving entry point) |
| `/checkpoints` `/restore <round>` | List checkpoints / roll back the working directory |
| `/commands` | List available custom slash commands |
| `/index [keyword]` | Rebuild the symbol/semantic index; with a keyword, search directly (word-based, Chinese supported) |
| `/lsp` | Detect local language servers, inspect `lspServers` config |
| `/trace [id]` | List run records / print the full timeline of a run |
| `/hooks` | List active hooks (including whether project hooks are trusted) |
| `/new` `/sessions` `/load <id>` | Session management |
| `/model <name>` `/compact` `/stats` | Model & context |
| `/export [md\|json]` | Export the current session |
| `/tools` `/exit` | Tool list / exit |

### 2. Electron desktop edition

```bash
cd packages/desktop
npm install           # only the desktop package needs electron
npm start             # launch the GUI
```

The Electron main process will:
1. Start the ASAPI server (backend + frontend hosting) on a random local port
2. Seed localStorage's `server_url` and `username` (**shell convenience**)
3. Load the UI

### UI notes

- **Left navbar**: expanded by default (with text labels), `collapsible="none"` — never collapses
- **Settings window**: click "Settings" at the bottom of the sidebar to open; configure backend URL and username, test the connection, clear data
- **Permission confirmation card**: floats above the input box when a tool needs authorization; `↑↓` to choose, `Enter` to confirm; choosing "always allow" writes the rule into the allowlist
- **Right panel** (enable via the top-bar panel menu): Plan / Skills / **Change preview** (uncommitted `git diff`, per-line coloring + add/remove stats) / **Checkpoints** (snapshot before each round's changes, in-place second confirmation before rollback) / **Run History** (timeline per run + active hooks, including an "untrusted project hooks" notice)
- **`/` menu**: top half lists custom slash commands (selecting one pastes the template body into the input for you to edit), bottom half lists skills (selecting one attaches it as a chip)
- **Browser panel** (enable via the top-bar panel menu, or opened automatically by the Agent): address bar + back/forward/reload + the page itself
- **Settings → General → Advanced**: hook toggles, trace toggle (including "record full request bodies"), change-awareness toggle, language servers (one-click enable/disable; auto-adds `tsserver.path` when detected), code index (rebuild + size), project hook trust (trust/revoke per directory)
- **No separate "connect to server" onboarding page** — you land straight on the chat page; connection info lives in the settings window

> Frontend customization is concentrated in `frontend/src/components/layout/AppSidebar.tsx`, `frontend/src/components/dialog/SettingsDialog.tsx`, and `frontend/src/App.tsx`; the rest of the upstream code stays untouched.

### 3. Browser only

```bash
node packages/core/src/asapi/server.js 3210
# Open http://127.0.0.1:3210 in a browser — straight to the chat page
```

## 🧪 Testing

```bash
npm test        # = the two commands below

# Core engine: tools / sandbox / permission decisions / HITL / context / project instructions / ReAct fallback / persistent shell
#              LSP + semantic index / all four hook points / trace & redaction / change awareness / HTTP
node packages/core/test/run.js        # 96 cases (real LSP included, auto-skipped if no server installed; Browser uses a fake driver)

# ASAPI protocol adapter: agentscope-frontend endpoints + SSE chat stream + permissions/checkpoints/git/commands
#                         index / hook trust / trace replay / HITL event ordering
node packages/core/test/asapi.js      # 65 cases
```

Tests redirect the data root to a temp directory (`COCODE_HOME`) and **never touch your real `~/.cocode`**.

## 🔌 Model providers

| Provider | Example baseURL |
|---|---|
| OpenAI | `https://api.openai.com/v1` |
| DeepSeek | `https://api.deepseek.com/v1` |
| Zhipu GLM | `https://open.bigmodel.cn/api/paas/v4` |
| Moonshot Kimi | `https://api.moonshot.cn/v1` |
| Ollama (local) | `http://127.0.0.1:11434/v1` |
| vLLM / SGLang | `http://your-host:8000/v1` |

Credential management (desktop UI "Credentials" page): each credential is of type `openai_compatible`, storing `base_url` + `api_key`, reusable across sessions on demand. Session-level settings (model name / parameters / working directory) live to the right of the sidebar.

**Capability probing**: if an endpoint rejects the `tools` parameter, the Agent remembers that capability, switches to the text ReAct protocol automatically, and keeps going (the round never fails wholesale); vision capability is inferred from the model name, and can be set manually via `vision` when detection fails.

## 🔐 Permissions & security

### 5 permission modes

| Mode | Read | Write | Execute |
|---|---|---|---|
| `default` | allow | **ask** | ask (read-only shell commands auto-approved, e.g. `ls`/`git status`) |
| `accept_edits` | allow | allow | ask |
| `explore` | allow | deny | deny (read-only contract; even the allowlist can't override it) |
| `bypass` | allow | allow | allow (deny rules still apply) |
| `dont_ask` | allow | deny | deny (don't disturb the user = don't ask = deny; never silently approves) |

When asked, the card presents `suggested_rules` (Bash: first words; paths: directory globs; Git: subcommands; WebFetch: host). Choosing "always allow" persists the rule into `permissionRules`, and similar calls skip confirmation afterwards.

### Three hard lines

- **Path sandbox**: all file paths go through `resolveInRoots()` and are compared against real paths (symlink escapes included); out-of-bounds returns an actionable hint; extra directories go through `allowedRoots`
- **Subprocess env sanitization**: `Bash` no longer inherits the full `process.env` — `API_KEY` / `TOKEN` / `PASSWORD` / `NODE_OPTIONS` etc. are always stripped (removed by name; PATH/HOME etc. pass through as usual)
- **Secret redaction**: `redact()` does literal replacement of registered secrets and recognizes common shapes like `Bearer …`, `sk-`/`ghp_`; tool outputs and text sent to the model/logs all pass through it
- Binds to 127.0.0.1 only, never exposed to the network; renderer has no Node integration (contextIsolation + sandbox enabled)

### Checkpoints & rollback

Whenever a round involves write/execution tools, a content-addressed snapshot of the working directory is taken before that round starts (`~/.cocode/checkpoints/<session>/`, last 10 rounds kept automatically). `/checkpoints` to view, `/restore <round>` to roll back (overwrites changed files, removes files created after the snapshot). This is the prerequisite for daring to enable `bypass`.

## 🪶 Low-token strategy

| Strategy | Description |
|---|---|
| Repo map (proactive) | A symbol skeleton replaces "repeated glob + grep"; a few hundred tokens replace dozens of tool calls, injected only above a threshold |
| Local code index | Symbol index (with line numbers) and semantic inverted index persisted to `~/.cocode/index/`, rebuilt incrementally by mtime; `Search` matches by words (`findUserById` splits into `find/user/by/id`), Chinese comments split by bigrams, definition lines weighted |
| Change-aware context | Injects "recently changed files + dirty git files" into the system prompt, so the model knows files on disk may no longer look like what it remembers |
| On-demand project instructions | Convention files like `COCODE.md` / `AGENTS.md` are injected only when present, with a character cap |
| Tool output truncation | `cfg.toolOutputLimit` (default 6000 chars); large outputs keep head+tail |
| Context eviction | Token estimate over budget → older tool results replaced with placeholders (last 4 kept intact) |
| History summarization | Still over limit → the model summarizes intermediate history once; multimodal content contributes text summaries only, no base64 flooding |
| Compact system prompt | Direct commands, no pleasantries; prefer `Edit` over `Write`, changes previewed as `+/-` |
| Prompt cache | Passes through `prompt_cache_key`, normalizes per-provider cached-token counting (DeepSeek / OpenAI / Anthropic) |
| Standard fields only | Before sending, only OpenAI-standard fields are kept; internal metadata stripped |

## 🌐 Built-in browser

The right-side "Browser" panel is a real browser built into the app, shared by you and the Agent:

- **You use it manually**: type a URL in the address bar (`example.com` auto-completes `https://`), back/forward/reload — like any normal browser.
- **The Agent uses it**: the `Browser` tool with actions `open` / `read` / `state` / `click` / `type` / `press` / `back` / `forward` / `reload`. The first call automatically opens this panel, so you can watch what it's doing.

### Division of labor vs WebFetch

| | WebFetch | Browser |
|---|---|---|
| What you get | HTML converted to plain text | The page rendered by a real browser |
| JS-rendered sites | No content | Works (the reason it exists) |
| Login state / interaction | No | Yes (click, type, paginate) |
| Speed & tokens | Fast, cheap | Much slower, body may be truncated |

**Use WebFetch to "read content"; use Browser only to "operate a page" or when "the page is JS-rendered."** This rule is written into the tool's description, and the model picks accordingly.

### Permissions

Navigation actions (`open` / `back` / `forward` / `reload`) are treated as **read**, same class as WebFetch; `click` / `type` / `press` are treated as **write** — they may submit forms or trigger server-side side effects, so under the default permission mode they ask first.

### Two surfaces (and why there's an iframe)

| Environment | Uses | Capability |
|---|---|---|
| Electron desktop | `<webview>` | Real browser: separate process, can log in, runs JS, reads any site |
| Opened in a browser | `<iframe>` | Same-origin pages fully usable; most cross-origin sites refuse embedding via X-Frame-Options / CSP — **when content can't be read it fails loudly**, never pretending success with empty content |

> Two narrowings are applied when `<webview>` is enabled on desktop: `will-attach-webview` strips preload, forces Node integration off, and allows http(s) only; `window.open` inside the webview is caught by the main process and navigates in place instead of popping a new window.

## 🧩 Extensibility

### Project instruction files

Drop `COCODE.md` / `AGENTS.md` at the project root (also recognized: `CLAUDE.md` / `.cursorrules` / `.github/copilot-instructions.md` / `.cocode/AGENTS.md`); the content is injected into the system prompt automatically.

### Custom slash commands

`~/.cocode/commands/*.md` or `<project>/.cocode/commands/*.md` (project level overrides same names):

```markdown
---
description: Review changes
---
Review these changes, focusing on edge cases: $ARGUMENTS
```

Use `/review the latest commit` directly in the REPL; it also appears in the frontend `/` menu.

### LSP (optional)

Without configuration, the `Lsp` tool falls back to the local symbol index (go-to-definition / find-references / diagnostics — zero-dependency and good enough, but no type info). Install a language server, add it to the config, and it switches to real LSP:

```jsonc
// ~/.cocode/config.json
{
  "lspServers": {
    ".ts": {
      "command": "/abs/path/to/typescript-language-server",
      "args": ["--stdio"],
      // Key: typescript-language-server must find typescript **inside the opened project**,
      // and most projects don't ship it — without tsserver.path it exits immediately.
      "initializationOptions": { "tsserver": { "path": "/abs/path/to/typescript/lib/tsserver.js" } }
    },
    ".py": { "command": "pyright-langserver", "args": ["--stdio"] }
  }
}
```

**Desktop Settings → General → Advanced** can configure this in one click: it probes locally installed servers (including `~/.workbuddy`-managed workspaces, `~/.local/bin`, Homebrew and other non-PATH locations), auto-adds `tsserver.path`, and writes the config on "Enable". The CLI exposes the same probe results via `cocode lsp` or REPL `/lsp`.

Any failure (not installed, handshake timeout, process crash) falls back to the local index, **and the failure reason is stated in the result** — otherwise "configured but not working" and "never configured" look identical.

> Field note: `typescript@7` (the Go rewrite) is incompatible with `typescript-language-server` (which needs 5.x's `lib/tsserver.js`). Install `typescript@5` alongside the server.

### Lifecycle hooks

`~/.cocode/hooks.json` (always active) and `<project>/.cocode/hooks.json` (**not executed by default**, see below):

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|Write", "hooks": [{ "type": "command", "command": "node .cocode/hooks/guard.js", "timeout": 10 }] }
    ]
  }
}
```

Hooks receive the event JSON on stdin (`hook_event_name` / `tool_name` / `tool_input` / `prompt` …) and can:

- Output `{"decision":"allow|deny|ask","reason":"…"}` to decide — **a `PreToolUse` deny takes precedence over permission-mode approvals; even `bypass` cannot override it**
- Output `{"updatedInput":{…}}` to rewrite tool arguments
- Output `{"additionalContext":"…"}` to inject context, or print plain text (equivalent to injection)
- `exit 2` to block, with stderr as the reason

⚠️ **Project-level hooks are untrusted by default**: they come from repository content — cloning a repo and executing its commands equals arbitrary code execution. You must explicitly trust the directory in settings (or via `POST /hooks/trust`) before they run; while untrusted, the event stream and UI show "detected but skipped".

### Observability

Every run writes a `~/.cocode/traces/<session>/<run>.jsonl` (`traceEnabled: false` to disable): request structure, responses, per-round usage, every tool call (including permission decisions and whether a hook blocked it), context compaction events. By default **conversation bodies are not recorded** — only structure (counts / char sizes / tool names); with `traceFullBody` enabled, full bodies are recorded and always redacted.

- CLI: `/trace` to list, `/trace <id>` to print the timeline
- Desktop: the right-side "Run History" panel
- HTTP: `GET /traces` / `GET /traces/:id` / `GET /traces/:id/markdown` / `GET /traces/:id/events` (replay the event stream) / `DELETE /traces?keep_days=7`

### Custom tools

`<project>/.cocode/tools/*.js` or `~/.cocode/tools/*.js`, `export default` a tool object or an array of tools:

```js
export default {
  name: 'HelloTool',
  description: 'Example',
  parameters: { type: 'object', properties: {} },
  async execute(args, ctx) { return 'hi'; }
};
```

## 📋 Protocol notes

The agentscope frontend relies on the `@agentscope-ai/agentscope` npm SDK's `appendEvent` for event merging (no manual handling on the frontend). The AgentEvents produced by CoCode's ASAPI server are fully compatible with that SDK — see the SSE stream validation in `core/test/asapi.js`. Tool names uniformly use **PascalCase** (consistent with the SDK's built-in tool family and the frontend `tool-renderers` mapping); legacy snake_case names in old sessions remain usable through the normalization table.

## 📝 License

This project is released under the [GNU AGPL-3.0](./LICENSE) license.
