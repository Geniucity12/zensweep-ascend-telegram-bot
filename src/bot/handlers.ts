import { Bot, Context, InlineKeyboard } from "grammy";
import { dbService, type TaskRow } from "../db";
import { kiwiLaunches, fetchLaunchProjects, buildLaunchCard, getLaunchStatusLabel, mintWindowLine, getMintWindowState, formatMintCountdown } from "../data/launches";
import { walletManager } from "../wallet/manager";
import { SUPPORTED_CHAINS, getChainConfig, FEE_PERCENTAGE, FEE_RECIPIENT_WALLET, ELYSIUM, DEFAULT_CHAIN_KEY, ZENSWEEP_LAUNCH_API_URL } from "../config";
import { marketplaceService } from "../engine/marketplace";
import { minterService } from "../engine/minter";
import { openSeaService } from "../engine/opensea";
import { getChainHealth, scanRecentDeployments, getDeploymentMeta, getWalletActivity } from "../engine/elysium";
import { analyzeToken, formatSafetyReport, formatSafetyInline } from "../engine/safety";
import { tradingService } from "../engine/trading";
import {
  mainKeyboard,
  marketsKeyboard,
  walletKeyboard,
  noWalletKeyboard,
  makeChainKeyboard,
  makeTaskKeyboard,
  makeCollectionKeyboard,
  makePortfolioKeyboard,
  makeTokenCardKeyboard,
  makeSafetyKeyboard,
  makeSlippageKeyboard,
  makeNftCardKeyboard,
} from "./keyboards";
import { formatEther, parseEther, parseUnits, type Address, type Hex } from "viem";

// -- Zensweep theme: green=good, yellow=caution, red=bad --
const C_GREEN = "🟢";
const C_YELLOW = "🟡";
const C_RED = "🔴";
const C_YBOX = "🟨";
function formatAge(s: number | null): string {
  if (s == null) return "—";
  if (s < 60) return Math.max(1, Math.round(s)) + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return (s / 3600).toFixed(1) + "h ago";
  return (s / 86400).toFixed(1) + "d ago";
}
function shortAddr(a: string): string { return a.slice(0, 6) + "…" + a.slice(-4); }

// In-memory conversation state for multi-step prompts
const userStates: Record<number, { step: string; data?: any }> = {};

export function registerHandlers(bot: Bot) {
  bot.command("start", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = dbService.getUser(userId);
    const chain = user?.selected_chain || DEFAULT_CHAIN_KEY;
    const chainConfig = getChainConfig(chain);

    let message = `🟢 *Zensweep — Ascend & Elysium Launch Assistant*\n\n`;
    message += `🌐 *Active Chain:* \`${chainConfig.name}\`\n`;
    message += `🧭 *Focus:* live Elysium launch tracking, mint-window countdowns, on-chain deployment and wallet monitoring for Ascend launches.\n\n`;

    if (user) {
      const balance = await walletManager.getBalance(user.wallet_address as Address, chain, false);
      message += `💳 *Wallet:* \`${user.wallet_address}\`\n`;
      message += `💰 *Balance:* \`${balance.eth} ${balance.symbol}\`\n\n`;
      message += `Use Zensweep to monitor launches, stay on top of launch status, and manage your wallet.`;
      await ctx.reply(message, { parse_mode: "Markdown", reply_markup: mainKeyboard });
    } else {
      message += `🔴 *No wallet connected yet.*\n\nCreate a server-managed wallet to get started. Your signing key stays on-host and never leaves the bot server.`;
      await ctx.reply(message, { parse_mode: "Markdown", reply_markup: noWalletKeyboard });
    }
  });

  // Basic Commands
  bot.command("wallet", async (ctx) => {
    await renderWalletMenu(ctx);
  });

  bot.command("launch", async (ctx) => {
    await renderLaunchMenu(ctx);
  });

  bot.command("launches", async (ctx) => {
    await renderLaunchMenu(ctx);
  });

  // Projects is now primary
  bot.command("projects", async (ctx) => {
    await renderLaunchMenu(ctx);
  });
  bot.command("project", async (ctx) => {
    await renderLaunchMenu(ctx);
  });

  bot.command("status", async (ctx) => {
    await renderStatusMenu(ctx);
  });

  bot.command("alerts", async (ctx) => {
    await renderAlertsMenu(ctx);
  });

  bot.command("tasks", async (ctx) => {
    await renderTasksMenu(ctx);
  });

  bot.command("chains", async (ctx) => {
    await renderChainsMenu(ctx);
  });

  bot.command("floor", async (ctx) => {
    await promptFloorCheck(ctx);
  });

  bot.command("fp", async (ctx) => {
    await promptFloorCheck(ctx);
  });

  bot.command("nfts", async (ctx) => {
    await renderNFTsMenu(ctx);
  });

  bot.command("mint", async (ctx) => {
    await promptMint(ctx);
  });

  bot.command("list", async (ctx) => {
    await promptListNFT(ctx);
  });

  bot.command("offer", async (ctx) => {
    await promptAcceptOffer(ctx);
  });

  bot.command("delist", async (ctx) => {
    await renderListingsMenu(ctx);
  });

  // Elysium-native commands (the new center of gravity)
  bot.command("mints", async (ctx) => {
    await renderMintsMenu(ctx);
  });

  bot.command("elysium", async (ctx) => {
    await renderElysiumMenu(ctx);
  });

  bot.command("deployments", async (ctx) => {
    await renderDeploymentsMenu(ctx);
  });

  bot.command("deploys", async (ctx) => {
    await renderDeploymentsMenu(ctx);
  });

  bot.command("watch", async (ctx) => {
    const arg = ctx.message?.text?.split(/\s+/).slice(1).join(" ") ?? "";
    await promptWatchAddress(ctx, arg);
  });

  bot.command("watchlist", async (ctx) => {
    await renderWatchlistMenu(ctx);
  });

  bot.command("mutedeploys", async (ctx) => {
    const uid = ctx.from?.id; if (!uid) return;
    dbService.setDeployAlertsEnabled(uid, false);
    await ctx.reply("🔕 Deployment alerts muted. Use /unmutedeploys to re-enable.", { parse_mode: "Markdown", reply_markup: mainKeyboard });
  });

  bot.command("unmutedeploys", async (ctx) => {
    const uid = ctx.from?.id; if (!uid) return;
    dbService.setDeployAlertsEnabled(uid, true);
    await ctx.reply("🔔 Deployment alerts unmuted. Check /deployments.", { parse_mode: "Markdown", reply_markup: mainKeyboard });
  });

  bot.command("unwatch", async (ctx) => {
    const arg = ctx.message?.text?.split(/\s+/).slice(1).join(" ") ?? "";
    await handleUnwatch(ctx, arg);
  });

  bot.command("track", async (ctx) => {
    await renderWatchlistMenu(ctx);
  });

  // Archived: cross-chain secondary markets (OpenSea) — Elysium-only mode.
  bot.command("markets", async (ctx) => {
    await ctx.reply("Archived: cross-chain markets (OpenSea-backed) are disabled in Elysium-only mode.\nUse `0x…` paste → Token Card, /launch, /deployments, or watch Kalos (https://www.kalos.fun) once its contracts are set.", { parse_mode: "Markdown", reply_markup: mainKeyboard });
  });

  bot.command("portfolio", async (ctx) => {
    await renderPortfolioMenu(ctx);
  });

  bot.command("pnl", async (ctx) => {
    await renderPortfolioMenu(ctx);
  });

  bot.command("export", async (ctx) => {
    await handleExportKey(ctx);
  });
  bot.command("import", async (ctx) => {
    const arg = ctx.message?.text?.split(/\s+/)[1] ?? "";
    if (!arg) { await ctx.reply("Usage: `/import 0x...privateKey`", { parse_mode: "Markdown" }); return; }
    await handleWalletImport(ctx, arg);
  });
  bot.command("wallet-change", async (ctx) => { await promptWalletChange(ctx); });

  bot.command("token", async (ctx) => {
    const arg = ctx.message?.text?.split(/\s+/)[1] ?? "";
    if (/^0x[a-fA-F0-9]{40}$/.test(arg)) await renderTokenCard(ctx, arg as Address);
    else await ctx.reply("Usage: `/token <0x...>` or just paste a token address in chat.", { parse_mode: "Markdown" });
  });

  bot.command("buy", async (ctx) => {
    const parts = ctx.message?.text?.split(/\s+/) ?? [];
    const token = parts[1];
    const amt = parts[2] ?? "0.1";
    if (!/^0x[a-fA-F0-9]{40}$/.test(token ?? "")) {
      await ctx.reply("Usage: `/buy <0x...Token> <amountHYPE>` e.g. `/buy 0xabc... 0.5`", { parse_mode: "Markdown" });
      return;
    }
    await handleTokenBuy(ctx, token as Address, amt);
  });

  bot.command("sell", async (ctx) => {
    const parts = ctx.message?.text?.split(/\s+/) ?? [];
    const token = parts[1];
    const pct = parts[2] ?? "100";
    if (!/^0x[a-fA-F0-9]{40}$/.test(token ?? "")) {
      await ctx.reply("Usage: `/sell <0x...Token> [25|50|100]`", { parse_mode: "Markdown" });
      return;
    }
    await handleTokenSell(ctx, token as Address, pct);
  });

  bot.command("safety", async (ctx) => {
    const arg = ctx.message?.text?.split(/\s+/)[1] ?? "";
    if (/^0x[a-fA-F0-9]{40}$/.test(arg)) await renderSafetyCard(ctx, arg as Address);
    else await renderSafetyInfo(ctx);
  });

  // Zensweep-native trader settings — not a clone. /deployments is your hunter feed, /portfolio is your hold view.
  bot.command("slippage", async (ctx) => {
    const arg = ctx.message?.text?.split(/\s+/)[1];
    const uid = ctx.from?.id;
    if (!uid) return;
    if (arg) {
      const pct = Number(arg);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 50) {
        await ctx.reply("Usage: `/slippage 1` or `/slippage 10` (percent 0.1–50).", { parse_mode: "Markdown" });
        return;
      }
      dbService.setSlippageBps(uid, Math.round(pct * 100));
      await ctx.reply(`✅ Slippage set to \`${pct}%\``, { parse_mode: "Markdown", reply_markup: makeSlippageKeyboard(dbService.getSlippageBps(uid)) });
      return;
    }
    await renderSlippageMenu(ctx);
  });

  bot.command("copy", async (ctx) => {
    await ctx.reply(
      `👥 *Zensweep Auto-Follow — V2 on the roadmap*\n\nZensweep will let you mirror up to 5 wallets on Elysium. Every mirrored buy runs the Safety Engine from *your* wallet first, and uses your slippage setting to keep frontruns harder.\n\nTestnet is paper mode until the DEX is live. For now \`/watch\` already tracks any wallet live — Auto-Follow builds on top.`,
      { parse_mode: "Markdown", reply_markup: mainKeyboard }
    );
  });

  bot.command("help", async (ctx) => {
    await renderHelpMenu(ctx);
  });

  // --- Aliases for stale Telegram autocomplete (old demo) -> current Zensweep ---
  bot.command("demowallet", async (ctx) => { await renderWalletMenu(ctx); });
  bot.command("demotokens", async (ctx) => {
    await ctx.reply("Demo tokens = paper trades now. Paste any `0x...` and tap *Buy 0.1 HYPE* - it records a synthetic position you can see in /portfolio.", { parse_mode: "Markdown", reply_markup: mainKeyboard });
  });
  bot.command("quote", async (ctx) => {
    const a = ctx.message?.text?.split(/\s+/)[1] ?? "";
    if (/^0x[a-fA-F0-9]{40}$/.test(a)) await renderSafetyCard(ctx, a as Address);
    else await ctx.reply("Usage: `/quote 0x...TokenAddress` - shows the safety card.", { parse_mode: "Markdown" });
  });
  bot.command("swap", async (ctx) => {
    const ps = ctx.message?.text?.split(/\s+/) ?? []; const tok = ps[1]; const amt = ps[2] ?? "0.1";
    if (/^0x[a-fA-F0-9]{40}$/.test(tok ?? "")) await handleTokenBuy(ctx, tok as Address, amt);
    else await ctx.reply("Usage: `/swap <0x...Token> [amountHYPE]` - or paste a `0x...` and use the Buy/Sell buttons.", { parse_mode: "Markdown" });
  });
  bot.command("price", async (ctx) => { await promptFloorCheck(ctx); });
  bot.command("chart", async (ctx) => {
    const uid = ctx.from?.id; if(!uid) return;
    const trades = dbService.getUserTrades(uid);
    if(!trades.length){ await ctx.reply("No trades yet. Buy a token, then check /portfolio.", { parse_mode: "Markdown", reply_markup: mainKeyboard }); return; }
    let m="Recent trades\n\n";
    for(const tr of trades.slice(0,8)) m += `${tr.action} \`${tr.contract.slice(0,10)}...\` ${tr.price_eth}\n`;
    await ctx.reply(m, { parse_mode: "Markdown", reply_markup: mainKeyboard });
  });
  bot.command("balance", async (ctx) => {
    const a = ctx.message?.text?.split(/\s+/)[1] ?? "";
    if (/^0x[a-fA-F0-9]{40}$/.test(a)){
      try{ const {getWalletActivity}=await import("../engine/elysium"); const ch=dbService.getUser(ctx.from?.id ?? 0)?.selected_chain||DEFAULT_CHAIN_KEY; const w=await getWalletActivity(a as Address,20,ch); await ctx.reply(`Balance of \`${a}\`: \`${w.balanceEth} ${w.symbol}\` (transfers: ${w.transfers.length})`, {parse_mode:"Markdown", reply_markup: mainKeyboard}); }catch(e){ await ctx.reply("Could not read balance: RPC error",{parse_mode:"Markdown"}); }
    } else { await renderWalletMenu(ctx); }
  });
  bot.command("lifecycle", async (ctx) => {
    await ctx.reply("Ascend lifecycle: `idea` -> `building` -> `testnet` -> `launch` (Ascend on Elysium) -> `AMM pool` -> `HyperCore spot` -> `HIP-3 perp`. See /launch and /mints.", { parse_mode: "Markdown", reply_markup: mainKeyboard });
  });
  bot.command("fees", async (ctx) => {
    await ctx.reply(`Fees: \`${(FEE_PERCENTAGE*100).toFixed(1)}%\` -> \`${FEE_RECIPIENT_WALLET||"(not set - fee-free)"}\``, { parse_mode: "Markdown", reply_markup: mainKeyboard });
  });

  // Callback Query Handlers
  bot.callbackQuery("menu_main", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = dbService.getUser(userId);
    const chain = user?.selected_chain || DEFAULT_CHAIN_KEY;
    const chainConfig = getChainConfig(chain);

    let message = `🟢 *Zensweep — Ascend & Elysium Launch Assistant*\n\n`;
    message += `🌐 *Active Chain:* \`${chainConfig.name}\`\n`;

    if (user) {
      const balance = await walletManager.getBalance(user.wallet_address as Address, chain, false);
      message += `💳 *Wallet:* \`${user.wallet_address}\`\n`;
      message += `💰 *Balance:* \`${balance.eth} ${balance.symbol}\`\n\n`;
      message += `Select an option:`;
      await ctx.editMessageText(message, { parse_mode: "Markdown", reply_markup: mainKeyboard });
    } else {
      message += `🔴 *No wallet connected.*`;
      await ctx.editMessageText(message, { parse_mode: "Markdown", reply_markup: noWalletKeyboard });
    }
  });

  bot.callbackQuery("menu_projects", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await renderLaunchMenu(ctx);
  });
  // alias for cached message buttons
  bot.callbackQuery("menu_launches", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await renderLaunchMenu(ctx);
  });

  bot.callbackQuery("menu_status", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await renderStatusMenu(ctx);
  });

  bot.callbackQuery("menu_alerts", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await renderAlertsMenu(ctx);
  });

  bot.callbackQuery("menu_wallet", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await renderWalletMenu(ctx);
  });

  bot.callbackQuery("wallet_refresh", async (ctx) => {
    ctx.answerCallbackQuery({ text: "Refreshing on-chain balance..." }).catch(() => {});
    await renderWalletMenu(ctx, true);
  });

  bot.callbackQuery("wallet_generate", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (!userId) return;

    const existingUser = dbService.getUser(userId);
    if (existingUser) {
      await ctx.reply("A wallet is already associated with your account. A new wallet would replace access to it.");
      await renderWalletMenu(ctx);
      return;
    }

    const newWallet = walletManager.createNewWallet(userId);
    const msg = `✅ *Server-managed EVM wallet created.*\n\n` +
      `💳 *Address:* \`${newWallet.address}\`\n\n` +
      `The signing key stays on the bot host and is not sent through Telegram. Only deposit funds you are comfortable keeping in a bot-managed wallet. Use Withdraw to move funds out.`;

    await ctx.reply(msg, { parse_mode: "Markdown" });
    await renderWalletMenu(ctx);
  });

  bot.callbackQuery("wallet_import", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const uid = ctx.from?.id; if (!uid) return;
    userStates[uid] = { step: "awaiting_import_key" };
    await ctx.reply(
      `🔑 *Import Wallet*\n\nSend your private key as \`0x…\` (64 hex). It will be encrypted on the bot host.\n\n*Steps:* Paste → Zensweep switches to that wallet. Delete your message after.\n\nOr reply \`/cancel\``,
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery("wallet_export", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await handleExportKey(ctx);
  });
  bot.callbackQuery("wallet_faucet", async (ctx) => {
    ctx.answerCallbackQuery({ text: "Requesting testnet HYPE..." }).catch(() => {});
    await handleFaucet(ctx);
  });
  bot.command("faucet", async (ctx) => { await handleFaucet(ctx); });
  bot.callbackQuery("wallet_change", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await promptWalletChange(ctx);
  });

  bot.callbackQuery("wallet_withdraw", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (!userId) return;

    userStates[userId] = { step: "awaiting_withdraw_address" };
    await ctx.reply(
      `📤 *Withdraw*\n\nSend to any EVM address. Reply with *address amount*\n\n*Examples:*\n• \`0xYourAddress 0.5\` — exact amount\n• \`0xYourAddress max\` — everything minus gas\n\nOr reply with just the address and I'll ask how much.`,
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery("menu_chains", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await renderChainsMenu(ctx);
  });

  // Chain selection callback
  bot.callbackQuery(/^chain_select_(.+)$/, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    const chainKey = ctx.match[1];
    if (!userId || !chainKey) return;

    dbService.setSelectedChain(userId, chainKey);
    const config = getChainConfig(chainKey);
    await ctx.reply(`🌐 Active chain switched to: *${config.name}*`, { parse_mode: "Markdown" });
    await renderChainsMenu(ctx);
  });

  bot.callbackQuery("menu_snipe", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await promptNewSnipe(ctx);
  });

  bot.callbackQuery("menu_tasks", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await renderTasksMenu(ctx);
  });

  bot.callbackQuery("menu_floor", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await promptFloorCheck(ctx);
  });

  bot.callbackQuery("menu_nfts", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await renderNFTsMenu(ctx);
  });

  bot.callbackQuery("menu_mint", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await promptMint(ctx);
  });

  bot.callbackQuery("menu_markets", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await ctx.reply("Archived. Use /launch and /deployments in Elysium-only mode.", { parse_mode: "Markdown", reply_markup: mainKeyboard });
  });
  bot.callbackQuery(/^watch_add_(0x[a-fA-F0-9]{40})$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await handleQuickWatch(ctx, ctx.match[1]);
  });

  bot.callbackQuery("deploy_alert_toggle", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const uid = ctx.from?.id; if (!uid) return;
    const enabled = dbService.toggleDeployAlerts(uid);
    await ctx.reply(enabled ? "🔔 Deployment alerts unmuted." : "🔕 Deployment alerts muted. Use /unmutedeploys to re-enable.", { parse_mode: "Markdown", reply_markup: mainKeyboard });
  });

  bot.callbackQuery("deploy_alert_toggle_off", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const uid = ctx.from?.id; if (!uid) return;
    dbService.setDeployAlertsEnabled(uid, false);
    await ctx.reply("🔕 Muted deployment alerts. Use /unmutedeploys or /alerts to re-enable.", { parse_mode: "Markdown", reply_markup: mainKeyboard });
  });

  bot.callbackQuery("menu_mints", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await renderMintsMenu(ctx);
  });

  bot.callbackQuery("menu_elysium", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await renderElysiumMenu(ctx);
  });

  bot.callbackQuery("menu_deployments", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await renderDeploymentsMenu(ctx);
  });

  bot.callbackQuery("menu_watchlist", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await renderWatchlistMenu(ctx);
  });

  bot.callbackQuery(/^watch_add_(0x[a-fA-F0-9]{40})$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await handleQuickWatch(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^unwatch_(\d+)$/, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await handleUnwatchById(ctx, Number(ctx.match[1]));
  });

  bot.callbackQuery(/^refresh_watch_(\d+)$/, async (ctx) => {
    ctx.answerCallbackQuery({ text: "Refreshing on-chain…" }).catch(() => {});
    await handleRefreshWatch(ctx, Number(ctx.match[1]));
  });

  bot.callbackQuery(/^nft_list_(\d+)$/, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    const nft = userId ? userStates[userId]?.data?.nfts?.[Number(ctx.match[1])] : undefined;
    if (!userId || !nft) return;
    userStates[userId] = { step: "awaiting_nft_list_price", data: nft };
    await ctx.reply(`Send the listing price in ETH for #${nft.tokenId}, for example \`0.25\`.`);
  });

  bot.callbackQuery(/^nft_offer_(\d+)$/, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    const nft = userId ? userStates[userId]?.data?.nfts?.[Number(ctx.match[1])] : undefined;
    if (!userId || !nft) return;
    await prepareOfferAcceptance(ctx, nft.contract, nft.tokenId);
  });

  bot.callbackQuery(/^listing_cancel_(\d+)$/, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await handleListingCancellation(ctx, Number(ctx.match[1]));
  });

  bot.callbackQuery("menu_history", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (!userId) return;

    const trades = dbService.getUserTrades(userId);
    if (trades.length === 0) {
      await ctx.reply("📜 *Trade History*\n\nNo trades recorded yet.", {
        parse_mode: "Markdown",
        reply_markup: mainKeyboard,
      });
      return;
    }

    let msg = `📜 *Recent Trades (Last ${trades.length})*\n\n`;
    trades.forEach((t) => {
      msg += `• [${t.chain.toUpperCase()}] Token #${t.token_id}: *${t.price_eth} ETH* (${t.action})\n  Tx: \`${t.tx_hash.slice(0, 10)}...\`\n`;
    });

    await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: mainKeyboard });
  });

  bot.callbackQuery("menu_portfolio", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await renderPortfolioMenu(ctx);
  });
  bot.callbackQuery("portfolio_refresh", async (ctx) => {
    ctx.answerCallbackQuery({ text: "Refreshing portfolio…" }).catch(() => {});
    await renderPortfolioMenu(ctx);
  });
  bot.callbackQuery("portfolio_share", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await handlePortfolioShare(ctx);
  });
  bot.callbackQuery("menu_safety_info", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await renderSafetyInfo(ctx);
  });
  bot.callbackQuery(/^tok_card_(0x[a-fA-F0-9]{40})$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await renderTokenCard(ctx, ctx.match[1] as Address);
  });
  bot.callbackQuery(/^tok_safety_(0x[a-fA-F0-9]{40})$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await renderSafetyCard(ctx, ctx.match[1] as Address);
  });
  bot.callbackQuery(/^tok_buy_(0x[a-fA-F0-9]{40})_(0\.1|0\.5|1|0\.01|0\.05|0\.2)$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await handleTokenBuy(ctx, ctx.match[1] as Address, ctx.match[2]);
  });
  bot.callbackQuery(/^tok_buyx_(0x[a-fA-F0-9]{40})$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const uid = ctx.from?.id;
    if (!uid) return;
    userStates[uid] = { step: "awaiting_buyx_amount", data: { token: ctx.match[1] } };
    await ctx.reply(`💰 Send HYPE amount for \`${ctx.match[1].slice(0, 10)}…\` (e.g. \`0.2\` or \`1.5\`):`, { parse_mode: "Markdown", reply_markup: mainKeyboard });
  });
  bot.callbackQuery(/^tok_sell_(0x[a-fA-F0-9]{40})_(25|50|100)$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await handleTokenSell(ctx, ctx.match[1] as Address, ctx.match[2]);
  });
  bot.callbackQuery(/^slip_set_(\d+)$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const uid = ctx.from?.id;
    if (!uid) return;
    const bps = Number(ctx.match[1]);
    dbService.setSlippageBps(uid, bps);
    await ctx.reply(`✅ Slippage set to \`${bps / 100}%\` — Zensweep will use this for every buy/sell so it's harder to front-run.`, { parse_mode: "Markdown", reply_markup: makeSlippageKeyboard(dbService.getSlippageBps(uid)) });
  });

  bot.callbackQuery("menu_help", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await renderHelpMenu(ctx);
  });

  // Task actions
  bot.callbackQuery(/^task_toggle_(\d+)$/, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const taskId = parseInt(ctx.match[1], 10);
    const userId = ctx.from?.id;
    if (!userId) return;

    const tasks = dbService.getUserTasks(userId);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    const nextStatus = task.status === "active" ? "paused" : "active";
    if (nextStatus === "active") {
      await ctx.reply("⚠️ Live marketplace monitoring is not configured, so this task cannot be resumed yet.");
      await renderTasksMenu(ctx);
      return;
    }
    dbService.updateTaskStatus(taskId, nextStatus);
    await ctx.reply(`Task #${taskId} is now *${nextStatus}*.`, { parse_mode: "Markdown" });
    await renderTasksMenu(ctx);
  });

  bot.callbackQuery(/^task_delete_(\d+)$/, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const taskId = parseInt(ctx.match[1], 10);
    const userId = ctx.from?.id;
    if (!userId) return;

    dbService.deleteTask(taskId, userId);
    await ctx.reply(`🗑 Task #${taskId} deleted.`, { parse_mode: "Markdown" });
    await renderTasksMenu(ctx);
  });

  // Snipe this collection button callback
  bot.callbackQuery(/^snipe_col_(0x[a-fA-F0-9]{40})$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (!userId) return;

    const contract = ctx.match[1];
    await ctx.reply(`🔍 Detecting network for \`${contract.slice(0, 10)}...\`...`, { parse_mode: "Markdown" });

    const stats = await marketplaceService.autoDetectAndGetStats(contract);
    userStates[userId] = {
      step: "awaiting_snipe_for_contract",
      data: { contract, chainKey: stats.chainKey, chainName: stats.chain },
    };

    let msg = `🎯 *Set Snipe Rule: ${stats.name}*\n\n`;
    msg += `🌐 *Network:* \`${stats.chain}\`\n`;
    msg += `📄 *Contract:* \`${contract}\`\n`;
    if (stats.floorPrice !== undefined && stats.floorPrice > 0) {
      msg += `💰 *Current Floor:* \`${stats.floorPrice} ${stats.floorCurrency || "ETH"}\`\n`;
    }
    msg += `\nPlease reply with your snipe settings:\n`;
    msg += `\`<max_price_eth> [quantity]\`\n\n`;
    msg += `*Examples:*\n`;
    msg += `• \`0.01\` — Buy 1 NFT if floor is ≤ 0.01 ETH\n`;
    msg += `• \`0.01 3\` — Buy up to 3 NFTs at ≤ 0.01 ETH each\n`;
    msg += `• \`0.01 3\` — Save a paused rule for up to 3 items at 0.01 ETH each`;

    await ctx.reply(msg, { parse_mode: "Markdown" });
  });

  // Trait snipe button callback
  bot.callbackQuery(/^snipe_trait_(0x[a-fA-F0-9]{40})$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (!userId) return;

    const contract = ctx.match[1];
    await ctx.reply(`🔍 Detecting network for \`${contract.slice(0, 10)}...\`...`, { parse_mode: "Markdown" });

    const stats = await marketplaceService.autoDetectAndGetStats(contract);
    userStates[userId] = {
      step: "awaiting_trait_snipe_params",
      data: { contract, chainKey: stats.chainKey, chainName: stats.chain },
    };

    let msg = `🧬 *Set Trait Snipe: ${stats.name}*\n\n`;
    msg += `🌐 *Network:* \`${stats.chain}\`\n`;
    msg += `📄 *Contract:* \`${contract}\`\n\n`;
    msg += `Please reply with your target trait and buy settings:\n`;
    msg += `\`<TraitType=Value> <max_price_eth> [quantity]\`\n\n`;
    msg += `*Examples:*\n`;
    msg += `• \`Eyes=Laser 0.5\` — Buy 1 NFT with Laser Eyes under 0.5 ETH\n`;
    msg += `• \`Skin=Gold 1.2 2\` — Buy up to 2 Gold Skins under 1.2 ETH each\n`;
    msg += `• \`Type=Alien 2.0 1\` — Save a paused rule for matching items under 2 ETH`;

    await ctx.reply(msg, { parse_mode: "Markdown" });
  });

  // Text message handler
  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    const text = ctx.message.text.trim();
    if (!userId) return;

    if (text === "/cancel") {
      if (userStates[userId]) { delete userStates[userId]; await ctx.reply("Cancelled.", { parse_mode: "Markdown", reply_markup: mainKeyboard }); }
      return;
    }

    const state = userStates[userId];

    if (state?.step === "awaiting_withdraw_address") {
      const parts = text.trim().split(/\s+/);
      const addr = parts[0] as Address;
      if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
        await ctx.reply("❌ Invalid address — need `0x...` 40 hex.");
        return;
      }
      if (parts.length === 1) {
        userStates[userId] = { step: "awaiting_withdraw_amount", data: { to: addr } };
        await ctx.reply(`💰 *How much HYPE to send to \`${addr}\`?*\n\nReply with a number (e.g. \`0.5\`), \`max\` for everything minus gas, or \`/cancel\`.`, { parse_mode: "Markdown" });
        return;
      }
      const amtStr = parts[1];
      if (amtStr.toLowerCase() === "max") {
        delete userStates[userId];
        const user = dbService.getUser(userId);
        const chain = user?.selected_chain || DEFAULT_CHAIN_KEY;
        try {
          await ctx.reply(`⏳ Withdrawing *max* to \`${addr}\`…`, { parse_mode: "Markdown" });
          const txHash = await walletManager.withdrawAll(userId, addr, chain);
          await ctx.reply(`✅ *Withdrawal Successful!*\n\nTx Hash: \`${txHash}\``, { parse_mode: "Markdown", reply_markup: mainKeyboard });
        } catch (err: any) { await ctx.reply(`❌ *Withdrawal Failed:* ${err.message}`, { parse_mode: "Markdown" }); }
        return;
      }
      const amt = Number(amtStr);
      if (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000) {
        await ctx.reply("❌ Invalid amount — use a number like `0.5` or `max`.");
        return;
      }
      delete userStates[userId];
      const user = dbService.getUser(userId);
      const chain = user?.selected_chain || DEFAULT_CHAIN_KEY;
      try {
        await ctx.reply(`⏳ Withdrawing \`${amtStr} HYPE\` to \`${addr}\`…`, { parse_mode: "Markdown" });
        const txHash = await walletManager.withdraw(userId, addr, chain, parseEther(amtStr));
        await ctx.reply(`✅ *Withdrawal Successful!*\n\nTx Hash: \`${txHash}\``, { parse_mode: "Markdown", reply_markup: mainKeyboard });
      } catch (err: any) { await ctx.reply(`❌ *Withdrawal Failed:* ${err.message}`, { parse_mode: "Markdown" }); }
      return;
    }

    if (state?.step === "awaiting_withdraw_amount") {
      delete userStates[userId];
      const to = state.data?.to as Address;
      if (!/^0x[a-fA-F0-9]{40}$/.test(to ?? "")) { await ctx.reply("Session expired, try again."); return; }
      const amtStr = text.trim().toLowerCase();
      const user = dbService.getUser(userId);
      const chain = user?.selected_chain || DEFAULT_CHAIN_KEY;
      try {
        if (amtStr === "max") {
          await ctx.reply(`⏳ Withdrawing *max* to \`${to}\`…`, { parse_mode: "Markdown" });
          const txHash = await walletManager.withdrawAll(userId, to, chain);
          await ctx.reply(`✅ *Withdrawal Successful!*\n\nTx Hash: \`${txHash}\``, { parse_mode: "Markdown", reply_markup: mainKeyboard });
        } else {
          const amt = Number(amtStr);
          if (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000) { await ctx.reply("❌ Invalid amount — use `0.5` or `max`."); return; }
          await ctx.reply(`⏳ Withdrawing \`${amtStr} HYPE\` to \`${to}\`…`, { parse_mode: "Markdown" });
          const txHash = await walletManager.withdraw(userId, to, chain, parseEther(amtStr));
          await ctx.reply(`✅ *Withdrawal Successful!*\n\nTx Hash: \`${txHash}\``, { parse_mode: "Markdown", reply_markup: mainKeyboard });
        }
      } catch (err: any) { await ctx.reply(`❌ *Withdrawal Failed:* ${err.message}`, { parse_mode: "Markdown" }); }
      return;
    }

    if (state?.step === "awaiting_floor_contract") {
      delete userStates[userId];
      await handleFloorLookup(ctx, text);
      return;
    }

    if (state?.step === "awaiting_list_params") {
      delete userStates[userId];
      const parts = text.split(/\s+/);
      if (parts.length !== 3 || !/^0x[a-fA-F0-9]{40}$/.test(parts[0])) {
        await ctx.reply("Format: `<contract_address> <token_id> <price_eth>`.", { parse_mode: "Markdown" });
        return;
      }
      await prepareListing(ctx, parts[0], parts[1], parts[2]);
      return;
    }

    if (state?.step === "awaiting_offer_params") {
      delete userStates[userId];
      const parts = text.split(/\s+/);
      if (parts.length !== 2 || !/^0x[a-fA-F0-9]{40}$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
        await ctx.reply("Format: `<contract_address> <token_id>`.", { parse_mode: "Markdown" });
        return;
      }
      await prepareOfferAcceptance(ctx, parts[0], parts[1]);
      return;
    }

    if (state?.step === "awaiting_nft_list_price") {
      const nft = state.data;
      delete userStates[userId];
      await prepareListing(ctx, nft?.contract, nft?.tokenId, text);
      return;
    }

    if (state?.step === "awaiting_listing_confirmation") {
      delete userStates[userId];
      if (!state.data || Date.now() > state.data.expiresAt) {
        await ctx.reply("Listing confirmation expired. Send /list to try again.");
        return;
      }
      if (text.toUpperCase() !== "CONFIRM") {
        await ctx.reply("Listing cancelled.");
        return;
      }
      await executeCreateListing(ctx, state.data);
      return;
    }

    if (state?.step === "awaiting_offer_confirmation") {
      delete userStates[userId];
      if (!state.data || Date.now() > state.data.expiresAt) {
        await ctx.reply("Offer confirmation expired. Start again from /nfts.");
        return;
      }
      if (text.toUpperCase() !== "CONFIRM") {
        await ctx.reply("Offer acceptance cancelled.");
        return;
      }
      await executeOfferAcceptance(ctx, state.data);
      return;
    }

    if (state?.step === "awaiting_listing_cancel_confirmation") {
      delete userStates[userId];
      if (!state.data || Date.now() > state.data.expiresAt) {
        await ctx.reply("Cancellation confirmation expired. Open /delist to try again.");
        return;
      }
      if (text.toUpperCase() !== "CONFIRM") {
        await ctx.reply("Listing cancellation cancelled.");
        return;
      }
      await executeListingCancellation(ctx, state.data.listingId);
      return;
    }

    if (state?.step === "awaiting_buyx_amount") {
      const raw = text.trim();
      const amt = Number(raw);
      if (!Number.isFinite(amt) || amt <= 0 || amt > 10000) {
        await ctx.reply("❌ Send a number like `0.2`, `0.5`, or `1` (HYPE).", { parse_mode: "Markdown" });
        return;
      }
      delete userStates[userId];
      const { token } = state.data ?? {};
      if (!/^0x[a-fA-F0-9]{40}$/.test(token ?? "")) { await ctx.reply("Session expired. Paste the token again.", { parse_mode: "Markdown" }); return; }
      await handleTokenBuy(ctx, token as Address, String(amt));
      return;
    }

    if (state?.step === "awaiting_mint_params") {
      delete userStates[userId];
      await handleMintParams(ctx, text);
      return;
    }

    if (state?.step === "awaiting_mint_confirmation") {
      delete userStates[userId];
      if (!state.data || Date.now() > state.data.expiresAt) {
        await ctx.reply("Mint confirmation expired. Send /mint to start again.");
        return;
      }
      if (text.trim().toUpperCase() !== "CONFIRM") {
        await ctx.reply("Mint cancelled. Send /mint when you are ready to try again.");
        return;
      }
      await executeMint(ctx, state.data);
      return;
    }

    if (state?.step === "awaiting_watch_address") {
      delete userStates[userId];
      await handleWatchSubmit(ctx, text);
      return;
    }

    if (state?.step === "awaiting_token_buy_confirm") {
      delete userStates[userId];
      if (text.trim().toUpperCase() !== "CONFIRM BUY") {
        await ctx.reply("Buy cancelled. Paste the token again when ready.", { parse_mode: "Markdown", reply_markup: mainKeyboard });
        return;
      }
      const { token, amountStr } = state.data ?? {};
      if (!token || !amountStr) { await ctx.reply("Session expired, try again.", { parse_mode: "Markdown" }); return; }
      await executeTokenBuy(ctx, token as Address, amountStr);
      return;
    }

    if (state?.step === "awaiting_import_key") {
      const raw = text.trim().replace(/\s+/g, "");
      const k = raw.startsWith("0x") || raw.startsWith("0X") ? raw : `0x${raw}`;
      if (!/^0x[0-9a-fA-F]{64}$/.test(k)) {
        await ctx.reply(`❌ Invalid key — got \`${raw.slice(0, 12)}…${raw.slice(-6)}\` (${raw.replace(/^0x/i, "").length} chars). Need exactly **64 hex chars**, with or without \`0x\`. Try again or \`/cancel\`.`, { parse_mode: "Markdown" });
        return;
      }
      delete userStates[userId];
      try {
        const w2 = walletManager.importWallet(userId, k);
        await ctx.reply(`✅ Wallet switched to \`${w2.address}\` — encrypted and live. Deposit with this new address.`, { parse_mode: "Markdown", reply_markup: mainKeyboard });
        try { await ctx.deleteMessage(); } catch {}
      } catch (e: any) {
        await ctx.reply(`❌ Import failed: ${e?.message ?? "unknown"}`, { parse_mode: "Markdown" });
      }
      return;
    }

    if (state?.step === "awaiting_wallet_change_confirm") {
      delete userStates[userId];
      if (text.trim().toUpperCase() !== "CONFIRM") {
        await ctx.reply("Change wallet cancelled. Your old wallet is still active.", { parse_mode: "Markdown", reply_markup: mainKeyboard });
        return;
      }
      try {
        const w2 = walletManager.createNewWallet(userId);
        await ctx.reply(`✅ New wallet created: \`${w2.address}\`\n\nOld key overwritten. Use \`/wallet\` to see balance, \`/export\` to back up new key.`, { parse_mode: "Markdown", reply_markup: mainKeyboard });
      } catch (e: any) {
        await ctx.reply(`❌ Could not create: ${e?.message ?? "unknown"}`, { parse_mode: "Markdown" });
      }
      return;
    }

    if (state?.step === "awaiting_token_sell_confirm") {
      delete userStates[userId];
      if (text.trim().toUpperCase() !== "CONFIRM SELL") {
        await ctx.reply("Sell cancelled.", { parse_mode: "Markdown", reply_markup: mainKeyboard });
        return;
      }
      const { token, balRaw } = state.data ?? {};
      if (!token || !balRaw) { await ctx.reply("Session expired.", { parse_mode: "Markdown" }); return; }
      await executeTokenSell(ctx, token as Address, "100", BigInt(balRaw));
      return;
    }

    if (state?.step === "awaiting_trait_snipe_params") {
      const contract = state.data?.contract;
      delete userStates[userId];

      const parts = text.split(/\s+/);
      let traitType: string | undefined;
      let traitValue: string | undefined;
      const numbers: number[] = [];

      for (const p of parts) {
        if (p.includes("=")) {
          const eqIdx = p.indexOf("=");
          traitType = p.slice(0, eqIdx).trim();
          traitValue = p.slice(eqIdx + 1).trim();
        } else {
          const num = Number(p);
          if (Number.isFinite(num)) numbers.push(num);
        }
      }

      if (!traitType || !traitValue) {
        await ctx.reply("❌ Invalid format. Please specify the trait as `TraitType=Value` (e.g. `Eyes=Laser 0.5`).");
        return;
      }

      if (numbers.length === 0 || numbers.length > 2 || numbers[0] <= 0) {
        await ctx.reply("❌ Send a positive max price and optional whole-number quantity. Auto-relisting is unavailable.");
        return;
      }

      const maxPrice = numbers[0];
      const targetCount = numbers[1] ?? 1;
      if (!Number.isInteger(targetCount) || targetCount < 1) {
        await ctx.reply("❌ Quantity must be a positive whole number.");
        return;
      }

      let chain = state.data?.chainKey;
      let chainName = state.data?.chainName;
      if (!chain) {
        const stats = await marketplaceService.autoDetectAndGetStats(contract);
        chain = stats.chainKey;
        chainName = stats.chain;
      }
      if (!chainName) {
        chainName = getChainConfig(chain).name;
      }

      const taskId = dbService.createTask(
        userId,
        chain,
        contract,
        maxPrice,
        targetCount,
        undefined,
        undefined,
        traitType,
        traitValue
      );

      let msg = `🧬 *Trait Snipe Rule Created (Task #${taskId})!*\n\n`;
      msg += `🌐 *Chain:* \`${chainName}\`\n`;
      msg += `📄 *Contract:* \`${contract}\`\n`;
      msg += `🧬 *Trait Filter:* \`${traitType} = ${traitValue}\`\n`;
      msg += `💰 *Max Buy Price:* \`${maxPrice} ETH\`\n`;
      msg += `🎯 *Target Quantity:* \`${targetCount}\`\n`;
      msg += `\n*Status:* ⏸ Saved paused; live order monitoring is not configured`;

      await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: mainKeyboard });
      return;
    }

    if (state?.step === "awaiting_snipe_for_contract") {
      const contract = state.data?.contract;
      delete userStates[userId];

      const parts = text.split(/\s+/);
      let traitType: string | undefined;
      let traitValue: string | undefined;
      const numbers: number[] = [];

      for (const p of parts) {
        if (p.includes("=")) {
          const eqIdx = p.indexOf("=");
          traitType = p.slice(0, eqIdx).trim();
          traitValue = p.slice(eqIdx + 1).trim();
        } else if (!p.startsWith("0x")) {
          const num = Number(p);
          if (Number.isFinite(num)) numbers.push(num);
        }
      }

      if (numbers.length === 0 || numbers.length > 2 || numbers[0] <= 0) {
        await ctx.reply("❌ Send a positive max price and optional whole-number quantity. Auto-relisting is unavailable.");
        return;
      }

      const maxPrice = numbers[0];
      const targetCount = numbers[1] ?? 1;
      if (!Number.isInteger(targetCount) || targetCount < 1) {
        await ctx.reply("❌ Quantity must be a positive whole number.");
        return;
      }

      let chain = state.data?.chainKey;
      let chainName = state.data?.chainName;
      if (!chain) {
        const stats = await marketplaceService.autoDetectAndGetStats(contract);
        chain = stats.chainKey;
        chainName = stats.chain;
      }
      if (!chainName) {
        chainName = getChainConfig(chain).name;
      }

      const taskId = dbService.createTask(
        userId,
        chain,
        contract,
        maxPrice,
        targetCount,
        undefined,
        undefined,
        traitType,
        traitValue
      );

      let msg = traitType
        ? `🧬 *Trait Snipe Rule Created (Task #${taskId})!*\n\n`
        : `🎯 *Snipe Rule Created (Task #${taskId})!*\n\n`;
      msg += `🌐 *Chain:* \`${chainName}\`\n`;
      msg += `📄 *Contract:* \`${contract}\`\n`;
      if (traitType && traitValue) {
        msg += `🧬 *Trait Filter:* \`${traitType} = ${traitValue}\`\n`;
      }
      msg += `💰 *Max Buy Price:* \`${maxPrice} ETH\`\n`;
      msg += `🎯 *Target Quantity:* \`${targetCount}\`\n`;
      msg += `\n*Status:* ⏸ Saved paused; live order monitoring is not configured`;

      await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: mainKeyboard });
      return;
    }

    // Paste-to-card: single Elysium token address -> token card + safety
    if (/^0x[a-fA-F0-9]{40}$/.test(text.trim()) && !state) {
      await renderTokenCard(ctx, text.trim() as Address);
      return;
    }

    // Snipe input parsing: <contract> <max_price> [target_count]
    const parts = text.split(/\s+/);
    if (parts[0].startsWith("0x") && parts[0].length === 42) {
      if (parts.length === 1) {
        // Bare address (fallback) -> also Token Card (Elysium-first)
        await renderTokenCard(ctx, parts[0] as Address);
        return;
      }

      const contract = parts[0];
      let traitType: string | undefined;
      let traitValue: string | undefined;
      const numbers: number[] = [];

      for (const p of parts.slice(1)) {
        if (p.includes("=")) {
          const eqIdx = p.indexOf("=");
          traitType = p.slice(0, eqIdx).trim();
          traitValue = p.slice(eqIdx + 1).trim();
        } else {
          const num = Number(p);
          if (Number.isFinite(num)) numbers.push(num);
        }
      }

      if (numbers.length === 0 || numbers.length > 2 || numbers[0] <= 0) {
        await ctx.reply(`⚠️ Provide a positive max price and optional whole-number quantity. Auto-relisting is unavailable.\nExample:\n\`${contract} 0.005 3\``, {
          parse_mode: "Markdown",
        });
        return;
      }

      const maxPrice = numbers[0];
      const targetCount = numbers[1] ?? 1;
      if (!Number.isInteger(targetCount) || targetCount < 1) {
        await ctx.reply("❌ Quantity must be a positive whole number.");
        return;
      }

      // Auto-detect the chain that this contract belongs to
      const stats = await marketplaceService.autoDetectAndGetStats(contract);
      const chain = stats.chainKey;
      const chainName = stats.chain;

      const taskId = dbService.createTask(
        userId,
        chain,
        contract,
        maxPrice,
        targetCount,
        undefined,
        undefined,
        traitType,
        traitValue
      );

      let msg = traitType
        ? `🧬 *Trait Snipe Rule Created (Task #${taskId})!*\n\n`
        : `🎯 *Snipe Rule Created (Task #${taskId})!*\n\n`;
      msg += `🌐 *Chain:* \`${chainName}\`\n`;
      msg += `📄 *Contract:* \`${contract}\`\n`;
      if (traitType && traitValue) {
        msg += `🧬 *Trait Filter:* \`${traitType} = ${traitValue}\`\n`;
      }
      msg += `💰 *Max Buy Price:* \`${maxPrice} ETH\`\n`;
      msg += `🎯 *Target Quantity:* \`${targetCount}\`\n`;
      msg += `\n*Status:* ⏸ Saved paused; live order monitoring is not configured`;

      await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: mainKeyboard });
      return;
    }

    // Unknown /command (including stale demo menu) -> point at the real menu
    if (text.startsWith("/")) {
      await ctx.reply(
        "Unknown command. Open /help or use the menu buttons — Zensweep is Elysium-first: /elysium, /deployments, /watch, /portfolio, /mints.",
        { parse_mode: "Markdown", reply_markup: mainKeyboard }
      );
      return;
    }

    // Default response if not recognized
    await ctx.reply(
      `Command not recognized. Use the menu buttons below or send a snipe format:\n\`<contract_address> <max_price_eth> [quantity]\`\n\n*Trait Snipe Format:*\n\`<contract_address> <Trait=Value> <max_price_eth> [quantity]\``,
      { parse_mode: "Markdown", reply_markup: mainKeyboard }
    );
  });
}

// Helpers
async function renderWalletMenu(ctx: Context, forceRefresh: boolean = false) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const user = dbService.getUser(userId);
  if (!user) {
    await ctx.reply(`🔴 *No wallet yet.* Generate or import one below:`, {
      reply_markup: noWalletKeyboard,
    });
    return;
  }

  const chain = user.selected_chain || DEFAULT_CHAIN_KEY;
  const chainConfig = getChainConfig(chain);
  const balance = await walletManager.getBalance(user.wallet_address as Address, chain, forceRefresh);

  let msg = `🟢 *Your Trading Wallet* — Elysium\n\n`;
  msg += `🌐 *Chain:* \`${chainConfig.name}\`\n`;
  msg += `📫 *Address:* \`${user.wallet_address}\`\n`;
  msg += `💰 *Balance:* \`${balance.eth} ${balance.symbol}\`\n\n`;
  msg += `This is a server-managed wallet; its signing key stays on the bot host.\n`;
  msg += `*Deposit:* Send native tokens (${balance.symbol}) only if you are comfortable with that custody model. Use Withdraw to move funds out.`;

  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: walletKeyboard });
}

async function renderChainsMenu(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const user = dbService.getUser(userId);
  const selected = user?.selected_chain || DEFAULT_CHAIN_KEY;

  await ctx.reply(`🌐 *Select Active Chain:*\n\nChoose which EVM network you want to trade on:`, {
    parse_mode: "Markdown",
    reply_markup: makeChainKeyboard(selected),
  });
}

async function promptNewSnipe(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const user = dbService.getUser(userId);
  const chain = user?.selected_chain || DEFAULT_CHAIN_KEY;

  let msg = `🎯 *Save Snipe Rule (${chain.toUpperCase()})*\n\n`;
  msg += `Rules are saved paused because live marketplace monitoring is not configured.\n\n`;
  msg += `Reply with your parameters in this format:\n`;
  msg += `\`<contract_address> <max_price_eth> [quantity]\`\n\n`;
  msg += `*Example:*\n`;
  msg += `\`0xde0acefc89d4cf5f4ce45a4fb8a51aa355091b44 0.005 3\`\n\n`;
  msg += `• Contract: \`0xde0a...\`\n`;
  msg += `• Max Buy Price: \`0.005 ETH\`\n`;
  msg += `• Quantity: \`3 NFTs\`\n`;
  msg += `• Auto-relisting is unavailable`;

  await ctx.reply(msg, { parse_mode: "Markdown" });
}

async function renderTasksMenu(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const tasks: TaskRow[] = dbService.getUserTasks(userId);
  if (tasks.length === 0) {
    await ctx.reply(`📋 *My Snipe Rules*\n\nYou have no rules saved yet.`, {
      parse_mode: "Markdown",
      reply_markup: mainKeyboard,
    });
    return;
  }

  for (const t of tasks.slice(0, 5)) {
    let msg = `📋 *Task #${t.id}* [${t.chain.toUpperCase()}]\n`;
    msg += `📄 *Contract:* \`${t.contract_address}\`\n`;
    if (t.trait_type && t.trait_value) {
      msg += `🧬 *Trait:* \`${t.trait_type} = ${t.trait_value}\`\n`;
    }
    msg += `💰 *Max Buy:* \`${t.max_price_eth} ETH\`\n`;
    msg += `🎯 *Progress:* \`${t.bought_count} / ${t.target_count} bought\`\n`;
    if (t.auto_relist_price_eth) {
      msg += `📈 *Auto-relist requested (not active):* \`${t.auto_relist_price_eth} ETH\`\n`;
    }
    msg += `*Status:* ${t.status === "active" ? "🟢 Active" : t.status === "completed" ? "✅ Completed" : "⏸ Paused"}`;

    await ctx.reply(msg, {
      parse_mode: "Markdown",
      reply_markup: makeTaskKeyboard(t.id, t.status === "active"),
    });
  }
}

async function promptFloorCheck(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;

  userStates[userId] = { step: "awaiting_floor_contract" };
  await ctx.reply(
    `📊 *Check Collection Stats & Floor Price*\n\nPlease reply with the NFT contract address:\n\n*Example:* \`0xde0acefc89d4cf5f4ce45a4fb8a51aa355091b44\``,
    { parse_mode: "Markdown" }
  );
}

async function handleFloorLookup(ctx: Context, contract: string) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const cleanContract = contract.trim();
  if (!cleanContract.startsWith("0x") || cleanContract.length !== 42) {
    await ctx.reply("❌ Invalid EVM contract address. Please send a 42-character `0x...` address.");
    return;
  }

  await ctx.reply(`🔍 Looking up \`${cleanContract.slice(0, 10)}...\` across all EVM chains...`, {
    parse_mode: "Markdown",
  });

  const stats = await marketplaceService.autoDetectAndGetStats(cleanContract);

  let msg = `📊 *${stats.name}*${stats.symbol ? ` (${stats.symbol})` : ""}\n\n`;
  msg += `🌐 *Network:* \`${stats.chain}\`\n`;
  msg += `📄 *Contract:* \`${stats.contract}\`\n`;

  if (stats.floorPrice !== undefined && stats.floorPrice > 0) {
    msg += `💰 *Floor Price:* \`${stats.floorPrice} ${stats.floorCurrency || "ETH"}\`\n`;
  } else {
    msg += `💰 *Floor Price:* \`No active listings\`\n`;
  }

  msg += `🔗 *Explorer:* [View on Explorer](${stats.explorerUrl})\n`;
  if (stats.openSeaUrl) {
    msg += `🌊 *OpenSea:* [View Collection](${stats.openSeaUrl})\n`;
  }

  await ctx.reply(msg, {
    parse_mode: "Markdown",
    reply_markup: makeCollectionKeyboard(cleanContract, stats.openSeaUrl),
  });
}

async function renderNFTsMenu(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const user = dbService.getUser(userId);
  if (!user) {
    await ctx.reply("⚠️ Please connect a wallet first.", { reply_markup: noWalletKeyboard });
    return;
  }

  const chain = user.selected_chain || DEFAULT_CHAIN_KEY;
  await ctx.reply(`🔍 Loading NFTs in your wallet on *${chain.toUpperCase()}*...`, { parse_mode: "Markdown" });

  const nfts = await marketplaceService.getNFTsForUser(user.wallet_address, chain);
  if (nfts.length === 0) {
    await ctx.reply(
      `🖼 *My Inventory (${chain.toUpperCase()})*\n\nNo NFTs found in your trading wallet on this chain.\n\n*Address:* \`${user.wallet_address}\``,
      { parse_mode: "Markdown", reply_markup: mainKeyboard }
    );
    return;
  }

  let msg = `🖼 *My Inventory (${chain.toUpperCase()})* — Found *${nfts.length}* NFT(s):\n\n`;
  for (const nft of nfts.slice(0, 10)) {
    msg += `• *${nft.title}*\n  Contract: \`${nft.contract}\`\n  ID: \`#${nft.tokenId}\`\n\n`;
  }
  const preview = nfts.slice(0, 5);
  userStates[userId] = { step: "nft_actions", data: { nfts: preview } };
  const keyboard = new InlineKeyboard();
  preview.forEach((nft, index) => {
    keyboard.text(`List #${nft.tokenId}`, `nft_list_${index}`)
      .text(`Best offer #${nft.tokenId}`, `nft_offer_${index}`)
      .row();
  });
  keyboard.text("🔙 Main Menu", "menu_main");

  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: keyboard });
}

async function promptMint(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) {
    await ctx.reply("⚠️ Please connect a wallet before minting.", { reply_markup: noWalletKeyboard });
    return;
  }

  userStates[userId] = { step: "awaiting_mint_params" };
  const feeNotice = FEE_RECIPIENT_WALLET && FEE_PERCENTAGE > 0
    ? `A ${FEE_PERCENTAGE * 100}% service fee is quoted before submission and, if confirmed, sent as a separate transaction after a successful paid mint. That fee transaction also uses your wallet's gas.`
    : "No service fee is currently configured.";
  await ctx.reply(
    `⚡ *Direct Contract Mint*\n\nSend your mint command like this:\n\`<contract_address> [quantity] [price_per_item_eth]\`\n\nExamples:\n\`0x123... 1 0.05\`\n\`0x123... 2 0\`\n\nThe bot does not read the contract's mint price; enter the exact required value. A wrong value may revert or behave according to that contract's rules.\n${feeNotice}\nMint calls the contract directly; it does not use OpenSea. Reply CONFIRM after reviewing the quote.`,
    { parse_mode: "Markdown" }
  );
}

async function handleMintParams(ctx: Context, text: string) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) {
    await ctx.reply("❌ No wallet found.");
    return;
  }

  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 0 || !/^0x[a-fA-F0-9]{40}$/.test(parts[0])) {
    await ctx.reply("❌ Invalid contract address. Use a 42-character `0x...` address.", {
      parse_mode: "Markdown",
    });
    return;
  }

  if (parts.length > 3) {
    await ctx.reply("❌ Format: `<contract> [quantity] [price_per_item_eth]`.", { parse_mode: "Markdown" });
    return;
  }

  const contract = parts[0];
  let quantity = 1;
  let priceEth = "0";
  if (parts[1] !== undefined) {
    if (!/^\d+$/.test(parts[1])) {
      await ctx.reply("❌ Quantity must be a positive whole number.");
      return;
    }
    quantity = Number(parts[1]);
  }
  if (parts[2] !== undefined) {
    if (!/^\d+(?:\.\d{1,18})?$/.test(parts[2])) {
      await ctx.reply("❌ Price must be a non-negative ETH amount with up to 18 decimal places.");
      return;
    }
    priceEth = parts[2];
  }

  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    await ctx.reply("❌ Quantity must be a positive whole number within the safe integer range.");
    return;
  }

  const chain = dbService.getUser(userId)?.selected_chain || DEFAULT_CHAIN_KEY;
  const mintValueWei = parseEther(priceEth) * BigInt(quantity);
  const totalCostEth = formatEther(mintValueWei);
  let serviceFeeEth = "0";
  if (FEE_RECIPIENT_WALLET && FEE_PERCENTAGE > 0 && mintValueWei > 0n) {
    const feeBasisPoints = BigInt(Math.floor(FEE_PERCENTAGE * 10000));
    serviceFeeEth = formatEther((mintValueWei * feeBasisPoints) / 10000n);
  }
  userStates[userId] = {
    step: "awaiting_mint_confirmation",
    data: { contract, quantity, priceEth, chain, expiresAt: Date.now() + 5 * 60_000 },
  };

  let quote = `Mint ${quantity} item(s) from contract \`${contract}\` on *${getChainConfig(chain).name}*?\n`;
  quote += `Entered mint value: *${totalCostEth} ${getChainConfig(chain).symbol}*\n`;
  if (FEE_RECIPIENT_WALLET && FEE_PERCENTAGE > 0 && mintValueWei > 0n) {
    quote += `Service fee (separate transaction): *${serviceFeeEth} ${getChainConfig(chain).symbol}*\n`;
    quote += `The fee transfer can fail after the mint succeeds; both transactions require gas.\n`;
  } else {
    quote += "Service fee: *0* (not configured or free mint)\n";
  }
  quote += "Gas is additional. Reply *CONFIRM* to submit, or anything else to cancel.";
  await ctx.reply(quote, { parse_mode: "Markdown" });
}

async function executeMint(ctx: Context, data: { contract: string; quantity: number; priceEth: string; chain: string }) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) {
    await ctx.reply("❌ No wallet found.");
    return;
  }

  try {
    await ctx.reply(`⏳ Sending mint transaction for *${data.quantity}* item(s)...`, { parse_mode: "Markdown" });

    const result = await minterService.executeMint(
      wallet.privateKey,
      data.contract,
      data.quantity,
      data.priceEth,
      data.chain
    );
    let feeLedgerError: string | undefined;
    if (result.serviceFeeEth !== "0") {
      try {
        dbService.recordServiceFee(
          userId,
          data.chain,
          "mint",
          result.totalCostEth,
          result.serviceFeeEth,
          result.serviceFeeTxHash,
          result.serviceFeePaid ? "paid" : "failed",
          result.serviceFeeError
        );
      } catch (error: any) {
        feeLedgerError = error?.message || "Fee record could not be saved";
        console.error("Failed to record mint fee:", error);
      }
    }

    let feeMessage = "";
    if (result.serviceFeeEth !== "0") {
      feeMessage = result.serviceFeePaid && result.serviceFeeTxHash
        ? `\n💸 *Service Fee Paid:* \`${result.serviceFeeEth} ETH\` ([fee tx](${getChainConfig(data.chain).explorerUrl}/tx/${result.serviceFeeTxHash}))`
        : `\n⚠️ *Service Fee Not Confirmed:* \`${result.serviceFeeEth} ETH\`` +
          (result.serviceFeeTxHash ? ` ([fee tx](${getChainConfig(data.chain).explorerUrl}/tx/${result.serviceFeeTxHash}))` : "") +
          `\nReason: ${result.serviceFeeError || "Fee transfer was not confirmed"}`;
    }

    await ctx.reply(
      `✅ *Mint Sent Successfully!*\n\n` +
        `📄 *Contract:* \`${result.contract}\`\n` +
        `🌐 *Chain:* \`${result.chainName}\`\n` +
        `🎯 *Quantity:* \`${result.quantity}\`\n` +
        `💰 *Entered Mint Value:* \`${result.totalCostEth} ETH\`\n` +
        `🔗 *Explorer:* [View Tx](${result.explorerUrl})` + feeMessage +
        (feeLedgerError ? `\n⚠️ Fee ledger write failed: ${feeLedgerError}` : ""),
      { parse_mode: "Markdown", reply_markup: mainKeyboard }
    );
  } catch (err: any) {
    await ctx.reply(`❌ Mint failed: ${err.message || "Unknown reason"}`);
  }
}

async function promptListNFT(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;
  if (!walletManager.getUserWallet(userId)) {
    await ctx.reply("Connect a wallet before creating a listing.", { reply_markup: noWalletKeyboard });
    return;
  }
  userStates[userId] = { step: "awaiting_list_params" };
  await ctx.reply("Send `<contract_address> <token_id> <price_eth>` to publish an OpenSea listing.", { parse_mode: "Markdown" });
}

async function promptAcceptOffer(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;
  userStates[userId] = { step: "awaiting_offer_params" };
  await ctx.reply("Send `<contract_address> <token_id>` to check the best offer for that exact NFT.", { parse_mode: "Markdown" });
}

async function prepareListing(ctx: Context, contract?: string, tokenId?: string, priceEth?: string) {
  const userId = ctx.from?.id;
  if (!userId || !contract || !tokenId || !priceEth) return;
  if (!/^0x[a-fA-F0-9]{40}$/.test(contract) || !/^\d+$/.test(tokenId) ||
      !/^\d+(?:\.\d{1,18})?$/.test(priceEth) || Number(priceEth) <= 0) {
    await ctx.reply("Invalid listing details. Use a contract, whole-number token ID, and positive ETH price.");
    return;
  }

  const chain = dbService.getUser(userId)?.selected_chain || DEFAULT_CHAIN_KEY;
  userStates[userId] = {
    step: "awaiting_listing_confirmation",
    data: { contract, tokenId, priceEth, chain, expiresAt: Date.now() + 5 * 60_000 },
  };
  await ctx.reply(
    `List NFT \`${contract} #${tokenId}\` on *${getChainConfig(chain).name}* for *${priceEth} ${getChainConfig(chain).symbol}*?\n` +
    "This creates a 30-day OpenSea listing. NFT approval may submit an on-chain transaction and cost gas. The NFT transfers only if a buyer fulfills the listing.\n" +
    "Reply *CONFIRM* to continue, or anything else to cancel.",
    { parse_mode: "Markdown" }
  );
}

async function executeCreateListing(ctx: Context, data: { contract: string; tokenId: string; priceEth: string; chain: string }) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) {
    await ctx.reply("No wallet found.");
    return;
  }

  try {
    await ctx.reply("⏳ Creating and publishing the Seaport listing...");
    const listing = await openSeaService.createNftListing(
      wallet.privateKey,
      data.chain,
      data.contract,
      data.tokenId,
      data.priceEth
    );
    const orderJson = JSON.stringify(listing.order, (_key, value) => typeof value === "bigint" ? value.toString() : value);
    const localId = dbService.createListing(
      userId,
      data.chain,
      data.contract,
      data.tokenId,
      Number(data.priceEth),
      listing.orderHash,
      orderJson
    );
    await ctx.reply(
      `✅ *Listing published* (record #${localId})\n\n` +
      `💰 Price: \`${data.priceEth} ${getChainConfig(data.chain).symbol}\`\n` +
      `🔖 Order: \`${listing.orderHash}\`\n` +
      `📝 The signed order is live on OpenSea until it expires or you cancel it.`,
      { parse_mode: "Markdown", reply_markup: mainKeyboard }
    );
  } catch (error: any) {
    await ctx.reply(`❌ Listing failed: ${error?.shortMessage || error?.message || "OpenSea rejected the listing."}`);
  }
}

async function prepareOfferAcceptance(ctx: Context, contract: string, tokenId: string) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) {
    await ctx.reply("Connect a wallet before accepting an offer.", { reply_markup: noWalletKeyboard });
    return;
  }

  try {
    const chain = dbService.getUser(userId)?.selected_chain || DEFAULT_CHAIN_KEY;
    const stats = await marketplaceService.autoDetectAndGetStats(contract);
    if (!stats.openSeaSlug) throw new Error("This NFT has no OpenSea collection slug.");
    const offer = await openSeaService.getBestOfferForNft(chain, stats.openSeaSlug, contract, tokenId);
    if (!offer) throw new Error("No supported offer for this exact NFT was found.");
    userStates[userId] = {
      step: "awaiting_offer_confirmation",
      data: { contract, tokenId, chain, offer, expiresAt: Date.now() + 5 * 60_000 },
    };
    await ctx.reply(
      `Accept the best offer for NFT \`${contract} #${tokenId}\`?\n` +
      `💰 Offer: *${offer.price} ${offer.currency}*\n` +
      "This transfers the NFT after confirmation. Any required NFT approval and the sale transaction use your wallet and require gas.\n" +
      "Reply *CONFIRM* to accept, or anything else to cancel.",
      { parse_mode: "Markdown" }
    );
  } catch (error: any) {
    await ctx.reply(`❌ Could not prepare offer acceptance: ${error?.message || "Unknown error"}`);
  }
}

async function executeOfferAcceptance(ctx: Context, data: { contract: string; tokenId: string; chain: string; offer: any }) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) {
    await ctx.reply("No wallet found.");
    return;
  }
  try {
    await ctx.reply("⏳ Accepting the verified NFT offer...");
    const txHash = await openSeaService.acceptNftOffer(wallet.privateKey, data.chain, data.offer);
    dbService.recordTrade(userId, data.chain, data.contract, data.tokenId, Number(data.offer.price), txHash, "sell");
    await ctx.reply(
      `✅ *Offer accepted*\n\n💰 ${data.offer.price} ${data.offer.currency}\n` +
      `🔗 [View transaction](${getChainConfig(data.chain).explorerUrl}/tx/${txHash})`,
      { parse_mode: "Markdown", reply_markup: mainKeyboard }
    );
  } catch (error: any) {
    await ctx.reply(`❌ Offer acceptance failed: ${error?.shortMessage || error?.message || "Unknown error"}`);
  }
}

async function handleListingCancellation(ctx: Context, listingId: number) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const listing = dbService.getUserListings(userId).find((item) => item.id === listingId);
  if (!listing || !listing.order_json) {
    await ctx.reply("This listing has no saved Seaport order to cancel.");
    return;
  }
  userStates[userId] = {
    step: "awaiting_listing_cancel_confirmation",
    data: { listingId, expiresAt: Date.now() + 5 * 60_000 },
  };
  await ctx.reply(`Cancel listing #${listingId} on-chain? This requires a transaction and gas. Reply *CONFIRM* to proceed.`, {
    parse_mode: "Markdown",
  });
}

async function executeListingCancellation(ctx: Context, listingId: number) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const listing = dbService.getUserListings(userId).find((item) => item.id === listingId);
  if (!listing || !listing.order_json) {
    await ctx.reply("This listing has no saved Seaport order to cancel.");
    return;
  }
  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) {
    await ctx.reply("No wallet found.");
    return;
  }
  try {
    const txHash = await openSeaService.cancelListing(wallet.privateKey, listing.chain, JSON.parse(listing.order_json));
    dbService.delist(listingId, userId);
    await ctx.reply(`✅ Listing cancelled on-chain.\n🔗 [View transaction](${getChainConfig(listing.chain).explorerUrl}/tx/${txHash})`, {
      parse_mode: "Markdown",
      reply_markup: mainKeyboard,
    });
  } catch (error: any) {
    await ctx.reply(`❌ Listing cancellation failed: ${error?.shortMessage || error?.message || "Unknown error"}`);
  }
}

async function renderListingsMenu(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const listings = dbService.getUserListings(userId);
  if (listings.length === 0) {
    await ctx.reply("📋 *Saved Listing Records*\n\nNo local records. Marketplace listings are not currently supported.", {
      parse_mode: "Markdown",
      reply_markup: mainKeyboard,
    });
    return;
  }

  let msg = `📋 *Your OpenSea Listings:*\n\n`;
  const keyboard = new InlineKeyboard();
  listings.forEach((l) => {
    msg += `• Listing #${l.id} [${l.chain.toUpperCase()}]: Token #${l.token_id} at *${l.price_eth} ETH*\n`;
    if (l.order_hash) msg += `  Order: \`${l.order_hash.slice(0, 12)}...\`\n`;
    keyboard.text(`Cancel #${l.id}`, `listing_cancel_${l.id}`).row();
  });

  keyboard.text("🔙 Main Menu", "menu_main");
  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: keyboard });
}

async function renderLaunchMenu(ctx: Context) {
  let msg: string;
  try {
    const apiUrl = ZENSWEEP_LAUNCH_API_URL || "";
    const projects = await fetchLaunchProjects();
    const liveCount = projects.filter((pr) => pr.status === "live" || pr.status === "minting").length;
    if (liveCount > 0) {
      msg = `🟢 *Zensweep Projects — Launchboard*\n_Live now: ${liveCount} / ${projects.length}_ • source: built-in references (pre-launch)\n_Watches Elysium for real projects when they go live — for on-chain truth use 🆕 Deployments._\n\n`;
    } else {
      msg = `🟢 *Zensweep Projects — Launchboard*\n_Built-in ecosystem references (pre-launch) • ${projects.length} entries_\n`;
      if (apiUrl) {
        msg += `_Source: launch API • ${projects.length} tracked projects_\n\n`;
      } else {
        msg += `_No live launch feed connected — set \`ZENSWEEP_LAUNCH_API_URL\` — alias \`KIWI_LAUNCH_API_URL\` kept — for live data. For real on-chain activity use 🆕 Deployments._\n\n`;
      }
    }
    const ranking: Record<string, number> = { live: 0, minting: 0, beta: 1, upcoming: 2, sold_out: 3 };
    const ranked = [...projects].sort((a, b) => (ranking[a.status] ?? 4) - (ranking[b.status] ?? 4));
    for (const project of ranked) {
      msg += `${buildLaunchCard(project)}\n\n`;
    }
    msg += `—\n_Tip: Deployments = what just hit the chain. Projects = who should launch. Watch a contract with \`/watch 0x…\` when it goes live._`;
  } catch (e: any) {
    console.error("renderLaunchMenu failed", e);
    await ctx.reply(`⚠️ Projects temporarily unavailable: ${e?.message ?? "unknown"}`, { parse_mode: "Markdown", reply_markup: mainKeyboard });
    return;
  }
  // Telegram legacy Markdown rejects unescaped *_[] — retry once as plain text so the menu always opens.
  try {
    await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: mainKeyboard });
  } catch {
    const plain = msg.replace(/([*_`\\])/g, "");
    await ctx.reply(plain, { parse_mode: undefined, reply_markup: mainKeyboard });
  }
}

async function renderMarketsMenu(ctx: Context) {
  let msg = `🏪 *Markets · EVM*\n\n`;
  msg += `Archived: cross-chain secondary markets (OpenSea) are disabled in Elysium-only mode.\n\n`;
  msg += `For Elysium-native discovery use 🚀 Launches, ⏳ Mints, 🆕 Deployments, and 👀 Watchlist. Kalos (https://www.kalos.fun) will be the Elysium NFT marketplace once its contracts are set.`;

  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: marketsKeyboard });
}

async function renderMintsMenu(ctx: Context) {
  const projects = await fetchLaunchProjects();
  const now = Date.now();
  const ranked = [...projects].sort((a, b) => {
    const rank = (p: (typeof projects)[number]) => {
      const s = getMintWindowState(p, now);
      return s === "live_now" ? 0 : s === "opens_soon" ? 1 : s === "scheduled" ? 2 : s === "unknown" ? 3 : 4;
    };
    return rank(a) - rank(b);
  });

  let msg = `🟡 *Mint Windows*\n\n`;
  for (const p of ranked) {
    const emoji = getMintWindowState(p, now) === "live_now" ? "⏳" : getMintWindowState(p, now) === "opens_soon" ? "⏰" : "📅";
    msg += `${emoji} *${p.name}* — ${getLaunchStatusLabel(p.status)}\n`;
    msg += `${mintWindowLine(p, now)}\n`;
    if (p.contractAddress) msg += `Contract: \`${p.contractAddress}\`\n`;
    msg += `\n`;
  }
  msg += `Zensweep DM-alerts you the moment a tracked window flips to opens-soon or live.`;

  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: mainKeyboard });
}

async function renderElysiumMenu(ctx: Context) {
  let health;
  try {
    health = await getChainHealth(ELYSIUM.key);
  } catch (err) {
    await ctx.reply(
      `🔴 *Elysium Live*\n\n🔴️ Could not reach the Elysium RPC right now. Try again in a moment.`,
      { parse_mode: "Markdown", reply_markup: mainKeyboard }
    );
    return;
  }

  let msg = `🟢 *Elysium Live* — ${health.chainName}\n\n`;
  msg += `🧱 Block: \`${health.blockNumber}\`\n`;
  msg += `⛽ Gas: \`${health.gasPriceGwei} gwei\`\n`;
  msg += `⚡ Block time: \`${health.blockTimeSeconds !== null ? `${health.blockTimeSeconds.toFixed(2)}s measured` : "n/a"}\`\n`;
  msg += `💧 Gas token: \`${health.symbol}\` (chain ${health.chainId})\n\n`;
  msg += `Explorer: ${health.explorerUrl}`;

  const kb = new InlineKeyboard()
    .text("🆕 Fresh Deployments", "menu_deployments")
    .text("👀 Watchlist", "menu_watchlist")
    .row()
    .text("🔙 Main Menu", "menu_main");
  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: kb });
}

async function renderDeploymentsMenu(ctx: Context, depth: number = 40) {
  await ctx.reply(`🟡 *Scanning Elysium — hunting fresh deployments…*`, { parse_mode: "Markdown" });
  let deployments;
  try {
    deployments = await scanRecentDeployments(depth, ELYSIUM.key);
  } catch (err: any) {
    await ctx.reply(`🔴 *Scan failed*

⚠️ \`${(err?.message ?? "RPC unreachable").replace(/`/g, "'")}\`

Try again in a moment.`, {
      parse_mode: "Markdown",
      reply_markup: mainKeyboard,
    });
    return;
  }
  if (deployments.length === 0) {
    await ctx.reply(`🟡 *Fresh Deployments*

No new contracts in the last ${depth} blocks.
New launches will appear here the instant they hit the chain.`, { parse_mode: "Markdown", reply_markup: mainKeyboard });
    return;
  }
  await ctx.reply(`🟡 *Fresh Deployments — ${deployments.length} new on Elysium*
_🔍 scanned last ${depth} blocks · tap an address to copy · 🛡️ Safety or 📄 Card to inspect_`, { parse_mode: "Markdown" });
  const list = deployments.slice(0, 5);
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    let label = "📄 Contract";
    let description: string | null = null;
    let kind: string = "contract";
    try {
      const meta = await getDeploymentMeta(d.address, ELYSIUM.key);
      label = meta.label;
      description = (meta as any).description ?? null;
      kind = (meta as any).kind ?? "contract";
    } catch {}
    const idx = `${i + 1}/${list.length}`;
    const age = formatAge(d.ageSeconds);
    const kindIcon = kind === "token" ? "🪙" : kind === "nft" ? "🖼️" : "📄";
    let block = `${kindIcon}  ${label}   ·   \`${idx}\`
`;
    if (description) block += `_${description}_
`;
    block += `\n`;
    block += `📄 \`${d.address}\`
`;
    block += `👤 by \`${d.deployer}\`
`;
    block += `🧱 block \`${d.blockNumber}\`  ·  ⏱ ${age}
`;
    block += `🔗 [tx](${ELYSIUM.explorerUrl}/tx/${d.txHash})  ·  [address](${ELYSIUM.explorerUrl}/address/${d.address})
`;
    block += `┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈`;
    const kb = new InlineKeyboard()
      .text(`🛡️ Safety  ${shortAddr(d.address)}`, `tok_safety_${d.address}`)
      .row()
      .text(`📄 Card`, `tok_card_${d.address}`)
      .text(`👀 Watch`, `watch_add_${d.address}`)
      .row();
    try { await ctx.reply(block, { parse_mode: "Markdown", reply_markup: kb }); }
    catch { const plain = block.replace(/[`*_]/g, ""); await ctx.reply(plain, { reply_markup: kb }); }
  }
  const footerKb = new InlineKeyboard()
    .text("🟢 Alerts: ON", "deploy_alert_toggle")
    .text("🔕 Mute", "deploy_alert_toggle_off")
    .row()
    .text("🔙 Main Menu", "menu_main");
  await ctx.reply(`🟡 _Tip: \`/mutedeploys\` mutes auto-DMs · \`/unmutedeploys\` back on. Fresh blocks every ~0.2s_`, { parse_mode: "Markdown", reply_markup: footerKb });
}

async function renderWatchlistMenu(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const watches = dbService.getUserWatches(userId);
  if (watches.length === 0) {
    await ctx.reply(
      `👀 *Watchlist*\n\nYou're not tracking any addresses yet.\n\nSend \`/watch <0x…> [label]\` to track a wallet or launch contract on Elysium. Zensweep DM-alerts you when its balance moves or fresh transfers appear.\n\n*Example:* \`/watch 0x1234…abcd Team treasury\``,
      { parse_mode: "Markdown", reply_markup: mainKeyboard }
    );
    return;
  }

  let msg = `🟡 *Watchlist* — ${watches.length} tracked\n\n`;
  const kb = new InlineKeyboard();
  for (const w of watches) {
    const cfg = getChainConfig(w.chain);
    msg += `• *${w.label ?? "Unnamed"}* [${cfg.name}]\n  \`${w.address}\`\n`;
    kb.text(`🔄 ${w.label ?? w.address.slice(0, 8) + "…"}`, `refresh_watch_${w.id}`)
      .text(`❌ Unwatch`, `unwatch_${w.id}`)
      .row();
  }
  msg += `\nTap 🔄 for a live balance + activity check.`;
  kb.text("🔙 Main Menu", "menu_main");
  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: kb });
}

async function promptWatchAddress(ctx: Context, arg: string) {
  const userId = ctx.from?.id;
  if (!userId) return;
  if (arg && /^0x[a-fA-F0-9]{40}(\s+.+)?$/.test(arg.trim())) {
    await handleWatchSubmit(ctx, arg.trim());
    return;
  }
  userStates[userId] = { step: "awaiting_watch_address" };
  await ctx.reply(
    `👀 *Track an Address*\n\nReply with an EVM address and optional label:\n\n\`<0x…> [label]\`\n\n*Example:* \`0x1234567890abcdef1234567890abcdef12345678 Team treasury\``,
    { parse_mode: "Markdown" }
  );
}

async function handleWatchSubmit(ctx: Context, text: string) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const parts = text.trim().split(/\s+/);
  const address = parts[0];
  const label = parts.length > 1 ? parts.slice(1).join(" ").slice(0, 64) : undefined;
  if (!/^0x[a-fA-F0-9]{40}$/.test(address ?? "")) {
    await ctx.reply("❌ That doesn't look like an EVM address. Send `<0x…> [label]`.", {
      parse_mode: "Markdown",
      reply_markup: mainKeyboard,
    });
    return;
  }
  const chain = dbService.getUser(userId)?.selected_chain || DEFAULT_CHAIN_KEY;
  const id = dbService.watchAddress(userId, chain, address, label ?? null);
  try {
    const activity = await getWalletActivity(address as Address, 30, chain);
    dbService.updateWatchSnapshot(id, activity.balanceWei.toString(), activity.transfers.length);
    await ctx.reply(
      `✅ *Watching* ${label ? `*${label}* ` : ""}\`${address}\` on ${getChainConfig(chain).name}.\n\n💰 Balance: \`${activity.balanceEth} ${activity.symbol}\`\n📦 Recent transfers: \`${activity.transfers.length}\`\n\nZensweep will DM you when it moves.`,
      { parse_mode: "Markdown", reply_markup: mainKeyboard }
    );
  } catch (err: any) {
    await ctx.reply(
      `✅ *Watch #${id} saved* for \`${address}\` on ${getChainConfig(chain).name} (live snapshot unavailable: ${err?.message ?? "RPC error"}).`,
      { parse_mode: "Markdown", reply_markup: mainKeyboard }
    );
  }
}

async function handleQuickWatch(ctx: Context, address: string) {
  const userId = ctx.from?.id;
  if (!userId) return;
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return;
  const chain = dbService.getUser(userId)?.selected_chain || DEFAULT_CHAIN_KEY;
  const id = dbService.watchAddress(userId, chain, address, null);
  await ctx.reply(`✅ *Watch #${id} saved* for \`${address}\` on ${getChainConfig(chain).name}.`, {
    parse_mode: "Markdown",
    reply_markup: mainKeyboard,
  });
}

async function handleUnwatch(ctx: Context, arg: string) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const id = Number(arg.trim().split(/\s+/)[0]);
  if (!Number.isInteger(id)) {
    await ctx.reply("Usage: `/unwatch <watch_id>` — see /watchlist for IDs.", {
      parse_mode: "Markdown",
      reply_markup: mainKeyboard,
    });
    return;
  }
  const ok = dbService.unwatchAddress(userId, id);
  await ctx.reply(ok ? `🗑 Watch #${id} removed.` : `⚠️ No watch #${id} found.`, {
    parse_mode: "Markdown",
    reply_markup: mainKeyboard,
  });
}

async function handleUnwatchById(ctx: Context, watchId: number) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const ok = dbService.unwatchAddress(userId, watchId);
  await ctx.reply(ok ? `🗑 Watch #${watchId} removed.` : `⚠️ Watch not found.`, {
    parse_mode: "Markdown",
    reply_markup: mainKeyboard,
  });
}

async function handleRefreshWatch(ctx: Context, watchId: number) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const watch = dbService.getUserWatches(userId).find((w) => w.id === watchId);
  if (!watch) {
    await ctx.reply("⚠️ Watch not found.", { parse_mode: "Markdown", reply_markup: mainKeyboard });
    return;
  }
  try {
    const activity = await getWalletActivity(watch.address as Address, 30, watch.chain);
    dbService.updateWatchSnapshot(watchId, activity.balanceWei.toString(), activity.transfers.length);
    const cfg = getChainConfig(watch.chain);
    let msg = `🔄 *${watch.label ?? "Watched address"}* [${cfg.name}]\n\n`;
    msg += `\`${watch.address}\`\n`;
    msg += `💰 Balance: \`${activity.balanceEth} ${activity.symbol}\`\n`;
    if (activity.transfers.length === 0) {
      msg += `\nNo native transfers in the scanned window.`;
    } else {
      msg += `\n*Recent transfers:*\n`;
      for (const t of activity.transfers.slice(0, 5)) {
        const dir = t.from.toLowerCase() === watch.address.toLowerCase() ? "➡️ OUT" : "⬅️ IN";
        msg += `${dir} ${t.valueEth} ${activity.symbol} — [tx](${cfg.explorerUrl}/tx/${t.txHash})\n`;
      }
    }
    await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: mainKeyboard });
  } catch (err: any) {
    await ctx.reply(`⚠️ Live check failed: ${err?.message ?? "RPC error"}`, {
      parse_mode: "Markdown",
      reply_markup: mainKeyboard,
    });
  }
}

async function renderAlertsMenu(ctx: Context) {
  const projects = await fetchLaunchProjects();
  const alertProjects = projects.filter((project) => project.status === "live" || project.status === "minting");

  let msg = `🟡 *Zensweep Alerts*\n\n`;
  const deployOn = dbService.isDeployAlertsEnabled(ctx.from?.id ?? 0);
  msg += `🆕 Deployment auto-alerts: ${deployOn ? "🔔 *ON* — you'll be DMed new contract drops" : "🔕 *MUTED* — no deployment DMs"}\n`;
  msg += `${deployOn ? "Tap 🔕 Mute below to stop." : "Tap 🔔 Unmute below to re-enable."}\n\n`;
  if (alertProjects.length === 0) {
    msg += `No live or minting launches right now. Zensweep will surface them here as soon as a project flips into an active launch stage.`;
  } else {
    msg += `Active launch alerts:\n\n`;
    for (const project of alertProjects) {
      msg += `• ${project.name} — *${getLaunchStatusLabel(project.status)}*\n`;
      msg += `  ${project.summary}\n`;
      msg += `  Mint: \`${project.mintDate}\`\n\n`;
    }
  }

  const kb = new InlineKeyboard();
  kb.text(deployOn ? "🔕 Mute Deployment Alerts" : "🔔 Unmute Deployment Alerts", "deploy_alert_toggle")
    .row()
    .text("🔔 Alerts", "menu_alerts")
    .text("📊 Status", "menu_status")
    .row()
    .text("🔙 Main Menu", "menu_main");

  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: kb });
}

async function renderStatusMenu(ctx: Context) {
  const userId = ctx.from?.id;
  const user = userId ? dbService.getUser(userId) : undefined;
  const chain = user?.selected_chain || DEFAULT_CHAIN_KEY;
  const chainConfig = getChainConfig(chain);

  let healthLine = "🔴 chain unreachable";
  try {
    const h = await getChainHealth(ELYSIUM.key);
    healthLine = `🟢 block \`${h.blockNumber}\` • gas \`${h.gasPriceGwei} gwei\``;
  } catch {
    // keep fallback
  }
  const watches = userId ? dbService.getUserWatches(userId).length : 0;

  let msg = `🟢 *Zensweep Status*\n\n`;
  msg += `🌐 Active network: \`${chainConfig.name}\`\n`;
  msg += `⛓ Elysium live: ${healthLine}\n`;
  msg += `🔐 Wallet status: ${user ? "connected" : "not connected"}\n`;
  msg += `📦 Tracked projects: ${kiwiLaunches.length}\n`;
  msg += `👀 Watched addresses: ${watches}\n`;
  msg += `\nZensweep watches Elysium on-chain: fresh deployments, mint windows, and wallet movement.`;

  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: mainKeyboard });
}

async function renderTokenCard(ctx: Context, token: Address) {
  const userId = ctx.from?.id;
  const w = userId ? walletManager.getUserWallet(userId) : undefined;
  let meta: Awaited<ReturnType<typeof getDeploymentMeta>> | null = null;
  try { meta = await getDeploymentMeta(token, ELYSIUM.key); } catch {}
  const explorer = getChainConfig(ELYSIUM.key).explorerUrl;
  if (meta && meta.kind === "nft") {
    const name = meta.name ?? "NFT Collection";
    const sym = meta.symbol ? ` ($${meta.symbol})` : "";
    const short = `\`${token.slice(0, 10)}…\``;
    const url = explorer ? `${explorer}/address/${token}` : undefined;
    const msg = `🖼️ *${name}${sym}* — NFT\n${short} ${token}\n\n*Collection on Elysium* — not a fungible token.\n${url ? `🔍 [View on Explorer](${url}) • ` : ""}👀 Tap Watch to track holders.\n\n*This is an NFT — trading via Kalos, not HYPE swaps.* No Price / Liquidity / Slippage here. Use \`/watch\` or hunter feed \`/deployments\`.`;
    await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: makeNftCardKeyboard(token, url) });
    return;
  }
  if (meta && meta.kind === "contract") {
    const sz = meta.bytecodeSize ? `${meta.bytecodeSize} bytes` : "—";
    await ctx.reply(`📄 *Not a tradable token* — \`${token}\`\n\nKind: Contract • Size: ${sz}\nTry hunter feed \`/deployments\` or \`/watch\` to track it.`, { parse_mode: "Markdown", reply_markup: mainKeyboard });
    return;
  }
  await ctx.reply(`🔍 Analyzing \`${token}\` on Elysium…`, { parse_mode: "Markdown" });
  let report;
  try {
    report = await analyzeToken(token, ELYSIUM.key, w?.address as unknown as Address);
  } catch (e: any) {
    await ctx.reply(`⚠️ Could not analyze token: ${e?.message ?? "unknown"}`, { parse_mode: "Markdown", reply_markup: mainKeyboard });
    return;
  }
  // Market lines — best-effort, paper-mode aware
  let priceLine = `Price: n/a (paper mode — no DEX pool indexed yet)`;
  let liquidityLine = `Liquidity: n/a (paper mode)`;
  let supplyLine = `Supply: n/a`;
  let slippagePct = "10%";
  try {
    if (userId) slippagePct = `${(dbService.getSlippageBps(userId) / 100).toFixed(0)}%`;
  } catch {}
  try {
    if (meta?.totalSupplyFormatted) supplyLine = `Supply: ${meta.totalSupplyFormatted}`;
    else if (meta?.kind === "token") supplyLine = `Supply: ${meta.name ?? ""} (${meta.symbol ?? ""})`;
  } catch {}
  // Try live quote if router is set — otherwise keep paper lines
  try {
    const { quoteBuy } = await import("../engine/trading");
    const q = await quoteBuy(token, parseEther("0.01") as any);
    const out = Number(q.amountOutWei) / 1e18;
    if (out > 0) {
      const perToken = 0.01 / out;
      priceLine = `Price: ${perToken.toExponential(3)} HYPE`;
      liquidityLine = `Liquidity: live pool (quote ok)`;
    }
  } catch {}
  let balLine = "";
  if (w) {
    try { const b = await tradingService.getTokenBalance(token, w.address as Address); balLine = `\n💼 Your balance: \`${b.formatted} ${b.symbol ?? ""}\``; } catch {}
  } else balLine = "\n💼 No wallet yet — create one to trade.";
  const fixedTitle = meta?.kind === "token" && meta?.name ? `${meta.name} ($${meta.symbol ?? "—"})` : null;
  const title = fixedTitle ?? (report.name && report.symbol ? `${report.name} ($${report.symbol})` : report.symbol ? `$${report.symbol}` : `Token \`${token.slice(0, 10)}…\``);
  const inlineSafety = formatSafetyInline(report);
  const msg = `*${title}*\n\`${token}\`\n\n${priceLine}\n${liquidityLine}\n${supplyLine}\nSlippage: ${slippagePct}\n\n${inlineSafety}${balLine}\n\n${formatSafetyReport(report)}\n\n${report.safe ? "✅ Ready to buy — tap below." : "⚠️ Review flags before buying."}`;
  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: makeTokenCardKeyboard(token) });
}

async function renderSafetyCard(ctx: Context, token: Address) {
  const userId = ctx.from?.id;
  const w = userId ? walletManager.getUserWallet(userId) : undefined;
  await ctx.reply(`🛡️ Safety check for \`${token}\`…`, { parse_mode: "Markdown" });
  try {
    const r = await analyzeToken(token, ELYSIUM.key, w?.address as unknown as Address);
    await ctx.reply(formatSafetyReport(r), { parse_mode: "Markdown", reply_markup: makeSafetyKeyboard(token) });
  } catch (e: any) {
    await ctx.reply(`⚠️ Check failed: ${e?.message ?? "unknown"}`, { parse_mode: "Markdown", reply_markup: mainKeyboard });
  }
}

async function renderSafetyInfo(ctx: Context) {
  await ctx.reply(
    `🛡️ *Zensweep Safety Engine*\n\nZensweep runs a pre-buy simulation FROM your wallet with your real amount. If it flags a scam, Zensweep blocks or asks you to confirm first. Scans honeypot (sell revert), owner/mint, blacklist, and upgradeable proxy — no guesswork. Checks catch common traps, but no scan can guarantee a token is safe.\n🟢 SAFE ≥85 • 🟡 RISKY 60-84 • 🔴 BLOCKED/UNSAFE <60 or honeypot.\n\nPaste any \`0x…\` → safety card, or \`/safety 0x…\`.`,
    { parse_mode: "Markdown", reply_markup: mainKeyboard }
  );
}

async function renderSlippageMenu(ctx: Context) {
  const uid = ctx.from?.id;
  if (!uid) return;
  const bps = dbService.getSlippageBps(uid);
  await ctx.reply(
    `⚙️ *Slippage* — how much price movement you'll accept\n\nCurrent: \`${bps / 100}%\` — Zensweep will use this for every buy/sell so it's harder to front-run.\n\nPick one:`,
    { parse_mode: "Markdown", reply_markup: makeSlippageKeyboard(bps) }
  );
}

async function _missingTradingHandlersStub() {} // keep file valid while inserting

async function handleTokenBuy(ctx: Context, token: Address, amountStr: string) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const w = walletManager.getUserWallet(userId);
  if (!w) { await ctx.reply("⚠️ Create a wallet first.", { reply_markup: noWalletKeyboard, parse_mode: "Markdown" }); return; }
  const amt = Number(amountStr);
  if (!Number.isFinite(amt) || amt <= 0 || amt > 10000) { await ctx.reply("❌ Invalid amount. Use 0.1, 0.5, or 1 HYPE.", { parse_mode: "Markdown" }); return; }
  let pre;
  try { pre = await analyzeToken(token, ELYSIUM.key, w.address as Address); } catch {}
  if (pre?.checks.honeypot) {
    await ctx.reply(`🔴 *BLOCKED — honeypot.*\n\n${formatSafetyReport(pre)}\n\nBuy cancelled.`, { parse_mode: "Markdown", reply_markup: makeSafetyKeyboard(token) });
    return;
  }
  if (pre && !pre.safe) {
    await ctx.reply(`🟡 *Risky — confirm buy?*\n\n${formatSafetyReport(pre)}\n\nReply *CONFIRM BUY* to proceed.`, { parse_mode: "Markdown" });
    userStates[userId] = { step: "awaiting_token_buy_confirm", data: { token, amountStr } };
    return;
  }
  await executeTokenBuy(ctx, token, amountStr);
}
async function executeTokenBuy(ctx: Context, token: Address, amountStr: string) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) return;
  const HYPE_GATE_MSG = `❌ *Not enough HYPE.* This trade costs \`${amountStr} HYPE\` + gas.`;
  let balStr = "0";
  try {
    const b = await walletManager.getBalance(wallet.address, ELYSIUM.key, true);
    balStr = b.eth;
    if (Number(b.eth) < Number(amountStr)) {
      const kb = new InlineKeyboard().text("💧 Get Testnet HYPE", "wallet_faucet").row().text("🔄 Check Again", `tok_card_${token}`).row().text("🔙 Main Menu", "menu_main");
      await ctx.reply(`${HYPE_GATE_MSG}\n\n💼 Balance: \`${b.eth} HYPE\``, { parse_mode: "Markdown", reply_markup: kb });
      return;
    }
  } catch {}
  const hypeInWei = parseEther(amountStr);
  await ctx.reply(`⏳ Buying with *${amountStr} HYPE*…`, { parse_mode: "Markdown" });
  try {
    const { quoteBuy } = await import("../engine/trading");
    let routerMissing = false;
    try { await quoteBuy(token, hypeInWei); } catch (e: any) {
      if (String(e?.message ?? "").includes("Trading not configured")) routerMissing = true;
      else {
        await ctx.reply(`⚠️ Quote failed (no liquidity yet): ${e?.message ?? "unknown"}. On testnet this is expected until DEX is live.`, { parse_mode: "Markdown", reply_markup: makeTokenCardKeyboard(token) });
        return;
      }
    }
    if (routerMissing) {
      const mockTokensOutWei = hypeInWei * 1000n;
      const paperTx = `paper-buy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` as `0x${string}`;
      let symbol: string | null = null;
      try { symbol = (await tradingService.getTokenBalance(token, wallet.address as Address)).symbol; } catch {}
      try { dbService.recordBuyPosition(userId, ELYSIUM.key, token, hypeInWei, mockTokensOutWei, symbol); } catch {}
      try { dbService.recordTrade(userId, ELYSIUM.key, token, "buy", Number(amountStr), paperTx, "buy"); } catch {}
      await ctx.reply(
        `📝 *Paper buy recorded* — \`${amountStr} HYPE\` → \`${token.slice(0, 10)}…\`\n\n` +
        `No DEX router is configured on Elysium testnet yet, so this is a synthetic position that lets you test the full loop. ` +
        `Check \`/portfolio\` for PnL and the shareable card. Live swaps run through \`ELYSIUM_ROUTER_ADDRESS\` on mainnet — no code change needed.\n\n` +
        `Tx \`${paperTx}\``,
        { parse_mode: "Markdown", reply_markup: makeTokenCardKeyboard(token) }
      );
      return;
    }
    const { txHash } = await tradingService.executeBuy(wallet.privateKey as Hex, token, hypeInWei);
    let outWei = 0n;
    try { outWei = (await tradingService.getTokenBalance(token, wallet.address as Address)).raw; } catch {}
    try { dbService.recordBuyPosition(userId, ELYSIUM.key, token, hypeInWei, outWei, null); } catch {}
    try { dbService.recordTrade(userId, ELYSIUM.key, token, "buy", Number(amountStr), txHash, "buy"); } catch {}
    await ctx.reply(`✅ Bought — \`${amountStr} HYPE\` → \`${token.slice(0, 10)}…\` Tx \`${txHash}\``, { parse_mode: "Markdown", reply_markup: makeTokenCardKeyboard(token) });
  } catch (e: any) {
    const m = e?.message ?? "unknown";
    if (m.includes("Trading not configured")) await ctx.reply(`ℹ️ Buy not live yet on testnet. DEX router not set — safety cards + /watch are live.`, { parse_mode: "Markdown", reply_markup: makeTokenCardKeyboard(token) });
    else await ctx.reply(`❌ Buy failed: ${m}`, { parse_mode: "Markdown", reply_markup: makeTokenCardKeyboard(token) });
  }
}




async function handleTokenSell(ctx: Context, token: Address, pctStr: string) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const w2 = walletManager.getUserWallet(userId);
  if (!w2) { await ctx.reply("⚠️ Create a wallet first.", { reply_markup: noWalletKeyboard, parse_mode: "Markdown" }); return; }
  const pct = Number(pctStr);
  if (![25, 50, 100].includes(pct)) { await ctx.reply("Use 25, 50, or 100.", { parse_mode: "Markdown" }); return; }
  const { ELYSIUM_ROUTER_ADDRESS: _routerForSell } = await import("../config");
  const isPaperSell = !_routerForSell;
  let bal: { raw: bigint; formatted: string; symbol: string | null };
  if (isPaperSell) {
    const pos = dbService.getPosition(userId, ELYSIUM.key, token);
    if (!pos || BigInt(pos.balance_wei) === 0n) { await ctx.reply(`You hold 0 of \`${token}\` (paper). Buy first to create a position.`, { parse_mode: "Markdown", reply_markup: makeTokenCardKeyboard(token) }); return; }
    bal = { raw: BigInt(pos.balance_wei), formatted: formatEther(BigInt(pos.balance_wei)), symbol: pos.symbol };
  } else {
    try { bal = await tradingService.getTokenBalance(token, w2.address as Address) as any; } catch (e: any) { await ctx.reply(`⚠️ Balance read failed: ${e?.message ?? "unknown"}`, { parse_mode: "Markdown" }); return; }
    if (bal.raw === 0n) { await ctx.reply(`You hold 0 of \`${token}\`.`, { parse_mode: "Markdown", reply_markup: makeTokenCardKeyboard(token) }); return; }
  }
  if (pct === 100) {
    await ctx.reply(`You hold \`${bal.formatted} ${bal.symbol ?? ""}\`. Sell 100%? Reply *CONFIRM SELL*.`, { parse_mode: "Markdown" });
    userStates[userId] = { step: "awaiting_token_sell_confirm", data: { token, balRaw: bal.raw.toString() } };
    return;
  }
  await executeTokenSell(ctx, token, pctStr, bal.raw);
}

async function executeTokenSell(ctx: Context, token: Address, pctStr: string, balRaw: bigint) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) return;
  const pct = Number(pctStr);
  const amount = balRaw * BigInt(pct) / 100n;
  if (amount === 0n) { await ctx.reply("Amount too small."); return; }
  await ctx.reply(`⏳ Selling *${pct}%*…`, { parse_mode: "Markdown" });
  try {
    const { ELYSIUM_ROUTER_ADDRESS: _rSell } = await import("../config");
    if (!_rSell) {
      const hypeOut = amount / 1000n;
      const paperTx = ("paper-sell-" + Date.now().toString(36)) as `0x${string}`;
      try { dbService.recordSellPosition(userId, ELYSIUM.key, token, amount, hypeOut); } catch {}
      try { dbService.recordTrade(userId, ELYSIUM.key, token, pctStr, Number(formatEther(amount)), paperTx, "sell"); } catch {}
      await ctx.reply(`\uD83D\uDCDD *Paper sell recorded* \u2014 \`${pct}%\` Tx \`${paperTx}\``, { parse_mode: "Markdown", reply_markup: makeTokenCardKeyboard(token) });
      return;
    }
    const { txHash } = await tradingService.executeSell(wallet.privateKey as Hex, token, amount);
    let hypeOut = 0n;
    try { const q = await (await import("../engine/trading")).quoteSell(token, amount); hypeOut = q.amountOutWei; } catch {}
    try { dbService.recordSellPosition(userId, ELYSIUM.key, token, amount, hypeOut); } catch {}
    try { dbService.recordTrade(userId, ELYSIUM.key, token, pctStr, Number(formatEther(amount)), txHash, "sell"); } catch {}
    await ctx.reply(`✅ *Sold ${pct}%* — \`${token.slice(0, 10)}…\` Tx \`${txHash}\``, { parse_mode: "Markdown", reply_markup: makeTokenCardKeyboard(token) });
  } catch (e: any) { await ctx.reply(`❌ Sell failed: ${e?.message ?? "unknown"}`, { parse_mode: "Markdown", reply_markup: makeTokenCardKeyboard(token) }); }
}

async function renderPortfolioMenu(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const pos = dbService.getPositions(userId);
  if (pos.length === 0) {
    await ctx.reply(`🟢 *Portfolio*\n\nNo positions yet. Paste a token and buy to start.`, { parse_mode: "Markdown", reply_markup: mainKeyboard });
    return;
  }
  let msg2 = `🟢 *Portfolio* — ${pos.length} token(s)\n\n`;
  let wins = 0, losses = 0; let totalPnlWei = 0n;
  for (const p of pos.slice(0, 10)) {
    const bal = BigInt(p.balance_wei); const spent = BigInt(p.total_spent_wei); const recv = BigInt(p.total_received_wei);
    const pnl = recv - spent; totalPnlWei += pnl;
    if (pnl > 0n) wins++; else if (pnl < 0n) losses++;
    const sym = p.symbol ? `$${p.symbol}` : p.token.slice(0, 10) + "…";
    const s = (pnl >= 0n ? "+" : "") + formatEther(pnl < 0n ? -pnl : pnl);
    if (pnl < 0n) msg2 += `🔴 ${sym} — PnL ${s} HYPE • bal ${formatEther(bal)}\n`;
    else if (pnl > 0n) msg2 += `🟢 ${sym} — PnL +${formatEther(pnl)} HYPE • bal ${formatEther(bal)}\n`;
    else msg2 += `⚪ ${sym} — even • bal ${formatEther(bal)}\n`;
  }
  const rate = (wins + losses) ? Math.round((wins / (wins + losses)) * 100) : 0;
  msg2 += `\n*Win rate:* ${rate}% (${wins}W/${losses}L) • *Total PnL:* ${totalPnlWei < 0n ? "-" + formatEther(-totalPnlWei) : formatEther(totalPnlWei)} HYPE`;
  await ctx.reply(msg2, { parse_mode: "Markdown", reply_markup: makePortfolioKeyboard() });
}

async function handlePortfolioShare(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const pos = dbService.getPositions(userId);
  if (pos.length === 0) { await ctx.reply("No positions to share yet.", { parse_mode: "Markdown" }); return; }
  let wins = 0, losses = 0; let totalPnlWei = 0n;
  for (const p of pos) { const pnl = BigInt(p.total_received_wei) - BigInt(p.total_spent_wei); totalPnlWei += pnl; if (pnl > 0n) wins++; else if (pnl < 0n) losses++; }
  const rate = wins + losses ? Math.round(wins / (wins + losses) * 100) : 0;
  const card = `🏆 *Zensweep PnL Card* • @zensweep_bot\n\n*Total PnL:* ${totalPnlWei < 0n ? "-" + formatEther(-totalPnlWei) : formatEther(totalPnlWei)} HYPE${totalPnlWei < 0n ? " 🔴" : " 🟢"}\n*Win rate:* ${rate}% (${wins}W/${losses}L) over ${pos.length} token(s)\n*Chain:* Elysium • *Bot:* @zensweep_bot\n\n#Elysium #Zensweep`;
  await ctx.reply(card, { parse_mode: "Markdown", reply_markup: makePortfolioKeyboard() });
}

async function handleFaucet(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const user = dbService.getUser(userId);
  if (!user) { await ctx.reply("Create a wallet first.", { reply_markup: noWalletKeyboard, parse_mode: "Markdown" }); return; }
  const gate = dbService.canFaucet(userId);
  if (!gate.ok) {
    const mins = Math.ceil(gate.waitMs / 60_000);
    await ctx.reply(`⏳ Faucet on cooldown — try again in \`${mins}m\`.`, { parse_mode: "Markdown", reply_markup: walletKeyboard });
    return;
  }
  const faucetKey = process.env.FAUCET_PRIVATE_KEY ?? "";
  const faucetUrl = process.env.FAUCET_URL ?? "https://elysium.kinetiq.xyz";
  if (!faucetKey) {
    const msg = `💧 *Get Testnet HYPE*\n\nTestnet needs real testnet HYPE to buy. Claim from the faucet, then retry your trade.\n\n🔗 ${faucetUrl}\n\nPaste your wallet to prefill:\n\`${user.wallet_address}\``;
    await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: walletKeyboard });
    return;
  }
  try {
    await ctx.reply(`⏳ Dripping testnet HYPE to \`${user.wallet_address}\`…`, { parse_mode: "Markdown" });
    const dripWei = BigInt(process.env.FAUCET_DRIP_WEI ?? "100000000000000000");
    const { createPublicClient, createWalletClient, http, parseEther } = await import("viem");
    const { privateKeyToAccount } = await import("viem/accounts");
    const elysium = getChainConfig("elysium");
    const faucetAccount = privateKeyToAccount(faucetKey as `0x${string}`);
    const faucetClient = createWalletClient({ account: faucetAccount, chain: elysium.viemChain, transport: http(elysium.rpcUrl) });
    const pub = createPublicClient({ chain: elysium.viemChain, transport: http(elysium.rpcUrl) });
    const hash = await faucetClient.sendTransaction({ account: faucetAccount, to: user.wallet_address as `0x${string}`, value: dripWei, chain: elysium.viemChain });
    await pub.waitForTransactionReceipt({ hash });
    dbService.markFaucet(userId);
    const kb = new InlineKeyboard().text("🔄 Refresh Balance", "wallet_refresh").text("📄 Explorer", `${faucetUrl}/address/${user.wallet_address}`).row().text("🔙 Main Menu", "menu_main");
    await ctx.reply(`✅ *Dripped ${dripWei / 1_000_000_000_000_000n / 10n / 100n} HYPE* → \`${user.wallet_address}\`\n\nTx: \`${hash}\`\n\nNow retry your Buy.`, { parse_mode: "Markdown", reply_markup: kb });
  } catch (e: any) {
    await ctx.reply(`❌ Faucet failed: ${e?.shortMessage ?? e?.message ?? "unknown"}. Fund FAUCET_PRIVATE_KEY with testnet HYPE or share ${process.env.FAUCET_URL ?? "https://elysium.kinetiq.xyz"}`, { parse_mode: "Markdown", reply_markup: walletKeyboard });
  }
}

async function handleExportKey(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const pk = walletManager.exportPrivateKey(userId);
  if (!pk) { await ctx.reply("No wallet found.", { reply_markup: noWalletKeyboard, parse_mode: "Markdown" }); return; }
  await ctx.reply(`🔑 *Private Key Export*\n\n\`${pk}\`\n\n⚠️ Anyone with this key controls the wallet. Delete after importing to MetaMask.`, { parse_mode: "Markdown" });
}

async function handleWalletImport(ctx: Context, raw: string) {
  const userId = ctx.from?.id; if (!userId) return;
  const cleaned = raw.trim().replace(/\s+/g, "");
  const k = cleaned.startsWith("0x") || cleaned.startsWith("0X") ? cleaned : `0x${cleaned}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) {
    await ctx.reply(`❌ Invalid key — got \`${cleaned.slice(0, 12)}…${cleaned.slice(-6)}\` (${cleaned.replace(/^0x/i, "").length} chars). Need exactly **64 hex chars**, with or without \`0x\`.`, { parse_mode: "Markdown" });
    return;
  }
  try {
    const w = walletManager.importWallet(userId, k);
    await ctx.reply(`✅ Wallet switched to \`${w.address}\` — encrypted and live.`, { parse_mode: "Markdown", reply_markup: mainKeyboard });
    try { await ctx.deleteMessage(); } catch {}
  } catch (e: any) {
    await ctx.reply(`❌ Import failed: ${e?.message ?? "unknown"}`, { parse_mode: "Markdown" });
  }
}

async function promptWalletChange(ctx: Context) {
  const userId = ctx.from?.id; if (!userId) return;
  const existing = dbService.getUser(userId);
  if (!existing) {
    const w = walletManager.createNewWallet(userId);
    await ctx.reply(`✅ Wallet created: \`${w.address}\`\n\nUse \`/export\` to back it up.`, { parse_mode: "Markdown", reply_markup: mainKeyboard });
    return;
  }
  userStates[userId] = { step: "awaiting_wallet_change_confirm" };
  await ctx.reply(
    `⚠️ *Change Wallet?*\n\nCurrent: \`${existing.wallet_address}\`\nThis creates a NEW wallet and overwrites the stored key. Withdraw first if you have funds.\n\nReply *CONFIRM* to create new wallet, or \`/cancel\`.`,
    { parse_mode: "Markdown" }
  );
}


async function renderHelpMenu(ctx: Context) {
  let msg = `ℹ️ *Zensweep Help*\n\n`;
  msg += `*Elysium-native:*\n`;
  msg += `• \`/launch\` — Tracked Ascend/Elysium launches\n`;
  msg += `• \`/mints\` — Mint-window countdowns\n`;
  msg += `• \`/elysium\` — Live chain health (block, gas)\n`;
  msg += `• \`/deployments\` — Fresh on-chain deployments\n`;
  msg += `• \`/watch <0x…> [label]\` — Track a wallet/contract\n`;
  msg += `• \`/watchlist\` — Your tracked addresses\n`;
  msg += `• \`/unwatch <id>\` — Stop tracking\n`;
  msg += `\n`;
  msg += `*Trading (Elysium HYPE):*\n`;
  msg += `• Paste any \`0x…\` → Zensweep card + Safety → Buy/Sell\n`;
  msg += `• \`/buy <0x…> <HYPE>\` / \`/sell <0x…> [25|50|100]\` (+ Buy X custom)\n`;
  msg += `• \`/safety <0x…>\` — honeypot/mint/blacklist/proxy — score 0–100\n`;
  msg += `• \`/portfolio\` — results, history and a share card\n`;
  msg += `• \`/slippage\` — your price tolerance (1–50%)\n`;
  msg += `• \`/copy\` — Zensweep Auto-Follow up to 5 wallets (V2)\n`;
  msg += `\n*Safety — Zensweep engine*\n`;
  msg += `Pre-buy simulation FROM your wallet (your real amount). Flags honeypot, mint, blacklist, proxy. If it flags a scam, Zensweep blocks or asks you to confirm. No scan can guarantee safety.\n`;
  msg += `\n*Your funds*\n`;
  msg += `\`/withdraw\` sends HYPE out at any time. \`/export\` shows your private key: never share it with anyone.\n`;
  msg += `\n*Wallet:*\n`;
  msg += `• \`/wallet\` — Address, balance & withdraw\n`;
  msg += `\n*Elysium note:*\n`;
  msg += `Cross-chain secondary markets are archived in Elysium-only mode. Use /launch and /deployments for Elysium-native discovery.\n`;
  msg += `\n`;
  msg += `*Zensweep focus:*\n`;
  msg += `- Live Elysium launch & deployment monitoring\n`;
  msg += `- Mint-window countdowns and alerts\n`;
  msg += `- On-chain wallet tracking for Ascend launches`;
  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: mainKeyboard });
}