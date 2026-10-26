import { Bot, Context, InlineKeyboard } from "grammy";
import { dbService, type TaskRow } from "../db";
import { kiwiLaunches, fetchLaunchProjects, buildLaunchCard, getLaunchStatusLabel, mintWindowLine, getMintWindowState, formatMintCountdown } from "../data/launches";
import { walletManager } from "../wallet/manager";
import { SUPPORTED_CHAINS, getChainConfig, FEE_PERCENTAGE, FEE_RECIPIENT_WALLET, ELYSIUM, DEFAULT_CHAIN_KEY, ZENSWEEP_LAUNCH_API_URL } from "../config";
import { marketplaceService } from "../engine/marketplace";
import { minterService } from "../engine/minter";
import { kalosService } from "../engine/kalos";
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
  makeNftActionsKeyboard,
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

/** Escape Telegram legacy-Markdown special chars in dynamic text (names, etc). */
function escMd(input: string): string {
  return String(input ?? "").replace(/([_*`[])/g, "\\$1");
}

/** Best-effort HYPE balance read. Returns null when the RPC can't be reached (NOT zero). */
async function tryReadHypeBalance(address: Address): Promise<bigint | null> {
  try {
    const cfg = getChainConfig(ELYSIUM.key);
    const { createPublicClient, http } = await import("viem");
    const pc = createPublicClient({ chain: cfg.viemChain, transport: http(cfg.rpcUrl) });
    return (await pc.getBalance({ address })) as bigint;
  } catch { return null; }
}
// Collection metadata cache: names rarely change — avoid re-hammering the RPC every menu open.
const collectionMetaCache = new Map<string, { name: string; symbol: string; at: number }>();
const COLLECTION_META_TTL_MS = 10 * 60_000;
// In-memory conversation state for multi-step prompts
const userStates: Record<number, { step: string; data?: any }> = {};

function isUserConfirmation(text: string): boolean {
  const norm = text.trim().toUpperCase();
  return ["CONFIRM", "YES", "Y", "OK", "BUY", "MINT", "LIST", "PROCEED", "SURE", "CONFIRM BUY"].includes(norm);
}

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

  bot.command("collections", async (ctx) => {
    await renderCollectionsMenu(ctx);
  });
  bot.command("collection", async (ctx) => {
    await renderCollectionsMenu(ctx);
  });
  bot.command("sweep", async (ctx) => {
    const arg = ctx.message?.text?.split(/\s+/).slice(1).join(" ") ?? "";
    await handleSweepCommand(ctx, arg);
  });
  // /floor is the legacy read-only floor check (prompt → lookup via Kalos).

  bot.command("nfts", async (ctx) => {
    await renderNFTsMenu(ctx);
  });
  bot.command("inventory", async (ctx) => {
    await renderNFTsMenu(ctx);
  });

  bot.command("mint", async (ctx) => {
    const raw = ctx.message?.text?.split(/\s+/).slice(1).join(" ") ?? "";
    if (raw) await handleMintParams(ctx, raw);
    else await promptMint(ctx);
  });

  bot.command("nftbuy", async (ctx) => {
    const raw = ctx.message?.text?.split(/\s+/).slice(1).join(" ") ?? "";
    await promptNftBuy(ctx, raw);
  });
  bot.command("buyitem", async (ctx) => {
    const raw = ctx.message?.text?.split(/\s+/).slice(1).join(" ") ?? "";
    await promptNftBuy(ctx, raw);
  });

  bot.command("nftlist", async (ctx) => {
    const raw = ctx.message?.text?.split(/\s+/).slice(1).join(" ") ?? "";
    await promptNftList(ctx, raw);
  });
  bot.command("list", async (ctx) => {
    const raw = ctx.message?.text?.split(/\s+/).slice(1).join(" ") ?? "";
    await promptNftList(ctx, raw);
  });

  bot.command("nftdelist", async (ctx) => {
    const raw = ctx.message?.text?.split(/\s+/).slice(1).join(" ") ?? "";
    await promptNftDelist(ctx, raw);
  });
  bot.command("delist", async (ctx) => {
    const raw = ctx.message?.text?.split(/\s+/).slice(1).join(" ") ?? "";
    await promptNftDelist(ctx, raw);
  });

  bot.command("nftoffer", async (ctx) => {
    const raw = ctx.message?.text?.split(/\s+/).slice(1).join(" ") ?? "";
    await promptNftOffer(ctx, raw);
  });
  bot.command("offer", async (ctx) => {
    const raw = ctx.message?.text?.split(/\s+/).slice(1).join(" ") ?? "";
    await promptNftOffer(ctx, raw);
  });

  bot.command("nftaccept", async (ctx) => {
    const raw = ctx.message?.text?.split(/\s+/).slice(1).join(" ") ?? "";
    await promptNftAccept(ctx, raw);
  });
  bot.command("accept", async (ctx) => {
    const raw = ctx.message?.text?.split(/\s+/).slice(1).join(" ") ?? "";
    await promptNftAccept(ctx, raw);
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

  bot.command("wrap", async (ctx) => {
    const arg = ctx.message?.text?.split(/\s+/)[1] ?? "";
    await handleWrap(ctx, arg || undefined);
  });
  bot.command("unwrap", async (ctx) => {
    const arg = ctx.message?.text?.split(/\s+/)[1] ?? "";
    await handleUnwrap(ctx, arg || undefined);
  });
  bot.callbackQuery("wallet_wrap", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id; if (!userId) return;
    userStates[userId] = { step: "awaiting_wrap_amount", data: { expiresAt: Date.now() + 5 * 60_000 } };
    const wallet = walletManager.getUserWallet(userId);
    let balLine = "";
    try {
      const { createPublicClient, http } = await import("viem");
      const cfg = getChainConfig(ELYSIUM.key);
      const pc = createPublicClient({ chain: cfg.viemChain, transport: http(cfg.rpcUrl) });
      const [native, w] = await Promise.all([
        pc.getBalance({ address: wallet!.address as Address }).catch(() => 0n),
        kalosService.whypeBalance(wallet!.address as Address).catch(() => ({ raw: 0n, symbol: "WHYPE" })),
      ]);
      const { formatEther } = await import("viem");
      balLine = `\n\nnative HYPE: \`${formatEther(native as bigint)}\` · WHYPE: \`${kalosService.formatPrice((w as any).raw)}\``;
    } catch {}
    await ctx.reply(
      `💰 *Wrap HYPE → WHYPE*\n\nBids escrow in WHYPE. Reply with an amount (e.g. \`0.1\`), or \`max\` to wrap everything except gas.${balLine}\n\nOr reply \`/cancel\`.`,
      { parse_mode: "Markdown" }
    );
  });
  bot.callbackQuery("wallet_unwrap", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id; if (!userId) return;
    userStates[userId] = { step: "awaiting_unwrap_amount", data: { expiresAt: Date.now() + 5 * 60_000 } };
    await ctx.reply(
      `💎 *Unwrap WHYPE → HYPE*\n\nReply with an amount (e.g. \`0.1\`), or \`max\` for all WHYPE.\n\nOr reply \`/cancel\`.`,
      { parse_mode: "Markdown" }
    );
  });

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

  // Taps on "🏷️ All" / "🏷️ Collections" explicitly re-open the menu.
  // Nothing else routes here: card Sweep/Buy/List/Offer buttons go straight
  // to their flows so a tap NEVER re-dumps the collections list.
  bot.callbackQuery("menu_collections", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await renderCollectionsMenu(ctx);
  });

  bot.callbackQuery("menu_nfts", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await renderNFTsMenu(ctx);
  });

  bot.callbackQuery("menu_mint", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await promptMint(ctx);
  });

  bot.callbackQuery(/^col_inspect_(0x[a-fA-F0-9]{40})$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await renderCollectionDetail(ctx, ctx.match[1] as Address);
  });

  bot.callbackQuery("col_inspect_prompt", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (!userId) return;
    userStates[userId] = { step: "awaiting_collection_inspect" };
    await ctx.reply("🔍 Send any NFT collection contract address (`0x...`) on Elysium:", { parse_mode: "Markdown" });
  });

  // Buy = "I know the token ID": paste ID first, then your max HYPE.
  // Flow: tap Buy → bot asks ONLY for the token ID (+ optional max) →
  // instant read: if listed at/below your max → 1-tap confirm, else offer fallback.
  bot.callbackQuery(/^kalos_buy_(0x[a-fA-F0-9]{40})$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (!userId) return;
    userStates[userId] = { step: "awaiting_buy_tokenid", data: { contract: ctx.match[1] as Address, expiresAt: Date.now() + 5 * 60_000 } };
    await ctx.reply(
      `🛒 *Buy from this collection*\n\nReply with the token ID + the MOST you'll pay:\n\n\`<tokenId> [maxHYPE]\`\n\n*Examples:*\n\`13578\` — buy #13578 at its listed price\n\`13578 0.5\` — buy #13578 only if ≤ 0.5 HYPE`,
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery(/^kalos_buy_(0x[a-fA-F0-9]{40})_(\d+)$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await promptNftBuy(ctx, `${ctx.match[1]} ${ctx.match[2]}`);
  });

  bot.callbackQuery(/^kalos_list_(0x[a-fA-F0-9]{40})(?:_(\d+))?$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const col = ctx.match[1] as Address;
    const tid = ctx.match[2];
    await promptNftList(ctx, tid ? `${col} ${tid}` : col);
  });

  bot.callbackQuery(/^kalos_delist_(0x[a-fA-F0-9]{40})_(\d+)$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await promptNftDelist(ctx, `${ctx.match[1]} ${ctx.match[2]}`);
  });

    bot.callbackQuery(/^kalos_offer_(0x[a-fA-F0-9]{40})$/i, async (ctx) => {
      ctx.answerCallbackQuery().catch(() => {});
      const userId = ctx.from?.id;
      if (!userId) return;
      userStates[userId] = { step: "awaiting_offer_any", data: { contract: ctx.match[1] as Address, expiresAt: Date.now() + 5 * 60_000 } };
      await ctx.reply(
        `🤝 *Make an Offer (token optional)*\n\nReply ONE of:\n\n\`<priceHYPE> [days]\` — offer on *any* token in this collection\n\`<tokenId> <priceHYPE> [days]\` — offer on a *specific* token\n\n*Examples:*\n\`0.5\` — 0.5 HYPE for any token (7 days)\n\`6187 0.5\` — 0.5 HYPE for #6187\n\`6187 0.5 3\` — 0.5 HYPE for #6187, 3 days`,
        { parse_mode: "Markdown" }
      );
    });

  bot.callbackQuery(/^kalos_offer_(0x[a-fA-F0-9]{40})_(\d+)$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const col = ctx.match[1] as Address;
    const tid = ctx.match[2];
    const userId = ctx.from?.id;
    if (!userId) return;
    // Token-level Offer tap (from sweep results / NFT cards): contract + token
    // known, only price + days still needed — mirror the List flow.
    userStates[userId] = { step: "awaiting_offer_price", data: { contract: col, tokenId: tid, expiresAt: Date.now() + 5 * 60_000 } };
    await ctx.reply(
      `🤝 *Offer on #${tid}*\n\nReply with your bid + optional days:\n\n\`<price_hype> [days]\`\n\n*Examples:*\n\`0.5\` — bid 0.5 HYPE for 7 days\n\`0.5 3\` — bid 0.5 HYPE for 3 days`,
      { parse_mode: "Markdown" }
    );
  });
  bot.callbackQuery(/^kalos_sweep_(0x[a-fA-F0-9]{40})$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await handleSweepCommand(ctx, ctx.match[1]);
  });
  bot.callbackQuery(/^kalos_sweepbuy_(0x[a-fA-F0-9]{40})_(\d+)$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const col = ctx.match[1] as Address;
    const tid = ctx.match[2];
    await promptNftBuy(ctx, `${col} ${tid}`);
  });
  bot.callbackQuery(/^kalos_sweepbuyN_(0x[a-fA-F0-9]{40})_(\d+)$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const col = ctx.match[1] as Address;
    const n = Math.max(1, Math.min(10, Number(ctx.match[2])));
    const userId = ctx.from?.id;
    if (!userId) return;
    const st = userStates[userId];
    // Two entry paths share this button:
    //  1) Fresh count pick (step awaiting_sweepN_pick or no state) -> run the sweep for N.
    //  2) Confirm tap after a multi-sweep preview (step awaiting_sweepN_confirm) -> execute stored items.
    if (st && st.step === "awaiting_sweepN_confirm" && st.data) {
      await executeSweepBuy(ctx, st.data.contract as Address, st.data.items as Array<{ tokenId: string; seller: string; price: string }>);
      return;
    }
    await renderSweepResults(ctx, col, (st?.data?.maxPriceEth as string | undefined) ?? undefined, n, false);
  });
  // Count-picker taps use kalos_sweepN_<addr>_<n> (no "buy" in the middle).
  // Same behavior as a fresh pick: run the sweep for N directly.
  bot.callbackQuery(/^kalos_sweepN_(0x[a-fA-F0-9]{40})_(\d+)$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const col = ctx.match[1] as Address;
    const n = Math.max(1, Math.min(10, Number(ctx.match[2])));
    const userId = ctx.from?.id;
    if (!userId) return;
    const st = userStates[userId];
    await renderSweepResults(ctx, col, (st?.data?.maxPriceEth as string | undefined) ?? undefined, n, false);
  });
  bot.callbackQuery("noop", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Already showing the cheapest live listing." }).catch(() => {});
  });

  bot.callbackQuery(/^kalos_mint_(0x[a-fA-F0-9]{40})$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await promptMint(ctx, ctx.match[1]);
  });

  bot.callbackQuery("confirm_nftbuy", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (!userId || !userStates[userId]?.data) return;
    const data = userStates[userId].data;
    delete userStates[userId];
    await executeNftBuy(ctx, data);
  });

  bot.callbackQuery("confirm_mint", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (!userId || !userStates[userId]?.data) return;
    const data = userStates[userId].data;
    delete userStates[userId];
    await executeMint(ctx, data);
  });

  bot.callbackQuery("confirm_nftlist", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (!userId || !userStates[userId]?.data) return;
    const data = userStates[userId].data;
    delete userStates[userId];
    await executeNftList(ctx, data);
  });

  bot.callbackQuery("confirm_nftapprove", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (!userId || !userStates[userId]?.data) return;
    const data = userStates[userId].data;
    delete userStates[userId];
    if (!data || Date.now() > (data.expiresAt ?? 0)) {
      await ctx.reply("Approval session expired. Start the listing again with /nftlist.");
      return;
    }
    const wallet = walletManager.getUserWallet(userId);
    if (!wallet) { await ctx.reply("No wallet found."); return; }
    try {
      await ctx.reply(`⏳ Approving Kalos to move your NFTs in \`${data.contract}\`…`, { parse_mode: "Markdown" });
      const hash = await kalosService.approveMarketplace(wallet.privateKey, data.contract as Address);
      if (!hash) {
        await ctx.reply("Already approved. Continuing your listing…", { parse_mode: "Markdown" });
      } else {
        const cfg = getChainConfig(ELYSIUM.key);
        await ctx.reply(`✅ *Approved.* [View approval tx](${cfg.explorerUrl}/tx/${hash})\n\nContinuing your listing…`, { parse_mode: "Markdown" });
      }
      await executeNftList(ctx, data);
    } catch (e: any) {
      await ctx.reply(`❌ Approval failed: ${e?.shortMessage || e?.message || "unknown"}\n\nListing not started — no gas spent on the listing itself.`);
    }
  });

  // 1-tap Accept from an /nfts card: straight to the confirm quote, no typing.
  bot.callbackQuery(/^kalos_accept_(0x[a-fA-F0-9]{40})_(\d+)_(0x[a-fA-F0-9]{40})$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await promptNftAccept(ctx, `${ctx.match[1]} ${ctx.match[2]} ${ctx.match[3]}`);
  });

  bot.callbackQuery("confirm_nftdelist", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (!userId || !userStates[userId]?.data) return;
    const data = userStates[userId].data;
    delete userStates[userId];
    await executeNftDelist(ctx, data);
  });

  bot.callbackQuery("confirm_nftoffer", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (!userId || !userStates[userId]?.data) return;
    const data = userStates[userId].data;
    delete userStates[userId];
    await executeNftOffer(ctx, data);
  });

  bot.callbackQuery("wrap_and_bid", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (!userId || !userStates[userId]?.data || userStates[userId].step !== "awaiting_offer_wrap_confirm") return;
    const data = userStates[userId].data as { contract: Address; tokenId: string; priceHype: string; days: number; expiresAt?: number };
    if (Date.now() > (data.expiresAt ?? 0)) { delete userStates[userId]; await ctx.reply("Offer session expired. Start again with /nftoffer."); return; }
    delete userStates[userId];
    const wallet = walletManager.getUserWallet(userId);
    if (!wallet) { await ctx.reply("No wallet found."); return; }
    try {
      const scope = data.tokenId === "0" ? "any token" : `#${data.tokenId}`;
      const shortfall = parseEther(data.priceHype); // worst case: wrap full bid; ensureBidFunds wraps only the shortfall
      await ctx.reply(`🔄 Wrapping HYPE → WHYPE, then placing your ${scope} bid for *${data.priceHype} HYPE*...`, { parse_mode: "Markdown" });
      await kalosService.ensureBidFunds(wallet.privateKey, data.contract, shortfall);
      const hash = await kalosService.createTokenBid(wallet.privateKey, data.contract, data.tokenId, data.priceHype, { days: data.days });
      const cfg = getChainConfig(ELYSIUM.key);
      await ctx.reply(
        `✅ *Offer Placed on Kalos!*\n\n` +
        `📄 *Collection:* \`${data.contract}\`\n` +
        `🏷 *Token:* \`${data.tokenId === "0" ? "any token" : `#${data.tokenId}`}\`\n` +
        `💰 *Bid:* \`${data.priceHype} HYPE\` (wrapped + approved automatically)\n` +
        `🔗 [View Transaction](${cfg.explorerUrl}/tx/${hash})`,
        { parse_mode: "Markdown", reply_markup: mainKeyboard }
      );
    } catch (e: any) {
      await ctx.reply(`❌ Wrap-and-bid failed: ${e?.shortMessage || e?.message || "unknown"}\n\nNo bid was placed. Your HYPE is safe — retry or top up and try again.`);
    }
  });

  bot.callbackQuery("confirm_nftaccept", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (!userId || !userStates[userId]?.data) return;
    const data = userStates[userId].data;
    delete userStates[userId];
    await executeNftAccept(ctx, data);
  });

  bot.callbackQuery(/^quick_offer_(0x[a-fA-F0-9]{40})_(\d+)(?:_(.+))?$/, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const col = ctx.match[1] as Address;
    const tid = ctx.match[2];
    const price = ctx.match[3];
    // Route through the same any/specific parser as manual input:
    // token present -> "6187 [0.5]"; never pass collection twice.
    const userId = ctx.from?.id;
    if (!userId) return;
    if (price !== undefined) {
      userStates[userId] = { step: "awaiting_offer_price", data: { contract: col, tokenId: tid, expiresAt: Date.now() + 5 * 60_000 } };
      await ctx.reply(
        `🤝 *Offer on #${tid}*\n\nReply with your bid + optional days:\n\n\`<price_hype> [days]\`\n\nSuggested: \`${price}\``,
        { parse_mode: "Markdown" }
      );
      return;
    }
    userStates[userId] = { step: "awaiting_offer_price", data: { contract: col, tokenId: tid, expiresAt: Date.now() + 5 * 60_000 } };
    await ctx.reply(
      `🤝 *Offer on #${tid}*\n\nReply with your bid + optional days:\n\n\`<price_hype> [days]\`\n\n*Example:* \`0.5 3\` — bid 0.5 HYPE for 3 days`,
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery("cancel_action", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (userId && userStates[userId]) delete userStates[userId];
    await ctx.reply("❌ Action cancelled.", { reply_markup: mainKeyboard });
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
    await promptNftList(ctx, `${nft.contract} ${nft.tokenId}`);
  });

  bot.callbackQuery(/^nft_offer_(\d+)$/, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    const nft = userId ? userStates[userId]?.data?.nfts?.[Number(ctx.match[1])] : undefined;
    if (!userId || !nft) return;
    await promptNftOffer(ctx, `${nft.contract} ${nft.tokenId}`);
  });

  bot.callbackQuery(/^listing_cancel_(\d+)$/, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (!userId) return;
    const listingId = Number(ctx.match[1]);
    const listing = dbService.getUserListings(userId).find((item) => item.id === listingId);
    if (!listing) {
      await ctx.reply("Listing not found.");
      return;
    }
    await executeNftDelist(ctx, { contract: listing.contract as Address, tokenId: listing.token_id, listingId });
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

    if (state?.step === "awaiting_wrap_amount") {
      delete userStates[userId];
      if (Date.now() > (state.data?.expiresAt ?? 0)) { await ctx.reply("Wrap session expired. Tap 💰 Wrap again."); return; }
      await handleWrap(ctx, text.trim());
      return;
    }

    if (state?.step === "awaiting_unwrap_amount") {
      delete userStates[userId];
      if (Date.now() > (state.data?.expiresAt ?? 0)) { await ctx.reply("Unwrap session expired. Tap 💎 Unwrap again."); return; }
      await handleUnwrap(ctx, text.trim());
      return;
    }

    if (state?.step === "awaiting_floor_contract") {
      delete userStates[userId];
      await handleFloorLookup(ctx, text);
      return;
    }

    if (state?.step === "awaiting_collection_inspect") {
      delete userStates[userId];
      const clean = text.trim();
      if (/^0x[a-fA-F0-9]{40}$/.test(clean)) {
        await renderCollectionDetail(ctx, clean as Address);
      } else {
        await ctx.reply("❌ Invalid contract address. Please provide a 42-character `0x...` address.", { parse_mode: "Markdown" });
      }
      return;
    }

    if (state?.step === "awaiting_nftlist_price") {
      const data0 = state.data ?? {};
      if (!data0.contract || !data0.tokenId || Date.now() > (data0.expiresAt ?? 0)) {
        delete userStates[userId];
        await ctx.reply("Listing session expired. Tap 🏷️ List on the NFT card again.");
        return;
      }
      delete userStates[userId];
      const p = text.trim().split(/\s+/).filter(Boolean);
      if (p.length === 0 || !/^\d+(?:\.\d{1,18})?$/.test(p[0] ?? "") || Number(p[0]) <= 0) {
        await ctx.reply("Send just the price, e.g. `0.55`, optionally followed by days: `0.55 3`", { parse_mode: "Markdown" });
        userStates[userId] = { step: "awaiting_nftlist_price", data: { ...data0, expiresAt: Date.now() + 5 * 60_000 } };
        return;
      }
      let days = 7;
      if (p[1] !== undefined) {
        const d = Number(p[1]);
        if (!Number.isInteger(d) || d < 1 || d > 30) {
          await ctx.reply("Duration must be 1–30 days. Try again, e.g. `0.55 3`.");
          userStates[userId] = { step: "awaiting_nftlist_price", data: { ...data0, expiresAt: Date.now() + 5 * 60_000 } };
          return;
        }
        days = d;
      }
      await promptNftList(ctx, `${data0.contract} ${data0.tokenId} ${p[0]} ${days}`);
      return;
    }

    // Unified offer input: "0.5" / "0.5 3" = any-token; "6187 0.5" / "6187 0.5 3" = specific token.
    if (state?.step === "awaiting_offer_any") {
      const data0 = state.data ?? {};
      if (!data0.contract || Date.now() > (data0.expiresAt ?? 0)) {
        delete userStates[userId];
        await ctx.reply("Offer session expired. Tap 🤝 Offer on the collection card again.");
        return;
      }
      delete userStates[userId];
      const p = text.trim().split(/\s+/).filter(Boolean);
      const isPrice = (s?: string) => !!s && /^\d+(?:\.\d{1,18})?$/.test(s) && Number(s) > 0;
      const isTid = (s?: string) => !!s && /^\d+$/.test(s);
      const isDays = (s?: string) => !!s && /^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= 30;
      let tid = "0"; let price = ""; let days = 7;
      if (p.length === 1 && isPrice(p[0])) { price = p[0]; }
      else if (p.length === 2 && isPrice(p[0]) && isDays(p[1])) { price = p[0]; days = Number(p[1]); }
      else if ((p.length === 2 || p.length === 3) && isTid(p[0]) && isPrice(p[1])) {
        tid = p[0]; price = p[1];
        if (p[2] !== undefined) {
          if (!isDays(p[2])) {
            await ctx.reply("Duration must be 1–30 days. Try again, e.g. `6187 0.5 3`.");
            userStates[userId] = { step: "awaiting_offer_any", data: { ...data0, expiresAt: Date.now() + 5 * 60_000 } };
            return;
          }
          days = Number(p[2]);
        }
      } else {
        await ctx.reply("Reply with `<price> [days]` for any token, or `<tokenId> <price> [days]` for a specific one. E.g. `0.5` or `6187 0.5 3`.", { parse_mode: "Markdown" });
        userStates[userId] = { step: "awaiting_offer_any", data: { ...data0, expiresAt: Date.now() + 5 * 60_000 } };
        return;
      }
      const label = tid === "0" ? "any token" : `#${tid}`;
      userStates[userId] = { step: "awaiting_nftoffer_confirmation", data: { contract: data0.contract, tokenId: tid, priceHype: price, days, expiresAt: Date.now() + 5 * 60_000 } };
      const kb = new InlineKeyboard()
        .text(`✅ Yes, Offer ${price} HYPE`, "confirm_nftoffer")
        .text("❌ Cancel", "cancel_action");
      await ctx.reply(
        `🤝 *Confirm Kalos Offer*\n\n📄 *Collection:* \`${data0.contract}\`\n🏷 *Token:* \`${label}\`\n💰 *Offer:* \`${price} HYPE\`\n⏱ *Expiry:* \`${days} days\`\n\nTap below or reply *YES*:`,
        { parse_mode: "Markdown", reply_markup: kb }
      );
      return;
    }
    if (state?.step === "awaiting_offer_tokenid") {
      const data0 = state.data ?? {};
      if (!data0.contract || Date.now() > (data0.expiresAt ?? 0)) {
        delete userStates[userId];
        await ctx.reply("Offer session expired. Tap 🤝 Offer on the collection card again.");
        return;
      }
      delete userStates[userId];
      const p = text.trim().split(/\s+/).filter(Boolean);
      if (p.length === 0 || !/^\d+$/.test(p[0] ?? "")) {
        await ctx.reply("Send just the token ID first, e.g. `6187` — or with your bid: `6187 0.5`", { parse_mode: "Markdown" });
        userStates[userId] = { step: "awaiting_offer_tokenid", data: { ...data0, expiresAt: Date.now() + 5 * 60_000 } };
        return;
      }
      const tid = p[0];
      if (p.length === 1) {
        userStates[userId] = { step: "awaiting_offer_price", data: { contract: data0.contract, tokenId: tid, expiresAt: Date.now() + 5 * 60_000 } };
        await ctx.reply(
          `🤝 *Offer on #${tid}*\n\nReply with your bid + optional days:\n\n\`<price_hype> [days]\`\n\n*Example:* \`0.5 3\` — bid 0.5 HYPE for 3 days`,
          { parse_mode: "Markdown" }
        );
        return;
      }
      if (!/^\d+(?:\.\d{1,18})?$/.test(p[1] ?? "") || Number(p[1]) <= 0) {
        await ctx.reply("Bid must be a positive HYPE amount, e.g. `6187 0.5`. Try again.");
        userStates[userId] = { step: "awaiting_offer_tokenid", data: { ...data0, expiresAt: Date.now() + 5 * 60_000 } };
        return;
      }
      let days = 7;
      if (p[2] !== undefined) {
        const d = Number(p[2]);
        if (!Number.isInteger(d) || d < 1 || d > 30) {
          await ctx.reply("Duration must be 1–30 days. Try again, e.g. `6187 0.5 3`.");
          userStates[userId] = { step: "awaiting_offer_tokenid", data: { ...data0, expiresAt: Date.now() + 5 * 60_000 } };
          return;
        }
        days = d;
      }
      await promptNftOffer(ctx, `${data0.contract} ${tid} ${p[1]} ${days}`);
      return;
    }

    if (state?.step === "awaiting_offer_price") {
      const data0 = state.data ?? {};
      if (!data0.contract || !data0.tokenId || Date.now() > (data0.expiresAt ?? 0)) {
        delete userStates[userId];
        await ctx.reply("Offer session expired. Tap 🤝 Offer on the token card again.");
        return;
      }
      delete userStates[userId];
      const p = text.trim().split(/\s+/).filter(Boolean);
      if (p.length === 0 || !/^\d+(?:\.\d{1,18})?$/.test(p[0] ?? "") || Number(p[0]) <= 0) {
        await ctx.reply("Send just the bid, e.g. `0.5`, optionally followed by days: `0.5 3`", { parse_mode: "Markdown" });
        userStates[userId] = { step: "awaiting_offer_price", data: { ...data0, expiresAt: Date.now() + 5 * 60_000 } };
        return;
      }
      let days = 7;
      if (p[1] !== undefined) {
        const d = Number(p[1]);
        if (!Number.isInteger(d) || d < 1 || d > 30) {
          await ctx.reply("Duration must be 1–30 days. Try again, e.g. `0.5 3`.");
          userStates[userId] = { step: "awaiting_offer_price", data: { ...data0, expiresAt: Date.now() + 5 * 60_000 } };
          return;
        }
        days = d;
      }
      await promptNftOffer(ctx, `${data0.contract} ${data0.tokenId} ${p[0]} ${days}`);
      return;
    }

    if (state?.step === "awaiting_nftbuy_params") {
      delete userStates[userId];
      await promptNftBuy(ctx, text);
      return;
    }

    if (state?.step === "awaiting_nftbuy_confirmation") {
      delete userStates[userId];
      if (!state.data || Date.now() > state.data.expiresAt) {
        await ctx.reply("Buy confirmation expired. Send /nftbuy to start again.");
        return;
      }
      if (!isUserConfirmation(text)) {
        await ctx.reply("Purchase cancelled.", { reply_markup: mainKeyboard });
        return;
      }
      await executeNftBuy(ctx, state.data);
      return;
    }

    if (state?.step === "awaiting_nftlist_params" || state?.step === "awaiting_list_params") {
      delete userStates[userId];
      await promptNftList(ctx, text);
      return;
    }

    if (state?.step === "awaiting_nftlist_confirmation" || state?.step === "awaiting_listing_confirmation") {
      delete userStates[userId];
      if (!state.data || Date.now() > state.data.expiresAt) {
        await ctx.reply("Listing confirmation expired. Send /nftlist to try again.");
        return;
      }
      if (!isUserConfirmation(text)) {
        await ctx.reply("Listing cancelled.", { reply_markup: mainKeyboard });
        return;
      }
      await executeNftList(ctx, state.data);
      return;
    }

    if (state?.step === "awaiting_nftdelist_params") {
      delete userStates[userId];
      await promptNftDelist(ctx, text);
      return;
    }

    if (state?.step === "awaiting_nftdelist_confirmation" || state?.step === "awaiting_listing_cancel_confirmation") {
      delete userStates[userId];
      if (!state.data || Date.now() > state.data.expiresAt) {
        await ctx.reply("Cancellation confirmation expired.");
        return;
      }
      if (!isUserConfirmation(text)) {
        await ctx.reply("Delisting cancelled.", { reply_markup: mainKeyboard });
        return;
      }
      await executeNftDelist(ctx, state.data);
      return;
    }

    if (state?.step === "awaiting_nftoffer_params" || state?.step === "awaiting_offer_params") {
      delete userStates[userId];
      await promptNftOffer(ctx, text);
      return;
    }

    if (state?.step === "awaiting_nftoffer_confirmation" || state?.step === "awaiting_offer_confirmation") {
      delete userStates[userId];
      if (!state.data || Date.now() > state.data.expiresAt) {
        await ctx.reply("Offer confirmation expired.");
        return;
      }
      if (!isUserConfirmation(text)) {
        await ctx.reply("Offer cancelled.", { reply_markup: mainKeyboard });
        return;
      }
      await executeNftOffer(ctx, state.data);
      return;
    }

    if (state?.step === "awaiting_nftaccept_params") {
      delete userStates[userId];
      await promptNftAccept(ctx, text);
      return;
    }

    if (state?.step === "awaiting_nftaccept_confirmation") {
      delete userStates[userId];
      if (!state.data || Date.now() > state.data.expiresAt) {
        await ctx.reply("Acceptance confirmation expired.");
        return;
      }
      if (!isUserConfirmation(text)) {
        await ctx.reply("Acceptance cancelled.", { reply_markup: mainKeyboard });
        return;
      }
      await executeNftAccept(ctx, state.data);
      return;
    }

    if (state?.step === "awaiting_buy_tokenid") {
      const data0 = state.data ?? {};
      if (!data0.contract || Date.now() > (data0.expiresAt ?? 0)) {
        delete userStates[userId];
        await ctx.reply("Buy session expired. Tap 🛒 Buy on the collection card again.");
        return;
      }
      delete userStates[userId];
      const parts = text.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0 || !/^\d+$/.test(parts[0] ?? "")) {
        await ctx.reply("Send just the token ID, e.g. `13578`, optionally followed by your max: `13578 0.5`", { parse_mode: "Markdown" });
        return;
      }
      const tid = parts[0];
      let maxHype: string | undefined;
      if (parts[1] !== undefined) {
        if (!/^\d+(?:\.\d{1,18})?$/.test(parts[1]) || Number(parts[1]) <= 0) {
          await ctx.reply("Max must be a positive HYPE amount, e.g. `13578 0.5`. Try again.");
          return;
        }
        maxHype = parts[1];
      }
      await promptNftBuy(ctx, maxHype ? `${data0.contract} ${tid} ${maxHype}` : `${data0.contract} ${tid}`);
      return;
    }

    if (state?.step === "awaiting_sweep_contract") {
      delete userStates[userId];
      const parts = text.trim().split(/\s+/).filter(Boolean);
      const contract = parts[0] ?? "";
      const maxPrice = parts[1];
      if (!contract || !/^0x[a-fA-F0-9]{40}$/.test(contract)) {
        await ctx.reply("That doesn't look like an EVM address. Send `<0x…> [maxHYPE]`.", { parse_mode: "Markdown" });
        return;
      }
      await renderSweepResults(ctx, contract as Address, maxPrice);
      return;
    }

    if (state?.step === "awaiting_sweep_confirm") {
      if (/^(yes|y|buy|sweep|confirm)$/i.test(text.trim())) {
        const data = state.data;
        delete userStates[userId];
        if (!data || Date.now() > data.expiresAt) {
          await ctx.reply("Sweep expired. Tap 🧹 Re-scan floor to refresh.", { parse_mode: "Markdown" });
          return;
        }
        await promptNftBuy(ctx, `${data.contract} ${data.tokenId}`);
        return;
      }
    }

    if (state?.step === "awaiting_sweepN_confirm") {
      if (/^(yes|y|buy|sweep|confirm)$/i.test(text.trim())) {
        const data = state.data;
        delete userStates[userId];
        if (!data || Date.now() > data.expiresAt) {
          await ctx.reply("Sweep expired. Tap 🧹 Re-scan floor to refresh.", { parse_mode: "Markdown" });
          return;
        }
        await executeSweepBuy(ctx, data.contract as Address, data.items as Array<{ tokenId: string; seller: string; price: string }>);
        return;
      }
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
      if (!isUserConfirmation(text)) {
        await ctx.reply("Mint cancelled. Send /mint when you are ready to try again.", { reply_markup: mainKeyboard });
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
  // Real WHYPE balance (what bids actually escrow) — not paper, read live on-chain.
  let whypeLine = "";
  try {
    const w = await kalosService.whypeBalance(user.wallet_address as Address);
    whypeLine = `💎 wrapped *Balance:* \`${kalosService.formatPrice(w.raw)} ${w.symbol}\` (bids escrow in this)\n`;
  } catch { whypeLine = ""; }

  let msg = `🟢 *Your Trading Wallet* — Elysium\n\n`;
  msg += `🌐 *Chain:* \`${chainConfig.name}\`\n`;
  msg += `📫 *Address:* \`${user.wallet_address}\`\n`;
  msg += `💰 native *Balance:* \`${balance.eth} ${balance.symbol}\`\n`;
  msg += whypeLine + `\n`;
  msg += `Bids escrow in *WHYPE*, not native HYPE. Tap 💰 *Wrap HYPE→WHYPE* below (or /wrap 0.1) to convert, 💎 *Unwrap* to go back.\n`;
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
    reply_markup: makeCollectionKeyboard(cleanContract),
  });

}

async function handleSweepCommand(ctx: Context, arg: string) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const parts = (arg ?? "").trim().split(/\s+/).filter(Boolean);
  const contract = parts[0] ?? "";
  // /sweep <contract> [count] [maxHYPE] — e.g. /sweep 0x… 3 10
  let count = 1;
  let maxPrice: string | undefined;
  const nums = parts.slice(1).map((p) => Number(p)).filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length === 1) {
    // Ambiguous: integer 1-10 = count, otherwise max price
    if (Number.isInteger(nums[0]) && nums[0] <= 10 && !parts[1].includes(".")) count = Math.min(10, Math.floor(nums[0]));
    else maxPrice = parts[1];
  } else if (nums.length >= 2) {
    count = Math.max(1, Math.min(10, Math.floor(nums[0])));
    maxPrice = parts[2];
  }
  if (!contract || !/^0x[a-fA-F0-9]{40}$/.test(contract)) {
    userStates[userId] = { step: "awaiting_sweep_contract" };
    await ctx.reply(
      `🧹 *Sweep Floor on Kalos*\n\nReply with a collection + how many + max each:\n\n\`<0x…> [count] [maxHYPE]\`\n\n*Examples:*\n\`0xd0e6…5d95\` — cheapest 1\n\`0xd0e6…5d95 3\` — cheapest 3 in one tx\n\`0xd0e6…5d95 3 10\` — 3 cheapest under 10 HYPE each`,
      { parse_mode: "Markdown" }
    );
    return;
  }
  await renderSweepResults(ctx, contract as Address, maxPrice, count, true);
}

async function renderSweepResults(ctx: Context, contract: Address, maxPriceEth?: string, count: number = 1, fromCommand = false) {
  const userId = ctx.from?.id;
  const cfg = getChainConfig(ELYSIUM.key);
  await ctx.reply(`🔍 Scanning Kalos for the ${count > 1 ? `${count} cheapest live listings` : "cheapest live listing"}…`, { parse_mode: "Markdown" });
  // Balance pre-check (best-effort only).
  // A balance read can NEVER block the sweep on its own: getBalance returns
  // "0" on RPC errors, which previously produced a bogus "No HYPE" message
  // for wallets that actually hold HYPE. Only a CONFIRMED zero blocks.
  if (userId) {
    try {
      const w0 = walletManager.getUserWallet(userId);
      if (w0) {
        const wei = await tryReadHypeBalance(w0.address as Address);
        if (wei !== null && wei <= 0n) {
          await ctx.reply(
              `🔴 *No HYPE to sweep with*\n\nYour wallet \`${w0.address}\` holds \`0 HYPE\`.\n\nTap 💧 Get Testnet HYPE on /wallet, then try /sweep again.`,
              { parse_mode: "Markdown", reply_markup: mainKeyboard }
            );
            return;
          }
        }
    } catch {}
  }
  const want = Math.max(1, Math.min(10, Math.floor(count)));
  function maxPriceHypeSafe(v?: string): string { return String(v ?? ""); }
  // Multi-count sweeps: ask HOW MANY before scanning (count picker).
  // Only for the bare "/sweep <contract>" command (no count, no max typed).
  // Button taps (card Sweep, Sweep-N, Re-scan) always scan directly.
  const isBareCommand = fromCommand && want === 1 && (maxPriceEth === undefined || maxPriceEth === null);
  if (isBareCommand) {
    const floorPreview = await kalosService.getVerifiedFloor(contract).catch(() => null);
    const floorLine = floorPreview && floorPreview > 0n ? `${kalosService.formatPrice(floorPreview)} HYPE` : "checking…";
    const kb = new InlineKeyboard()
      .text("🧹 Sweep 1", `kalos_sweepN_${contract}_1`)
      .text("🧹 Sweep 2", `kalos_sweepN_${contract}_2`)
      .text("🧹 Sweep 3", `kalos_sweepN_${contract}_3`).row()
      .text("🧹 Sweep 5", `kalos_sweepN_${contract}_5`)
      .text("🧹 Re-scan floor", `kalos_sweep_${contract}`).row()
      .text("🏷️ Collections", "menu_collections")
      .text("🔙 Main Menu", "menu_main");
    if (userId) {
      userStates[userId] = { step: "awaiting_sweepN_pick", data: { contract, maxPriceEth: maxPriceEth ?? null, expiresAt: Date.now() + 5 * 60_000 } };
    }
    await ctx.reply(
      `🧹 *Sweep Floor — how many?*\n\nContract: \`${contract}\`\nKalos floor: \`${floorLine}\`${maxPriceEth ? `\nMax filter: \`${maxPriceHypeSafe(maxPriceEth)} HYPE\`` : ""}\n\nTap how many cheapest listings to sweep in one transaction:`,
      { parse_mode: "Markdown", reply_markup: kb }
    );
    return;
  }
  let cheapest: Array<{ tokenId: bigint; seller: Address; price: bigint; expiration: bigint }> = [];
  try {
    cheapest = await kalosService.findCheapestListings(contract, { maxScan: 500, maxResults: Math.max(want, 5), maxPriceEth: maxPriceEth });
  } catch (e: any) {
    await ctx.reply(`🔴 Kalos scan failed: ${e?.shortMessage ?? e?.message ?? "unknown"}`, { parse_mode: "Markdown" });
    return;
  }
  if (cheapest.length === 0) {
    let floorLine = "No active listings";
    try {
      const fp = await kalosService.getVerifiedFloor(contract);
      if (fp && fp > 0n) floorLine = `${kalosService.formatPrice(fp)} HYPE`;
    } catch {}
    await ctx.reply(
      `🧹 *Sweep Floor — no match*\n\nContract: \`${contract}\`\nKalos floor: \`${floorLine}\`\n${maxPriceEth ? `Max filter: \`${maxPriceEth} HYPE\`\n` : ""}\nNo live listing found in the first 60 tokenIds. The floor may be stale, expired, or above your max. Try without a max or tap Collections to browse.`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🏷️ Collections", "menu_collections").text("🔙 Main Menu", "menu_main") }
    );
    return;
  }
  const take = cheapest.slice(0, want);
  const best = take[0];
  const bestPrice = kalosService.formatPrice(best.price);
  const totalWei = take.reduce((s, h) => s + h.price, 0n);
  const totalStr = kalosService.formatPrice(totalWei);
  let ownerNow: string = best.seller;
  try {
    const { createPublicClient, http } = await import("viem");
    const pc = createPublicClient({ chain: cfg.viemChain, transport: http(cfg.rpcUrl) });
    ownerNow = (await pc.readContract({
      address: contract, abi: [{ name: "ownerOf", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "address" }] }] as any,
      functionName: "ownerOf", args: [best.tokenId],
    } as any)) as string;
  } catch {}
  for (const c of take.slice(0, 3)) {
    const p = kalosService.formatPrice(c.price);
    const isBest = c.tokenId === best.tokenId && c.seller.toLowerCase() === best.seller.toLowerCase();
    const kb = new InlineKeyboard()
      .text(isBest ? `🛒 Buy #${c.tokenId} — ${p} HYPE` : `Buy #${c.tokenId} — ${p}`, `kalos_sweepbuy_${contract}_${c.tokenId}`)
      .row()
      .text("🧹 Re-scan floor", `kalos_sweep_${contract}`)
      .text("🏷️ Collections", "menu_collections")
      .row()
      .text("🔙 Main Menu", "menu_main");
    const expLine = c.expiration > 0n ? ` · ends ${new Date(Number(c.expiration) * 1000).toLocaleDateString()}` : "";
    await ctx.reply(
      `${isBest ? "🏆 *Cheapest live listing*" : "💰 *Also listed*"}\n\n🖼️ \`${contract.slice(0, 10)}…\` #${c.tokenId}\n💰 Price: \`${p} HYPE\`${expLine}\n👤 Seller: \`${c.seller}\`\n🔗 [Explorer](${cfg.explorerUrl}/address/${contract})${isBest && ownerNow.toLowerCase() !== best.seller.toLowerCase() ? `\n\n⚠️ Owner changed since listing — re-check before buying.` : ""}`,
      { parse_mode: "Markdown", reply_markup: kb }
    );
  }
  if (userId) {
    if (want > 1 && take.length > 1) {
      const listLine = take.map((t) => `#${t.tokenId} (${kalosService.formatPrice(t.price)})`).join(" + ");
      const sweepKb = new InlineKeyboard()
        .text(`🧹 Sweep ${take.length} for ~${totalStr} HYPE`, `kalos_sweepbuyN_${contract}_${take.length}`)
        .row()
        .text("🧹 Re-scan floor", `kalos_sweep_${contract}`)
        .text("🏷️ Collections", "menu_collections")
        .row()
        .text("🔙 Main Menu", "menu_main");
      userStates[userId] = {
        step: "awaiting_sweepN_confirm",
        data: { contract, items: take.map((t) => ({ tokenId: t.tokenId.toString(), seller: t.seller, price: t.price.toString() })), total: totalStr, expiresAt: Date.now() + 5 * 60_000 },
      };
      await ctx.reply(
        `🧹 *Sweep ${take.length}:* ${listLine}\n\nTotal ~\`${totalStr} HYPE\` in one tx. Reply \`yes\` or tap Sweep above.`,
        { parse_mode: "Markdown", reply_markup: sweepKb }
      );
    } else {
      userStates[userId] = { step: "awaiting_sweep_confirm", data: { contract, tokenId: best.tokenId.toString(), seller: best.seller, price: bestPrice, expiresAt: Date.now() + 5 * 60_000 } };
      await ctx.reply(`Reply \`yes\` to buy #${best.tokenId} for ~${bestPrice} HYPE, or tap Buy above.`, { parse_mode: "Markdown" });
    }
  }
}

  const ERC721_META_ABI = [
    { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
    { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
    { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  ] as const;

  /** Best-effort collection metadata: name + symbol, with symbol fallback. Never throws. */
  async function readCollectionMeta(addr: Address): Promise<{ name: string; symbol: string }> {
    const fallback = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
    const key = addr.toLowerCase();
    const cached = collectionMetaCache.get(key);
    if (cached && Date.now() - cached.at < COLLECTION_META_TTL_MS && cached.name !== fallback) return cached;
    try {
      const { createPublicClient, http } = await import("viem");
      const cfg = getChainConfig(ELYSIUM.key);
      const pc = createPublicClient({ chain: cfg.viemChain, transport: http(cfg.rpcUrl) });
      // Sequential (not parallel): the testnet RPC rate-limits aggressively and
      // parallel name()+symbol() pairs across 20+ collections all fail at once,
      // which is exactly how cards end up nameless (0x9b87… fallback). Retry once.
      let n: string | null = null;
      let s: string | null = null;
      for (let attempt = 0; attempt < 2 && (n === null || s === null); attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * attempt));
        try { n = (await pc.readContract({ address: addr, abi: ERC721_META_ABI as any, functionName: "name" } as any).catch(() => null)) as string | null; } catch { /* retry */ }
        try { s = (await pc.readContract({ address: addr, abi: ERC721_META_ABI as any, functionName: "symbol" } as any).catch(() => null)) as string | null; } catch { /* retry */ }
      }
      if (typeof n === "string" && n.trim().length > 0) {
        const meta = { name: n.trim(), symbol: typeof s === "string" ? s.trim() : "" };
        collectionMetaCache.set(key, { ...meta, at: Date.now() });
        return meta;
      }
      if (typeof s === "string" && s.trim().length > 0) {
        const meta = { name: `${s.trim()} Collection`, symbol: s.trim() };
        collectionMetaCache.set(key, { ...meta, at: Date.now() });
        return meta;
      }
    } catch {}
    if (cached) return { name: cached.name, symbol: cached.symbol };
    return { name: fallback, symbol: "" };
  }

  /** One styled per-collection card (Markdown, with plain-text fallback). */
  function buildCollectionCard(r: {
    name: string; symbol: string; address: Address;
    floorWei: bigint | null; floorStr: string; count: number;
    unverified: boolean; scannedAt: string;
  }): { text: string; plain: string } {
    const title = r.symbol ? `${r.name} ($${r.symbol})` : r.name;
    const floorEmoji = !r.floorWei || r.floorWei <= 0n ? "⚪" : r.unverified ? "🟡" : "🟢";
    const floorLine = r.floorWei && r.floorWei > 0n
      ? `💰 *Floor:* \`${r.floorStr}\`${r.unverified ? " ⏳" : ""}`
      : `💰 *Floor:* \`No active listings\``;
    const liveLine = r.count > 0 ? `📊 *Live asks:* \`${r.count} verified\`` : `📊 *Live asks:* \`none found\``;
    const text =
      `🖼️ *${escMd(title)}*\n` +
      `📄 \`${r.address}\`\n\n` +
      `${floorEmoji} ${floorLine}\n` +
      `${liveLine}\n` +
      `🏛 *Market:* Kalos (Elysium L2)${r.unverified ? " · _verifying…_" : ""}`;
    const plain = text.replace(/[`*_]/g, "");
    return { text, plain };
  }

  function collectionCardKeyboard(r: { address: Address; name: string; symbol: string; floorWei: bigint | null; floorStr: string }): InlineKeyboard {
    const kb = new InlineKeyboard();
    const label = r.symbol ? `$${r.symbol}` : r.name.slice(0, 16);
    if (r.floorWei && r.floorWei > 0n) kb.text(`🧹 Sweep ${label} — ${r.floorStr}`, `kalos_sweep_${r.address}`).row();
    else kb.text(`🔍 Inspect ${label}`, `col_inspect_${r.address}`).row();
    kb.text("🛒 Buy", `kalos_buy_${r.address}`)
      .text("🏷️ List", `kalos_list_${r.address}`)
      .text("🤝 Offer", `kalos_offer_${r.address}`).row();
    kb.text("👀 Watch", `watch_add_${r.address}`)
      .text("🏷️ All", "menu_collections").row();
    return kb;
  }

async function renderCollectionsMenu(ctx: Context) {
  const cfg = getChainConfig(ELYSIUM.key);
  const kalosAddress = kalosService.address();
  const sentScanning = await ctx.reply(`🔍 Scanning Kalos — discovering live collections…`, { parse_mode: "Markdown" }).catch(() => null);

  // Discover EVERY live Kalos collection on-chain — no hardcoding.
  // One shared scan feeds discovery AND all floor rows (cached 45s).
  // Scan depth covers well beyond the last 50k blocks so collections whose
  // listings are older still appear (up to ~24+ on Kalos testnet).
  let discovered: Address[] = [];
  let sharedEvents: Awaited<ReturnType<typeof kalosService.cachedScan>> = [];
  let scanFailed = false;
  try {
    sharedEvents = await kalosService.cachedScan({ blocksBack: 200_000 });
    const seen = new Set<string>();
    for (const e of sharedEvents) seen.add(e.nftAddress.toLowerCase());
    discovered = [...seen] as Address[];
  } catch { scanFailed = true; }
  const watched: Address[] = [];
  try {
    const { dbService: _db } = await import("../db");
    for (const row of _db.getUserListings(0)) {
      if (row.contract && /^0x[a-fA-F0-9]{40}$/.test(row.contract)) watched.push(row.contract as Address);
    }
  } catch {}
  const merged: Address[] = [];
  const seenAddr = new Set<string>();
  for (const a of [...discovered, ...watched]) {
    const k = a.toLowerCase();
    if (seenAddr.has(k)) continue;
    seenAddr.add(k);
    merged.push(a);
  }
  // Resolve names (bounded parallel: 5 at a time — the testnet RPC 429s on
  // Promise.all bursts, which used to leave every card showing raw 0x…).
  const nameRows: Array<{ address: Address; name: string; symbol: string }> = [];
  {
    const queue = [...merged];
    const workers = new Array(Math.min(5, queue.length)).fill(0).map(async () => {
      while (queue.length > 0) {
        const addr = queue.shift()!;
        try {
          const meta = await readCollectionMeta(addr);
          nameRows.push({ address: addr, name: meta.name, symbol: meta.symbol });
        } catch {
          nameRows.push({ address: addr, name: `${addr.slice(0, 6)}…${addr.slice(-4)}`, symbol: "" });
        }
      }
    });
    await Promise.all(workers);
  }
  // …then verified floors from ONE batched call (no per-collection scans).
  // Two-phase menu: instant event-price estimates first, verified floors edited in.
  let floors = new Map<string, { floor: bigint | null; liveCount: number }>();
  const eventFloor = (addr: Address): bigint | null => {
    let best: bigint | null = null;
    for (const e of sharedEvents) {
      try {
        if (e.nftAddress.toLowerCase() !== addr.toLowerCase()) continue;
        if (e.tokenId <= 0n || e.pricePerItem <= 0n) continue;
        if (best === null || e.pricePerItem < best) best = e.pricePerItem;
      } catch {}
    }
    return best;
  };
  const eventCount = (addr: Address): number => {
    let n = 0;
    for (const e of sharedEvents) {
      try { if (e.nftAddress.toLowerCase() === addr.toLowerCase()) n++; } catch {}
    }
    return n;
  };
  // Resolve names + VERIFIED floors (cheapest live ask — getMinPrice returns 0 on Kalos)
  type ColRow = { address: Address; name: string; symbol: string; tag?: string; floorWei: bigint | null; floorStr: string; count: number; live: number; unverified: boolean };
  const rows: ColRow[] = nameRows.map(({ address: addr, name, symbol }) => {
    const f = floors.get(addr.toLowerCase());
    const floorWei = f?.floor ?? null;
    const live = f?.liveCount ?? 0;
    const tag = undefined;
    return { address: addr, name, symbol, tag, floorWei, floorStr: floorWei && floorWei > 0n ? `${kalosService.formatPrice(floorWei)} HYPE` : "No active listings", count: live, live, unverified: false };
  });
  const scannedAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sortRows = () => rows.sort((a, b) => {
    const af = a.floorWei ?? 10n ** 30n;
    const bf = b.floorWei ?? 10n ** 30n;
    return af < bf ? -1 : af > bf ? 1 : 0;
  });
  void kbLen;
  const buildHeaderText = (verified: boolean): string => {
    let m = `🏷️ *Kalos NFT Marketplace — Elysium*\n\n`;
    m += `🌐 *Chain:* \`${cfg.name}\` (Chain ID \`${cfg.chainId}\`)\n`;
    m += `🏛 *Marketplace:* \`${kalosAddress || "0x0ff8b7afc288ac42f82320f54a49c400f233bf07"}\`\n`;
    m += `🔗 *Portal:* [kalos.fun](https://kalos.fun)\n`;
    m += `🕒 *Scanned:* \`${scannedAt}\` · \`${rows.length} collections\`\n\n`;
    if (rows.length === 0) {
      m += scanFailed
        ? `⚠️ *Kalos data temporarily unavailable* — the testnet RPC is not responding. This is usually brief maintenance; try again shortly. You can still paste any NFT contract \`0x…\` to inspect it directly.\n\n`
        : `No live Kalos collections found in recent blocks. Paste any NFT contract \`0x…\` to inspect it directly.\n\n`;
    } else {
      m += verified
        ? `*Live on Kalos (floor = cheapest verified ask):*\n`
        : `*Live on Kalos (floor ≈ recent ask — verifying ${rows.length}…):*\n`;
    }
    return m;
  };
  const buildMenuText = (_verified: boolean): string => buildHeaderText(_verified);
  const buildMenuKeyboard = (): InlineKeyboard => new InlineKeyboard();
  void buildMenuText;
  void buildMenuKeyboard;
  /** Phase-2 MUST overwrite the floor line even when an edit partially fails:
   * verified floors replace estimates, dead rows explicitly say so. */
  function applyVerifiedFloor(r: (typeof rows)[number], f: { floor: bigint | null; liveCount: number } | undefined) {
    if (f?.floor && f.floor > 0n) {
      r.floorWei = f.floor;
      r.floorStr = `${kalosService.formatPrice(f.floor)} HYPE`;
      r.count = f.liveCount;
    } else {
      r.floorWei = null;
      r.floorStr = "No active listings";
      r.count = 0;
    }
    r.unverified = false;
    r.tag = undefined;
  }
  /** Tag one collection's card so phase-2 edits hit the RIGHT message. */
  const COLLECTION_CARD_TAG = "kalos_collection_card";
  function collectionCardTag(r: { address: Address }): string {
    return `${COLLECTION_CARD_TAG}:${r.address.toLowerCase()}`;
  }
  /** Edit one collection card in place (Markdown, plain-text fallback). */
  async function editCollectionCard(chatId: number, msgId: number, r: (typeof rows)[number], kb: InlineKeyboard): Promise<void> {
    const card = buildCollectionCard({ ...r, scannedAt });
    try {
      await ctx.api.editMessageText(chatId, msgId, card.text, { parse_mode: "Markdown", reply_markup: kb });
    } catch {
      try { await ctx.api.editMessageText(chatId, msgId, card.plain, { reply_markup: kb }); } catch {}
    }
  }
  rows.sort((a, b) => {
    const af = a.floorWei ?? 10n ** 30n;
    const bf = b.floorWei ?? 10n ** 30n;
    return af < bf ? -1 : af > bf ? 1 : 0;
  });
  // Phase 1: instant estimates (marked ⏳ unverified) — one card per collection.
  for (const r of rows) {
    const ef = eventFloor(r.address);
    if (ef && ef > 0n) {
      r.floorWei = ef;
      r.floorStr = `${kalosService.formatPrice(ef)} HYPE`;
      r.count = eventCount(r.address);
      r.unverified = true;
    }
  }
  sortRows();

  /** Send one card per collection. Returns address->messageId so phase-2 edits the SAME cards. */
  async function sendCollectionCards(_verified: boolean): Promise<Map<string, number>> {
    const ids = new Map<string, number>();
    for (const r of rows) {
      const card = buildCollectionCard({ ...r, scannedAt });
      const kb = collectionCardKeyboard(r);
      try {
        const sent = await ctx.reply(card.text, { parse_mode: "Markdown", reply_markup: kb });
        ids.set(r.address.toLowerCase(), sent.message_id);
      } catch {
        try {
          const sent = await ctx.reply(card.plain, { reply_markup: kb });
          ids.set(r.address.toLowerCase(), sent.message_id);
        } catch {}
      }
      // Gentle pacing so Telegram never throttles the burst.
      await new Promise((res) => setTimeout(res, 120));
    }
    return ids;
  }
  void collectionCardTag;
  void editCollectionCard;

  const projects = await fetchLaunchProjects();
  const nftProjects = projects.filter((p) => p.contractAddress || p.tags.includes("nft") || p.tags.includes("collection") || p.status === "minting" || p.status === "live");

  const footerText =
    `\n💡 *Kalos Commands (manual still works):*\n` +
    `• \`/sweep <0x…> [maxHYPE]\` — auto-find cheapest + 1-tap Buy\n` +
    `• \`/nftbuy [contract] [id]\` — Buy item on Kalos\n` +
    `• \`/nftlist [contract] [id] [price]\` — List on Kalos\n` +
    `• \`/nftdelist [contract] [id]\` — Cancel listing\n` +
    `• \`/nftoffer [contract] [id] [price]\` — Place bid\n`;
  const footerKeyboard = (): InlineKeyboard => new InlineKeyboard()
    .text("🔍 Inspect Any 0x... Contract", "col_inspect_prompt").row()
    .text("⚡ Direct Mint", "menu_mint").text("🖼️ My NFTs", "menu_nfts").row()
    .text("🔙 Main Menu", "menu_main");

  let headerMsgId: number | undefined;
  try {
    if (sentScanning) { try { await ctx.api.deleteMessage(ctx.chat!.id, sentScanning.message_id); } catch {} }
  } catch {}
  if (rows.length === 0 && scanFailed) {
    try {
      const fb = footerKeyboard();
      await ctx.reply(buildHeaderText(false) + footerText, { parse_mode: "Markdown", reply_markup: fb });
    } catch {
      await ctx.reply(buildHeaderText(false).replace(/[`*_]/g, "") + footerText.replace(/[`*_]/g, ""));
    }
    return;
  }

  // Phase-1 header + ALL collection cards (estimates, marked ⏳).
  let phase1CardIds = new Map<string, number>();
  try {
    const headerKb = new InlineKeyboard()
      .text("🔍 Inspect Any 0x... Contract", "col_inspect_prompt").row()
      .text("🔙 Main Menu", "menu_main");
    const sent = await ctx.reply(buildHeaderText(false), { parse_mode: "Markdown", reply_markup: rows.length > 0 ? headerKb : footerKeyboard() });
    headerMsgId = sent.message_id;
  } catch {}
  if (rows.length > 0) {
    phase1CardIds = await sendCollectionCards(false);
  }

  // Launch-board floors use the shared scan (no extra RPC scans).
  const launchFloors = new Map<string, string>();
  for (const p of nftProjects.slice(0, 8)) {
    const addr = p.contractAddress;
    if (addr && /^0x[a-fA-F0-9]{40}$/.test(addr)) {
      const ef = eventFloor(addr as Address);
      launchFloors.set(addr.toLowerCase(), ef && ef > 0n ? `${kalosService.formatPrice(ef)} HYPE` : "—");
    }
  }

  // Phase 2 (background): verify floors, then EDIT the SAME cards in place.
  // No re-sends, no deletes — each card's message id is stable per address.
  (async () => {
    try {
      floors = await kalosService.getCollectionFloors(nameRows.map((r) => r.address), { events: sharedEvents, perCollection: 80 });
    } catch { floors = new Map(); }
    for (const r of rows) {
      applyVerifiedFloor(r, floors.get(r.address.toLowerCase()));
      const lf = launchFloors.get(r.address.toLowerCase());
      if (lf && lf !== "—") launchFloors.set(r.address.toLowerCase(), r.floorStr);
    }
    sortRows();
    // Edit each card IN PLACE (same message ids) — the chat never gets a second dump.
    // Retry once per card: a single failed edit must not leave a stale ⏳ estimate.
    if (rows.length > 0 && ctx.chat) {
      for (const r of rows) {
        const msgId = phase1CardIds.get(r.address.toLowerCase());
        if (!msgId) continue;
        const kb = collectionCardKeyboard(r);
        try {
          await editCollectionCard(ctx.chat.id, msgId, r, kb);
        } catch {
          try {
            await new Promise((res) => setTimeout(res, 800));
            await editCollectionCard(ctx.chat.id, msgId, r, kb);
          } catch {}
        }
      }
      try {
        if (headerMsgId) {
          await ctx.api.editMessageText(ctx.chat.id, headerMsgId, buildHeaderText(true), { parse_mode: "Markdown" });
        }
      } catch {}
    }
    // Launch-board footer: ONE message (and ONLY if there is something to show
    // beyond the per-collection cards — never a second dump of collections).
    if (headerMsgId && ctx.chat) {
      try {
        const hasLaunchContent = nftProjects.length > 0;
        if (hasLaunchContent) {
          let m = buildHeaderText(true);
          m += `*Featured & Tracked Collections:*\n\n`;
          for (const p of nftProjects.slice(0, 8)) {
            const addr = p.contractAddress;
            const fl = addr ? (launchFloors.get(addr.toLowerCase()) ?? "—") : "—";
            m += `• *${escMd(p.name)}* [${escMd(p.stage)}]\n`;
            if (addr) m += `  Contract: \`${addr}\`\n`;
            m += `  Floor: \`${fl}\` • Mint: \`${escMd(p.mintDate)}\`\n\n`;
          }
          m += footerText;
          const kb = footerKeyboard();
          for (const p of nftProjects.slice(0, 8)) {
            if (p.contractAddress) {
              try { (kb as any).inline_keyboard.unshift([{ text: `🔍 ${p.name.slice(0, 16)}`, callback_data: `col_inspect_${p.contractAddress}` }]); } catch {}
            }
          }
          await ctx.reply(m, { parse_mode: "Markdown", reply_markup: kb });
        } else {
          // No launch board content: just append the commands footer to the header.
          try {
            await ctx.api.editMessageText(ctx.chat.id, headerMsgId, buildHeaderText(true) + footerText, { parse_mode: "Markdown" });
          } catch {}
        }
      } catch {}
    }
  })();
  return; // phase-2 edits the SAME cards in place; nothing is ever re-sent
}

function kbLen(kb: InlineKeyboard): number {
  try { return ((kb as any).inline_keyboard ?? []).length; } catch { return 0; }
}

async function renderCollectionDetail(ctx: Context, address: Address) {
  let meta: Awaited<ReturnType<typeof getDeploymentMeta>> | null = null;
  try { meta = await getDeploymentMeta(address, ELYSIUM.key); } catch {}

  const name = meta?.name ?? "Elysium Collection";
  const symbol = meta?.symbol ? ` ($${meta.symbol})` : "";
  const explorer = getChainConfig(ELYSIUM.key).explorerUrl;
  const explorerUrl = explorer ? `${explorer}/address/${address}` : undefined;

  let floorStr = "No active listings";
  try {
    const fp = await kalosService.getVerifiedFloor(address);
    if (fp && fp > 0n) floorStr = `${kalosService.formatPrice(fp)} HYPE`;
  } catch {}

  let userBalStr = "0";
  const userId = ctx.from?.id;
  const user = userId ? dbService.getUser(userId) : undefined;
  if (user?.wallet_address) {
    try {
      const cfg = getChainConfig(ELYSIUM.key);
      const { createPublicClient, http } = await import("viem");
      const client = createPublicClient({ chain: cfg.viemChain, transport: http(cfg.rpcUrl) });
      const bal = await client.readContract({
        address,
        abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] }],
        functionName: "balanceOf",
        args: [user.wallet_address as Address],
      }) as bigint;
      userBalStr = bal.toString();
    } catch {}
  }

  let msg = `🖼️ *${escMd(name)}${symbol ? ` (${escMd(symbol.slice(2, -1))})` : ""}*\n`;
  msg += `\`${address}\`\n\n`;
  msg += `🏛 *Marketplace:* Kalos (Elysium L2)\n`;
  msg += `💰 *Floor Price:* \`${floorStr}\`\n`;
  msg += `💼 *Your Holdings:* \`${userBalStr} owned\``;
  const userTokens = user?.wallet_address ? await kalosService.tokensOfOwner(address, user.wallet_address as Address).catch(() => []) : [];
  const shownTokens = (userTokens ?? []).slice(0, 10);
  if (shownTokens.length > 0) {
    msg += ` _(IDs: ${shownTokens.map((t) => `#${t.toString()}`).join(", ")}${(userTokens?.length ?? 0) > shownTokens.length ? ` +${(userTokens?.length ?? 0) - shownTokens.length} more` : ""})_`;
  }
  msg += `\n`;
  if (meta?.bytecodeSize) msg += `📦 *Contract Size:* \`${meta.bytecodeSize} bytes\`\n`;
  if (explorerUrl) msg += `🔗 [View on Explorer](${explorerUrl}) • [View on Kalos](https://kalos.fun)\n\n`;
  msg += `*Kalos Actions:* Tap below to Buy on Kalos, List an item, Make an Offer, or Direct Mint.`;

  const kb = new InlineKeyboard();
  kb.text("🛒 Buy Floor", `kalos_sweep_${address}`)
    .text("🏷️ List Item", `kalos_list_${address}`).row()
    .text("⚡ Direct Mint", `kalos_mint_${address}`)
    .text("🤝 Make Offer", `kalos_offer_${address}`).row()
    .url("🌐 View on Kalos", "https://kalos.fun")
    .text("👀 Watch", `watch_add_${address}`).row()
    .text("🏷️ All Collections", "menu_collections")
    .text("🔙 Main Menu", "menu_main");

  await ctx.reply(msg, {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
  // If the user holds NFTs here, send tap-to-list buttons for each token (no typing).
  if (shownTokens.length > 0) {
    const kb = new InlineKeyboard();
    for (const t of shownTokens) {
      kb.text(`🏷️ List #${t.toString()}`, `kalos_list_${address}_${t.toString()}`).row();
    }
    kb.text("🔙 Main Menu", "menu_main");
    try {
      await ctx.reply(`Select a token to list from *${escMd(name)}*:`, { parse_mode: "Markdown", reply_markup: kb });
    } catch {
      await ctx.reply(`Select a token to list from ${name}:`, { reply_markup: kb });
    }
  }
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
  await ctx.reply(`🔍 Scanning your wallet on *${chain.toUpperCase()}* for NFTs…`, { parse_mode: "Markdown" });

  const nfts = await marketplaceService.getNFTsForUser(user.wallet_address, chain);
  // Self-heal tracked listings FIRST so a sold/cancelled listing never shows
  // as "Active" (the #4727 bug) — then render from the cleaned list.
  try {
    const trackedBefore = dbService.getUserListings(userId);
    if (trackedBefore.length > 0) {
      await Promise.all(trackedBefore.slice(0, 10).map((l) => kalosService.reconcileListing(l.id, userId).catch(() => null)));
    }
  } catch {}
  const activeListings = dbService.getUserListings(userId);

  if (nfts.length === 0 && activeListings.length === 0) {
    const kb = new InlineKeyboard()
      .text("🏷️ Explore Collections", "menu_collections")
      .text("⚡ Direct Mint", "menu_mint").row()
      .text("🔙 Main Menu", "menu_main");

    await ctx.reply(
      `🖼 *My NFT Inventory (${chain.toUpperCase()})*\n\n` +
      `No NFTs detected in your wallet yet.\n\n` +
      `*Address:* \`${user.wallet_address}\`\n\n` +
      `💡 *Get started on Elysium:*\n` +
      `• Browse live collections: \`/collections\`\n` +
      `• Direct-to-contract minting: \`/mint\`\n` +
      `• Buy from Kalos marketplace: \`/nftbuy\``,
      { parse_mode: "Markdown", reply_markup: kb }
    );
    return;
  }

  let msg = `🖼 *My NFT Inventory (${chain.toUpperCase()})*\n` +
            `*Wallet:* \`${user.wallet_address}\`\n\n`;

  // Incoming live offers on YOUR tokens (verified via getTokenBid + ownership).
  // Shows a checking line first so "none right now" only appears AFTER a real scan.
  let incomingBids: Array<{ collection: Address; tokenId: bigint; bidder: Address; price: bigint; expiration: bigint }> = [];
  let bidsScanned = false;
  await ctx.reply(`🤝 Checking live offers on your NFTs…`, { parse_mode: "Markdown" }).catch(() => null);
  try {
    const myTokens = nfts.slice(0, 12).map((n) => ({ collection: n.contract as Address, tokenId: BigInt(n.tokenId) }));
    if (myTokens.length > 0) {
      incomingBids = await kalosService.getIncomingBids(myTokens, user.wallet_address as Address, { perToken: 4 });
    }
    bidsScanned = true;
  } catch { incomingBids = []; bidsScanned = true; }

   // ONE card per NFT: List + Accept-Offer / Make-Offer on the card itself.
  // No giant shared wall — each token carries its own actions. If the card
  // send fails (bad Markdown), fall back to PLAIN TEXT *WITH THE SAME BUTTONS*.
  for (const nft of nfts.slice(0, 12)) {
    const nftBids = incomingBids.filter(
      (b) => b.collection.toLowerCase() === String(nft.contract).toLowerCase() && b.tokenId.toString() === String(nft.tokenId)
    );
    const best = nftBids.length > 0 ? nftBids[0] : null;
    const offerLine = !bidsScanned
      ? `\n🤝 *Offers:* \`checking…\``
      : best
        ? `\n🤝 *Top Offer:* \`${kalosService.formatPrice(best.price)} HYPE\` from \`${best.bidder.slice(0, 6)}…${best.bidder.slice(-4)}\``
        : `\n🤝 *Offers:* \`none right now\``;
    const extraLine = nftBids.length > 1 ? ` (+${nftBids.length - 1} more)` : "";
    const text = `🖼️ *${escMd(nft.title)}*\n\`${nft.contract}\` • Token \`#${escMd(String(nft.tokenId))}\`${offerLine}${extraLine}`;
    const cardKb = (() => {
      const kb = new InlineKeyboard();
      kb.text(`🏷️ List #${nft.tokenId}`, `kalos_list_${nft.contract}_${nft.tokenId}`);
      if (best) kb.text(`✅ Accept ${kalosService.formatPrice(best.price)}`, `kalos_accept_${nft.contract}_${nft.tokenId}_${best.bidder}`);
      kb.text(`🔍 Collection`, `col_inspect_${nft.contract}`).row();
      kb.text("🔙 Menu", "menu_main");
      return kb;
    })();
    try {
      await ctx.reply(text, { parse_mode: "Markdown", reply_markup: cardKb });
    } catch {
      try { await ctx.reply(text.replace(/[`*_]/g, ""), { reply_markup: cardKb }); } catch {}
    }
  }

  // Summary footer ONLY (counts + active listings with Cancel) — no per-NFT
  // lines here anymore, each NFT already got its own card above.

  // Summary footer: counts + ACTIVE listings, each with its own Cancel.
  // (Your screenshot showed a listing with NO cancel path — now every listing
  // gets one, and the cards above carry List/Accept per NFT.)
  if (nfts.length > 0) {
    msg += `*Held NFTs: ${nfts.length} (each has its own card above with List / Accept buttons)*\n\n`;
  }

  if (activeListings.length > 0) {
    msg += `*Active Kalos Listings (${activeListings.length}):*\n`;
    for (const l of activeListings) {
      msg += `• Listing #${l.id}: Token #${l.token_id} at \`${l.price_eth} HYPE\`\n  Contract: \`${l.contract}\`\n\n`;
    }
  }

  const kb = new InlineKeyboard();
  for (const l of activeListings.slice(0, 8)) {
    kb.text(`❌ Cancel #${l.token_id} (${l.price_eth} HYPE)`, `listing_cancel_${l.id}`).row();
  }
  kb.text("⚡ Direct Mint", "menu_mint")
    .text("🏷️ Collections", "menu_collections").row()
    .text("🔙 Main Menu", "menu_main");

  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: kb });
}

async function promptMint(ctx: Context, defaultContract?: string) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) {
    await ctx.reply("⚠️ Please connect a wallet before minting.", { reply_markup: noWalletKeyboard });
    return;
  }

  userStates[userId] = { step: "awaiting_mint_params" };
  const prefill = defaultContract ? `\nPrefilled contract: \`${defaultContract}\`\nSend: \`${defaultContract} 1 0.05\`` : "";
  await ctx.reply(
    `⚡ *Direct Contract Mint (Elysium)*\n\n` +
    `Send your mint command like this:\n` +
    `\`<contract_address> [quantity] [price_per_item_hype]\`\n\n` +
    `*Examples:*\n` +
    `• \`0x123... 1 0.05\` (mint 1 for 0.05 HYPE each)\n` +
    `• \`0x123... 2 0\` (mint 2 on a free mint)${prefill}\n\n` +
    `Gas is paid in native HYPE. Reply *CONFIRM* after reviewing the quote.`,
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

  const contract = parts[0];
  let quantity = 1;
  let priceHype = "0";
  if (parts[1] !== undefined) {
    if (!/^\d+$/.test(parts[1])) {
      await ctx.reply("❌ Quantity must be a positive whole number.");
      return;
    }
    quantity = Number(parts[1]);
  }
  if (parts[2] !== undefined) {
    if (!/^\d+(?:\.\d{1,18})?$/.test(parts[2])) {
      await ctx.reply("❌ Price must be a non-negative HYPE amount.");
      return;
    }
    priceHype = parts[2];
  }

  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    await ctx.reply("❌ Quantity must be a positive whole number.");
    return;
  }

  const chain = ELYSIUM.key;
  const cfg = getChainConfig(chain);
  const mintValueWei = parseEther(priceHype) * BigInt(quantity);
  const totalCostHype = formatEther(mintValueWei);

  let serviceFeeHype = "0";
  if (FEE_RECIPIENT_WALLET && FEE_PERCENTAGE > 0 && mintValueWei > 0n) {
    const feeBasisPoints = BigInt(Math.floor(FEE_PERCENTAGE * 10000));
    serviceFeeHype = formatEther((mintValueWei * feeBasisPoints) / 10000n);
  }

  userStates[userId] = {
    step: "awaiting_mint_confirmation",
    data: { contract, quantity, priceEth: priceHype, chain, expiresAt: Date.now() + 5 * 60_000 },
  };

  let quote = `⚡ *Confirm Mint on Elysium*\n\n`;
  quote += `📄 *Contract:* \`${contract}\`\n`;
  quote += `🎯 *Quantity:* \`${quantity}\` item(s)\n`;
  quote += `💰 *Total Mint Cost:* \`${totalCostHype} ${cfg.symbol}\`\n`;
  if (FEE_RECIPIENT_WALLET && FEE_PERCENTAGE > 0 && mintValueWei > 0n) {
    quote += `💸 *Service Fee:* \`${serviceFeeHype} ${cfg.symbol}\`\n`;
  }
  const kb = new InlineKeyboard()
    .text(`✅ Yes, Mint for ${totalCostHype} HYPE`, "confirm_mint")
    .text("❌ Cancel", "cancel_action");

  quote += `\nGas uses native HYPE.\nTap the button below or reply *YES* to submit:`;
  await ctx.reply(quote, { parse_mode: "Markdown", reply_markup: kb });
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
        console.error("Failed to record mint fee:", error);
      }
    }

    await ctx.reply(
      `✅ *Mint Transaction Confirmed!*\n\n` +
      `📄 *Contract:* \`${result.contract}\`\n` +
      `🎯 *Quantity:* \`${result.quantity}\`\n` +
      `💰 *Total Cost:* \`${result.totalCostEth} HYPE\`\n` +
      `🔗 *Explorer:* [View Tx](${result.explorerUrl})`,
      { parse_mode: "Markdown", reply_markup: mainKeyboard }
    );
  } catch (err: any) {
    await ctx.reply(`❌ Mint failed: ${err.message || "Unknown reason"}`);
  }
}

async function promptNftBuy(ctx: Context, raw?: string) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) {
    await ctx.reply("Connect a wallet first.", { reply_markup: noWalletKeyboard });
    return;
  }

  const parts = (raw || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && /^0x[a-fA-F0-9]{40}$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
    const collection = parts[0] as Address;
    const tokenId = parts[1];
    let manualSeller = (parts[2] && /^0x[a-fA-F0-9]{40}$/.test(parts[2])) ? (parts[2] as Address) : undefined;
    let maxPriceHype = parts[3] ?? (manualSeller ? undefined : parts[2]);

    // Always resolve current owner from chain (prevents stale-listing revert)
    let currentOwner: Address | undefined;
    try {
      const cfg = getChainConfig(ELYSIUM.key);
      const { createPublicClient, http } = await import("viem");
      const client = createPublicClient({ chain: cfg.viemChain, transport: http(cfg.rpcUrl) });
      currentOwner = await client.readContract({
        address: collection,
        abi: [{ name: "ownerOf", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "address" }] }],
        functionName: "ownerOf",
        args: [BigInt(tokenId)],
      }) as Address;
    } catch {}

    // The seller we'll query the listing for — prefer manually specified, fall back to current owner
    const seller = manualSeller ?? currentOwner;

    if (!seller) {
      await ctx.reply("⚠️ Could not detect token owner. Please provide seller address:\n`/nftbuy <collection> <tokenId> <seller_address> [maxPrice]`", { parse_mode: "Markdown" });
      return;
    }

    // Check Kalos listing status on-chain before prompting confirmation
    let listing: { quantity: bigint; pricePerItem: bigint; expirationTime: bigint } | null = null;
    try {
      listing = await kalosService.getListing(collection, BigInt(tokenId), seller);
    } catch {}

    // If seller has a listing but no longer owns the token — stale listing, will revert on-chain
    if (listing && listing.pricePerItem > 0n && currentOwner && seller.toLowerCase() !== currentOwner.toLowerCase()) {
      const offerKb = new InlineKeyboard()
        .text(`🤝 Make Offer on #${tokenId}`, `quick_offer_${collection}_${tokenId}${maxPriceHype ? `_${maxPriceHype}` : ""}`)
        .row()
        .text("❌ Cancel", "cancel_action");

      await ctx.reply(
        `⚠️ *Stale Listing on Kalos — Token Already Transferred!*\n\n` +
        `📄 *Collection:* \`${collection}\`\n` +
        `🏷 *Token ID:* \`#${tokenId}\`\n` +
        `👤 *Listed By:* \`${seller}\` _(no longer the owner)_\n` +
        `👤 *Current Owner:* \`${currentOwner}\`\n\n` +
        `This NFT was sold or transferred after being listed. The listing is stale and any buy attempt would revert.\n\n` +
        `You can place an offer to the current owner instead:`,
        { parse_mode: "Markdown", reply_markup: offerKb }
      );
      return;
    }

    if (!listing || listing.quantity === 0n || listing.pricePerItem === 0n) {
      // The token has an owner but they haven't listed it (or listing is stale)
      const offerKb = new InlineKeyboard()
        .text(`🤝 Make Offer on #${tokenId}`, `quick_offer_${collection}_${tokenId}${maxPriceHype ? `_${maxPriceHype}` : ""}`)
        .row()
        .text("❌ Cancel", "cancel_action");

      await ctx.reply(
        `⚠️ *Token #${tokenId} is not listed for sale on Kalos!*\n\n` +
        `📄 *Collection:* \`${collection}\`\n` +
        `👤 *Current Owner:* \`${currentOwner ?? seller}\`\n\n` +
        `_This token may have recently been sold or transferred — the current owner hasn't listed it on Kalos, or the listing has been removed._\n\n` +
        `You cannot direct-buy an unlisted token. You can place an offer instead:`,
        { parse_mode: "Markdown", reply_markup: offerKb }
      );
      return;
    }

    const listedPrice = formatEther(listing.pricePerItem);
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    if (listing.expirationTime > 0n && listing.expirationTime < nowSec) {
      await ctx.reply(
        `⚠️ *Listing Expired on Kalos!*\n\nToken #${tokenId} had a listing that expired. The owner needs to relist it.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (maxPriceHype && Number(listedPrice) > Number(maxPriceHype)) {
      await ctx.reply(
        `⚠️ *Price Exceeds Max!*\n\nListed price is *${listedPrice} HYPE*, which exceeds your maximum of *${maxPriceHype} HYPE*.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    userStates[userId] = {
      step: "awaiting_nftbuy_confirmation",
      data: { collection, tokenId, owner: seller, maxPriceHype: maxPriceHype || listedPrice, expiresAt: Date.now() + 5 * 60_000 },
    };

    const kb = new InlineKeyboard()
      .text(`✅ Yes, Buy for ${listedPrice} HYPE`, "confirm_nftbuy")
      .text("❌ Cancel", "cancel_action");

    let quote = `🛒 *Confirm Kalos NFT Purchase*\n\n`;
    quote += `📄 *Collection:* \`${collection}\`\n`;
    quote += `🏷 *Token ID:* \`#${tokenId}\`\n`;
    quote += `👤 *Seller:* \`${seller}\`\n`;
    quote += `💰 *Listed Price:* \`${listedPrice} HYPE\`\n`;
    if (maxPriceHype && maxPriceHype !== listedPrice) {
      quote += `🛡 *Max Slippage Limit:* \`${maxPriceHype} HYPE\`\n`;
    }
    quote += `\nTap the button below or reply *YES* to proceed:`;
    await ctx.reply(quote, { parse_mode: "Markdown", reply_markup: kb });
    return;
  }

  userStates[userId] = { step: "awaiting_nftbuy_params" };
  await ctx.reply(
    `🛒 *Buy NFT on Kalos*\n\n` +
    `Send the command like this:\n` +
    `\`<collection_address> <token_id> [max_price_hype]\`\n\n` +
    `*Examples:*\n` +
    `• \`0x123... 1 0.1\` (buy token #1 at up to 0.1 HYPE)\n` +
    `• \`0x123... 4\` (buy token #4 at current listing price)\n\n` +
    `_The bot automatically resolves the seller address from the contract._\n` +
    `Reply with the details above, or \`/cancel\`.`,
    { parse_mode: "Markdown" }
  );
}


async function executeSweepBuy(ctx: Context, contract: Address, items: Array<{ tokenId: string; seller: string; price: string }>) {
  const userId = ctx.from?.id;
  if (!userId) return;
  delete userStates[userId];
  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) {
    await ctx.reply("No wallet found. Use /wallet to create one first.", { reply_markup: noWalletKeyboard });
    return;
  }
  const n = Math.max(1, Math.min(10, items.length));
  const take = items.slice(0, n);
  const listLine = take.map((t) => `#${t.tokenId} (${t.price} HYPE)`).join(" + ");
  try {
    // Gas-free dry-run on the FIRST item: catch stale/sold listings before spending gas.
    const first = take[0];
    const dry = await kalosService.dryRunBuy(contract, BigInt(first.tokenId), first.seller as Address, wallet.address as Address, 1n);
    if (!dry.ok) {
      await ctx.reply(
        `❌ *Sweep would fail — no gas spent.*\n\n${dry.reason}\n\nTap 🧹 Re-scan floor and try again.`,
        { parse_mode: "Markdown", reply_markup: mainKeyboard }
      );
      return;
    }
    await ctx.reply(`⏳ Sweeping ${take.length} on Kalos (${listLine})…`, { parse_mode: "Markdown" });
    const { hash, totalWei } = await kalosService.sweepBuy(
      wallet.privateKey,
      contract,
      take.length,
      undefined
    );
    const cfg = getChainConfig(ELYSIUM.key);
    await ctx.reply(
      `✅ *Sweep complete — ${take.length} NFT${take.length > 1 ? "s" : ""} bought!*\n\n${listLine}\nTotal: \`${kalosService.formatPrice(totalWei)} HYPE\`\nTx: \`${hash}\`\n🔗 [View](${cfg.explorerUrl}/tx/${hash})`,
      { parse_mode: "Markdown", reply_markup: mainKeyboard }
    );
  } catch (e: any) {
    const decoded = kalosService.decodeBuyError(e);
    const detail = decoded ? `Contract error: \`${decoded}\`` : (e?.shortMessage ?? e?.message ?? "unknown");
    await ctx.reply(`❌ Sweep failed: ${detail}\n\nListings may have sold. Tap 🧹 Re-scan floor and try again.`, { parse_mode: "Markdown", reply_markup: mainKeyboard });
  }
}

async function executeNftBuy(ctx: Context, data: { collection: Address; tokenId: string; owner: Address; maxPriceHype?: string }) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) { await ctx.reply("No wallet found."); return; }

  try {
    const now = BigInt(Math.floor(Date.now() / 1000));
    await ctx.reply(`⏳ Verifying listing #${data.tokenId} on Kalos…`, { parse_mode: "Markdown" });
    const listing = await kalosService.getListing(data.collection, BigInt(data.tokenId), data.owner);
    if (!listing || listing.pricePerItem === 0n) {
      await ctx.reply(`❌ *No longer listed.* Token #${data.tokenId} was sold, delisted, or the seller changed. Tap 🧹 Re-scan floor for a live one.`, { parse_mode: "Markdown", reply_markup: makeCollectionKeyboard(data.collection) });
      return;
    }
    if (listing.expirationTime > 0n && listing.expirationTime < now) {
      await ctx.reply(`⚠️ *Listing expired.* The seller needs to relist #${data.tokenId} on Kalos.`, { parse_mode: "Markdown" });
      return;
    }
    const livePrice = kalosService.formatPrice(listing.pricePerItem);
    // Gas-free dry-run: simulate the exact buy. If it would revert, tell the
    // user the decoded contract reason instead of spending gas on a failure.
    const dry = await kalosService.dryRunBuy(data.collection, BigInt(data.tokenId), data.owner, wallet.address as Address, 1n);
    if (!dry.ok) {
      await ctx.reply(
        `❌ *Buy would fail — no gas spent.*\n\n${dry.reason}\n\nTap 🧹 Re-scan floor for a live listing.`,
        { parse_mode: "Markdown", reply_markup: makeCollectionKeyboard(data.collection) }
      );
      return;
    }
    await ctx.reply(`⏳ Purchasing #${data.tokenId} on Kalos for ~${livePrice} HYPE…`, { parse_mode: "Markdown" });
    const hash = await kalosService.buy(wallet.privateKey, data.collection, data.tokenId, data.owner, {
      maxPriceEth: data.maxPriceHype,
    });
    const cfg = getChainConfig(ELYSIUM.key);
    dbService.recordTrade(userId, ELYSIUM.key, data.collection, data.tokenId, Number(data.maxPriceHype || "0"), hash, "buy");
    await ctx.reply(
      `✅ *NFT Purchased Successfully on Kalos!*\n\n` +
      `📄 *Collection:* \`${data.collection}\`\n` +
      `🏷 *Token ID:* \`#${data.tokenId}\`\n` +
      `🔗 [View Transaction](${cfg.explorerUrl}/tx/${hash})`,
      { parse_mode: "Markdown", reply_markup: mainKeyboard }
    );
  } catch (err: any) {
    const decoded = kalosService.decodeBuyError(err);
    const detail = decoded ? `Contract error: \`${decoded}\`` : (err?.shortMessage || err?.message || "Contract reverted");
    await ctx.reply(`❌ Buy failed: ${detail}`);
  }
}

async function promptNftList(ctx: Context, raw?: string) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) {
    await ctx.reply("Connect a wallet before listing an NFT.", { reply_markup: noWalletKeyboard });
    return;
  }

  const parts = (raw || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 2 && /^0x[a-fA-F0-9]{40}$/.test(parts[0] as string) && /^\d+$/.test(parts[1] as string)) {
    const preContract = parts[0] as Address;
    const preTokenId = parts[1];
    userStates[userId] = { step: "awaiting_nftlist_price", data: { contract: preContract, tokenId: preTokenId, expiresAt: Date.now() + 5 * 60_000 } };
    await ctx.reply(
      `🏷 *List #${preTokenId} on Kalos*\n\nReply with price + optional days:\n\n\`<price_hype> [days]\`\n\n*Examples:*\n\`0.55\` — list at 0.55 HYPE for 7 days\n\`0.55 3\` — list at 0.55 HYPE for 3 days`,
      { parse_mode: "Markdown" }
    );
    return;
  }
  // (two-part prefill handled above)
  const partsFull = (raw || "").trim().split(/\s+/).filter(Boolean);
  if (partsFull.length >= 3 && /^0x[a-fA-F0-9]{40}$/.test(partsFull[0]) && /^\d+$/.test(partsFull[1]) && /^\d+(?:\.\d{1,18})?$/.test(partsFull[2])) {
    const contract = partsFull[0] as Address;
    const tokenId = partsFull[1];
    const priceHype = partsFull[2];
    const days = partsFull[3] ? Number(partsFull[3]) : 7;

    userStates[userId] = {
      step: "awaiting_nftlist_confirmation",
      data: { contract, tokenId, priceHype, days, expiresAt: Date.now() + 5 * 60_000 },
    };

    const kb = new InlineKeyboard()
      .text(`✅ Yes, List for ${priceHype} HYPE`, "confirm_nftlist")
      .text("❌ Cancel", "cancel_action");

    let quote = `🏷 *Confirm Kalos NFT Listing*\n\n`;
    quote += `📄 *Collection:* \`${contract}\`\n`;
    quote += `🔢 *Token ID:* \`#${tokenId}\`\n`;
    quote += `💰 *Listing Price:* \`${priceHype} HYPE\`\n`;
    quote += `⏱ *Duration:* \`${days} days\`\n\n`;
    quote += `_Will approve Kalos marketplace contract if not approved yet._\n\n`;
    quote += `Tap the button below or reply *YES* to publish:`;
    await ctx.reply(quote, { parse_mode: "Markdown", reply_markup: kb });
    return;
  }

  userStates[userId] = { step: "awaiting_nftlist_params" };
  await ctx.reply(
    `🏷 *List NFT on Kalos*\n\n` +
    `Send listing details:\n` +
    `\`<collection_address> <token_id> <price_hype> [duration_days]\`\n\n` +
    `*Example:*\n` +
    `\`0x123... 1 0.25 7\`\n\n` +
    `Or reply \`/cancel\`.`,
    { parse_mode: "Markdown" }
  );
}

async function executeNftList(ctx: Context, data: { contract: Address; tokenId: string; priceHype: string; days: number }) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) { await ctx.reply("No wallet found."); return; }

  try {
    await ctx.reply(`⏳ Checking #${data.tokenId} on Kalos…`, { parse_mode: "Markdown" });
    const { parseEther: parseEtherList } = await import("viem");
    const expList = BigInt(Math.floor(Date.now() / 1000) + (data.days ?? 7) * 86400);
    const dryList = await kalosService.dryRunList(data.contract, BigInt(data.tokenId), wallet.address as Address, parseEtherList(data.priceHype), expList);
    if (!dryList.ok) {
      const needsApproval = (dryList as { needsApproval?: boolean }).needsApproval === true;
      if (needsApproval) {
        if (userId) {
          userStates[userId] = { step: "awaiting_nftlist_approve", data: { ...data, expiresAt: Date.now() + 5 * 60_000 } };
        }
        const kb = new InlineKeyboard()
          .text("✅ Approve Kalos", "confirm_nftapprove")
          .text("❌ Cancel", "cancel_action");
        await ctx.reply(
          `🔐 *Approval needed.*\n\n${dryList.reason}\n\nTap Approve (one tx), then I’ll continue your listing automatically.`,
          { parse_mode: "Markdown", reply_markup: kb }
        );
        return;
      }
      await ctx.reply(`❌ *Listing blocked — no gas spent.*\n\n${dryList.reason}\n\nCheck: 1) token ID is yours in /nfts, 2) expiry 1–30 days.`, { parse_mode: "Markdown" });
      return;
    }
    await ctx.reply(`⏳ Approving & creating listing on Kalos for *${data.priceHype} HYPE*...`, { parse_mode: "Markdown" });
    const hash = await kalosService.createListing(wallet.privateKey, data.contract, data.tokenId, data.priceHype, { days: data.days });
    const localId = dbService.createListing(userId, ELYSIUM.key, data.contract, data.tokenId, Number(data.priceHype), hash, null);
    const cfg = getChainConfig(ELYSIUM.key);

    await ctx.reply(
      `✅ *Listing Published on Kalos!* (Record #${localId})\n\n` +
      `📄 *Collection:* \`${data.contract}\`\n` +
      `🏷 *Token ID:* \`#${data.tokenId}\`\n` +
      `💰 *Price:* \`${data.priceHype} HYPE\`\n` +
      `🔗 [View Transaction](${cfg.explorerUrl}/tx/${hash})\n\n` +
      `Buyers can now purchase your NFT directly via Kalos on Telegram!`,
      { parse_mode: "Markdown", reply_markup: mainKeyboard }
    );
  } catch (err: any) {
    const decoded = kalosService.decodeContractError(err);
    const detail = decoded ? `Contract error: \`${decoded}\`` : (err?.shortMessage || err?.message || "Reverted");
    await ctx.reply(`❌ Listing failed: ${detail}\n\nTip: check /nfts — it now shows your EXACT token IDs. List only a token you hold.`);
  }
}

async function promptNftDelist(ctx: Context, raw?: string) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) {
    await ctx.reply("Connect a wallet first.", { reply_markup: noWalletKeyboard });
    return;
  }

  const parts = (raw || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && /^0x[a-fA-F0-9]{40}$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
    const contract = parts[0] as Address;
    const tokenId = parts[1];

    userStates[userId] = {
      step: "awaiting_nftdelist_confirmation",
      data: { contract, tokenId, expiresAt: Date.now() + 5 * 60_000 },
    };

    const kb = new InlineKeyboard()
      .text("✅ Yes, Delist NFT", "confirm_nftdelist")
      .text("❌ Keep Listing", "cancel_action");

    await ctx.reply(
      `❌ Cancel listing on Kalos for \`${contract} #${tokenId}\`?\n` +
      `This executes an on-chain cancel transaction.\n\nTap the button below or reply *YES* to proceed:`,
      { parse_mode: "Markdown", reply_markup: kb }
    );
    return;
  }

  const activeListings = dbService.getUserListings(userId);
  if (activeListings.length === 0) {
    await ctx.reply("No active local listings found. Send `/nftdelist <collection> <token_id>` to cancel directly.", { parse_mode: "Markdown" });
    return;
  }

  let msg = `📋 *Active Kalos Listings*\n\nSelect a listing to cancel:\n`;
  const kb = new InlineKeyboard();
  activeListings.forEach((l) => {
    msg += `• Listing #${l.id}: Token #${l.token_id} at \`${l.price_eth} HYPE\`\n  Contract: \`${l.contract}\`\n`;
    kb.text(`Cancel #${l.id} (${l.contract.slice(0, 6)}… #${l.token_id})`, `listing_cancel_${l.id}`).row();
  });
  kb.text("🔙 Main Menu", "menu_main");
  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: kb });
}

async function executeNftDelist(ctx: Context, data: { contract: Address; tokenId: string; listingId?: number }) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) { await ctx.reply("No wallet found."); return; }

  try {
    await ctx.reply(`⏳ Cancelling listing on Kalos...`, { parse_mode: "Markdown" });
    const dry = await kalosService.dryRunCancel(data.contract, BigInt(data.tokenId), wallet.address as Address);
    if (!dry.ok) {
      await ctx.reply(`❌ *Cancel would fail — no gas spent.*\n\n${dry.reason}`, { parse_mode: "Markdown" });
      return;
    }
    const hash = await kalosService.cancelListing(wallet.privateKey, data.contract, data.tokenId);
    if (data.listingId) {
      dbService.delist(data.listingId, userId);
    }
    const cfg = getChainConfig(ELYSIUM.key);
    await ctx.reply(
      `✅ *Listing Cancelled on Kalos!*\n\n` +
      `🔗 [View Transaction](${cfg.explorerUrl}/tx/${hash})`,
      { parse_mode: "Markdown", reply_markup: mainKeyboard }
    );
  } catch (err: any) {
    const decoded = kalosService.decodeContractError(err);
    const detail = decoded ? `Contract error: \`${decoded}\`` : (err?.shortMessage || err?.message || "Reverted");
    await ctx.reply(`❌ Delisting failed: ${detail}`);
  }
}

async function promptNftOffer(ctx: Context, raw?: string) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) {
    await ctx.reply("Connect a wallet before making an offer.", { reply_markup: noWalletKeyboard });
    return;
  }

  const parts = (raw || "").trim().split(/\s+/).filter(Boolean);
  const isAddr = (s?: string) => !!s && /^0x[a-fA-F0-9]{40}$/.test(s);
  const isTid = (s?: string) => !!s && /^\d+$/.test(s);
  const isPrice = (s?: string) => !!s && /^\d+(?:\.\d{1,18})?$/.test(s) && Number(s) > 0;
  const isDays = (s?: string) => !!s && /^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= 30;
  // Accepted shapes (tokenId 0 = any token):
  //   <contract> <price> [days] | <contract> <tokenId> <price> [days]
  if (parts.length >= 2 && isAddr(parts[0]) && isPrice(parts[1]) && (parts[2] === undefined || isDays(parts[2]))) {
    const anyContract = parts[0] as Address;
    userStates[userId] = {
      step: "awaiting_nftoffer_confirmation",
      data: { contract: anyContract, tokenId: "0", priceHype: parts[1], days: parts[2] !== undefined ? Number(parts[2]) : 7, expiresAt: Date.now() + 5 * 60_000 },
    };
  } else if (parts.length >= 3 && isAddr(parts[0]) && isTid(parts[1]) && isPrice(parts[2])) {
    const specContract = parts[0] as Address;
    const specTokenId = parts[1];
    const specPrice = parts[2];
    let specDays = 7;
    if (parts[3] !== undefined) {
      if (!isDays(parts[3])) {
        await ctx.reply("Duration must be 1–30 days. Try again, e.g. `<contract> 6187 0.5 3`.", { parse_mode: "Markdown" });
        return;
      }
      specDays = Number(parts[3]);
    }

    userStates[userId] = {
      step: "awaiting_nftoffer_confirmation",
      data: { contract: specContract, tokenId: specTokenId, priceHype: specPrice, days: specDays, expiresAt: Date.now() + 5 * 60_000 },
    };

    const tokenLabel = `#${specTokenId}`;
    const kb = new InlineKeyboard()
      .text(`✅ Yes, Offer ${specPrice} HYPE`, "confirm_nftoffer")
      .text("❌ Cancel", "cancel_action");

    let quote = `🤝 *Confirm Kalos Offer / Bid*\n\n`;
    quote += `📄 *Collection:* \`${specContract}\`\n`;
    quote += `🏷 *Token:* \`${tokenLabel}\`\n`;
    quote += `💰 *Offer Price:* \`${specPrice} HYPE\`\n`;
    quote += `⏱ *Expiry:* \`${specDays} days\`\n\n`;
    quote += `Tap the button below or reply *YES* to proceed:`;
    await ctx.reply(quote, { parse_mode: "Markdown", reply_markup: kb });
    return;
  } else {
      // Fell through (e.g. bad shape) — show the flexible prompt.
      userStates[userId] = { step: "awaiting_nftoffer_params" };
      await ctx.reply(
        `🤝 *Make Offer on Kalos*\n\nSend ONE of:\n\n\`<collection> <price> [days]\` — any token\n\`<collection> <tokenId> <price> [days]\` — specific token\n\n*Example:*\n\`0x123... 0.5\` or \`0x123... 1 0.1 7\`\n\nOr reply \`/cancel\`.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

  userStates[userId] = { step: "awaiting_nftoffer_params" };
  await ctx.reply(
    `🤝 *Make Offer on Kalos*\n\nSend ONE of:\n\n\`<collection> <price> [days]\` — offer on *any* token\n\`<collection> <tokenId> <price> [days]\` — offer on a *specific* token\n\n*Example:*\n\`0x123... 0.5\` or \`0x123... 1 0.1 7\`\n\nOr reply \`/cancel\`.`,
    { parse_mode: "Markdown" }
  );
}

async function executeNftOffer(ctx: Context, data: { contract: Address; tokenId: string; priceHype: string; days: number }) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) { await ctx.reply("No wallet found."); return; }

  try {
    const scope = data.tokenId === "0" ? "any token" : `#${data.tokenId}`;
    await ctx.reply(`⏳ Placing ${scope} bid on Kalos for *${data.priceHype} HYPE*...`, { parse_mode: "Markdown" });
    const need = parseEther(data.priceHype);
    const dry = await kalosService.dryRunBid(data.contract, BigInt(data.tokenId), need, wallet.address as Address);
    if (!dry.ok) {
      if (dry.code === "NEEDS_WRAP" && dry.shortfall && dry.shortfall > 0n) {
        const shortStr = kalosService.formatPrice(dry.shortfall);
        const kb = new InlineKeyboard().text(`🔄 Wrap ${shortStr} HYPE & Bid`, "wrap_and_bid").text("💰 Wrap…", "wallet_wrap").row().text("💧 Get HYPE", "wallet_faucet").text("❌ Cancel", "cancel_action");
        userStates[userId] = { step: "awaiting_offer_wrap_confirm", data: { ...data, expiresAt: Date.now() + 5 * 60_000 } };
        await ctx.reply(
          `🔄 *One tap to fix:* you hold 0 WHYPE but need *${data.priceHype} WHYPE* for this bid.\n\n` +
          `Your HYPE is native — bids escrow in WHYPE. Tap below and I'll wrap *${shortStr} HYPE → WHYPE*, approve Kalos, then place your bid. Small gas applies to the wrap.`,
          { parse_mode: "Markdown", reply_markup: kb }
        );
        return;
      }
      if (dry.code === "INSUFFICIENT_WHYPE") {
        const kb = new InlineKeyboard().text("💰 Wrap…", "wallet_wrap").text("💧 Get Testnet HYPE", "wallet_faucet").row().text("💎 Check WHYPE", "wallet_refresh").text("❌ Cancel", "cancel_action");
        await ctx.reply(`❌ *Offer would fail — no gas spent.*\n\n${dry.reason}\n\nYou need real funds first: top up HYPE (faucet), then wrap to WHYPE. Your WHYPE balance is live in /wallet — nothing paper.`, { parse_mode: "Markdown", reply_markup: kb });
        return;
      }
      await ctx.reply(`❌ *Offer would fail — no gas spent.*\n\n${dry.reason}`, { parse_mode: "Markdown" });
      return;
    }
    const hash = await kalosService.createTokenBid(wallet.privateKey, data.contract, data.tokenId, data.priceHype, { days: data.days });
    const cfg = getChainConfig(ELYSIUM.key);
    await ctx.reply(
      `✅ *Offer Placed on Kalos!*\n\n` +
      `📄 *Collection:* \`${data.contract}\`\n` +
      `🏷 *Token:* \`${data.tokenId === "0" ? "any token" : `#${data.tokenId}`}\`\n` +
      `💰 *Bid:* \`${data.priceHype} HYPE\`\n` +
      `🔗 [View Transaction](${cfg.explorerUrl}/tx/${hash})`,
      { parse_mode: "Markdown", reply_markup: mainKeyboard }
    );
  } catch (err: any) {
    const decoded = kalosService.decodeContractError(err);
    const detail = decoded ? `Contract error: \`${decoded}\`` : (err?.shortMessage || err?.message || "Reverted");
    await ctx.reply(`❌ Offer failed: ${detail}`);
  }
}

async function promptNftAccept(ctx: Context, raw?: string) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) {
    await ctx.reply("Connect a wallet first.", { reply_markup: noWalletKeyboard });
    return;
  }

  const parts = (raw || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 3 && /^0x[a-fA-F0-9]{40}$/.test(parts[0]) && /^\d+$/.test(parts[1]) && /^0x[a-fA-F0-9]{40}$/.test(parts[2])) {
    const contract = parts[0] as Address;
    const tokenId = parts[1];
    const bidder = parts[2] as Address;
    const priceHype = parts[3];

    userStates[userId] = {
      step: "awaiting_nftaccept_confirmation",
      data: { contract, tokenId, bidder, priceHype, expiresAt: Date.now() + 5 * 60_000 },
    };

    const kb = new InlineKeyboard()
      .text("✅ Yes, Accept Bid", "confirm_nftaccept")
      .text("❌ Cancel", "cancel_action");

    let quote = `🤝 *Accept Kalos Bid*\n\n`;
    quote += `📄 *Collection:* \`${contract}\`\n`;
    quote += `🏷 *Token ID:* \`#${tokenId}\`\n`;
    quote += `👤 *Bidder:* \`${bidder}\`\n`;
    if (priceHype) quote += `💰 *Expected Payout:* \`${priceHype} HYPE\`\n`;
    quote += `\nTap the button below or reply *YES* to proceed:`;
    await ctx.reply(quote, { parse_mode: "Markdown", reply_markup: kb });
    return;
  }

  userStates[userId] = { step: "awaiting_nftaccept_params" };
  await ctx.reply(
    `🤝 *Accept Offer on Kalos*\n\n` +
    `Send details:\n` +
    `\`<collection_address> <token_id> <bidder_address> [expected_price_hype]\`\n\n` +
    `*Example:*\n` +
    `\`0x123... 1 0xBidder... 0.1\`\n\n` +
    `Or reply \`/cancel\`.`,
    { parse_mode: "Markdown" }
  );
}

async function executeNftAccept(ctx: Context, data: { contract: Address; tokenId: string; bidder: Address; priceHype?: string }) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) { await ctx.reply("No wallet found."); return; }

  try {
    await ctx.reply(`⏳ Accepting bid and executing transfer on Kalos...`, { parse_mode: "Markdown" });
    const dry = await kalosService.dryRunAccept(data.contract, BigInt(data.tokenId), data.bidder, wallet.address as Address);
    if (!dry.ok) {
      await ctx.reply(`❌ *Accept would fail — no gas spent.*\n\n${dry.reason}`, { parse_mode: "Markdown" });
      return;
    }
    const hash = await kalosService.acceptBid(wallet.privateKey, data.contract, data.tokenId, data.bidder, { priceEth: data.priceHype });
    const cfg = getChainConfig(ELYSIUM.key);
    dbService.recordTrade(userId, ELYSIUM.key, data.contract, data.tokenId, Number(data.priceHype || "0"), hash, "sell");
    await ctx.reply(
      `✅ *Bid Accepted on Kalos!*\n\n` +
      `🔗 [View Transaction](${cfg.explorerUrl}/tx/${hash})`,
      { parse_mode: "Markdown", reply_markup: mainKeyboard }
    );
  } catch (err: any) {
    const decoded = kalosService.decodeContractError(err);
    const detail = decoded ? `Contract error: \`${decoded}\`` : (err?.shortMessage || err?.message || "Reverted");
    await ctx.reply(`❌ Accept failed: ${detail}`);
  }
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
    let floorLine = "No active listings";
    try {
      const fp = await kalosService.getVerifiedFloor(token);
      if (fp && fp > 0n) floorLine = `\`${kalosService.formatPrice(fp)} HYPE\``;
    } catch {}
    const msg = `🖼️ *${name}${sym}* — NFT Collection\n${short} \`${token}\`\n\n🏛 *Marketplace:* Kalos (Elysium L2)\n💰 *Floor Price:* ${floorLine}\n${url ? `🔍 [View on Explorer](${url}) • ` : ""}🌐 [View on Kalos](https://kalos.fun)\n\n*Tap Buy on Kalos to purchase, or List Item to sell directly in Telegram.*`;
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

/** Wrap explicit amount (or "max") of native HYPE -> WHYPE. Real tx, never paper. */
async function handleWrap(ctx: Context, raw?: string) {
  const userId = ctx.from?.id; if (!userId) return;
  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) { await ctx.reply("Create a wallet first.", { reply_markup: noWalletKeyboard }); return; }
  const arg = (raw ?? "").trim().toLowerCase();
  if (!arg) {
    userStates[userId] = { step: "awaiting_wrap_amount", data: { expiresAt: Date.now() + 5 * 60_000 } };
    await ctx.reply(`💰 *Wrap HYPE → WHYPE*\n\nReply with an amount (e.g. \`0.1\`), or \`max\`.\n\nOr reply \`/cancel\`.`, { parse_mode: "Markdown" });
    return;
  }
  try {
    const { createPublicClient, http, parseEther, formatEther } = await import("viem");
    const cfg = getChainConfig(ELYSIUM.key);
    const pc = createPublicClient({ chain: cfg.viemChain, transport: http(cfg.rpcUrl) });
    const native = await pc.getBalance({ address: wallet.address as Address });
    const buffer = parseEther("0.005");
    let amount: bigint;
    if (arg === "max" || arg === "all") {
      if (native <= buffer) { await ctx.reply(`❌ Nothing wrappable: you hold \`${formatEther(native)} HYPE\` and ~0.005 must stay for gas. Top up via 💧 Get Testnet HYPE first.`); return; }
      amount = native - buffer;
    } else {
      if (!/^\d+(?:\.\d{1,18})?$/.test(arg) || Number(arg) <= 0) { await ctx.reply("❌ Invalid amount — use e.g. `0.1` or `max`."); return; }
      amount = parseEther(arg as `${number}`);
      if (native < amount + buffer) {
        await ctx.reply(`❌ Not enough HYPE: you hold \`${formatEther(native)} HYPE\` but need \`${formatEther(amount)} + ~0.005 gas\`. Top up via 💧 Get Testnet HYPE, or wrap less.`, { parse_mode: "Markdown" });
        return;
      }
    }
    await ctx.reply(`🔄 Wrapping \`${formatEther(amount)} HYPE → WHYPE\`...`, { parse_mode: "Markdown" });
    const hash = await kalosService.wrapHype(wallet.privateKey, amount);
    const w = await kalosService.whypeBalance(wallet.address as Address).catch(() => ({ raw: 0n, symbol: "WHYPE" }));
    await ctx.reply(
      `✅ *Wrapped!* \`${formatEther(amount)} HYPE → WHYPE\`\n\n💎 WHYPE now: \`${kalosService.formatPrice(w.raw)} ${w.symbol}\`\n🔗 [View wrap tx](${cfg.explorerUrl}/tx/${hash})\n\nNow retry your offer — or tap 🔄 Wrap & Bid on the offer card.`,
      { parse_mode: "Markdown", reply_markup: mainKeyboard }
    );
  } catch (e: any) {
    await ctx.reply(`❌ Wrap failed: ${e?.shortMessage || e?.message || "unknown"}`);
  }
}

/** Unwrap explicit amount (or "max") of WHYPE -> native HYPE. */
async function handleUnwrap(ctx: Context, raw?: string) {
  const userId = ctx.from?.id; if (!userId) return;
  const wallet = walletManager.getUserWallet(userId);
  if (!wallet) { await ctx.reply("Create a wallet first.", { reply_markup: noWalletKeyboard }); return; }
  const arg = (raw ?? "").trim().toLowerCase();
  if (!arg) {
    userStates[userId] = { step: "awaiting_unwrap_amount", data: { expiresAt: Date.now() + 5 * 60_000 } };
    await ctx.reply(`💎 *Unwrap WHYPE → HYPE*\n\nReply with an amount (e.g. \`0.1\`), or \`max\`.\n\nOr reply \`/cancel\`.`, { parse_mode: "Markdown" });
    return;
  }
  try {
    const { parseEther, formatEther } = await import("viem");
    const w = await kalosService.whypeBalance(wallet.address as Address);
    let amount: bigint;
    if (arg === "max" || arg === "all") {
      if (w.raw <= 0n) { await ctx.reply(`❌ Nothing to unwrap: you hold \`0 WHYPE\`. Wrap first with /wrap.`); return; }
      amount = w.raw;
    } else {
      if (!/^\d+(?:\.\d{1,18})?$/.test(arg) || Number(arg) <= 0) { await ctx.reply("❌ Invalid amount — use e.g. `0.1` or `max`."); return; }
      amount = parseEther(arg as `${number}`);
      if (w.raw < amount) { await ctx.reply(`❌ Not enough WHYPE: you hold \`${kalosService.formatPrice(w.raw)} WHYPE\`.`); return; }
    }
    await ctx.reply(`🔄 Unwrapping \`${formatEther(amount)} WHYPE → HYPE\`...`, { parse_mode: "Markdown" });
    const cfg = getChainConfig(ELYSIUM.key);
    const hash = await kalosService.unwrapHype(wallet.privateKey, amount);
    await ctx.reply(`✅ *Unwrapped!* \`${formatEther(amount)} WHYPE → HYPE\`\n🔗 [View tx](${cfg.explorerUrl}/tx/${hash})`, { parse_mode: "Markdown", reply_markup: mainKeyboard });
  } catch (e: any) {
    await ctx.reply(`❌ Unwrap failed: ${e?.shortMessage || e?.message || "unknown"}`);
  }
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
  msg += `*Token Trading (Elysium HYPE):*\n`;
  msg += `• Paste any \`0x…\` → Zensweep card + Safety → Buy/Sell\n`;
  msg += `• \`/buy <0x…> <HYPE>\` / \`/sell <0x…> [25|50|100]\` (+ Buy X custom)\n`;
  msg += `• \`/safety <0x…>\` — honeypot/mint/blacklist/proxy — score 0–100\n`;
  msg += `• \`/portfolio\` — results, history and a share card\n`;
  msg += `• \`/slippage\` — your price tolerance (1–50%)\n`;
  msg += `• \`/copy\` — Zensweep Auto-Follow up to 5 wallets (V2)\n`;
  msg += `\n`;
  msg += `*NFTs & Kalos Marketplace:*\n`;
  msg += `• \`/collections\` — Live Kalos NFT collections & floor prices\n`;
  msg += `• \`/nfts\` — Your Elysium NFT inventory & active listings\n`;
  msg += `• \`/mint <0x…> [quantity] [price]\` — Direct contract mint in HYPE\n`;
  msg += `• \`/nftbuy <0x…> <tokenId> [maxPrice]\` — Buy item on Kalos\n`;
  msg += `• \`/nftlist <0x…> <tokenId> <price> [days]\` — List NFT for sale on Kalos\n`;
  msg += `• \`/nftdelist <0x…> <tokenId>\` — Cancel listing on Kalos\n`;
  msg += `• \`/nftoffer <0x…> <tokenId> <price> [days]\` — Place bid on Kalos (or \`/offer\`) — auto-wraps HYPE→WHYPE as needed\n`;
  msg += `• \`/nftaccept <0x…> <tokenId> <bidder>\` — Accept Kalos bid\n`;
  msg += `• \`/wrap <amount|max>\` / \`/unwrap <amount|max>\` — Convert HYPE ↔ WHYPE (bids escrow in WHYPE)\n`;
  msg += `• \`/faucet\` — Get testnet HYPE when your wallet is empty\n`;
  msg += `• \`/sweep <0x…> [maxHYPE]\` — Auto-find cheapest live ask + 1-tap buy\n`;
  msg += `\n*Safety — Zensweep engine*\n`;
  msg += `Pre-buy simulation FROM your wallet (your real amount). Flags honeypot, mint, blacklist, proxy. If it flags a scam, Zensweep blocks or asks you to confirm. No scan can guarantee safety.\n`;
  msg += `\n*Your funds*\n`;
  msg += `\`/withdraw\` sends HYPE out at any time. \`/export\` shows your private key: never share it with anyone.\n`;
  msg += `\n*Wallet:*\n`;
  msg += `• \`/wallet\` — Address, balance & withdraw\n`;
  msg += `\n*Zensweep focus:*\n`;
  msg += `- Live Elysium launch & deployment monitoring\n`;
  msg += `- Kalos NFT marketplace orderbook trading\n`;
  msg += `- Mint-window countdowns and direct contract mints\n`;
  msg += `- On-chain wallet tracking for Ascend launches`;
  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: mainKeyboard });
}
