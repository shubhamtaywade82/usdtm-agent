# CLAUDE.md

Autonomous Development Partner instructions for `usdtm-agentic-paper-trader` (Node.js 20+ TypeScript ESM).

## Commands

- **Typecheck**: `npm run typecheck` (`tsc --noEmit`)
- **Build**: `npm run build` (`tsc`)
- **Smoke test**: `npm run smoke` (`tsx src/smoke.ts`)
- **Run dev/start**: `npm start` (`tsx src/index.ts`)

## Autonomous Partner Loop

Execute all tasks through this closed-loop cycle:

1. **Context & Architecture**:
   - Query `@ttsc/graph` for compiler-accurate type graphs, signatures, and symbol relationships.
   - Query `ts-lsp-mcp` for hover types and diagnostics (`getTypeAtPosition`, `getDiagnostics`).
2. **Dependency Management**:
   - Audit dependencies with `@yawlabs/npmjs-mcp` or `npm info <pkg>`.
   - Ensure peer dependency compatibility before modifying `package.json`.
3. **Implementation**:
   - Write simple, direct code that solves the issue without speculative wrappers.
   - Enforce constraints: functions ≤ 30 lines, files ≤ 300 lines, nesting ≤ 3 levels, parameters ≤ 4.
   - Explain WHY in comments, never WHAT.
4. **Runtime Debugging**:
   - For runtime errors, run with `tsx --inspect` / `node --inspect` and connect `@hyperdrive-eng/mcp-nodejs-debugger`.
   - Inspect scope variables, step execution, and confirm root causes.
5. **Verification**:
   - Run `npm run typecheck` and `npm run smoke`.
   - Isolate any failure, fix, and re-run until all checks pass.
6. **Diff & Safety**:
   - Review `git diff` before finishing.
   - Never commit automatically; ask for explicit user approval.
