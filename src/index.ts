import { Bot } from "grammy";
import { TELEGRAM_BOT_TOKEN, KEY_ENCRYPTION_SECRET } from "./config";
import { registerHandlers } from "./bot/handlers";
import { startAlertScheduler } from "./bot/alerts";

/**
 * Zensweep — Ascend & Elysium Launch Assistant.
 *
 * Bootstraps the grammY bot, registers all command/callback handlers, and
 * starts the background alert scheduler. Requires TELEGRAM_BOT_TOKEN in the
 * environment. KEY_ENCRYPTION_SECRET is required before any custodial wallet
 * can be created (it encrypts private keys at rest).
 */
async function main() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error("Missing TELEGRAM_BOT_TOKEN. Set it in your environment or .env file.");
    process.exit(1);
  }
  if (!KEY_ENCRYPTION_SECRET) {
    console.warn(
      "WARNING: KEY_ENCRYPTION_SECRET is not set. Wallet creation will fail until it is provided."
    );
  }

  const bot = new Bot(TELEGRAM_BOT_TOKEN);

  registerHandlers(bot);

  bot.catch((err) => {
    console.error("Bot error:", err.error);
  });

  // Sync the Telegram autocomplete menu — Zensweep-native, not a copy. Kept lean: hunter feed + Zensweep card + your settings.
  const kiwiCommands = [
    { command: "start", description: "Open Zensweep dashboard" },
    { command: "wallet", description: "Your HYPE wallet & withdraw" },
    { command: "launch", description: "Tracked Ascend launches" },
    { command: "mints", description: "Mint-window countdowns" },
    { command: "elysium", description: "Live Elysium chain (99801)" },
    { command: "deployments", description: "Fresh deployments — hunter feed" },
    { command: "watch", description: "Track a wallet — 0x... [label]" },
    { command: "watchlist", description: "Your tracked addresses" },
    { command: "buy", description: "Buy a token — 0x... amount" },
    { command: "sell", description: "Sell a token — 0x... 25/50/100" },
    { command: "safety", description: "Zensweep Safety Engine check" },
    { command: "portfolio", description: "What you hold — PnL & share card" },
    { command: "slippage", description: "Your price tolerance (1–50%)" },
    { command: "collections", description: "Live Kalos NFT collections" },
    { command: "nfts", description: "Your Elysium NFT inventory" },
    { command: "mint", description: "Mint an NFT — /mint [contract]" },
    { command: "nftbuy", description: "Buy NFT on Kalos — /nftbuy [col] [id]" },
    { command: "nftlist", description: "List NFT on Kalos — /nftlist [col] [id] [price]" },
    { command: "nftdelist", description: "Cancel Kalos listing — /nftdelist [col] [id]" },
    { command: "nftoffer", description: "Offer on Kalos — /nftoffer [col] [id] [price]" },
    { command: "nftaccept", description: "Accept offer on Kalos — /nftaccept [col] [id] [bidder]" },
    { command: "alerts", description: "Deployment & launch alerts" },
    { command: "status", description: "Bot & chain status" },
    { command: "help", description: "How Zensweep works" },
  ];

  bot.start({
    onStart: async (info) => {
      console.log(`Zensweep bot started as @${info.username}`);
      try {
        await bot.api.setMyCommands(kiwiCommands);
        console.log("Telegram command menu synced");
      } catch (e) {
        console.warn("Could not sync command menu:", e);
      }
      startAlertScheduler(bot);
    },
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});