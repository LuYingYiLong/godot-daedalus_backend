# Godot Daedalus Backend

Godot Daedalus Backend is the TypeScript runtime service for the Godot Daedalus editor plugin. It provides the WebSocket/RPC backend, DeepSeek chat integration, approval-gated Godot project tools, session persistence, MCP host support, and Godot MCP servers.

This npm package is a source-runtime package. It publishes the TypeScript source and small JavaScript bin launchers, then runs the source through `tsx` at runtime. It does not publish compiled `dist/` output.

## Requirements

- Node.js 20.19 or newer.
- npm.
- Godot 4.x for Godot validation and editor workflows.
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
npm install -g godot-daedalus_backend
```

Local project install:

```powershell
npm install godot-daedalus_backend
```

## Run The WebSocket Backend

After installing the package, start it through the published bin command:

```powershell
$env:PORT = "8080"
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
- `npm run ping`: run the local ping client.
- `npm run pack:check`: inspect the npm package contents without publishing.

## Published Files

The npm package uses the `files` whitelist in `package.json`. Runtime users receive:

- `bin/`
- `src/`
- `scripts/deepseek-tokenizer-server.py`
- `README.md`
- `package.json`

Tests, local agent instructions, generated tarballs, environment files, `node_modules/`, and tokenizer model files are not published.

Before publishing:

```powershell
npm test
npm publish --dry-run
npm publish
```
