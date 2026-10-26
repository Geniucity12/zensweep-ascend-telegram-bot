import { Bot, Context, InlineKeyboard } from "grammy";
import { dbService } from "../db";
import { walletManager } from "../wallet/manager";
import { getChainConfig, ELYSIUM, DEFAULT_CHAIN_KEY } from "../config";
import { getWalletActivity } from "../engine/elysium";
import { kalosService } from "../engine/kalos";
import {
  mainKeyboard,
  walletKeyboard,
  noWalletKeyboard,
  makeNftCardKeyboard,
  makeCollectionKeyboard,
} from "./keyboards";
import { formatEther, parseEther, type Address, type Hex } from "viem";

/** Escape Telegram legacy-Markdown special chars in dynamic text (names, etc). */
function escMd(input: string): string {
  return String(input ?? "").replace(/([_*`[])/g, "\\$1");
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

    let message = `🟢 *Zensweep — Kalos NFTs on Elysium*\n\n`;
    message += `🌐 *Active Chain:* \`${chainConfig.name}\`\n`;
    message += `🧭 *Focus:* live floors, 1-tap sweeps, fire-and-forget offers, floor-drop pings.\n\n`;

    if (user) {
      const balance = await walletManager.getBalance(user.wallet_address as Address, chain, false);
      message += `💳 *Wallet:* \`${user.wallet_address}\`\n`;
      message += `💰 *Balance:* \`${balance.eth} ${balance.symbol}\`\n\n`;
      message += `Use Zensweep to sweep floors, place bids, and track collections — fastest finger on Kalos.`;
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

  bot.command("alerts", async (ctx) => {
    await renderAlertsMenu(ctx);
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

  // Direct minting removed — mint on the collection site; the bot tracks, sweeps and bids.

  bot.command("nftbuy", async (ctx) => {
    const raw = ctx.message?.text?.split(/\s+/).slice(1).join(" ") ?? "";
    await promptNftBuy(ctx, raw);
  });

  // Listing removed — create/cancel listings on kalos.fun; the bot buys, bids and tracks.

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


  // Chain/launch pages removed — the hunter feed is /collections + /watch pings.

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

  // Archived: cross-chain secondary markets removed — Elysium Kalos NFTs only.

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

  // Paper token trading removed — Elysium DEX isn't live; the bot is Kalos NFTs only.

  bot.command("help", async (ctx) => {
    await renderHelpMenu(ctx);
  });

  // Demo aliases + dead token commands removed.

  // Callback Query Handlers
  bot.callbackQuery("menu_main", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = dbService.getUser(userId);
    const chain = user?.selected_chain || DEFAULT_CHAIN_KEY;
    const chainConfig = getChainConfig(chain);

    let message = `🟢 *Zensweep — Kalos NFTs on Elysium*\n\n`;
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

  // Snipe/task/safety/portfolio menus removed — Kalos NFTs only.

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

  // Snipe/task/floor/chain menus removed — Kalos NFTs only.

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

  // Direct-mint prompt removed — mint on the collection site.

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

  // Listing/delist button taps removed — manage listings on kalos.fun; bot buys/bids/tracks.

  // Collection Offer tap: token optional — buyer may not care about tokenId.
  bot.callbackQuery(/^kalos_offer_(0x[a-fA-F0-9]{40})$/i, async (ctx) => {
      ctx.answerCallbackQuery().catch(() => {});
      const userId = ctx.from?.id;
      if (!userId) return;
      userStates[userId] = { step: "awaiting_offer_any", data: { contract: ctx.match[1] as Address, expiresAt: Date.now() + 5 * 60_000 } };
      await ctx.reply(
        `🤝 *Make an Offer (token optional)*\n\nReply ONE of:\n\n\`<priceHYPE> [duration]\` — offer on *any* token in this collection\n\`<tokenId> <priceHYPE> [duration]\` — offer on a *specific* token\n\n*Examples:*\n\`0.5\` — 0.5 HYPE for any token (7 days)\n\`0.5 6h\` — 0.5 HYPE for any token, 6 hours\n\`6187 0.5\` — 0.5 HYPE for #6187\n\`6187 0.5 3d\` — 0.5 HYPE for #6187, 3 days`,
        { parse_mode: "Markdown" }
      );
    });

  bot.callbackQuery(/^kalos_offer_(0x[a-fA-F0-9]{40})_(\d+)$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const col = ctx.match[1] as Address;
    const tid = ctx.match[2];
    const userId = ctx.from?.id;
    if (!userId) return;
    // Token-level Offer tap: contract + token known, only price + duration needed.
    userStates[userId] = { step: "awaiting_offer_price", data: { contract: col, tokenId: tid, expiresAt: Date.now() + 5 * 60_000 } };
    await ctx.reply(
      `🤝 *Offer on #${tid}*\n\nReply with your bid + optional duration:\n\n\`<price_hype> [duration]\`\n\n*Examples:*\n\`0.5\` — bid 0.5 HYPE for 7 days\n\`0.5 6h\` — bid 0.5 HYPE for 6 hours`,
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
    await renderSweepResults(ctx, col, (st?.data?.maxTotalEth as string | undefined) ?? undefined, n, false);
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
    await renderSweepResults(ctx, col, (st?.data?.maxTotalEth as string | undefined) ?? undefined, n, false);
  });
  bot.callbackQuery("noop", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Already showing the cheapest live listing." }).catch(() => {});
  });

  // Direct-mint button removed — mint on the collection site.

  bot.callbackQuery("confirm_nftbuy", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (!userId || !userStates[userId]?.data) return;
    const data = userStates[userId].data;
    delete userStates[userId];
    await executeNftBuy(ctx, data);
  });

  // Mint-execute removed — mint on the collection site.

  // Listing-confirm callbacks removed — listings live on kalos.fun.

  // 1-tap Accept from an /nfts card: straight to the confirm quote, no typing.
  bot.callbackQuery(/^kalos_accept_(0x[a-fA-F0-9]{40})_(\d+)_(0x[a-fA-F0-9]{40})$/i, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await promptNftAccept(ctx, `${ctx.match[1]} ${ctx.match[2]} ${ctx.match[3]}`);
  });

  // Delist-confirm removed — cancel listings on kalos.fun.

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
    if (!userId || !userStates[userId]?.data) return;
    if (userStates[userId].step !== "awaiting_offer_wrap_confirm" && userStates[userId].step !== "awaiting_offer_approve_confirm") return;
    const data = userStates[userId].data as { contract: Address; tokenId: string; priceHype: string; days: number; expiresAt?: number };
    if (Date.now() > (data.expiresAt ?? 0)) { delete userStates[userId]; await ctx.reply("Offer session expired. Start again with /offer."); return; }
    delete userStates[userId];
    const wallet = walletManager.getUserWallet(userId);
    if (!wallet) { await ctx.reply("No wallet found."); return; }
    try {
      const scope = data.tokenId === "0" ? "any token" : `#${data.tokenId}`;
      const shortfall = parseEther(data.priceHype); // worst case: wrap full bid; ensureBidFunds wraps only the shortfall
      await ctx.reply(`🔄 Approving Kalos + wrapping (if needed), then placing your ${scope} bid for *${data.priceHype} HYPE*...`, { parse_mode: "Markdown" });
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
      await ctx.reply(`❌ Approve-and-bid failed: ${e?.shortMessage || e?.message || "unknown"}\n\nNo bid was placed. Your WHYPE is safe — tap again or retry /offer.`);
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



  // Archived button removed.
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

  // Mint/history/portfolio/safety button menus removed — Kalos NFTs only.

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

  // Listing buttons removed — manage listings on kalos.fun.

  bot.callbackQuery(/^nft_offer_(\d+)$/, async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    const nft = userId ? userStates[userId]?.data?.nfts?.[Number(ctx.match[1])] : undefined;
    if (!userId || !nft) return;
    await promptNftOffer(ctx, `${nft.contract} ${nft.tokenId}`);
  });

  // Listing-cancel button removed — cancel listings on kalos.fun.


  // Trade-history/portfolio/safety/token/task/snipe button menus removed.
  // Snipe buttons removed — watch + sweep cover this now.

  bot.callbackQuery("menu_help", async (ctx) => {
    ctx.answerCallbackQuery().catch(() => {});
    await renderHelpMenu(ctx);
  });

  // Task/snipe actions removed — watch + sweep cover this now.

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

  // Floor-lookup text step removed — floors live in /collections cards.

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

  // Listing-price text step removed — listings live on kalos.fun.

    // Unified offer input: "0.5" / "0.5 3" / "0.5 6h" = any-token; "6187 0.5" / "6187 0.5 3d" = specific.
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
      let tid = "0"; let price = ""; let days = 7;
      if (p.length >= 1 && isPrice(p[0])) {
        price = p[0];
        if (p[1] !== undefined) {
          const dd = parseDurationDays(p[1]);
          if (dd === null) {
            await ctx.reply("Duration: `3` = 3 days, or `6h` / `30m` / `2d`. E.g. `0.5 6h`.", { parse_mode: "Markdown" });
            userStates[userId] = { step: "awaiting_offer_any", data: { ...data0, expiresAt: Date.now() + 5 * 60_000 } };
            return;
          }
          days = dd;
        }
      }
      else if (p.length >= 2 && isTid(p[0]) && isPrice(p[1])) {
        tid = p[0]; price = p[1];
        if (p[2] !== undefined) {
          const dd = parseDurationDays(p[2]);
          if (dd === null) {
            await ctx.reply("Duration: `3` = 3 days, or `6h` / `30m` / `2d`. E.g. `6187 0.5 6h`.");
            userStates[userId] = { step: "awaiting_offer_any", data: { ...data0, expiresAt: Date.now() + 5 * 60_000 } };
            return;
          }
          days = dd;
        }
      } else {
        await ctx.reply("Reply `<price> [duration]` for any token, or `<tokenId> <price> [duration]`. E.g. `0.5`, `0.5 6h`, `6187 0.5 3d`.", { parse_mode: "Markdown" });
        userStates[userId] = { step: "awaiting_offer_any", data: { ...data0, expiresAt: Date.now() + 5 * 60_000 } };
        return;
      }
      const label = tid === "0" ? "any token" : `#${tid}`;
      const daysRounded = Math.max(1, Math.min(30, Math.round(days)));
      userStates[userId] = { step: "awaiting_nftoffer_confirmation", data: { contract: data0.contract, tokenId: tid, priceHype: price, days: daysRounded, expiresAt: Date.now() + 5 * 60_000 } };
      const kb = new InlineKeyboard()
        .text(`✅ Yes, Offer ${price} HYPE`, "confirm_nftoffer")
        .text("❌ Cancel", "cancel_action");
      await ctx.reply(
        `🤝 *Confirm Kalos Offer*\n\n📄 *Collection:* \`${data0.contract}\`\n🏷 *Token:* \`${label}\`\n💰 *Offer:* \`${price} HYPE\`\n⏱ *Expiry:* \`${formatDuration(days)}\`\n\nTap below or reply *YES*:`,
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
        const dd = parseDurationDays(p[2]);
        if (dd === null) {
          await ctx.reply("Duration: `3` = 3 days, or `6h` / `30m` / `2d`. Try again, e.g. `6187 0.5 6h`.");
          userStates[userId] = { step: "awaiting_offer_tokenid", data: { ...data0, expiresAt: Date.now() + 5 * 60_000 } };
          return;
        }
        days = dd;
      }
      await promptNftOffer(ctx, `${data0.contract} ${tid} ${p[1]} ${Math.max(1, Math.min(30, Math.round(days)))}`);
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
        await ctx.reply("Send just the bid, e.g. `0.5`, optionally followed by duration: `0.5 6h`", { parse_mode: "Markdown" });
        userStates[userId] = { step: "awaiting_offer_price", data: { ...data0, expiresAt: Date.now() + 5 * 60_000 } };
        return;
      }
      let days = 7;
      if (p[1] !== undefined) {
        const dd = parseDurationDays(p[1]);
        if (dd === null) {
          await ctx.reply("Duration: `3` = 3 days, or `6h` / `30m` / `2d`. Try again, e.g. `0.5 6h`.");
          userStates[userId] = { step: "awaiting_offer_price", data: { ...data0, expiresAt: Date.now() + 5 * 60_000 } };
          return;
        }
        days = dd;
      }
      await promptNftOffer(ctx, `${data0.contract} ${data0.tokenId} ${p[0]} ${Math.max(1, Math.min(30, Math.round(days)))}`);
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

  // Listing/delist text confirms removed — kalos.fun.

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


  // Buy-X / mint / token-buy handlers removed — Kalos NFTs only.

    if (state?.step === "awaiting_watch_address") {
      delete userStates[userId];
      await handleWatchSubmit(ctx, text);
      return;
    }

  // Token-buy confirm removed.

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

  // Snipe/trait-snipe/token-sell text handlers removed.

  // Text message handler
  // (snipe-rule bodies deleted — watch + sweep cover this now)

  // Pasted address: NFT collection? inspect it. Anything else: redirect to /help.
  {
    const t = text.trim();
    if (/^0x[a-fA-F0-9]{40}$/.test(t) && !state) {
      await renderCollectionDetail(ctx, t as Address);
      return;
    }
  }

  // Unknown /command -> point at the lean menu
    if (text.startsWith("/")) {
      await ctx.reply(
        "Unknown command. Zensweep is lean now: /collections /sweep /offer /accept /watch /watchlist /alerts /nfts /wallet — or /help.",
        { parse_mode: "Markdown", reply_markup: mainKeyboard }
      );
      return;
    }

    // Default response if not recognized
    await ctx.reply(
      `I didn't get that. Try /collections to browse, /sweep to buy the floor, /offer to bid — or /help.`,
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

// Snipe/task/floor/chain menus removed — Kalos NFTs only.

async function handleSweepCommand(ctx: Context, arg: string) {
  const userId = ctx.from?.id;
  if (!userId) return;
  // /sweep <contract> [maxTotalHYPE] [count] — maxTotal is TOTAL SPEND across
  // the whole sweep (what the user asked), count caps at 10.
  // 2 numbers = total + count (order-free: int<=10 is the count).
  const parts = (arg ?? "").trim().split(/\s+/).filter(Boolean);
  const contract = parts[0] ?? "";
  let count = 1;
  let maxTotal: string | undefined;
  const rest = parts.slice(1);
  if (rest.length === 1) {
    if (/^\d+$/.test(rest[0]) && Number(rest[0]) >= 1 && Number(rest[0]) <= 10) count = Math.floor(Number(rest[0]));
    else if (/^\d+(?:\.\d{1,18})?$/.test(rest[0]) && Number(rest[0]) > 0) maxTotal = rest[0];
  } else if (rest.length >= 2) {
    const ints = rest.map((p, i) => ({ p, i })).filter(({ p }) => /^\d+$/.test(p) && Number(p) >= 1 && Number(p) <= 10);
    const amts = rest.map((p, i) => ({ p, i })).filter(({ p }) => /^\d+(?:\.\d{1,18})?$/.test(p) && Number(p) > 0);
    if (ints.length === 1 && amts.length >= 1) {
      count = Math.floor(Number(ints[0].p));
      const other = amts.find((a) => a.i !== ints[0].i) ?? amts[0];
      maxTotal = other.p;
    } else if (amts.length >= 1) {
      maxTotal = amts[0].p;
      if (amts.length >= 2) count = Math.min(10, Math.max(1, Math.floor(Number(amts[1].p))));
    }
  }
  if (!contract || !/^0x[a-fA-F0-9]{40}$/.test(contract)) {
    userStates[userId] = { step: "awaiting_sweep_contract" };
    await ctx.reply(
      `🧹 *Sweep Floor on Kalos*\n\nReply with a collection + total budget + how many:\n\n\`<0x…> [maxTotalHYPE] [count]\`\n\n*Examples:*\n\`0xd0e6…5d95\` — cheapest 1\n\`0xd0e6…5d95 10\` — up to 10 HYPE total\n\`0xd0e6…5d95 10 3\` — 3 cheapest, max 10 HYPE total`,
      { parse_mode: "Markdown" }
    );
    return;
  }
  await renderSweepResults(ctx, contract as Address, maxTotal, count, true);
}

async function renderSweepResults(ctx: Context, contract: Address, maxTotalEth?: string, count: number = 1, fromCommand = false) {
  const userId = ctx.from?.id;
  const cfg = getChainConfig(ELYSIUM.key);
  await ctx.reply(`🔍 Scanning Kalos for the ${count > 1 ? `${count} cheapest live listings` : "cheapest live listing"}…`, { parse_mode: "Markdown" });
  // Balance pre-check (best-effort only).
  // A balance read can NEVER block the sweep on its own: getBalance returns
  // "0" on RPC errors, which previously produced a bogus "No HYPE" message
  // for wallets that actually hold HYPE. Only a CONFIRMED zero blocks.
  const want = Math.max(1, Math.min(10, Math.floor(count)));
  function maxTotalHypeSafe(v?: string): string { return String(v ?? ""); }
  // Multi-count sweeps: ask HOW MANY before scanning (count picker).
  // Only for the bare "/sweep <contract>" command (no count, no total typed).
  // Button taps (card Sweep, Sweep-N, Re-scan) always scan directly.
  const isBareCommand = fromCommand && want === 1 && (maxTotalEth === undefined || maxTotalEth === null);
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
      userStates[userId] = { step: "awaiting_sweepN_pick", data: { contract, maxTotalEth: (typeof maxTotalEth !== "undefined" ? maxTotalEth : null), expiresAt: Date.now() + 5 * 60_000 } };
    }
    await ctx.reply(`🧹 Pick count`, { parse_mode: "Markdown", reply_markup: kb });
    return;
  }
  let cheapest: Array<{ tokenId: bigint; seller: Address; price: bigint; expiration: bigint }> = [];
  try {
    cheapest = await kalosService.findCheapestListings(contract, { maxScan: 500, maxResults: Math.max(want, 5) });
  } catch (e: any) {
    await ctx.reply(`🔴 Kalos scan failed`, { parse_mode: "Markdown" });
    return;
  }
  try {
    const __b = (typeof maxTotalEth !== "undefined" ? (maxTotalEth as unknown as string) : undefined);
    if (__b) {
      const { parseEther: __pe } = await import("viem");
      const __budget = __pe(__b as `${number}`);
      const __fit: typeof cheapest = []; let __run = 0n;
      for (const __c of cheapest) { if (__run + __c.price <= __budget) { __fit.push(__c); __run += __c.price; } else break; }
      cheapest = __fit;
    }
  } catch {}
  if (cheapest.length === 0) {
    let floorLine = "No active listings";
    try {
      const fp = await kalosService.getVerifiedFloor(contract);
      if (fp && fp > 0n) floorLine = `${kalosService.formatPrice(fp)} HYPE`;
    } catch {}
    await ctx.reply(`🧹 *Sweep Floor — no match*`,
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

  // Human durations everywhere: "6h" / "6hrs" / "6 hours", "30m" / "30mins" /
  // "30 minutes", "2d" / "2 days", plain "3" = 3 days (legacy). Returns days
  // as a float; callers round/clamp to what their tx needs (bids: 1-30 days).
  function parseDurationDays(raw?: string): number | null {
    if (raw === undefined) return null;
    const t = String(raw).trim().toLowerCase();
    if (/^\d+$/.test(t)) { const d = Number(t); return d >= 1 && d <= 30 ? d : null; }
    let m = t.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes)$/);
    if (m) { const mins = Number(m[1]); if (!(mins > 0 && mins <= 60 * 24 * 30)) return null; return mins / (60 * 24); }
    m = t.match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)$/);
    if (m) { const h = Number(m[1]); if (!(h > 0 && h <= 24 * 30)) return null; return h / 24; }
    m = t.match(/^(\d+(?:\.\d+)?)\s*(d|day|days)$/);
    if (m) { const d = Number(m[1]); if (!(d >= 1 && d <= 30)) return null; return d; }
    return null;
  }
  function formatDuration(days: number): string {
    if (days < 1) {
      const mins = Math.round(days * 24 * 60);
      if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"}`;
      const h = days * 24;
      const hr = Math.round(h * 10) / 10;
      return `${hr} hour${hr === 1 ? "" : "s"}`;
    }
    const r = Math.round(days * 10) / 10;
    return `${r} day${r === 1 ? "" : "s"}`;
  }

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

  function collectionCardKeyboard(r: { address: Address; name: string; symbol: string; floorWei: bigint | null; floorStr: string; count: number; unverified: boolean }): InlineKeyboard {
    const kb = new InlineKeyboard();
    const label = r.symbol ? `$${r.symbol}` : r.name.slice(0, 16);
    // Sweep first whenever a floor exists — verified OR event-estimate.
    // A stale "No active listings" row hid behind the estimate before.
    if (r.floorWei && r.floorWei > 0n) kb.text(r.unverified ? `🧹 Sweep ~${label} — ${r.floorStr} ⏳` : `🧹 Sweep ${label} — ${r.floorStr}`, `kalos_sweep_${r.address}`).row();
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
   * verified floors replace estimates; dead rows explicitly say so — but a
   * floor that verified from EVENTS and just hasn't re-verified yet must NOT
   * be wiped to "No active listings" by an empty phase-2 batch. */
  function applyVerifiedFloor(r: (typeof rows)[number], f: { floor: bigint | null; liveCount: number } | undefined) {
    if (f?.floor && f.floor > 0n) {
      r.floorWei = f.floor;
      r.floorStr = `${kalosService.formatPrice(f.floor)} HYPE`;
      r.count = f.liveCount;
      r.unverified = false;
    } else if (r.floorWei && r.floorWei > 0n && r.unverified) {
      // Keep the event estimate (still shows Sweep with ⏳) — verification
      // may have 429'd this cycle; don't flash "No active listings".
    } else {
      r.floorWei = null;
      r.floorStr = "No active listings";
      r.count = 0;
      r.unverified = false;
    }
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

  // Launch-board extras removed — the feed is the cards themselves.

  const footerText =
    `\n💡 *Lean bot:* /sweep buys the floor, /offer bids, /watch pings drops. Listing + minting live on kalos.fun.\n`;
  const footerKeyboard = (): InlineKeyboard => new InlineKeyboard()
    .text("🔍 Inspect Any 0x... Contract", "col_inspect_prompt").row()
    .text("🖼️ My NFTs", "menu_nfts").row()
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

  // Phase 2 (background): verify floors, then EDIT the SAME cards in place.
  // No re-sends, no deletes — each card's message id is stable per address.
  (async () => {
    try {
      floors = await kalosService.getCollectionFloors(nameRows.map((r) => r.address), { events: sharedEvents, perCollection: 80 });
    } catch { floors = new Map(); }
    for (const r of rows) {
      applyVerifiedFloor(r, floors.get(r.address.toLowerCase()));
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
    // Footer: just append commands to the header — never a second dump.
    if (headerMsgId && ctx.chat) {
      try {
        try {
          await ctx.api.editMessageText(ctx.chat.id, headerMsgId, buildHeaderText(true) + footerText, { parse_mode: "Markdown" });
        } catch {}
      } catch {}
    }
  })();
  return; // phase-2 edits the SAME cards in place; nothing is ever re-sent
}

function kbLen(kb: InlineKeyboard): number {
  try { return ((kb as any).inline_keyboard ?? []).length; } catch { return 0; }
}

async function renderCollectionDetail(ctx: Context, address: Address) {
  const meta = await readCollectionMeta(address).catch(() => ({ name: `${address.slice(0, 6)}…${address.slice(-4)}`, symbol: "" }));

  const name = meta.name;
  const symbol = meta.symbol ? ` ($${meta.symbol})` : "";
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
  if (explorerUrl) msg += `🔗 [View on Explorer](${explorerUrl}) • [View on Kalos](https://kalos.fun)\n\n`;
  msg += `*Buy or bid below — manage listings + minting on kalos.fun.*`;

  const kb = new InlineKeyboard();
  kb.text("🛒 Buy Floor", `kalos_sweep_${address}`)
    .text("🤝 Make Offer", `kalos_offer_${address}`).row()
    .url("🌐 View on Kalos", "https://kalos.fun")
    .text("👀 Watch", `watch_add_${address}`).row()
    .text("🏷️ All Collections", "menu_collections")
    .text("🔙 Main Menu", "menu_main");

  await ctx.reply(msg, {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
  // Listing buttons removed — manage listings on kalos.fun.
}

async function renderNFTsMenu(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const user = dbService.getUser(userId);
  if (!user) {
    await ctx.reply("⚠️ Please connect a wallet first.", { reply_markup: noWalletKeyboard });
    return;
  }

  await ctx.reply(`🔍 Scanning your Elysium wallet for NFTs…`, { parse_mode: "Markdown" });

  const nfts: Array<{ collection: Address; tokenId: bigint }> = [];
  try {
    // Cheap discovery: only ItemListed events, shared scan (45s cache).
    const discovered = await kalosService.discoverCollections({ blocksBack: 200_000 });
    // Bound the ownership probe: 30 collections x tokensOfOwner is the RPC
    // hotspot that starves the bid scan — 12 is enough, FIFO by discovery.
    for (const col of discovered.slice(0, 12)) {
      try {
        const ids = await kalosService.tokensOfOwner(col, user.wallet_address as Address, { limit: 10 });
        for (const tid of ids) nfts.push({ collection: col, tokenId: tid });
        if (nfts.length >= 12) break;
      } catch {}
    }
  } catch {}
  const activeListings: Array<never> = [];

  if (nfts.length === 0) {
    const kb = new InlineKeyboard()
      .text("🏷️ Explore Collections", "menu_collections").row()
      .text("🔙 Main Menu", "menu_main");

    await ctx.reply(
      `🖼 *My NFT Inventory*\n\n` +
      `No NFTs detected in your wallet yet.\n\n` +
      `*Address:* \`${user.wallet_address}\`\n\n` +
      `💡 *Get started:*\n` +
      `• Browse live collections: \`/collections\`\n` +
      `• Sweep a floor or place an offer from any collection card`,
      { parse_mode: "Markdown", reply_markup: kb }
    );
    return;
  }

  let msg = `🖼 *My NFT Inventory*\n` +
            `*Wallet:* \`${user.wallet_address}\`\n\n`;

  // Incoming live offers on YOUR tokens (verified via getTokenBid + ownership).
  // Shows a checking line first so "none right now" only appears AFTER a real scan.
  let incomingBids: Array<{ collection: Address; tokenId: bigint; bidder: Address; price: bigint; expiration: bigint }> = [];
  let bidsScanned = false;
  await ctx.reply(`🤝 Checking live offers on your NFTs…`, { parse_mode: "Markdown" }).catch(() => null);
  try {
    const myTokens = nfts.slice(0, 12).map((n) => ({ collection: n.collection as Address, tokenId: BigInt(n.tokenId) }));
    if (myTokens.length > 0) {
      incomingBids = await kalosService.getIncomingBids(myTokens, user.wallet_address as Address, { perToken: 4 });
    }
    bidsScanned = true;
  } catch { incomingBids = []; bidsScanned = true; }

   // ONE card per NFT: Accept live offers / inspect collection on the card itself.
  // No giant shared wall — each token carries its own actions. If the card
  // send fails (bad Markdown), fall back to PLAIN TEXT *WITH THE SAME BUTTONS*.
  for (const nft of nfts.slice(0, 12) as Array<{ collection: Address; tokenId: bigint }>) {
    const nftBids = incomingBids.filter(
      (b) => b.collection.toLowerCase() === String(nft.collection).toLowerCase() && b.tokenId.toString() === String(nft.tokenId)
    );
    const best = nftBids.length > 0 ? nftBids[0] : null;
    const offerLine = !bidsScanned
      ? `\n🤝 *Offers:* \`checking…\``
      : best
        ? `\n🤝 *Top Offer:* \`${kalosService.formatPrice(best.price)} HYPE\` from \`${best.bidder.slice(0, 6)}…${best.bidder.slice(-4)}\``
        : `\n🤝 *Offers:* \`none right now\``;
    const extraLine = nftBids.length > 1 ? ` (+${nftBids.length - 1} more)` : "";
    const meta = await readCollectionMeta(nft.collection as Address).catch(() => ({ name: `#${String(nft.tokenId)}`, symbol: "" }));
    const text = `🖼️ *${escMd(meta.name)} #${escMd(String(nft.tokenId))}*\n\`${nft.collection}\`${offerLine}${extraLine}`;
    const cardKb = (() => {
      const kb = new InlineKeyboard();
      if (best) kb.text(`✅ Accept ${kalosService.formatPrice(best.price)}`, `kalos_accept_${nft.collection}_${nft.tokenId}_${best.bidder}`).row();
      for (const b of nftBids.slice(0, 3)) {
        kb.text(`🤝 ${kalosService.formatPrice(b.price)} from ${b.bidder.slice(0, 6)}…${b.bidder.slice(-4)}`, `kalos_accept_${nft.collection}_${nft.tokenId}_${b.bidder}`).row();
      }
      kb.text(`🔍 Collection`, `col_inspect_${nft.collection}`).row();
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
    msg += `*Held NFTs: ${nfts.length} (each has its own card above with Accept/Offer buttons)*\n\n`;
  }

  const kb = new InlineKeyboard();
  kb.text("🏷️ Collections", "menu_collections").row()
    .text("🔙 Main Menu", "menu_main");

  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: kb });
}

// Mint prompts removed — mint on the collection site.

// Mint prompts + executor removed — mint on the collection site.

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

// List/delist prompt + executor removed — manage listings on kalos.fun.

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
  // Accepted shapes (tokenId 0 = any token, duration = days | 6h | 30m):
  //   <contract> <price> [duration] | <contract> <tokenId> <price> [duration]
  if (parts.length >= 2 && isAddr(parts[0]) && isPrice(parts[1])) {
    const anyContract = parts[0] as Address;
    let anyDays = 7;
    if (parts[2] !== undefined) {
      const dd = parseDurationDays(parts[2]);
      if (dd === null) {
        await ctx.reply("Duration: `3` = 3 days, or `6h` / `30m` / `2d`. E.g. `<contract> 0.5 6h`.", { parse_mode: "Markdown" });
        return;
      }
      anyDays = Math.max(1, Math.min(30, Math.round(dd)));
    }
    userStates[userId] = {
      step: "awaiting_nftoffer_confirmation",
      data: { contract: anyContract, tokenId: "0", priceHype: parts[1], days: anyDays, expiresAt: Date.now() + 5 * 60_000 },
    };
  } else if (parts.length >= 3 && isAddr(parts[0]) && isTid(parts[1]) && isPrice(parts[2])) {
    const specContract = parts[0] as Address;
    const specTokenId = parts[1];
    const specPrice = parts[2];
    let specDays = 7;
    if (parts[3] !== undefined) {
      const dd = parseDurationDays(parts[3]);
      if (dd === null) {
        await ctx.reply("Duration: `3` = 3 days, or `6h` / `30m` / `2d`. E.g. `<contract> 6187 0.5 6h`.", { parse_mode: "Markdown" });
        return;
      }
      specDays = Math.max(1, Math.min(30, Math.round(dd)));
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
    quote += `⏱ *Expiry:* \`${formatDuration(specDays)}\`\n\n`;
    quote += `Tap the button below or reply *YES* to proceed:`;
    await ctx.reply(quote, { parse_mode: "Markdown", reply_markup: kb });
    return;
  } else {
      // Fell through (e.g. bad shape) — show the flexible prompt.
      userStates[userId] = { step: "awaiting_nftoffer_params" };
      await ctx.reply(
        `🤝 *Make Offer on Kalos*\n\nSend ONE of:\n\n\`<collection> <price> [duration]\` — any token\n\`<collection> <tokenId> <price> [duration]\` — specific token\n\n*Duration:* \`3\` = 3 days, \`6h\` = 6 hours, \`30m\` = 30 mins\n\n*Example:*\n\`0x123... 0.5 6h\` or \`0x123... 1 0.1 3d\`\n\nOr reply \`/cancel\`.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

  userStates[userId] = { step: "awaiting_nftoffer_params" };
  await ctx.reply(
    `🤝 *Make Offer on Kalos*\n\nSend ONE of:\n\n\`<collection> <price> [duration]\` — offer on *any* token\n\`<collection> <tokenId> <price> [duration]\` — offer on a *specific* token\n\n*Duration:* \`3\` = 3 days, \`6h\` = 6 hours, \`30m\` = 30 mins\n\n*Example:*\n\`0x123... 0.5 6h\` or \`0x123... 1 0.1 3d\`\n\nOr reply \`/cancel\`.`,
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
      if (dry.code === "NEEDS_APPROVE") {
        const kb = new InlineKeyboard().text(`✅ Approve Kalos & Bid ${data.priceHype}`, "wrap_and_bid").text("❌ Cancel", "cancel_action");
        userStates[userId] = { step: "awaiting_offer_approve_confirm", data: { ...data, expiresAt: Date.now() + 5 * 60_000 } };
        await ctx.reply(
          `🔐 *One tap to fix:* ${dry.reason}\n\n` +
          `Your WHYPE balance already covers this bid — Kalos just needs permission to pull it. Tap below and I'll approve + place the bid (small gas for the approve).`,
          { parse_mode: "Markdown", reply_markup: kb }
        );
        return;
      }
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


// Launch/markets/mints/elysium/deploy menus removed — the feed is /collections.

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
  let msg = `🔔 *Zensweep Alerts*\n\n`;
  const deployOn = dbService.isDeployAlertsEnabled(ctx.from?.id ?? 0);
  msg += `🆕 Deployment auto-alerts: ${deployOn ? "🔔 *ON* — you'll be DMed new contract drops" : "🔕 *MUTED* — no deployment DMs"}\n`;
  msg += `${deployOn ? "Tap 🔕 Mute below to stop." : "Tap 🔔 Unmute below to re-enable."}\n\n`;
  msg += `👀 *Watchlist pings:* floor drops + wallet moves on addresses you track with /watch.\n`;
  msg += `🤝 *Offer pings:* you get DMed when your Kalos bid is accepted or outbid.`;

  const kb = new InlineKeyboard();
  kb.text(deployOn ? "🔕 Mute Deployment Alerts" : "🔔 Unmute Deployment Alerts", "deploy_alert_toggle")
    .row()
    .text("🔙 Main Menu", "menu_main");

  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: kb });
}

// Status + token-card/safety/slippage/trading/portfolio menus removed — lean bot.

// Lean: wallet helpers (faucet/wrap/unwrap/export/import) live below.
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
  let msg = `ℹ️ *Zensweep — fastest finger on Kalos (Elysium NFTs)*\n\n`;
  msg += `*Find it:*\n`;
  msg += `• \`/collections\` — live feed, real names + floors\n`;
  msg += `• \`/sweep <contract> [maxTotalHYPE] [count]\` — cheapest live asks, total-budget capped\n`;
  msg += `  e.g. \`/sweep 0x… 10 3\` — 3 cheapest, max 10 HYPE total\n`;
  msg += `\n*Bid it (durations: 3 = 3 days, 6h = 6 hours, 30m = 30 mins):*\n`;
  msg += `• \`/offer <collection> [tokenId] <price> [duration]\` — any-token or specific\n`;
  msg += `  e.g. \`/offer 0x… 0.5 6h\` — 0.5 on any token, 6 hours\n`;
  msg += `• \`/accept <collection> <tokenId> <bidder>\` — accept a bid on your NFT\n`;
  msg += `\n*Track it:*\n`;
  msg += `• \`/watch <0x…> [label]\` — floor-drop + new-deployment pings\n`;
  msg += `• \`/watchlist\` — your tracked collections\n`;
  msg += `• \`/alerts\` — ping settings\n`;
  msg += `\n*Your stuff:*\n`;
  msg += `• \`/nfts\` — what you own + live offers (tap to accept)\n`;
  msg += `• \`/wallet\` — HYPE + WHYPE balances, wrap/unwrap + faucet inside\n`;
  msg += `\nBids escrow in *WHYPE* (wrapped HYPE) — convert inside \`/wallet\`. Kalos takes its marketplace fee on every trade; Zensweep adds nothing on testnet.`;
  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: mainKeyboard });
}
