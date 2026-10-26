import { InlineKeyboard } from "grammy";

/**
 * Inline keyboards — lean bot: collections, sweep, bids, watches, inventory, wallet, help.
 */

export const mainKeyboard = new InlineKeyboard()
  .text("🖼️ Collections", "menu_collections")
  .text("🖼️ My NFTs", "menu_nfts").row()
  .text("👀 Watchlist", "menu_watchlist")
  .text("🔔 Alerts", "menu_alerts").row()
  .text("💰 Wallet", "menu_wallet")
  .text("ℹ️ Help", "menu_help");

export const walletKeyboard = new InlineKeyboard()
  .text("🔄 Refresh", "wallet_refresh")
  .text("💰 Wrap HYPE→WHYPE", "wallet_wrap").row()
  .text("📤 Withdraw", "wallet_withdraw")
  .text("💧 Get Testnet HYPE", "wallet_faucet").row()
  .text("💎 Unwrap WHYPE→HYPE", "wallet_unwrap")
  .text("🔑 Export Key", "wallet_export").row()
  .text("📥 Import Wallet", "wallet_import")
  .text("🔄 Change Wallet", "wallet_change").row()
  .text("🔙 Main Menu", "menu_main");

export const noWalletKeyboard = new InlineKeyboard()
  .text("➕ Create Wallet", "wallet_generate")
  .text("📥 Import Wallet", "wallet_import")
  .row()
  .text("ℹ️ Help", "menu_help");

export function makeNftCardKeyboard(address: string, explorerUrl?: string, floorHype?: string): InlineKeyboard {
  const k = new InlineKeyboard();
  k.text("🛒 Buy", `kalos_buy_${address}`)
   .text("🤝 Make Offer", `kalos_offer_${address}`).row();
  if (explorerUrl) {
    k.url("🔍 Explorer", explorerUrl);
  }
  k.url("🌐 Kalos", "https://kalos.fun");
  k.text("👀 Watch", "watch_add_" + address).row();
  k.text("🏷️ Collections", "menu_collections").text("🔙 Main Menu", "menu_main");
  return k;
}

export function makeCollectionKeyboard(contract: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text("🧹 Sweep Floor", `kalos_sweep_${contract}`).row()
    .text("🛒 Buy", `kalos_buy_${contract}`)
    .text("🤝 Make Offer", `kalos_offer_${contract}`).row()
    .url("🌐 View on Kalos", "https://kalos.fun")
    .text("👀 Watch", `watch_add_${contract}`).row()
    .text("🏷️ All Collections", "menu_collections")
    .text("🔙 Main Menu", "menu_main");
  return kb;
}

