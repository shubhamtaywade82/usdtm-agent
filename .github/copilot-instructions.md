# GitHub Copilot Instructions

Guidelines for AI assistance in `usdtm-agentic-paper-trader` (TypeScript / Node.js ESM).

## Workflow Guidelines

1. **Autonomous Verification**: Always verify changes by checking TypeScript types (`npm run typecheck`) and running smoke tests (`npm run smoke`).
2. **KISS & YAGNI First**: Keep solutions minimal. Avoid unnecessary abstraction layers, manager classes, or design patterns unless explicitly requested.
3. **Structure Limits**:
   - Functions ≤ 30 lines.
   - Files ≤ 300 lines.
   - Nesting ≤ 3 levels.
   - Parameters ≤ 4.
4. **Comments**: Only explain WHY non-obvious logic exists; never restate WHAT code does.
5. **No Auto-Commits**: Always leave git commits to explicit user direction.
