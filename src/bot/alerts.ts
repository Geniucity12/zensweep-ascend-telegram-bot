import { InlineKeyboard, type Bot } from "grammy";
import { dbService } from "../db";
import { fetchLaunchProjects, getLaunchStatusLabel, mintWindowLine, getMintWindowState, type LaunchProject, type LaunchStatus } from "../data/launches";
import { marketplaceService } from "../engine/marketplace";
import { getChainConfig, ELYSIUM, ALERT_POLL_INTERVAL_MS } from "../config";
import { getChainHealth, scanRecentDeployments, getDeploymentMeta, getWalletActivity } from "../engine/elysium";
import type { Address } from "viem";

/**
 * Background alert scheduler.
 *
 * Five jobs, run on an interval:
 *   1. Launch-status watcher — refetches the launch board and DMs every user
 *      when a project changes status (e.g. upcoming → minting → live).
 *   2. Mint-window watcher — DMs when a mint window flips to "opens_soon" or
 *      "live_now" for the first time.
 *   3. Elysium deployments watcher — surfaces fresh on-chain contract
 *      deployments on Elysium (new launches appearing on-chain).
 *   4. Watch-motion watcher — DMs watch owners when a tracked address's
 *      balance moves or fresh transfers appear.
 *   5. Kalos listing watcher — DMs sellers when THEIR listing sells, cancels
 *      or expires (reconciles local DB against getListing + ItemSold events).
 * Floor watcher (OpenSea-backed) is retained for EVM snipe tasks.
 *
 * All sends are best-effort; a failed DM never crashes the loop.
 */

const lastKnownStatuses = new Map<string, string>();
let initialized = false;
let bot: Bot | null = null;
const seenDeploymentTx = new Set<string>();
const alertedMintWindows = new Set<string>();


async function notifyUsers(text: string) {
  if (!bot) return;
  const users = dbService.getAllUserIds();
  for (const userId of users) {
    try {
      await bot.api.sendMessage(userId, text, { parse_mode: "Markdown" });
    } catch (err) {
      // User may have blocked the bot; ignore.
    }
  }
}

async function checkLaunches() {
  const projects: LaunchProject[] = await fetchLaunchProjects();
  if (!initialized) {
    for (const p of projects) lastKnownStatuses.set(p.id, p.status);
    initialized = true;
    return;
  }
  for (const p of projects) {
    const prev = lastKnownStatuses.get(p.id);
    if (prev && prev !== p.status) {
      const emoji = p.status === "live" ? "🟢" : p.status === "minting" ? "🟡" : "🔵";
      await notifyUsers(
        `${emoji} *Launch Update:* *${p.name}*\n` +
          `_Status: ${getLaunchStatusLabel(prev as LaunchStatus)} → ${getLaunchStatusLabel(p.status)}_\n` +
          `${p.summary}\n${mintWindowLine(p)}${p.website ? `\nWebsite: ${p.website}` : ""}`
      );
    }
    lastKnownStatuses.set(p.id, p.status);
  }
}

/** Alert once when a mint window flips to opens_soon or live_now. */
async function checkMintWindows() {
  const projects: LaunchProject[] = await fetchLaunchProjects();
  const now = Date.now();
  for (const p of projects) {
    const state = getMintWindowState(p, now);
    if (state !== "opens_soon" && state !== "live_now") continue;
    const key = `${p.id}:${state}`;
    if (alertedMintWindows.has(key)) continue;
    alertedMintWindows.add(key);
    const emoji = state === "live_now" ? "⏳" : "⏰";
    await notifyUsers(
      `${emoji} *Mint Window ${state === "live_now" ? "OPEN" : "opening soon"}:* *${p.name}*\n` +
        `${mintWindowLine(p, now)}\n` +
        (p.contractAddress ? `Contract: \`${p.contractAddress}\`\n` : "") +
        (p.website ? `Website: ${p.website}` : "")
    );
  }
}

/** Surface fresh on-chain contract deployments on Elysium. */
/**
 * DM only users who have deployment alerts enabled.
 * Sends a keyboard so they can mute/unmute inline.
 */
async function notifyDeployUsers(text: string) {
  if (!bot) return;
  const userIds = dbService.getDeployAlertUserIds();
  for (const userId of userIds) {
    const kb = new InlineKeyboard().text("🔕 Mute Deployment Alerts", "deploy_alert_toggle_off").row().text("🆕 Fresh Deployments", "menu_deployments");
    try {
      await bot.api.sendMessage(userId, text, { parse_mode: "Markdown", reply_markup: kb });
    } catch {
      // User may have blocked the bot; ignore.
    }
  }
}

async function checkElysiumDeployments() {
  try {
    await getChainHealth(ELYSIUM.key);
  } catch {
    return; // chain unreachable this cycle
  }
  let deployments;
  try {
    deployments = await scanRecentDeployments(40, ELYSIUM.key);
  } catch {
    return;
  }
  const fresh = deployments.filter((d) => !seenDeploymentTx.has(d.txHash));
  for (const d of fresh) seenDeploymentTx.add(d.txHash);
  // Keep the set bounded across long runs.
  if (seenDeploymentTx.size > 500) {
    const arr = [...seenDeploymentTx].slice(-300);
    seenDeploymentTx.clear();
    for (const h of arr) seenDeploymentTx.add(h);
  }
  if (!initialized) return; // first tick only seeds
  if (fresh.length === 0) return;
  const enriched = await Promise.all(
    fresh.slice(0, 5).map(async (d) => {
      let label = "📄 Contract";
      try {
        const meta = await getDeploymentMeta(d.address, ELYSIUM.key);
        label = meta.label;
      } catch { /* keep default */ }
      return `${label}\n\`${d.address}\`\n  by \`${d.deployer}\` • block ${d.blockNumber}\n  [tx](${ELYSIUM.explorerUrl}/tx/${d.txHash}) • [address](${ELYSIUM.explorerUrl}/address/${d.address})`;
    })
  );
  await notifyDeployUsers(
    `🆕 *Fresh Elysium deployments* (${fresh.length} new)\n\n` +
      enriched.join("\n\n") +
      `\n\nTrack one: \`/watch <0x…> [label]\`\nStop these: \`/mutedeploys\` — turn back on: \`/unmutedeploys\``
  );
}

async function checkFloors() {
  const tasks = dbService.getAllActiveTasks();
  for (const task of tasks) {
    try {
      const stats = await marketplaceService.autoDetectAndGetStats(task.contract_address);
      if (stats.floorPrice === undefined || stats.floorPrice <= 0) continue;
      if (stats.floorPrice <= task.max_price_eth) {
        const symbol = stats.floorCurrency || getChainConfig(task.chain).symbol;
        await notifyUsers(
          `🎯 *Floor Hit!* (Task #${task.id})\n` +
            `📄 \`${stats.name}\`\n` +
            `💰 Floor: *${stats.floorPrice} ${symbol}* ≤ your max *${task.max_price_eth} ${symbol}*\n` +
            `🔗 ${stats.explorerUrl}`
        );
        // Avoid re-alerting every interval for the same trigger.
        dbService.updateTaskStatus(task.id, "paused");
      }
    } catch {
      // Skip contracts we cannot resolve this cycle.
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
    await checkLaunches();
    await checkMintWindows();
    await checkElysiumDeployments();
    await checkWatchMotion();
    await checkFloors();
    await checkListingSales();
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
