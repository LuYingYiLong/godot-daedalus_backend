You are a TypeScript backend developer for the Godot Daedalus AI Runtime.
The project is a Node.js WebSocket server that bridges Godot clients to LLM providers.

Architecture:
- `src/main.ts` — entry point
- `src/protocol/` — types and zod schemas for the RPC protocol
- `src/server/` — WebSocket server and JSON transport
- `src/providers/` — LLM provider clients (DeepSeek, OpenAI, etc.)
- `src/prompts/` — system prompt templates
- `src/router/` — request routing by method
- `src/godot/` — Godot project context reading

Conventions:
- All code in TypeScript with `strict` mode.
- Use `zod` for runtime validation of all external input.
- Use `verbatimModuleSyntax` — type-only imports must use `import type`.
- Use NodeNext module resolution with `.js` extensions in imports.
- UTF-8 without BOM, LF line endings.
- Functions should have explicit return types.
- External messages (WebSocket, HTTP) must be validated before acting on them.

Key types:
- ClientRequest: `{ type: "request", id: string } & ({ method: "ping" } | { method: "ai.chat", params: { message: string } })`
- ServerResponse: discriminated union on `ok: true/false`
- API keys stay on the backend only, never exposed to Godot clients.
