# STI — Solana Token Intelligence

On-chain intelligence toolkit for Solana tokens — a 12-phase analysis pipeline with an 18-rule evaluation engine, deterministic scoring, and honest reporting of data gaps.

## What it does

Given a Solana token mint address, STI runs a 12-phase pipeline:

1. **Token discovery** — metadata, program, decimals
2. **Authority & supply** — mint/freeze authority, supply structure
3. **Holder discovery** — token accounts → unique holders
4. **Holder concentration** — distribution, liquidity pools, CEX-wallet filtering
5. **Creator / dev analysis** — deployer attribution and activity
6. **Fee & trading economics** — fee model, protocol state
7. **Database wallet matching** — overlap with your curated wallet list
8. **Wallet behavior timeline** — per-wallet on-chain history
9. **Risk engine** — 18 deterministic rules (SPR / CTR / LTR / TCR)
10. **Scoring engine** — weighted score 0–100 with confidence
11. **Final report** — JSON summary incl. wallet-conviction adjustments
12. **Early signals** — deterministic rug checklist (`AVOID` / `CAUTION` / `WATCH` / `NEUTRAL_OK`)

Optional collectors (opt-in, heavy on RPC usage):

- **14 — Funding graph**: pre-acquisition funders per wallet (unlocks CTR-01/CTR-02)
- **15 — Market volume**: market-wide buy/sell volume per wallet (unlocks the 5 market rules)

A core design principle: **when data is missing, rate-limited, or insufficient, the tool reports `INSUFFICIENT_DATA` instead of inventing a signal.** Scores never benefit from absent data.

## Requirements

- Node.js 18+ (no external npm dependencies)
- A [Helius](https://www.helius.dev/) API key (free tier works; the default request pacing targets ~9 req/s — see `rpc_throttle` in the config)

## Setup

```sh
# 1. Create your config from the example (never commit the real one)
cp Config/config.json.example Config/config.json

# 2. Put your Helius API key in (or run: node Script/set_key.js)
#    Edit Config/config.json -> helius.api_key

# 3. Fill in any missing config sections (idempotent, never touches your API key)
node merge_config.js

# 4. Start the interactive menu
node main.js
```

Enter a token mint (contract address) when asked, then pick a menu item. `00` runs phases 1–12 end to end; `13` generates the HTML report; `14`/`15` are the optional collectors (run `00` → `14` → `15` → `09` → `13` if you need everything).

Results are written to `Output/<mint>/` as JSON plus `report.html`.

## Configuration notes

- `Config/config.json` is yours alone — it is git-ignored. Only `config.json.example` ships with the repo.
- `rpc_throttle.min_interval_ms` (default `110` ≈ 9 req/s): lower it for a faster paid key, raise it if you still hit 429s.
- `market_volume` / `funding_graph` / `phase8` sections tune the optional collectors (concurrency, delays, caps).
- `evaluation_guards.liquidity_credibility_ratio`: if the observed DEX pool is smaller than 1% of observed sell volume, liquidity-based rules honestly return `INSUFFICIENT_DATA`.
- `Data/database-wallet.json`: your curated wallet list — see "Wallet database (manual)" below.
- `Data/cex_registry.json`: known CEX/service addresses, excluded from holder-concentration and top buyer/seller rankings (totals unchanged).

## Wallet database (manual)

Phases 7 and 11 can cross-reference your own curated wallet list. The list is
personal, so the repo ships only a format example — add your wallets manually:

1. Copy the example (or run `node merge_config.js`, which creates an empty
   `Data/database-wallet.json` for you):
   ```sh
   cp Data/database-wallet.example.json Data/database-wallet.json
   ```
2. Edit `Data/database-wallet.json` — a top-level JSON array:
   ```json
   [
     { "address": "WALLET_ADDRESS", "name": "My label", "groups": ["early"], "emoji": "💚" }
   ]
   ```
   - `address` (required): the Solana wallet address
   - `name` (optional): your own label
   - `groups` (optional): role labels — `early`, `Whale`, `Dev`, `Rug/Kol`.
     Role weights: `early` 2, `Whale` 3, `Dev` −1, `Rug/Kol` −2; wallets
     without a group fall back to `DEFAULT` (weight 1)
   - `emoji` (optional): conviction modifier — `🚫` = −10, `🚩` = −5,
     `💚` = +2, `⭐` = +5. Stacks with the role weight
     (e.g. `Dev` + `🚫` = −11)

With fewer than 3 matching wallets for a token, the conviction adjustment is
skipped honestly (`INSUFFICIENT_DATA`) instead of being treated as zero.

## Rate limits & honesty

- Every phase shares one global request throttle per process, with exponential backoff + jitter and `Retry-After` support on 429/5xx.
- If Phase 8 is heavily rate-limited, **stop and wait** — do not force the run. Missing data must never be read as a positive signal.
- Market-volume files marked `PARTIAL` cover the most recent transactions only (recency-biased window); the 5 market rules then evaluate on the observed window with the scope disclosed, or stay `INSUFFICIENT_DATA` below 500 parsed transactions.

## Disclaimer

This tool is for research and education. It is not financial advice. On-chain heuristics (funder attribution, buy/sell classification) are documented approximations, not ground truth. Always do your own research.
