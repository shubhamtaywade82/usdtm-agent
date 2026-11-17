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
   - Query `skel-mcp` for compact signatures, symbol bodies, and diffs.
   - Query `@ttsc/graph` for compiler-accurate call graphs and architectural dependencies ("who calls what").
2. **Dependency Management**:
   - Audit and manage dependencies using `@pinkpixel/npm-helper-mcp`.
   - Use `upgradePackages` with `peer: true` as the baseline to avoid peer dependency conflicts.
   - Run `runDoctor` after dependency modifications.
3. **Implementation & Type Intelligence**:
   - Write simple, direct code (KISS/YAGNI).
   - Enforce constraints: functions ≤ 30 lines, files ≤ 300 lines, nesting ≤ 3 levels, parameters ≤ 4.
   - Explain WHY in comments, never WHAT.
   - Use `ts-lsp-mcp` (`getTypeAtPosition`, `getDiagnostics`) for compiler-level type checking at exact positions.
4. **Runtime Debugging**:
   - For runtime errors, run with `tsx --inspect` / `node --inspect` and connect `@hyperdrive-eng/mcp-nodejs-debugger`.
   - Inspect scope variables, evaluate call stack expressions, and isolate root causes.
5. **Verification**:
   - Run test suites with per-test details (e.g., `npm run smoke`, `cobasaja`, or `@mcpjam/sdk`).
   - Run `npm run typecheck` and `npm run smoke`.
   - Isolate any failure, fix, and re-run only affected tests until green.
6. **Sanity Diff & Safety**:
   - Review `git diff` (or `skel-mcp` diff) and verify architectural integrity with `@ttsc/graph`.
   - Never commit automatically; ask for explicit user approval.
