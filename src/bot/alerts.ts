import { InlineKeyboard, type Bot } from "grammy";
import { dbService } from "../db";
import { getChainConfig, ELYSIUM, ALERT_POLL_INTERVAL_MS } from "../config";
import { getWalletActivity, scanRecentDeployments } from "../engine/elysium";
import { kalosService } from "../engine/kalos";
import type { Address } from "viem";

/**
 * Background alert scheduler — lean bot, three jobs:
 *   1. Watch-motion watcher — DMs watch owners when a tracked collection
 *      wallet moves or fresh transfers appear.
 *   2. Kalos floor watcher — DMs watch owners on new cheapest live asks.
 *   3. Kalos offer watcher — DMs bidders on accept/fill, owners on new bids.
 * All sends are best-effort; a failed DM never crashes the loop.
 */

let bot: Bot | null = null;
const seenDeploymentTx = new Set<string>();
const initialized = { value: false };
/** Last verified floor per collection (lowercase) — floor-drop detection. */
const lastFloors = new Map<string, bigint>();
/** Last alerted floor per collection — dedupes restart re-pings of the same floor. */
const lastAlertedFloor = new Map<string, { floor: bigint; at: number }>();
/** Collection name cache: names rarely change — avoids hammering the RPC every tick. */
const alertMetaCache = new Map<string, { name: string; symbol: string; at: number }>();
const ALERT_META_TTL_MS = 60 * 60_000;

function escAlertMd(s: string): string {
  return String(s ?? "").replace(/([_*`[])/g, "\\$1");
}

/** Best-effort on-chain collection name + symbol for alert DMs. Never throws. */
async function getAlertCollectionMeta(addr: Address): Promise<{ name: string; symbol: string }> {
  const fallback = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  const key = addr.toLowerCase();
  const cached = alertMetaCache.get(key);
  if (cached && Date.now() - cached.at < ALERT_META_TTL_MS && cached.name !== fallback) return cached;
  try {
    const { createPublicClient, http } = await import("viem");
    const cfg = getChainConfig(ELYSIUM.key);
    const pc = createPublicClient({ chain: cfg.viemChain, transport: http(cfg.rpcUrl) });
    const ABI = [
      { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
      { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
    ] as const;
    let n: string | null = null;
    let s: string | null = null;
    for (let attempt = 0; attempt < 2 && (n === null || s === null); attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * attempt));
      try { n = (await pc.readContract({ address: addr, abi: ABI as any, functionName: "name" } as any).catch(() => null)) as string | null; } catch { /* retry */ }
      try { s = (await pc.readContract({ address: addr, abi: ABI as any, functionName: "symbol" } as any).catch(() => null)) as string | null; } catch { /* retry */ }
    }
    if (typeof n === "string" && n.trim().length > 0) {
      const meta = { name: n.trim(), symbol: typeof s === "string" ? s.trim() : "" };
      alertMetaCache.set(key, { ...meta, at: Date.now() });
      return meta;
    }
    if (typeof s === "string" && s.trim().length > 0) {
      const meta = { name: `${s.trim()} Collection`, symbol: s.trim() };
      alertMetaCache.set(key, { ...meta, at: Date.now() });
      return meta;
    }
  } catch { /* fall through to fallback */ }
  if (cached) return { name: cached.name, symbol: cached.symbol };
  return { name: fallback, symbol: "" };
}

/** DM only users who have deployment alerts enabled. */
async function notifyDeployUsers(text: string) {
  if (!bot) return;
  const userIds = dbService.getDeployAlertUserIds();
  for (const userId of userIds) {
    const kb = new InlineKeyboard().text("🔕 Mute", "deploy_alert_toggle_off").row().text("🔙 Main Menu", "menu_main");
    try {
      await bot.api.sendMessage(userId, text, { parse_mode: "Markdown", reply_markup: kb });
    } catch { /* blocked; ignore */ }
  }
}

/** Surface fresh on-chain contract deployments on Elysium (first tick seeds). */
async function checkElysiumDeployments() {
  let deployments;
  try {
    deployments = await scanRecentDeployments(40, ELYSIUM.key);
  } catch {
    return;
  }
  const fresh = deployments.filter((d) => !seenDeploymentTx.has(d.txHash));
  for (const d of fresh) seenDeploymentTx.add(d.txHash);
  if (seenDeploymentTx.size > 500) {
    const arr = [...seenDeploymentTx].slice(-300);
    seenDeploymentTx.clear();
    for (const h of arr) seenDeploymentTx.add(h);
  }
  if (!initialized.value) return; // first tick only seeds
  if (fresh.length === 0) return;
  const lines = fresh.slice(0, 5).map(
    (d) => `📄 \`${d.address}\`\n  by \`${d.deployer}\` • block ${d.blockNumber}\n  [tx](${ELYSIUM.explorerUrl}/tx/${d.txHash})`
  );
  await notifyDeployUsers(
    `🆕 *Fresh Elysium deployments* (${fresh.length} new)\n\n` +
      lines.join("\n\n") +
      `\n\nTrack one: \`/watch <0x…> [label]\` — or browse /collections for live Kalos floors.`
  );
}

/** DM watch owners when a tracked watched-collection's floor drops. */
async function checkWatchFloors() {
  if (!bot) return;
  const watches = dbService.getAllWatches();
  const collections = [...new Set(
    watches.filter((w) => /^0x[a-fA-F0-9]{40}$/.test(w.address ?? "")).map((w) => (w.address as string).toLowerCase())
  )].slice(0, 20);
  for (const col of collections) {
    let floor: bigint | null = null;
    try {
      floor = await kalosService.getVerifiedFloor(col as Address);
    } catch { continue; }
    if (!floor || floor <= 0n) continue;
    const prev = lastFloors.get(col);
    lastFloors.set(col, floor);
    if (prev === undefined || floor === prev) continue; // first sighting or no change
    const isDrop = floor < prev;
    // Noise gate both ways: ignore wiggles under ~2% (e.g. 22 -> 21.9).
    // Ratchets via lastFloors above, so a slow bleed/pump still pings
    // once the cumulative move crosses 2%.
    const diff = isDrop ? prev - floor : floor - prev;
    const base = prev > 0n ? prev : 1n;
    const moveBps = Number((diff * 10_000n) / base);
    if (moveBps < 200) continue;
    // Dedup restarts: if we already pinged this exact floor recently, skip.
    const alerted = lastAlertedFloor.get(col);
    if (alerted && alerted.floor === floor && Date.now() - alerted.at < 60 * 60_000) continue;
    lastAlertedFloor.set(col, { floor, at: Date.now() });
    const meta = await getAlertCollectionMeta(col as Address).catch(() => ({ name: `${col.slice(0, 6)}…${col.slice(-4)}`, symbol: "" }));
    const title = meta.symbol ? `${meta.name} ($${meta.symbol})` : meta.name;
    const label = watches.find((w) => (w.address as string).toLowerCase() === col)?.label;
    const labelLine = label ? `\n👀 *Watch:* ${escAlertMd(label)}` : ``;
    const owners = [...new Set(watches.filter((w) => (w.address as string).toLowerCase() === col).map((w) => w.user_id))];
    const arrow = isDrop ? `📉 *Floor drop: ${escAlertMd(title)}*` : `📈 *Floor pump: ${escAlertMd(title)}*`;
    const cta = isDrop ? `Tap Sweep to grab it or Offer to bid below.` : `Floor is climbing — list into strength or hold.`;
    for (const uid of owners.slice(0, 50)) {
      try {
        const kb = new InlineKeyboard()
          .text(`🧹 Sweep ${meta.symbol ? `$${meta.symbol}` : "floor"} — ${kalosService.formatPrice(floor)}`, `kalos_sweep_${col}`).row()
          .text(`🤝 Offer`, `kalos_offer_${col}`)
          .text(`🔍 Inspect`, `col_inspect_${col}`).row()
          .text(`👀 Watchlist`, `menu_watchlist`)
          .text(`🔙 Menu`, `menu_main`);
        await bot.api.sendMessage(
          uid,
          `${arrow}${labelLine}\n\`${col}\`\n💰 Now \`${kalosService.formatPrice(floor)} HYPE\` (was \`${kalosService.formatPrice(prev)} HYPE\`)\n\n${cta}`,
          { parse_mode: "Markdown", reply_markup: kb }
        );
      } catch {}
    }
  }
}

/** DM watch owners on balance movement or fresh transfers. Targeted, not broadcast. */
async function checkWatchMotion() {
  if (!bot) return;
  const watches = dbService.getAllWatches();
  for (const w of watches) {
    let activity;
    try {
      activity = await getWalletActivity(w.address as Address, 30, w.chain);
    } catch {
      continue; // unreachable this cycle
    }
    const prevBalance = w.last_seen_balance_wei;
    const prevTxCount = w.last_seen_tx_count ?? 0;
    const newBalance = activity.balanceWei.toString();
    const newTxCount = activity.transfers.length;
    dbService.updateWatchSnapshot(w.id, newBalance, newTxCount);

    // Baseline tick: first snapshot only seeds, no alert.
    if (prevBalance === null) continue;
    const moved = prevBalance !== newBalance || newTxCount > prevTxCount;
    if (!moved) continue;

    const cfg = getChainConfig(w.chain);
    const label = w.label ?? "Watched address";
    let msg = `👀 *Watch alert:* *${label}* [${cfg.name}]\n\n`;
    msg += `\`${w.address}\`\n`;
    msg += `💰 Balance: \`${activity.balanceEth} ${activity.symbol}\`\n`;
    const latest = activity.transfers[0];
    if (latest) {
      const dir = latest.from.toLowerCase() === w.address.toLowerCase() ? "➡️ OUT" : "⬅️ IN";
      msg += `${dir} ${latest.valueEth} ${activity.symbol} — [tx](${cfg.explorerUrl}/tx/${latest.txHash})`;
    }
    try {
      await bot.api.sendMessage(w.user_id, msg, { parse_mode: "Markdown" });
    } catch {
      // blocked or deleted; ignore
    }
  }
}

/** DM every user with an active Kalos listing that just sold, cancelled or expired. */
async function checkListingSales() {
  if (!bot) return;
  let actives: Array<{ id: number; user_id: number }>;
  try { actives = dbService.getAllActiveListings(); } catch { return; }
  if (actives.length === 0) return;
  const cfg = getChainConfig(ELYSIUM.key);
  for (const l of actives.slice(0, 25)) {
    try {
      const { kalosService } = await import("../engine/kalos");
      const res = await kalosService.reconcileListing(l.id, l.user_id);
      if (!res || res.status === "live") continue;
      if (res.status === "sold") {
        const price = res.priceWei ? `${kalosService.formatPrice(res.priceWei)} HYPE` : "sold";
        const row = dbService.getListing(l.id, l.user_id);
        const link = res.txHash ? `\n🔗 [View sale](${cfg.explorerUrl}/tx/${res.txHash})` : "";
        try {
          await bot.api.sendMessage(
            l.user_id,
            `💰 *NFT Sold on Kalos!*\n\nToken \`#${row?.token_id ?? "?"}\` sold for \`${price}\`${res.buyer ? `\nBuyer: \`${res.buyer}\`` : ""}${link}`,
            { parse_mode: "Markdown" }
          );
        } catch {}
      } else if (res.status === "expired") {
        const row = dbService.getListing(l.id, l.user_id);
        try {
          await bot.api.sendMessage(l.user_id, `⏰ *Kalos listing expired* — Token \`#${row?.token_id ?? "?"}\` is no longer listed. Relist with /nftlist to sell it.`, { parse_mode: "Markdown" });
        } catch {}
      } else {
        const row = dbService.getListing(l.id, l.user_id);
        try {
          await bot.api.sendMessage(l.user_id, `❌ *Kalos listing closed* — Token \`#${row?.token_id ?? "?"}\` is no longer listed (cancelled or moved).`, { parse_mode: "Markdown" });
        } catch {}
      }
    } catch {
      // one bad listing never blocks the rest
    }
  }
}

async function tick() {
  try {
    await checkElysiumDeployments();
    await checkWatchMotion();
    await checkWatchFloors();
    await checkListingSales();
    initialized.value = true;
  } catch (err) {
    console.error("Alert tick failed:", err);
  }
}

export function startAlertScheduler(botInstance: Bot) {
  bot = botInstance;
  const interval = Number.isFinite(ALERT_POLL_INTERVAL_MS) && ALERT_POLL_INTERVAL_MS > 0
    ? ALERT_POLL_INTERVAL_MS
    : 5 * 60_000;
  console.log(`Alert scheduler running every ${Math.round(interval / 1000)}s`);
  setInterval(tick, interval);
}
