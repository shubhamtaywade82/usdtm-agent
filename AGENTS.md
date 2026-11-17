# AGENTS.md

Instructions and workflow specification for autonomous AI coding agents (OpenCode, Codex, Antigravity, Aider).

## Repository Overview

- **Stack**: Node.js >= 20, TypeScript 5.9+, ESM (`"type": "module"`).
- **Core Libraries**: `@nemesis-oss/binance-sdk`, `better-sqlite3`, `zod`, `ws`, `ollama`.
- **Primary Scripts**:
  - `npm run typecheck` (`tsc --noEmit`)
  - `npm run smoke` (`tsx src/smoke.ts`)
  - `npm run build` (`tsc`)
  - `npm start` (`tsx src/index.ts`)

## The Autonomous Development Partner Workflow

Agents must close the development feedback loop autonomously:

```
Context (LSP/AST) ➔ Dependencies ➔ Implement ➔ Debug (CDP) ➔ Verify (Tests) ➔ Sanity Diff
```

### 1. Context & Type Intelligence
- Rely on `@ttsc/graph` or `skel-mcp` to retrieve symbol signatures and AST relationships instead of loading entire files.
- Use `ts-lsp-mcp` for exact type evaluation and compiler diagnostics.

### 2. Dependency Management
- Use `@yawlabs/npmjs-mcp` or npm CLI to check package health, vulnerabilities, and version tags.
- Always check peer dependency compatibility when modifying dependencies.

### 3. Implementation Standards
- Follow KISS and YAGNI: no speculative abstractions, factories, or single-use wrapper classes.
- Functions ≤ 30 lines.
- Files ≤ 300 lines.
- Nesting ≤ 3 levels (guard clauses / early returns).
- Parameters ≤ 4.
- Comments must only explain WHY, never WHAT.

### 4. Runtime Debugging
- Debug runtime failures by attaching `@hyperdrive-eng/mcp-nodejs-debugger` to `node --inspect` or `tsx --inspect`.
- Inspect call frames, evaluate expressions, and locate root causes before guessing.

### 5. Verification Protocol
- Never complete a task without running `npm run typecheck` and `npm run smoke`.
- If failures occur, parse the error details, resolve them, and re-run only the affected tests until green.

### 6. Git & Safety Rules
- Never commit automatically. Always ask for explicit user approval before running `git commit`.
- Do not add `Co-Authored-By:` lines to commit messages.
