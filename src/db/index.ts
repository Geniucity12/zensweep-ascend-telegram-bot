import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, DB_FILE, resolveChainKey } from "../config";

/**
 * Lightweight JSON-file persistence layer.
 *
 * Zero native deps so the bot runs anywhere Node 18+ runs. The interface is
 * intentionally narrow; swapping to SQLite/Postgres later only requires
 * re-implementing this module's exported methods.
 */

export interface UserRow {
  user_id: number;
  wallet_address: string;
  selected_chain: string;
  created_at: string;
  deploy_alerts_enabled?: boolean;
  slippage_bps?: number;
  faucet_last_at?: string | null;
}

/** Encrypted custodial key material (AES-256-GCM hex). Never leaves the host. */
export interface KeyRow {
  user_id: number;
  address: string;
  encrypted_private_key: string;
  created_at: string;
}

export interface TaskRow {
  id: number;
  user_id: number;
  chain: string;
  contract_address: string;
  max_price_eth: number;
  target_count: number;
  auto_relist_price_eth: number | null;
  bought_count: number;
  status: "active" | "paused" | "completed";
  trait_type: string | null;
  trait_value: string | null;
  created_at: string;
}

export interface TradeRow {
  id: number;
  user_id: number;
  chain: string;
  contract: string;
  token_id: string;
  price_eth: number;
  action: string;
  tx_hash: string;
  created_at: string;
}

export interface ListingRow {
  id: number;
  user_id: number;
  chain: string;
  contract: string;
  token_id: string;
  price_eth: number;
  order_hash: string | null;
  order_json: string | null;
  active: number;
  created_at: string;
}

export interface ServiceFeeRow {
  id: number;
  user_id: number;
  chain: string;
  kind: string;
  gross_eth: string;
  fee_eth: string;
  tx_hash: string | null;
  status: string;
  error: string | null;
  created_at: string;
}

/** An address a user tracks for on-chain activity on a given chain. */
export interface WatchRow {
  id: number;
  user_id: number;
  chain: string;
  address: string;
  label: string | null;
  last_seen_balance_wei: string | null;
  last_seen_tx_count: number;
  created_at: string;
}

export interface PositionRow {
  user_id: number;
  chain: string;
  token: string; // lowercased
  symbol: string | null;
  balance_wei: string; // bigint string
  total_spent_wei: string; // HYPE spent buying
  total_received_wei: string; // HYPE received selling
  avg_buy_price_wei: string | null;
  updated_at: string;
}

interface Schema {
  users: Record<number, UserRow>;
  keys: Record<number, KeyRow>;
  tasks: TaskRow[];
  trades: TradeRow[];
  listings: ListingRow[];
  serviceFees: ServiceFeeRow[];
  watches: WatchRow[];
  positions: PositionRow[];
  counters: { task: number; trade: number; listing: number; serviceFee: number; watch: number };
}

function emptySchema(): Schema {
  return {
    users: {},
    keys: {},
    tasks: [],
    trades: [],
    listings: [],
    serviceFees: [],
    watches: [],
    positions: [],
    counters: { task: 0, trade: 0, listing: 0, serviceFee: 0, watch: 0 },
  };
}

class JsonStore {
  private file: string;
  private data: Schema;

  constructor(file: string) {
    this.file = file;
    this.data = emptySchema();
    this.load();
  }

  private load() {
    try {
      if (existsSync(this.file)) {
        const raw = readFileSync(this.file, "utf8");
        const parsed = JSON.parse(raw) as Partial<Schema>;
        this.data = { ...emptySchema(), ...parsed } as Schema;
        for (const uid of Object.keys((this.data as any).users ?? {})) { const u=(this.data as any).users[uid]; if(u && u.deploy_alerts_enabled===undefined) u.deploy_alerts_enabled=true; if(u && u.slippage_bps===undefined) u.slippage_bps=1000; }
      }
    } catch (err) {
      console.error("Failed to load DB, starting fresh:", err);
      this.data = emptySchema();
    }
  }

  save() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
      // Atomic-ish write to avoid partial files.
      writeFileSync(this.file, readFileSync(tmp, "utf8"), "utf8");
    } catch (err) {
      console.error("Failed to persist DB:", err);
    }
  }

  get schema(): Schema {
    return this.data;
  }

  nextId(kind: "task" | "trade" | "listing" | "serviceFee" | "watch"): number {
    this.data.counters[kind] += 1;
    return this.data.counters[kind];
  }
}

// Resolve DB path: absolute when Volume mounted (/data/kiwi.db.json), relative otherwise.
function resolveDbPath(): string {
  if (path.isAbsolute(DB_FILE)) return DB_FILE;
  return path.resolve(process.cwd(), DB_FILE);
}
const dbPath = resolveDbPath();
(function migrateIfNeeded() {
  const legacy = path.resolve(process.cwd(), "data/kiwi.db.json");
  if (dbPath === legacy) return;
  try {
    if (!existsSync(dbPath) && existsSync(legacy)) {
      mkdirSync(path.dirname(dbPath), { recursive: true });
      writeFileSync(dbPath, readFileSync(legacy, "utf8"),"utf8");
      console.log("[db] migrated legacy DB ->", dbPath);
    }
  } catch (e) { console.warn("[db] migration failed:", e); }
})();
console.log("[db] using", dbPath, "(DATA_DIR=" + DATA_DIR + ")");
if (!process.env.RAILWAY_VOLUME_MOUNT_PATH && !dbPath.startsWith("/data") && process.env.RAILWAY_ENVIRONMENT) {
  console.warn("[db] WARNING: ephemeral disk - WILL BE WIPED on redeploy. Mount Volume at /data.");
}
const store = new JsonStore(dbPath);

export const dbService = {
  // --- Users ---
  getUser(userId: number): UserRow | undefined {
    return store.schema.users[userId];
  },

  upsertUser(userId: number, walletAddress: string, chainKey: string): UserRow {
    const existing = store.schema.users[userId];
    const row: UserRow = existing
      ? { ...existing, wallet_address: walletAddress, selected_chain: resolveChainKey(chainKey) }
      : {
          user_id: userId,
          wallet_address: walletAddress,
          selected_chain: resolveChainKey(chainKey),
          created_at: new Date().toISOString(),
        };
    store.schema.users[userId] = row;
    store.save();
    return row;
  },

  setSelectedChain(userId: number, chainKey: string): void {
    const existing = store.schema.users[userId];
    if (!existing) return; // no wallet yet; nothing to update
    existing.selected_chain = resolveChainKey(chainKey);
    store.save();
  },

  // --- Custodial key material (encrypted) ---
  getKey(userId: number): KeyRow | undefined {
    return store.schema.keys[userId];
  },

  setKey(userId: number, address: string, encryptedPrivateKey: string): void {
    store.schema.keys[userId] = {
      user_id: userId,
      address,
      encrypted_private_key: encryptedPrivateKey,
      created_at: new Date().toISOString(),
    };
    store.save();
  },

  // --- Snipe tasks ---
  createTask(
    userId: number,
    chain: string,
    contractAddress: string,
    maxPriceEth: number,
    targetCount: number,
    autoRelistPriceEth?: number | null,
    _autoRelist?: unknown,
    traitType?: string | null,
    traitValue?: string | null
  ): number {
    const id = store.nextId("task");
    const row: TaskRow = {
      id,
      user_id: userId,
      chain: resolveChainKey(chain),
      contract_address: contractAddress.toLowerCase(),
      max_price_eth: maxPriceEth,
      target_count: targetCount,
      auto_relist_price_eth: autoRelistPriceEth ?? null,
      bought_count: 0,
      status: "active",
      trait_type: traitType ?? null,
      trait_value: traitValue ?? null,
      created_at: new Date().toISOString(),
    };
    store.schema.tasks.push(row);
    store.save();
    return id;
  },

  getUserTasks(userId: number): TaskRow[] {
    return store.schema.tasks.filter((t) => t.user_id === userId);
  },

  getAllActiveTasks(): TaskRow[] {
    return store.schema.tasks.filter((t) => t.status === "active");
  },

  /** All Telegram user IDs that have ever interacted (for broadcasts). */
  getAllUserIds(): number[] {
    return Object.keys(store.schema.users).map(Number);
  },

  updateTaskStatus(taskId: number, status: TaskRow["status"]): void {
    const task = store.schema.tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.status = status;
    store.save();
  },

  incrementTaskBought(taskId: number): void {
    const task = store.schema.tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.bought_count += 1;
    if (task.bought_count >= task.target_count) task.status = "completed";
    store.save();
  },

  // --- Positions (Elysium token portfolio) ---
  getPositions(userId: number): PositionRow[] {
    return (store.schema.positions ?? []).filter((p) => p.user_id === userId);
  },

  getPosition(userId: number, chain: string, token: string): PositionRow | undefined {
    return (store.schema.positions ?? []).find(
      (p) => p.user_id === userId && p.chain === resolveChainKey(chain) && p.token === token.toLowerCase()
    );
  },

  upsertPosition(userId: number, chain: string, token: string, patch: Partial<PositionRow> & { symbol?: string | null }): PositionRow {
    if (!store.schema.positions) store.schema.positions = [];
    const key = token.toLowerCase();
    const resolved = resolveChainKey(chain);
    let row = store.schema.positions.find((p) => p.user_id === userId && p.chain === resolved && p.token === key);
    if (!row) {
      row = {
        user_id: userId,
        chain: resolved,
        token: key,
        symbol: patch.symbol ?? null,
        balance_wei: patch.balance_wei ?? "0",
        total_spent_wei: patch.total_spent_wei ?? "0",
        total_received_wei: patch.total_received_wei ?? "0",
        avg_buy_price_wei: patch.avg_buy_price_wei ?? null,
        updated_at: new Date().toISOString(),
      };
      store.schema.positions.push(row);
    } else {
      if (patch.symbol !== undefined) row.symbol = patch.symbol ?? row.symbol;
      if (patch.balance_wei !== undefined) row.balance_wei = patch.balance_wei!;
      if (patch.total_spent_wei !== undefined) row.total_spent_wei = patch.total_spent_wei!;
      if (patch.total_received_wei !== undefined) row.total_received_wei = patch.total_received_wei!;
      if (patch.avg_buy_price_wei !== undefined) row.avg_buy_price_wei = patch.avg_buy_price_wei ?? row.avg_buy_price_wei;
      row.updated_at = new Date().toISOString();
    }
    store.save();
    return row;
  },

  recordBuyPosition(userId: number, chain: string, token: string, amountInWei: bigint, tokenOutWei: bigint, symbol?: string | null): void {
    const pos = this.getPosition(userId, chain, token);
    const prevBal = pos ? BigInt(pos.balance_wei) : 0n;
    const prevSpent = pos ? BigInt(pos.total_spent_wei) : 0n;
    const newBal = prevBal + tokenOutWei;
    const newSpent = prevSpent + amountInWei;
    const avg = newBal > 0n ? (newSpent * 10n ** 18n / newBal).toString() : null;
    this.upsertPosition(userId, chain, token, {
      symbol: symbol ?? pos?.symbol ?? null,
      balance_wei: newBal.toString(),
      total_spent_wei: newSpent.toString(),
      avg_buy_price_wei: avg,
    });
  },

  recordSellPosition(userId: number, chain: string, token: string, tokenInWei: bigint, hypeOutWei: bigint): void {
    const pos = this.getPosition(userId, chain, token);
    if (!pos) return;
    const prevBal = BigInt(pos.balance_wei);
    const prevRecv = BigInt(pos.total_received_wei);
    const newBal = prevBal > tokenInWei ? prevBal - tokenInWei : 0n;
    const newRecv = prevRecv + hypeOutWei;
    this.upsertPosition(userId, chain, token, {
      balance_wei: newBal.toString(),
      total_received_wei: newRecv.toString(),
    });
  },

  deleteTask(taskId: number, userId: number): void {
    const idx = store.schema.tasks.findIndex((t) => t.id === taskId && t.user_id === userId);
    if (idx === -1) return;
    store.schema.tasks.splice(idx, 1);
    store.save();
  },

  // --- Trades ---
  recordTrade(
    userId: number,
    chain: string,
    contract: string,
    tokenId: string,
    priceEth: number,
    txHash: string,
    action: string
  ): number {
    const id = store.nextId("trade");
    const row: TradeRow = {
      id,
      user_id: userId,
      chain: resolveChainKey(chain),
      contract: contract.toLowerCase(),
      token_id: tokenId,
      price_eth: priceEth,
      action,
      tx_hash: txHash,
      created_at: new Date().toISOString(),
    };
    store.schema.trades.push(row);
    store.save();
    return id;
  },

  getUserTrades(userId: number): TradeRow[] {
    return store.schema.trades
      .filter((t) => t.user_id === userId)
      .slice()
      .sort((a, b) => b.id - a.id)
      .slice(0, 25);
  },

  // --- Listings ---
  createListing(
    userId: number,
    chain: string,
    contract: string,
    tokenId: string,
    priceEth: number,
    orderHash: string | null,
    orderJson: string | null
  ): number {
    const id = store.nextId("listing");
    const row: ListingRow = {
      id,
      user_id: userId,
      chain: resolveChainKey(chain),
      contract: contract.toLowerCase(),
      token_id: tokenId,
      price_eth: priceEth,
      order_hash: orderHash,
      order_json: orderJson,
      active: 1,
      created_at: new Date().toISOString(),
    };
    store.schema.listings.push(row);
    store.save();
    return id;
  },

  /** All active listings across every user (for the sale watcher). */
  getAllActiveListings(): ListingRow[] {
    return store.schema.listings.filter((l) => l.active === 1);
  },

  getUserListings(userId: number): ListingRow[] {
    return store.schema.listings.filter((l) => l.user_id === userId && l.active === 1);
  },

  getListing(listingId: number, userId: number): ListingRow | undefined {
    return store.schema.listings.find((l) => l.id === listingId && l.user_id === userId);
  },

  delist(listingId: number, userId: number): void {
    const row = store.schema.listings.find((l) => l.id === listingId && l.user_id === userId);
    if (!row) return;
    row.active = 0;
    store.save();
  },

  // --- Service fee ledger ---
  recordServiceFee(
    userId: number,
    chain: string,
    kind: string,
    grossEth: string,
    feeEth: string,
    txHash: string | null | undefined,
    status: string,
    error?: string | null | undefined
  ): number {
    const id = store.nextId("serviceFee");
    const row: ServiceFeeRow = {
      id,
      user_id: userId,
      chain: resolveChainKey(chain),
      kind,
      gross_eth: grossEth,
      fee_eth: feeEth,
      tx_hash: txHash ?? null,
      status,
      error: error ?? null,
      created_at: new Date().toISOString(),
    };
    store.schema.serviceFees.push(row);
    store.save();
    return id;
  },

  // --- Watched addresses (on-chain wallet tracking) ---
  watchAddress(userId: number, chain: string, address: string, label?: string | null): number {
    const normalized = address.toLowerCase();
    const existing = store.schema.watches.find(
      (w) => w.user_id === userId && w.chain === resolveChainKey(chain) && w.address === normalized
    );
    if (existing) {
      if (label) existing.label = label;
      store.save();
      return existing.id;
    }
    const id = store.nextId("watch");
    const row: WatchRow = {
      id,
      user_id: userId,
      chain: resolveChainKey(chain),
      address: normalized,
      label: label ?? null,
      last_seen_balance_wei: null,
      last_seen_tx_count: 0,
      created_at: new Date().toISOString(),
    };
    store.schema.watches.push(row);
    store.save();
    return id;
  },

  unwatchAddress(userId: number, watchId: number): boolean {
    const idx = store.schema.watches.findIndex((w) => w.id === watchId && w.user_id === userId);
    if (idx === -1) return false;
    store.schema.watches.splice(idx, 1);
    store.save();
    return true;
  },

  getUserWatches(userId: number): WatchRow[] {
    return store.schema.watches.filter((w) => w.user_id === userId);
  },

  getAllWatches(): WatchRow[] {
    return store.schema.watches.slice();
  },

  updateWatchSnapshot(watchId: number, balanceWei: string, txCount: number): void {
    const row = store.schema.watches.find((w) => w.id === watchId);
    if (!row) return;
    row.last_seen_balance_wei = balanceWei;
    row.last_seen_tx_count = txCount;
    store.save();
  },
  isDeployAlertsEnabled(userId: number): boolean {
    const u = (store.schema.users as any)[userId] as UserRow | undefined;
    if (!u) return true;
    return u.deploy_alerts_enabled !== false;
  },
  setDeployAlertsEnabled(userId: number, enabled: boolean): void {
    const u = (store.schema.users as any)[userId] as UserRow | undefined;
    if (!u) return;
    u.deploy_alerts_enabled = enabled;
    store.save();
  },
  toggleDeployAlerts(userId: number): boolean {
    const cur = this.isDeployAlertsEnabled(userId);
    this.setDeployAlertsEnabled(userId, !cur);
    return !cur;
  },
  getDeployAlertUserIds(): number[] {
    const users = store.schema.users as Record<number, UserRow>;
    return Object.keys(users).map(Number).filter((id) => (users[id] as any).deploy_alerts_enabled !== false);
  },

  getSlippageBps(userId: number): number {
    const u = (store.schema.users as any)[userId] as UserRow | undefined;
    if (!u || u.slippage_bps === undefined) return 1000;
    return u.slippage_bps;
  },
  setSlippageBps(userId: number, bps: number): void {
    const u = (store.schema.users as any)[userId] as UserRow | undefined;
    if (!u) return;
    u.slippage_bps = Math.max(10, Math.min(5000, Math.round(bps)));
    store.save();
  },

  canFaucet(userId: number): { ok: boolean; waitMs: number } {
    const u = (store.schema.users as any)[userId] as UserRow | undefined;
    if (!u || !u.faucet_last_at) return { ok: true, waitMs: 0 };
    const last = new Date(u.faucet_last_at).getTime();
    const cooldown = Number(process.env.FAUCET_COOLDOWN_MS ?? String(60 * 60_000));
    const diff = Date.now() - last;
    if (diff >= cooldown) return { ok: true, waitMs: 0 };
    return { ok: false, waitMs: cooldown - diff };
  },
  markFaucet(userId: number): void {
    const u = (store.schema.users as any)[userId] as UserRow | undefined;
    if (!u) return;
    u.faucet_last_at = new Date().toISOString();
    store.save();
  },
};



