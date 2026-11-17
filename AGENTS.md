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
Context (skel / @ttsc/graph) ➔ Dependencies (@pinkpixel/npm-helper-mcp) ➔ Implement (ts-lsp-mcp) ➔ Debug (mcp-nodejs-debugger) ➔ Verify (Per-test runner) ➔ Sanity Diff (skel-mcp diff)
```

### 1. Static Context & Architecture
- Use `skel-mcp` to retrieve signatures, symbol bodies, and diffs without reading entire files.
- Use `@ttsc/graph` to query compiler-resolved architectural call graphs and symbol relationships ("who calls what").
- *Caveat*: Do not substitute `@ttsc/graph` for `ts-lsp-mcp`. The graph server resolves architectural structure; the LSP server evaluates types at exact file positions.

### 2. Dependency Management
- Use `@pinkpixel/npm-helper-mcp` for package updates and audits.
- Always use `upgradePackages` with `peer: true` for the safe baseline to ensure compatible versions without conflicts.
- Run `runDoctor` after adding or upgrading dependencies.

### 3. Implementation & Type Intelligence
- Adhere strictly to KISS and YAGNI:
  - Functions ≤ 30 lines.
  - Files ≤ 300 lines.
  - Nesting ≤ 3 levels (guard clauses / early returns).
  - Parameters ≤ 4 (options object beyond 4).
  - Comments must only explain WHY, never WHAT.
- Use `ts-lsp-mcp` (`getTypeAtPosition`, `getDiagnostics`) to verify compiler types and diagnostics inline during editing.

### 4. Runtime Debugging
- Debug runtime failures by attaching `@hyperdrive-eng/mcp-nodejs-debugger` to `node --inspect` or `tsx --inspect`.
- Inspect call frames, evaluate expressions, and locate root causes before guessing.

### 5. Verification Protocol
- Run test suites with per-test output (e.g. `npm run smoke`, `cobasaja`, or `@mcpjam/sdk`).
- Always run `npm run typecheck` (`tsc --noEmit`) and `npm run smoke`.
- If failures occur, parse per-test failure outputs, isolate the root cause, and re-run only the affected tests until green.

### 6. Sanity Diff & Safety
- Review the Git diff via `skel-mcp` (or git diff) and verify architectural relationships via `@ttsc/graph` before concluding.
- Never commit automatically. Always ask for explicit user approval before running `git commit`.
- Do not add `Co-Authored-By:` lines to commit messages.
