# Zensweep

Telegram bot for the Elysium network — launch tracking, deployment discovery, wallet monitoring, paper token trading, and live Kalos NFT trading.

Live bot: [@zensweep_bot](https://t.me/zensweep_bot) · Elysium Testnet (Chain ID 99801)

## Overview

Zensweep brings Elysium on-chain activity into Telegram. It scans for newly deployed contracts, tracks mint windows, monitors watched wallets, checks token safety before trading, paper-trades tokens, and trades NFTs live on the Kalos marketplace — all without leaving a chat.

Built for [Elysium by Kinetiq](https://elysium.kinetiq.xyz), an Arbitrum Orbit L2 settling to HyperEVM with HYPE as its native gas token.

## Features

**Elysium Native**
- Live chain health (/elysium) — current block, gas price, and measured block time.
- Deployment discovery (/deployments) — scans recent blocks for new contracts.
- Launch board (/launch) — curated Ascend / Elysium launches with status and links.
- Mint windows (/mints) — countdown timers with DM alerts.
- Wallet watch (/watch, /watchlist) — track any EVM address and get notified on balance changes.

**Trading & Safety**
- Token card — paste any 0x... address for safety analysis and Buy/Sell buttons (paper trades on testnet until a DEX router is live).
- Safety checks (/safety 0x...) — honeypot, owner/mint, blacklist, proxy detection (scored 0–100).
- HYPE-native trading — Buy 0.1/0.5/1 HYPE and Sell 25/50/100% (paper mode on testnet; real swaps once ELYSIUM_ROUTER_ADDRESS is set).
- Portfolio (/portfolio) — realized PnL, win rate, per-token balances, shareable card.

**Kalos NFT Marketplace (live on-chain)**
- Collections (/collections) — every live Kalos collection discovered on-chain with verified floors (cheapest live ask, checked via getListing + ownerOf + expiry). No hardcoding.
- Sweep floor (/sweep 0x... [count] [maxHYPE]) — finds the cheapest verified live listings and buys up to 10 in one batch transaction.
- Buy (/nftbuy [collection] [id]) — buy any listed NFT with stale-listing detection and 1-tap confirm.
- List (/nftlist [collection] [id] [price]) — list your NFT on Kalos (auto-approves the marketplace).
- Delist (/nftdelist [collection] [id]) — cancel your Kalos listing on-chain.
- Offers (/nftoffer, /nftaccept) — bid on any token and accept bids as a seller.
- Inventory (/nfts) — your Elysium NFTs plus active Kalos listings.

**Wallet**
- Custodial wallet per Telegram user (/wallet). Keys encrypted at rest (AES-256-GCM).
- Balance refresh, chain switching, full withdrawal, and private-key export (/export).

**Secondary Markets**
- OpenSea-backed tooling (/markets) — archived in Elysium-only mode. Use /collections for live Kalos data instead. Requires OPENSEA_API_KEY.

## Quick Start

```bash
# 1. Clone and install
git clone <your-repo>
cd zensweep
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env and set TELEGRAM_BOT_TOKEN and KEY_ENCRYPTION_SECRET

# 3. Run
npm run build && npm start   # production
npm run dev                  # development (ts-node)
```

## Configuration

All configuration is via environment variables (see .env.example):

| Variable | Required | Description |
|----------|----------|-------------|
| TELEGRAM_BOT_TOKEN | Yes | Telegram bot token from @BotFather |
| KEY_ENCRYPTION_SECRET | Yes | Hex secret for AES-256-GCM key encryption |
| ELYSIUM_RPC_URL | No | Elysium RPC endpoint (default: https://testnet-rpc.elysium.kinetiq.xyz) |
| ELYSIUM_CHAIN_ID | No | Elysium chain ID (default: 99801) |
| ELYSIUM_ROUTER_ADDRESS | No | Uniswap V2 router on Elysium. When unset, trading runs in paper mode |
| ELYSIUM_WHYPE_ADDRESS | No | Wrapped HYPE address. If empty, resolved via router.WETH() |
| FEE_PERCENTAGE | No | Fee fraction, e.g. 0.025 = 2.5% |
| FEE_RECIPIENT_WALLET | No | Address that receives fees. If empty, trades are fee-free |
| KALOS_MARKETPLACE_ADDRESS | No | Kalos marketplace contract (default: 0x0ff8b7afc288ac42f82320f54a49c400f233bf07) |
| KALOS_API_URL | No | Reserved for a Kalos index API (currently unused — all reads are on-chain) |
| ZENSWEEP_LAUNCH_API_URL | No | Remote JSON feed for the launch board (alias: `KIWI_LAUNCH_API_URL` kept) |
| ALERT_POLL_INTERVAL_MS | No | Alert scheduler interval in ms (default: 300000) |
| FAUCET_PRIVATE_KEY | No | Testnet HYPE drip key. If empty, the bot links the Elysium faucet instead |
| OPENSEA_API_KEY | No | Legacy, unused in Elysium-only mode |

## Usage

### Commands

| Command | Description |
|---------|-------------|
| /start | Open the Zensweep dashboard |
| /wallet | View address, balance, and wallet actions |
| /launch | Browse tracked launches |
| /mints | View mint-window countdowns |
| /elysium | Live Elysium chain health |
| /deployments | Recent on-chain deployments |
| /watch 0x... [label] | Track a wallet or contract |
| /watchlist | List and manage watched addresses |
| /safety 0x... | Safety check for a token |
| /portfolio | Portfolio, PnL, and share card |
| /alerts | Active launch alerts |
| /status | Bot and data-source status |
| /collections | Live Kalos NFT collections with verified floors |
| /sweep | Sweep floor — cheapest live listing + 1-tap Buy |
| /nfts | Your Elysium NFT inventory + active Kalos listings |
| /mint | Mint an NFT — /mint [contract] |
| /nftbuy | Buy NFT on Kalos — /nftbuy [collection] [id] |
| /nftlist | List NFT on Kalos — /nftlist [collection] [id] [price] |
| /nftdelist | Cancel Kalos listing — /nftdelist [collection] [id] |
| /nftoffer | Offer on Kalos — /nftoffer [collection] [id] [price] |
| /nftaccept | Accept offer on Kalos — /nftaccept [collection] [id] [bidder] |
| /markets | Archived in Elysium-only mode (use /collections) |
| /help | Command reference |

Any bare 0x... address pasted in chat opens the Token Card directly (ERC-20 safety + paper Buy/Sell, or NFT floor + Kalos actions for collections).

### Workflows

**Tokens (paper on testnet):**
1. Send /start and create a wallet.
2. Browse /deployments or /launch to find new projects.
3. Paste a token address, review the safety score, then Buy or Sell from the card.
4. Check /portfolio for PnL and share your card.
5. Watch team or treasury wallets with /watch 0x... Treasury to get notified on movement.

**NFTs (live on Kalos):**
1. Browse /collections for live collections with verified floors.
2. Tap 🧹 Sweep on any collection, or run /sweep 0x... [count] [maxHYPE].
3. Confirm the 1-tap Buy — the NFT lands in your custodial wallet.
4. List it back with /nftlist, track it in /nfts, cancel anytime with /nftdelist.

### Paper Trading on Testnet

When ELYSIUM_ROUTER_ADDRESS is not set (the current state on Elysium testnet, where no canonical DEX router is deployed), buys and sells are recorded as synthetic paper positions. This makes the full buy -> sell -> portfolio workflow testable without on-chain liquidity. Set the router address on mainnet and the same code performs real swaps with no code change.

## Architecture

```
src/
  index.ts              # Bot bootstrap and Telegram command sync
  config.ts             # Chain configs, fee settings, env parsing
  bot/
    handlers.ts         # All command and callback handlers
    keyboards.ts        # Inline keyboards
    alerts.ts           # Background scheduler (deployments, mints, watches)
  engine/
    elysium.ts          # Chain health, deployment scan, wallet activity
    safety.ts           # Token safety analysis
    trading.ts          # HYPE-native router trading (paper mode until router set)
    kalos.ts            # Kalos NFT marketplace — discovery, verified floors, buy/sell/list
    marketplace.ts      # Collection stats + NFT inventory (Kalos-enriched)
    opensea.ts          # OpenSea API client (legacy, unused in Elysium-only mode)
    minter.ts           # Contract mint execution
  wallet/
    manager.ts          # Custodial wallet, encryption, balances
  db/
    index.ts            # JSON-file persistence (swappable to Postgres)
  data/
    launches.ts         # Launch board and mint-window logic
```

## Development

```bash
npm run build        # compile TypeScript
npm run typecheck    # type-check without emitting
npm run dev          # run with ts-node and live reload
```

## Deployment

The bot uses long polling — no webhook or public port required.

1. Push to GitHub (.env is gitignored).
2. Create a new Railway project from the repository.
3. Add environment variables in the dashboard.
4. Set the start command to `npm run build && npm start`.
5. Deploy — logs should show `Zensweep bot started as @zensweep_bot` and `Telegram command menu synced`.

## Security

- Private keys are stored encrypted at rest (AES-256-GCM) and never sent through Telegram except via the explicit /export command, which warns the user to delete the message after importing.
- Changing KEY_ENCRYPTION_SECRET after wallets are created will make existing keys undecryptable.
- Zensweep never holds or transfers funds outside of explicit user actions (Buy, Sell, Mint, Withdraw, NFT Buy/List/Delist/Offer).