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
    if (prev === undefined || floor >= prev) continue; // first sighting or no drop
    const owners = [...new Set(watches.filter((w) => (w.address as string).toLowerCase() === col).map((w) => w.user_id))];
    for (const uid of owners.slice(0, 50)) {
      try {
        await bot.api.sendMessage(
          uid,
          `📉 *Floor drop:* \`${col}\`\n💰 Now \`${kalosService.formatPrice(floor)} HYPE\` (was \`${kalosService.formatPrice(prev)} HYPE\`)\n\n/sweep to grab it, /offer to bid below.`,
          { parse_mode: "Markdown" }
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
