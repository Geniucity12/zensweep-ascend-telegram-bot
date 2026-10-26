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

  // Lean menu: 7 things done well — feed, sweep, bids, watches, inventory, wallet, help.
  const kiwiCommands = [
    { command: "start", description: "Open Zensweep — Kalos NFTs on Elysium" },
    { command: "collections", description: "Live Kalos NFT collections & floors" },
    { command: "sweep", description: "Sweep floor — cheapest live listing" },
    { command: "offer", description: "Place a bid — /offer [col] [id] [price]" },
    { command: "accept", description: "Accept a bid — /accept [col] [id] [bidder]" },
    { command: "nftlist", description: "List your NFT — /nftlist [col] [id] [price]" },
    { command: "nftdelist", description: "Cancel listing — /nftdelist [col] [id]" },
    { command: "watch", description: "Track a collection — /watch 0x…" },
    { command: "watchlist", description: "Your tracked collections" },
    { command: "alerts", description: "Floor & deployment pings" },
    { command: "nfts", description: "Your NFTs & live offers" },
    { command: "wallet", description: "HYPE + WHYPE balances & wrap" },
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