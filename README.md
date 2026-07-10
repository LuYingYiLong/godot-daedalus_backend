# Godot Daedalus Backend

Godot Daedalus Backend is the TypeScript runtime service for the Godot Daedalus editor plugin. It provides the WebSocket/RPC backend, DeepSeek chat integration, approval-gated Godot project tools, session persistence, MCP host support, and Godot MCP servers.

This npm package is a source-runtime package. It publishes the TypeScript source and small JavaScript bin launchers, then runs the source through `tsx` at runtime. It does not publish compiled `dist/` output.

## Requirements

- Node.js 22.12.0 or newer.
- npm.
- Godot 4.7 for the public Beta validation path. Godot 4.x may work, but Windows + Godot 4.7 is the first supported Beta target.
- Optional Python 3 for the DeepSeek tokenizer helper.

The Python tokenizer bridge is included as `scripts/deepseek-tokenizer-server.py`. The tokenizer model files are intentionally not included in the npm package because they can be large. If you want exact tokenizer counting, install the Python dependency and point the backend at your tokenizer directory:

```powershell
pip install tokenizers
$env:PYTHON_CMD = "python"
$env:DEEPSEEK_TOKENIZER_DIR = "D:\path\to\tokenizer"
```

If Python or tokenizer files are unavailable, the backend can still run; token counting may fall back to the non-Python path used by the runtime.

## Install

Global install:

```powershell
npm install -g daedalus-backend
```

Local project install:

```powershell
npm install daedalus-backend
```

## Run The WebSocket Backend

After installing the package, start it through the published bin command:

```powershell
$env:PORT = "38180"
godot-daedalus-backend
```

The Godot plugin connects to this backend over WebSocket. Provider configuration, including the DeepSeek API key, is normally saved from the plugin settings UI.

If the package is installed locally in another project, use npm exec or the local `.bin` command:

```powershell
npm exec godot-daedalus-backend
.\node_modules\.bin\godot-daedalus-backend.cmd
```

Do not use `npm run dev` from the consuming Godot project unless that project's own `package.json` defines a `dev` script. `npm run dev` is only a source-repository development command.

To add a convenient script in the consuming project:

```json
{
  "scripts": {
    "daedalus": "godot-daedalus-backend"
  }
}
```

Then run:

```powershell
npm run daedalus
```

## Daedalus Manager

The package also ships `godot-daedalus-manager`, a JSON-first manager CLI used by the Godot plugin for stable install, update, launch, rollback, and diagnostics workflows.

```powershell
godot-daedalus-manager --json status --project "D:\GodotProjects\example"
godot-daedalus-manager --json backend install
godot-daedalus-manager --json backend start --port 38180
godot-daedalus-manager --json backend stop
godot-daedalus-manager --json backend rollback
```

Backend installs are versioned under `%APPDATA%\.godot_daedalus\backend\versions\<version>`. The manager switches `%APPDATA%\.godot_daedalus\backend\current.json` after a new version is staged, avoiding in-place edits of a running `node_modules` directory.

Frontend plugin updates are staged rather than hot-applied. GitHub releases should provide:

```text
godot-daedalus-plugin-vX.Y.Z.zip
godot-daedalus-plugin-vX.Y.Z.manifest.json
```

The zip must contain `addons/godot_daedalus/plugin.cfg`. The manifest must include `version`, `tag`, `sha256`, `assetName`, and `minGodotVersion`.

Manager logs and runtime state live under `%APPDATA%\.godot_daedalus`. If a frontend update is blocked by a Godot file lock, close Godot and run the pending update again. Rollback commands are available for both backend and frontend:

```powershell
godot-daedalus-manager --json backend rollback
godot-daedalus-manager --json frontend rollback --project "D:\GodotProjects\example"
```

## Run The Godot MCP Server

The standalone Godot MCP server requires a Godot project path:

```powershell
$env:GODOT_PROJECT_PATH = "D:\GodotProjects\example"
godot-daedalus-mcp
```

## Run The Terminal MCP Server

The terminal MCP server exposes guarded verification commands, including Godot headless checks. Configure the project and Godot executable first:

```powershell
$env:GODOT_PROJECT_PATH = "D:\GodotProjects\example"
$env:GODOT_EXECUTABLE_PATH = "D:\Godot_v4.7-stable_win64.exe\Godot_v4.7-stable_win64.exe"
godot-daedalus-terminal-mcp
```

## Run The Automation MCP Server

Automation MCP is a development-only MCP server for external smoke clients such as Codex. It controls the backend through normal WebSocket/RPC calls and is not exposed to the Godot plugin MCP menu or to Daedalus in-product LLM tools.

It is disabled unless explicitly enabled:

```powershell
$env:DAEDALUS_AUTOMATION_MCP = "1"
npm run automation:mcp -- --backend-url ws://localhost:38180
```

Published package users can run:

```powershell
$env:DAEDALUS_AUTOMATION_MCP = "1"
godot-daedalus-automation-mcp --backend-url ws://localhost:38180
```

See [`docs/automation-mcp.md`](docs/automation-mcp.md) for Codex MCP configuration, approval whitelist settings, tool names, and smoke workflow examples.

## Development

```powershell
npm install
npm run typecheck
npm test
npm run pack:check
```

Useful scripts:

- `npm start`: run the WebSocket backend from source.
- `npm run mcp`: run the Godot MCP server from source.
- `npm run terminal:mcp`: run the terminal MCP server from source.
- `npm run automation:mcp`: run the development-only Automation MCP server. Requires `DAEDALUS_AUTOMATION_MCP=1`.
- `npm run ping`: run the local ping client.
- `npm run pack:check`: inspect the npm package contents without publishing.
- `npm run smoke:beta`: start the backend and run the Windows/Godot public Beta smoke checks.
- `npm run smoke:automation`: run the Automation WebSocket/RPC smoke matrix; add `use_llm scenario=plan_clarify` for a real provider Plan smoke.
- `npm run smoke:llm -- use_llm model_id=deepseek-v4-pro`: start a temporary backend, run one real provider Agent write against a timestamped smoke file, auto-approve only that smoke write, and verify the persisted inline diff batch.
- `npm run dev:llm -- model_id=deepseek-v4-pro`: development shortcut for the same real LLM inline diff smoke.

Public Beta release readiness is tracked in [`docs/beta-release-checklist.md`](docs/beta-release-checklist.md). The checklist covers Windows CI, Godot headless checks, real provider manual validation, frontend package rules, rollback, and security regression checks.

## Published Files

The npm package uses the `files` whitelist in `package.json`. Runtime users receive:

- `bin/`
- `docs/`
- `src/`
- `scripts/beta-smoke.ps1`
- `scripts/llm-inline-diff-smoke.ts`
- `scripts/deepseek-tokenizer-server.py`
- `README.md`
- `package.json`

Tests, local agent instructions, generated tarballs, environment files, `node_modules/`, and tokenizer model files are not published.

Before publishing:

```powershell
npm test
npm run check
npm run smoke:beta
# Optional paid/network validation before a public Beta:
npm run smoke:llm -- use_llm provider=deepseek model_id=deepseek-v4-pro
npm publish --dry-run
npm publish
```
