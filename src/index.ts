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

  // Lean menu: feed, sweep, bids, listings, watches, inventory, wallet, help.
  // Keep in sync with renderHelpMenu + registered bot.command()s below.
  // Ascend-only surface. The Kalos/NFT commands still exist in handlers.ts but
  // are deliberately NOT listed here — frozen, not deleted.
  const kiwiCommands = [
    { command: "start", description: "Open Zensweep — Ascend trading on Elysium" },
    { command: "launches", description: "New Ascend launches" },
    { command: "token", description: "Check a CA — pool, fee, age, quote" },
    { command: "buy", description: "Buy — /buy [CA] [HYPE]" },
    { command: "sell", description: "Sell — /sell [CA] [amount|max]" },
    { command: "wallet", description: "HYPE + WHYPE balances" },
    { command: "wrap", description: "Wrap HYPE → WHYPE — /wrap [amount|max]" },
    { command: "unwrap", description: "Unwrap WHYPE → HYPE — /unwrap [amount|max]" },
    { command: "export", description: "Export your private key" },
    { command: "import", description: "Import an existing wallet" },
    { command: "support", description: "Help / support chat" },
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