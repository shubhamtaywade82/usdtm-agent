# Agentic USDT-M Futures Paper Trader

A fully agentic, autonomous crypto trading agent for **Binance USDT-M perpetual futures**, running entirely on **public market data** (no API keys, no account endpoints) and executing against a local **paper exchange** with a hard risk layer.

An LLM (default: `openbmb/minicpm5-2b` via Ollama, configurable) is the brain: it wakes on market events, investigates with tools, states a plan, and places orders — all through a ReAct-style tool-calling loop.

```
        ┌────────────────────────────────────────────────────────────┐
        │                     Binance USDT-M (public)                │
        │   WS: aggTrade, klines, bookTicker, markPrice, ticker,     │
        │       forceOrder (liquidations), depth diffs  +  REST hist │
        └───────────────┬────────────────────────────┬───────────────┘
                        │ WebSocket (primary)        │ REST (cached fallback)
                        ▼                            ▼
                ┌──────────────────────────────────────────┐
                │            MarketDataHub                 │
                │  live prices · L2 books · klines ·       │
                │  funding · liquidations · ratios         │
                └───────────────┬──────────────────────────┘
                                │ events
                ┌───────────────▼───────────────┐
                │   Event-driven Runner         │  kline close / big liq /
                │   (cooldown + coalescing)     │  schedule → wake agent
                └───────────────┬───────────────┘
                                ▼
                ┌───────────────────────────────┐
                │      Agent (ReAct loop)       │  Ollama LLM + 17 tools
                │  bounded steps · doom-loop    │
                │  detection · memory           │
                └───────────────┬───────────────┘
                        proposes │
                                ▼
                ┌───────────────────────────────┐
                │      RiskManager (hard)       │  leverage / notional / risk
                │  circuit breakers · halts     │  caps / doom-loop / rate
                └───────────────┬───────────────┘
                     approves ▼
                ┌───────────────────────────────┐
                │  PaperExchange → Rails        │  margin · fees · funding ·
                │  paper_exchange :3100 (HTTP)  │  liquidations · persistence
                └───────────────────────────────┘
```

## Design principles

1. **WebSocket-first.** All live data (prices, book, mark price, klines, liquidations) arrives over WS through `@nemesis-oss/binance-sdk`'s pooled connections. REST is only a cached fallback for history endpoints, wrapped in hard timeouts so a rate-limited REST never stalls an agent cycle. (This matters: Binance actively bans REST-poling IPs and its own error message says "use the websocket for live updates".)
2. **The LLM proposes; the risk layer disposes.** Every order passes `RiskManager.checkOrder()` — leverage caps, per-symbol and portfolio notional caps, per-trade risk caps (stop-distance-based), margin checks, doom-loop detection, order rate limits, and a daily-loss circuit breaker. A halted account can only resume via explicit acknowledge.
3. **Event-driven, not a polling loop.** The agent sleeps until a 5m/15m candle closes, a large liquidation prints (≥ $500k default), or the safety-net timer fires. A cooldown coalesces event storms into single cycles.
4. **Bounded autonomy.** Max steps per cycle, per-request LLM timeout, tool-call doom-loop detection (same call 4× in 5 min → forced stop), identical-order doom-loop detection (same order 4× in 10 min → reject), and compact tool-result serialization sized for small-context models.

## Systems-Level Control Loop Architecture

At the systems level, this agentic trader is a control loop where a deterministic **harness** (runtime) mediates between a stochastic **model** and external **capabilities** (market data feeds, paper exchange, and memory).

```
 ┌────────────────────────────────────────────────────────────────────────┐
 │                      Deterministic Harness (Runtime)                   │
 │                                                                        │
 │   Event Coalescer ──► Bounded Cycle Runner ──► Evaluator-Optimizer     │
 │   (5m/15m kline close,  (Step limits, timeout,  (RiskManager hard      │
 │    liq spikes, timer)    KV-cache prefix,      gatekeeper, halts,      │
 │                          doom-loop guards)     invariants)             │
 └─────────────┬─────────────────────▲─────────────────────┬──────────────┘
               │ Context             │ Tool Calls          │ State Mutation
               ▼                     │                     ▼
 ┌───────────────────────────┐       │         ┌──────────────────────────┐
 │      Stochastic Model     │───────┘         │  External Capabilities   │
 │   (Ollama / Local LLM)    │                 │  · Live WS / REST Hub    │
 │  · ReAct exploration      │                 │  · 17 Domain Tools       │
 │  · Plan-and-Execute thesis│                 │  · Paper SQLite Engine   │
 │  · Adaptive order proposal│                 │  · Episodic Reflections  │
 └───────────────────────────┘                 └──────────────────────────┘
```

### Where `usdtm-agent` Sits in the Agentic Taxonomy

1. **Hybrid ReAct with Plan-and-Execute Milestones**:
   - The agent alternates between reasoning and structured tool calls (ReAct) to investigate market overview, order book depth, indicators, and liquidations.
   - It is bound by an enforced **Plan Milestone**: `place_market_order` is rejected until the agent has called `set_plan` in the current cycle. The plan is a single free-text string; the risk layer does not check its contents.
2. **Evaluator-Optimizer Mechanical Gate (Generator-Critic)**:
   - When the stochastic model emits an order (`place_market_order`), it is not directly executed.
   - The deterministic `RiskManager` evaluates 10 non-negotiable invariants (leverage, notional limits, per-trade stop-loss risk, margin, and order doom-loops).
   - If rejected, the structured critique is injected back into the conversation context as tool output, enabling the model to adapt and self-correct on the subsequent turn.
3. **Why Structured Tools Over CodeAct for Financial Execution**:
   - In live trading, arbitrary script execution introduces unconstrained side-effect risks and bypasses pre-flight risk evaluation. Structured tool calls enforce deterministic schema validation and strict state-mutation checkpoints.

### Production Harness Wiring Mechanics

1. **Tiered Context & Scoped Capabilities**:
   - Capabilities are cleanly segregated into **Market Data (read)**, **Account (read)**, and **Risk-Gated Execution (write)**. Small models avoid tool hallucination through strict Zod schemas and compact payload serialization.
2. **Prompt-Cache Prefix Stability**:
   - LLM engines (Ollama, vLLM, llama.cpp) cache KV prefixes based on token prefix equality. The invariant system prompt and tool schemas form a 100% static prefix. Dynamic state (trigger events, UTC timestamp, and rolling episodic memories) is appended to the user turn at the tail.
3. **Mechanical Runner Guardrails (Never Prompt-Only)**:
   - **Max Steps**: Hard ceiling on turns per cycle (`AGENT_MAX_STEPS = 12`).
   - **Wall-Clock Timeout**: Hard per-turn LLM timeout (`AGENT_REQUEST_TIMEOUT_MS = 120000`).
   - **Duplicate Tool-Call Doom Loop**: Tracks identical `(tool, args)` invocations across a 5-minute rolling window; aborts the cycle at 4 repetitions.
   - **Order Doom Loop**: Detects identical order specifications within 10 minutes and rejects repeats.
   - **Side-Effect Gating**: All order execution is gated by the deterministic `RiskManager` circuit breaker (daily loss limits trigger immediate halts).

## Quick start

```bash
npm install
cp .env.example .env        # adjust model / symbols / risk caps

# sanity check (no Ollama needed): 38 checks incl. live WS
npm run smoke

# agent-loop integration test (mock Ollama, live market data)
npx tsx src/agent-mock.ts

# run the trader (requires a local Ollama serving a tool-calling model)
npm start

# single startup cycle then exit
npm start -- --once
```

### Requirements

- Node.js ≥ 20
- [Ollama](https://ollama.com) serving a **tool-calling** model (e.g. `qwen2.5:7b`, `llama3.1:8b`, or the default `openbmb/minicpm5-2b`). Test with: `ollama pull qwen2.5:7b && OLLAMA_MODEL=qwen2.5:7b npm start`
- The Rails `paper_exchange` service running on `PAPER_EXCHANGE_URL` (default `http://127.0.0.1:3100/api/v1`). It owns account state, persistence and the single-writer lease; this repo is only the client.
- Network access to `fstream.binance.com` (WS) and `fapi.binance.com` (REST fallback)

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama server |
| `OLLAMA_MODEL` | `openbmb/minicpm5-2b` | Any tool-calling model |
| `AGENT_MAX_STEPS` | `12` | Tool-calling steps per cycle |
| `AGENT_NUM_CTX` | `8192` | Model context window |
| `SYMBOLS` | `BTCUSDT,ETHUSDT,SOLUSDT` | USDT-M universe |
| `INITIAL_BALANCE` | `10000` | Paper wallet (USDT) |
| `MAX_LEVERAGE` | `3` | Hard cap |
| `MAX_POSITION_NOTIONAL_PCT` | `25` | % of equity per symbol |
| `MAX_PORTFOLIO_NOTIONAL_PCT` | `80` | % of equity total |
| `MAX_RISK_PER_TRADE_PCT` | `1.5` | stop distance × qty, % of equity |
| `DAILY_LOSS_LIMIT_PCT` | `5` | trips the trading halt |
| `MAKER_FEE_BPS` / `TAKER_FEE_BPS` | `2` / `5` | Paper fees |
| `KLINE_TRIGGER_INTERVALS` | `5m,15m` | Candle-close wake-ups |
| `LIQUIDATION_NOTIONAL_USD` | `500000` | Big-liq wake-up threshold |
| `CYCLE_MINUTES` | `15` | Safety-net cycle |
| `COOLDOWN_SECONDS` | `45` | Min gap between cycles |
| `REST_TIMEOUT_MS` | `8000` | Hard cap on any REST fallback call |
| `AGENT_REQUEST_TIMEOUT_MS` | `120000` | Hard cap on one LLM request |
| `PAPER_EXCHANGE_URL` | `http://127.0.0.1:3100/api/v1` | Rails paper_exchange base URL |
| `PAPER_EXCHANGE_ACCOUNT_ID` | `usdtm-agent` | Paper account this runner trades |
| `PAPER_EXCHANGE_API_KEY` | hardcoded fallback in `config.ts` | Sent as `X-API-Key`. Known issue: the key is in source and git history; move it to `.env` and rotate it |

## Agent tools (17)

**Market data (read, live):** `get_live_price`, `get_24h_ticker`, `get_klines`, `get_indicators` (EMA/RSI/ATR/MACD/Bollinger/VWAP/trend classification), `get_order_book` (live L2), `get_mark_price_funding`, `get_funding_history`, `get_open_interest` (+ history), `get_long_short_ratio` (global/top-trader/taker), `get_recent_liquidations`, `get_market_overview`, `get_symbol_rules`.

**Account (read):** `get_portfolio` (equity, margin, positions, liq prices), `get_recent_orders`.

**Trading (write, risk-gated):** `set_plan` (takes one `plan` string, min 10 chars), `place_market_order`, `close_position`. `place_market_order` is rejected until `set_plan` succeeds in the current cycle; `close_position` is not gated, so the agent can always exit.

## Paper exchange semantics

- One-way positions per symbol (LONG or SHORT), leverage, isolated-style margin.
- Fills at the live WS mid price; taker fee on notional (bps configurable).
- **Funding** settled every 8h from the live WS funding rate (LONG pays positive funding).
- **Liquidation** when mark price crosses the estimated liquidation price (maintenance-margin approximation); position force-closed, PnL realized.
- Account, positions, orders (with the agent's stated reason) and funding payments are persisted by the Rails `paper_exchange` service, so state survives restarts. The equity curve is kept in memory by the runner and is lost on restart.
- The daily-loss baseline is re-anchored to synced equity at each process start (the server does not expose day-start equity). A restart after a loss therefore resets the breaker's reference point, and any manual halt is also lost on restart.

## Risk layer (hard limits)

`checkOrder` runs 10 checks: trading halt, symbol universe, sanity, leverage cap, per-position notional, portfolio notional, margin availability (incl. fee), per-trade risk cap (when stop distance stated), doom-loop, order rate limit. Orders that reduce an existing position (opposite side, qty ≤ position size) skip the exposure and margin checks (position/portfolio notional, margin availability, per-trade risk), so an account over its caps can always de-risk; halt, universe, sanity, doom-loop and rate limit still apply. The **daily-loss circuit breaker** compares equity to day-start equity each cycle and halts all trading at the configured limit. Halts clear only via `RiskManager.setHalt(false, '', /* ack */ true)` — a deliberate act.

## Logging & observability

Console log (emoji-prefixed) covers: hub lifecycle, every cycle trigger + result (steps, tool calls, orders, stop reason, summary), paper fills, funding settlements, paper liquidations, and graceful-shutdown equity. The equity curve is held in memory by the runner (`PaperExchange.getEquityCurve`).

## Project layout

```
src/
  config.ts            env parsing, all tunables
  types.ts             shared domain types (USDT-M only)
  market-data-hub.ts   WS-first data layer + cached REST fallbacks
  paper-exchange.ts    HTTP client for the Rails paper_exchange service (lease, orders, funding)
  indicators.ts        RSI / EMA / ATR / MACD / Bollinger / VWAP
  risk.ts              hard risk layer + circuit breakers
  tools.ts             17 agent tools + zod→JSON-Schema
  agent.ts             ReAct loop, memory, doom-loop detection
  index.ts             event-driven runner (triggers, maintenance, shutdown)
  smoke.ts             38-check smoke test (no LLM needed)
  agent-mock.ts        agent-loop integration test (mock Ollama)
```

## Notes & limitations

- Paper fills use the WS top-of-book mid; there is no queueing/slippage model (fills happen in the Rails `paper_exchange` service, not in this repo).
- Tool arguments are validated with the tool's Zod schema before execution; invalid arguments are returned to the model as an error.
- An order with no `stop_distance_pct` is allowed and skips the per-trade risk cap. That is current behavior; requiring a stop would be a policy change.
- `close_position` is not checked by `RiskManager` and is still allowed while the trading halt is active.
- The liquidation price is an approximation using a flat maintenance-margin rate, not Binance's tiered MMR tables.
- Only USDT-M perpetuals are supported by design; no spot, COIN-M, or options.
- The system is intentionally **read-only toward Binance**: it subscribes to public streams and calls public REST endpoints only. It cannot touch a real account even if misconfigured.
