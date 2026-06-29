# Repository Guidelines

## Project Structure & Module Organization

This repository is a small TypeScript backend intended to support Godot-related tooling or runtime services. Source files belong in `src/`. The server entry point is `src/main.ts`, and the local ping client is `src/ping-client.ts`.

Keep runtime code under `src/`, tests under `tests/` or colocated as `*.test.ts`, and generated output under `dist/` if a build step is added. Do not commit `node_modules/`.

## Build, Test, and Development Commands

Install dependencies:

```powershell
npm install
```

Run TypeScript checking directly:

```powershell
npx tsc --noEmit
```

Use `npm run dev` for local execution, `npm run ping` to send a sample ping message to the running server, and `npm run typecheck` before submitting changes.

## Coding Style & Naming Conventions

Use TypeScript with `strict` mode enabled. Prefer explicit types for exported functions, message payloads, and WebSocket/RPC boundaries. Use `camelCase` for variables and functions, `PascalCase` for types/classes, and `UPPER_SNAKE_CASE` for constants.

Use UTF-8 without BOM and LF line endings. Keep files focused: protocol schemas, server setup, and transport handlers should be split once they grow beyond a small entry point. For comments in project code, write concise Chinese comments only where they clarify non-obvious behavior.

## Testing Guidelines

No test framework is configured yet. When adding tests, choose a TypeScript-friendly runner such as Vitest or Node's built-in test runner. Name tests `*.test.ts` and cover protocol validation, WebSocket message handling, and error responses.

Until a test script exists, run:

```powershell
npx tsc --noEmit
```

## Commit & Pull Request Guidelines

This directory currently has no git history, so there is no established commit convention. Use short imperative commits, for example `Add websocket server entry` or `Validate RPC request schema`.

Pull requests should include a brief summary, manual verification steps, linked issues when applicable, and notes about protocol or configuration changes.

## Security & Configuration Tips

Do not hard-code secrets, tokens, or machine-specific paths in source files. Prefer environment variables for ports and credentials. Validate all external messages with `zod` before acting on them.
