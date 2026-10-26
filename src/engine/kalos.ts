import { createPublicClient, createWalletClient, http, parseEther, formatEther, decodeErrorResult, type Address, type Hex, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getChainConfig, KALOS_MARKETPLACE_ADDRESS, ELYSIUM } from "../config";
import kalosAbi from "../abi/kalosMarketplace.json";
import { dbService } from "../db";
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const NATIVE = ZERO;
/**
 * Human explanation for common Kalos listing reverts.
 * The contract reverts with bare custom errors (no message), so map the
 * decoded error name + viem's hint text to the actual fix.
 */
function decodeListingHint(decoded: string | null, rawShort: string, tokenId: bigint): string | null {
  const d = (decoded ?? "").toLowerCase();
  const r = (rawShort ?? "").toLowerCase();
  const says = (...needles: string[]) => needles.some((x) => d.includes(x) || r.includes(x));
  if (says("notowningitem", "not owning", "not the owner", "ownable", "ownerof")) {
    return `You don't own #${tokenId} (or the marketplace can't see your approval yet). List only tokens shown in /nfts, and approve Kalos first.`;
  }
  if (says("notapproved", "itemnotapproved", "not approved", "allowance", "erc721: caller is not token owner or approved", "not authorized")) {
    return `Kalos is not approved to move #${tokenId}. Approve the marketplace for this collection, then list again.`;
  }
  if (says("collectionnotapproved", "approvalstatus", "collection not approved", "unapproved collection")) {
    return `This collection is not approved for trading on Kalos (collection approval status). Only approved collections can list.`;
  }
  if (says("paymenttokennotsupported", "unsupported payment", "invalid payment")) {
    return `Payment token rejected: this marketplace only accepts WHYPE listings. Retry — the bot already uses WHYPE.`;
  }
  if (says("invalidquantity", "invalid quantity", "quantity")) {
    return `Invalid quantity for #${tokenId} (must be ≥ 1).`;
  }
  if (says("belowminprice", "min price", "price too low")) {
    return `Price is below the collection's minimum on Kalos. Raise your list price.`;
  }
  if (says("invalid expiration", "expiration", "invalidexpirationtime", "expiry")) {
    return `Bad expiry window for #${tokenId}. Retry with a 1–30 day duration.`;
  }
  return null;
}
/** WHYPE on Elysium testnet (verified on-chain: wnative() + paymentToken()). */
const WHYPE_FALLBACK = "0x41051f27c609dB70af05b7128f15155Dc8E49Ac7" as Address;
/** Module-level wnative cache (verified live: equals WHYPE_FALLBACK). */
let cachedWnative: Address | null = null;
function kalosAddr(): Address | null { const a = (KALOS_MARKETPLACE_ADDRESS || "0x0ff8b7afc288ac42f82320f54a49c400f233bf07").trim(); if (!a || !/^0x[a-fA-F0-9]{40}$/.test(a)) return null; return a as Address; }
export function isKalosConfigured(): boolean { return !!kalosAddr(); }
function publicClient() { const cfg = getChainConfig(ELYSIUM.key); return createPublicClient({ chain: cfg.viemChain, transport: http(cfg.rpcUrl) }); }
function walletClient(pk: Hex) { const cfg = getChainConfig(ELYSIUM.key); const account = privateKeyToAccount(pk); return createWalletClient({ account, chain: cfg.viemChain, transport: http(cfg.rpcUrl) }); }
const erc20Abi = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "deposit", type: "function", stateMutability: "payable", inputs: [], outputs: [] },
  { name: "withdraw", type: "function", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
] as const;
const erc721Abi = [
  { name: "ownerOf", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "address" }] },
  { name: "isApprovedForAll", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "operator", type: "address" }], outputs: [{ type: "bool" }] },
  { name: "setApprovalForAll", type: "function", stateMutability: "nonpayable", inputs: [{ name: "operator", type: "address" }, { name: "approved", type: "bool" }], outputs: [] },
] as const;
export interface KalosListing { quantity: bigint; pricePerItem: bigint; expirationTime: bigint; paymentTokenAddress: Address; }
/** A decoded Kalos ItemListed event (RPC fallback path). */
export interface ListedEvent { seller: Address; nftAddress: Address; tokenId: bigint; quantity: bigint; pricePerItem: bigint; expirationTime: bigint; paymentToken: Address; blockNumber?: bigint; }
// ---- Kalos indexer client (kalos.fun's own data API) ----
// kalos.fun exposes its indexer at /api/market-view:
//   scope=directory            -> all collections + stats.{floor, topBid} (no listings/bids)
//   scope=collection/<slug>    -> live listings[] + bids[] + stats for ONE collection
// The bot uses this as PRIMARY (matches kalos.fun exactly) and falls back to
// on-chain RPC reads when the API is unreachable.
export interface KalosIndexCollection {
  slug: string; address: Address; name: string; symbol: string;
  category?: string; supply?: number; minted?: number; verified?: boolean;
}
export interface KalosIndexListing {
  slug: string; tokenId: bigint; nft: Address; seller: Address;
  price: bigint; paymentToken: Address; expiration: bigint;
}
export interface KalosIndexBid {
  type: string; slug: string; nft: Address; tokenId: bigint; bidder: Address;
  quantity: bigint; price: bigint; paymentToken: Address; expiration: bigint;
  funded?: boolean; fillable?: string; at?: number;
}
interface MarketViewPayload {
  generatedAt?: number; block?: string; collections?: any[]; listings?: any[];
  bids?: any[]; stats?: Record<string, any>;
}
const KALOS_API_BASE = (process.env.KALOS_API_URL || "https://kalos.fun").replace(/\/$/, "");
const indexCache: {
  dir?: { at: number; cols: KalosIndexCollection[]; stats: Map<string, { floor: bigint | null; topBid: bigint | null }> };
  col?: Map<string, { at: number; listings: KalosIndexListing[]; bids: KalosIndexBid[]; stats: { floor: bigint | null; topBid: bigint | null } }>;
} = { col: new Map() };
const INDEX_DIR_TTL_MS = 60_000;
const INDEX_COL_TTL_MS = 30_000;
function bi(v: any): bigint { try { return BigInt(v ?? 0); } catch { return 0n; } }
async function fetchMarketView(scope: string): Promise<MarketViewPayload | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const r = await fetch(`${KALOS_API_BASE}/api/market-view?scope=${encodeURIComponent(scope)}`, { signal: ctrl.signal });
    if (!r.ok) return null;
    return (await r.json()) as MarketViewPayload;
  } catch { return null; }
  finally { clearTimeout(t); }
}

/** Kalos indexer directory: every collection kalos.fun lists (no hardcoded count). Cached 60s. */
export async function getIndexDirectory(): Promise<{ cols: KalosIndexCollection[]; stats: Map<string, { floor: bigint | null; topBid: bigint | null }>; block?: string }> {
  if (indexCache.dir && Date.now() - indexCache.dir.at < INDEX_DIR_TTL_MS) {
    return { cols: indexCache.dir.cols, stats: indexCache.dir.stats };
  }
  const d = await fetchMarketView("directory");
  if (!d || !Array.isArray(d.collections)) throw new Error("Kalos indexer unreachable");
  const cols: KalosIndexCollection[] = (d.collections ?? []).map((c: any) => ({
    slug: String(c.slug), address: c.address as Address,
    name: String(c.name ?? c.slug), symbol: String(c.symbol ?? ""),
    category: c.category, supply: c.supply, minted: c.minted, verified: !!c.verified,
  }));
  const stats = new Map<string, { floor: bigint | null; topBid: bigint | null }>();
  const st = d.stats ?? {};
  for (const c of cols) {
    const s = st[c.slug];
    if (!s) { stats.set(c.address.toLowerCase(), { floor: null, topBid: null }); continue; }
    const f = s.floor != null ? bi(s.floor) : 0n;
    const t = s.topBid != null ? bi(s.topBid) : 0n;
    stats.set(c.address.toLowerCase(), { floor: f > 0n ? f : null, topBid: t > 0n ? t : null });
  }
  indexCache.dir = { at: Date.now(), cols, stats };
  return { cols, stats, block: d.block };
}

/** Live listings + bids for ONE collection by slug. Cached 30s. */
export async function getIndexCollection(slug: string): Promise<{ listings: KalosIndexListing[]; bids: KalosIndexBid[]; stats: { floor: bigint | null; topBid: bigint | null } }> {
  const hit = indexCache.col!.get(slug);
  if (hit && Date.now() - hit.at < INDEX_COL_TTL_MS) return hit;
  const d = await fetchMarketView(`collection/${slug}`);
  if (!d) throw new Error("Kalos indexer unreachable");
  const listings: KalosIndexListing[] = (Array.isArray(d.listings) ? d.listings : [])
    .filter((l: any) => String(l.slug) === slug)
    .map((l: any) => ({
      slug: String(l.slug), tokenId: bi(l.tokenId), nft: l.nft as Address, seller: l.seller as Address,
      price: bi(l.price), paymentToken: l.paymentToken as Address, expiration: bi(l.expiration),
    }))
    .filter((l: KalosIndexListing) => l.price > 0n)
    .sort((a: KalosIndexListing, b: KalosIndexListing) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
  const bids: KalosIndexBid[] = (Array.isArray(d.bids) ? d.bids : [])
    .filter((b: any) => String(b.slug) === slug)
    .map((b: any) => ({
      type: String(b.type ?? "token"), slug: String(b.slug), nft: b.nft as Address,
      tokenId: bi(b.tokenId), bidder: b.bidder as Address, quantity: bi(b.quantity),
      price: bi(b.price), paymentToken: b.paymentToken as Address, expiration: bi(b.expiration),
      funded: b.funded, fillable: b.fillable, at: b.at,
    }))
    .filter((b: KalosIndexBid) => b.price > 0n)
    .sort((a: KalosIndexBid, b: KalosIndexBid) => (a.price > b.price ? -1 : a.price < b.price ? 1 : 0));
  const s = d.stats?.[slug];
  const stats = {
    floor: s?.floor != null && bi(s.floor) > 0n ? bi(s.floor) : (listings[0]?.price ?? null),
    topBid: s?.topBid != null && bi(s.topBid) > 0n ? bi(s.topBid) : (bids[0]?.price ?? null),
  };
  const out = { listings, bids, stats };
  indexCache.col!.set(slug, { at: Date.now(), ...out });
  return out;
}

/** Slug for a collection address (directory lookup, cached). Null = unregistered (e.g. Spartan). */
export async function slugForCollection(addr: Address): Promise<string | null> {
  try {
    const { cols } = await getIndexDirectory();
    const hit = cols.find((c) => c.address.toLowerCase() === addr.toLowerCase());
    return hit ? hit.slug : null;
  } catch { return null; }
}
/** Module-level scan cache (shared across all kalosService calls in this process). */
let scanCache: { at: number; blocksBack: number; events: ListedEvent[] } | null = null;
/**
 * Retry helper for flaky testnet RPC (429s). Sequential, backoff, throws last error.
 * Bounded-parallel map. The public testnet RPC rate-limits aggressively, so
 * verification batches must NOT fire hundreds of concurrent eth_calls.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 400): Promise<T> {
  let last: any = null;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) { last = e; }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, baseMs * (i + 1)));
  }
  throw last;
}
/** Per-collection payment-token cache (pinned token never changes). */
const payTokenCache = new Map<string, { token: Address; at: number }>();
const PAY_TOKEN_TTL_MS = 10 * 60_000;
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
export const kalosService = {
  address(): Address | null { return kalosAddr(); },
  /** Marketplace-level wnative (the WHYPE the contract treats as native). Cached. */
  async wnative(): Promise<Address> {
    if (cachedWnative) return cachedWnative;
    const addr = kalosAddr()!;
    const client = publicClient();
    try {
      cachedWnative = (await withRetry(() => client.readContract({ address: addr, abi: kalosAbi as any, functionName: "wnative" } as any) as Promise<Address>, 3, 400)) as Address;
    } catch { cachedWnative = WHYPE_FALLBACK; }
    if (!cachedWnative || !/^0x[a-fA-F0-9]{40}$/.test(cachedWnative)) cachedWnative = WHYPE_FALLBACK;
    return cachedWnative;
  },
  async getListing(collection: Address, tokenId: bigint, seller: Address): Promise<KalosListing | null> {
    const addr = kalosAddr(); if (!addr) throw new Error("Kalos not configured");
    const client = publicClient();
    const res = await client.readContract({ address: addr, abi: kalosAbi as any, functionName: "getListing", args: [collection, tokenId, seller] } as any) as any;
    if (!res || res.pricePerItem === 0n) return null; return res as KalosListing;
  },
  async getMinPriceForCollection(collection: Address): Promise<bigint | null> {
    const addr = kalosAddr(); if (!addr) return null;
    try { const c = publicClient(); return (await c.readContract({ address: addr, abi: kalosAbi as any, functionName: "getMinPriceForCollection", args: [collection] } as any)) as bigint; } catch { return null; }
  },
  async isApprovedForAll(nft: Address, owner: Address): Promise<boolean> {
    const addr = kalosAddr(); if (!addr) return false;
    try { const c = publicClient(); return !!(await c.readContract({ address: nft, abi: erc721Abi as any, functionName: "isApprovedForAll", args: [owner, addr] } as any)); } catch { return false; }
  },
  async approveMarketplace(privateKey: Hex, nft: Address): Promise<Hash | null> {
    const addr = kalosAddr()!; const account = privateKeyToAccount(privateKey); const pc = publicClient();
    const ok = await this.isApprovedForAll(nft, account.address); if (ok) return null;
    const wc = walletClient(privateKey);
    const hash = await withRetry(() => wc.writeContract({ address: nft, abi: erc721Abi as any, functionName: "setApprovalForAll", args: [addr, true] } as any), 3, 600);
    await withRetry(() => pc.waitForTransactionReceipt({ hash }), 3, 600); return hash;
  },
  async createListing(privateKey: Hex, nftAddress: Address, tokenId: string | bigint, pricePerItemEth: string, opts?: { quantity?: number; days?: number }): Promise<Hash> {
    const addr = kalosAddr(); if (!addr) throw new Error("Kalos not configured");
    const tid = BigInt(tokenId); const qty = BigInt(opts?.quantity ?? 1); const price = parseEther(pricePerItemEth); if (price <= 0n) throw new Error("Price must be > 0");
    const exp = BigInt(Math.floor(Date.now()/1000) + (opts?.days ?? 7)*86400);
    // 1) You must own the token — otherwise the contract reverts (NotOwningItem).
    const account = privateKeyToAccount(privateKey);
    const client = publicClient();
    const ownerNow = (await client.readContract({
      address: nftAddress, abi: erc721Abi as any, functionName: "ownerOf", args: [tid],
    } as any).catch(() => null)) as Address | null;
    if (!ownerNow) throw new Error(`Token #${tid} does not exist in collection ${nftAddress.slice(0, 10)}… (ownerOf reverted). Check the token ID.`);
    if (ownerNow.toLowerCase() !== account.address.toLowerCase()) {
      throw new Error(`You don't own #${tid}: it belongs to ${ownerNow.slice(0, 10)}…, not your wallet ${account.address.slice(0, 10)}…. List only tokens you hold (see /nfts).`);
    }
    await this.approveMarketplace(privateKey, nftAddress);
    // 1b) Re-check approval AFTER the approve tx confirms: createOrUpdateListings
    // reverts (ItemNotApproved) if the approval didn't actually land on-chain.
    const approvedNow = (await client.readContract({
      address: nftAddress, abi: erc721Abi as any, functionName: "isApprovedForAll", args: [account.address, addr],
    } as any).catch(() => false)) as boolean;
    if (!approvedNow) {
      throw new Error(`Kalos approval didn't stick for this collection — the approve tx may have failed or is still pending. Wait a few seconds and retry the listing.`);
    }
    // 2) List in the marketplace's native quote token (WHYPE), NOT zero address.
    // Verified on-chain: paymentToken() == wnative() == WHYPE and every live
    // listing uses it. Zero-address listings revert.
    const payToken = await this.wnative();
    const wc = walletClient(privateKey); const pc = publicClient();
    const param = { nftAddress, tokenId: tid, quantity: qty, pricePerItem: price, expirationTime: exp, paymentToken: payToken };
    // 3) Gas-free dry-run so a revert never costs gas — decode the contract reason.
    try {
      await pc.simulateContract({
        address: addr, abi: kalosAbi as any, functionName: "createOrUpdateListings",
        args: [[param]], account: account.address,
      } as any);
    } catch (e: any) {
      const decoded = this.decodeContractError(e);
      const cause = (e?.cause?.shortMessage || e?.shortMessage || e?.message || "unknown").slice(0, 220);
      throw new Error(`Listing would revert${decoded ? ` with ${decoded}` : ""}: ${cause}`);
    }
    const hash = await withRetry(() => wc.writeContract({ address: addr, abi: kalosAbi as any, functionName: "createOrUpdateListings", args: [[param]] } as any), 3, 600);
    await withRetry(() => pc.waitForTransactionReceipt({ hash }), 3, 600); return hash;
  },
  async cancelListing(privateKey: Hex, nftAddress: Address, tokenId: string | bigint): Promise<Hash> {
    const addr = kalosAddr()!; const wc = walletClient(privateKey); const pc = publicClient();
    const hash = await withRetry(() => wc.writeContract({ address: addr, abi: kalosAbi as any, functionName: "cancelListings", args: [[{ nftAddress, tokenId: BigInt(tokenId) }]] } as any), 3, 600);
    await withRetry(() => pc.waitForTransactionReceipt({ hash }), 3, 600); return hash;
  },
  /** Build one buy-item param exactly like kalos.fun: listing's paymentToken + usingNative=(token==wnative). */
  async buildBuyItem(
    collection: Address, tokenId: bigint, seller: Address, qty: bigint, listing: KalosListing
  ): Promise<{ nftAddress: Address; tokenId: bigint; owner: Address; quantity: bigint; maxPricePerItem: bigint; paymentToken: Address; usingNative: boolean }> {
    const wnative = (await this.wnative()).toLowerCase();
    const payToken = (listing.paymentTokenAddress ?? ZERO) as Address;
    const usingNative = payToken.toLowerCase() === wnative || payToken.toLowerCase() === ZERO.toLowerCase();
    return {
      nftAddress: collection, tokenId, owner: seller, quantity: qty,
      maxPricePerItem: listing.pricePerItem,
      // Mirror kalos.fun: pass the LISTING's paymentToken, not hardcoded zero.
      paymentToken: payToken,
      usingNative,
    };
  },
  async buy(privateKey: Hex, nftAddress: Address, tokenId: string | bigint, owner: Address, opts?: { quantity?: number; maxPriceEth?: string }): Promise<Hash> {
    const addr = kalosAddr()!; const tid = BigInt(tokenId); const qty = BigInt(opts?.quantity ?? 1);
    const listing = await this.getListing(nftAddress, tid, owner);
    if (!listing || listing.pricePerItem === 0n) {
      throw new Error(`Token #${tid} is not listed for sale on Kalos by ${owner.slice(0, 8)}…`);
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (listing.expirationTime > 0n && listing.expirationTime < now) {
      throw new Error(`Listing for token #${tid} has expired on Kalos.`);
    }
    const price = listing.pricePerItem * qty;
    if (opts?.maxPriceEth) {
      const maxP = parseEther(opts.maxPriceEth);
      if (price > maxP) throw new Error(`Listed price (${formatEther(price)} HYPE) exceeds your max price (${opts.maxPriceEth} HYPE).`);
    }
    // Re-check owner at execution time (kills the stale-seller revert before it costs gas).
    try {
      const client = publicClient();
      const ownerNow = (await client.readContract({
        address: nftAddress, abi: erc721Abi as any, functionName: "ownerOf", args: [tid],
      } as any).catch(() => null)) as Address | null;
      if (!ownerNow) throw new Error(`Token #${tid} no longer exists (ownerOf reverted). It may have been burned or moved.`);
      if (ownerNow.toLowerCase() !== owner.toLowerCase()) {
        throw new Error(`Seller changed for #${tid}: listed by ${owner.slice(0, 10)}… but now owned by ${ownerNow.slice(0, 10)}…. Re-scan and buy the live listing.`);
      }
    } catch (e: any) {
      if (e?.message?.startsWith("Seller changed") || e?.message?.includes("no longer exists")) throw e;
      // ownerOf read failed (RPC) — proceed; the contract will revert honestly if stale.
    }
    const item = await this.buildBuyItem(nftAddress, tid, owner, qty, listing);
    const wc = walletClient(privateKey); const pc = publicClient();
    const hash = await wc.writeContract({ address: addr, abi: kalosAbi as any, functionName: "buyItems", args: [[item]], value: price } as any);
    await pc.waitForTransactionReceipt({ hash }); return hash;
  },

  /** Collection's pinned payment token (per getPaymentTokenForCollection), else wnative. */
  async paymentTokenFor(nftAddress: Address): Promise<Address> {
    const key = nftAddress.toLowerCase();
    const hit = payTokenCache.get(key);
    if (hit && Date.now() - hit.at < PAY_TOKEN_TTL_MS) return hit.token;
    try {
      const pinned = (await withRetry(() => publicClient().readContract({
        address: kalosAddr()!, abi: kalosAbi as any, functionName: "getPaymentTokenForCollection", args: [nftAddress],
      } as any) as Promise<Address | null>, 3, 400).catch(() => null)) as Address | null;
      if (pinned && /^0x[a-fA-F0-9]{40}$/.test(pinned) && pinned.toLowerCase() !== ZERO.toLowerCase()) {
        payTokenCache.set(key, { token: pinned, at: Date.now() });
        return pinned;
      }
    } catch {}
    const w = await this.wnative();
    payTokenCache.set(key, { token: w, at: Date.now() });
    return w;
  },
  /** Reads that gate bid writes: global bids switch + collection approval status. */
  async bidGates(nftAddress: Address): Promise<{ bidsActive: boolean; collectionApproved: boolean }> {
    const client = publicClient();
    const addr = kalosAddr()!;
    let bidsActive = true;
    try {
      bidsActive = (await client.readContract({ address: addr, abi: kalosAbi as any, functionName: "areBidsActive" } as any).catch(() => true)) as boolean;
    } catch { bidsActive = true; }
    let collectionApproved = true;
    try {
      const st = (await client.readContract({ address: addr, abi: kalosAbi as any, functionName: "collectionApprovals", args: [nftAddress] } as any).catch(() => 2)) as number | bigint;
      collectionApproved = Number(st) !== 0;
    } catch { collectionApproved = true; }
    return { bidsActive: !!bidsActive, collectionApproved };
  },
  /** WHYPE (payment-token) balance of an account — bids escrow in WHYPE, not native HYPE. */
  async paymentTokenBalance(of: Address, nftAddress: Address): Promise<{ symbol: string; decimals: number; raw: bigint }> {
    const client = publicClient();
    const pay = await this.paymentTokenFor(nftAddress);
    const erc = [
      { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
      { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
      { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
    ] as const;
    // Sequential + retried: parallel balanceOf/symbol/decimals bursts 429 and
    // the whole Promise.all used to resolve 0n — the exact "you hold 0 WHYPE"
    // lie when the wallet really holds 0.1. Never report 0 without retries.
    let raw: bigint = 0n;
    try {
      const v = await withRetry(() => client.readContract({ address: pay, abi: erc as any, functionName: "balanceOf", args: [of] } as any) as Promise<unknown>, 3, 400);
      try { raw = BigInt((v as any) ?? 0); } catch { raw = 0n; }
    } catch { raw = 0n; }
    let symbol: unknown = "WHYPE";
    try { symbol = await withRetry(() => client.readContract({ address: pay, abi: erc as any, functionName: "symbol" } as any) as Promise<unknown>, 2, 400).catch(() => "WHYPE"); } catch { symbol = "WHYPE"; }
    let decimals: unknown = 18;
    try { decimals = await withRetry(() => client.readContract({ address: pay, abi: erc as any, functionName: "decimals" } as any) as Promise<unknown>, 2, 400).catch(() => 18); } catch { decimals = 18; }
    return { symbol: String(symbol ?? "WHYPE"), decimals: Number(decimals ?? 18), raw };
  },
  /** Generic WHYPE balance (no collection needed) — for wallet display. */
  async whypeBalance(of: Address): Promise<{ symbol: string; raw: bigint }> {
    const pay = await this.wnative();
    const erc = [
      { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
      { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
    ] as const;
    const client = publicClient();
    let raw: bigint = 0n;
    try {
      const v = await withRetry(() => client.readContract({ address: pay, abi: erc as any, functionName: "balanceOf", args: [of] } as any) as Promise<unknown>, 3, 400);
      try { raw = BigInt((v as any) ?? 0); } catch { raw = 0n; }
    } catch { raw = 0n; }
    let symbol: unknown = "WHYPE";
    try { symbol = await withRetry(() => client.readContract({ address: pay, abi: erc as any, functionName: "symbol" } as any) as Promise<unknown>, 2, 400).catch(() => "WHYPE"); } catch { symbol = "WHYPE"; }
    return { symbol: String(symbol ?? "WHYPE"), raw };
  },
  /** Unwrap WHYPE -> native HYPE (withdraw). Returns tx hash. */
  async unwrapHype(privateKey: Hex, amountWei: bigint, payToken?: Address): Promise<Hash> {
    const token = payToken ?? await this.wnative();
    const wc = walletClient(privateKey); const pc = publicClient();
    const hash = await wc.writeContract({ address: token, abi: erc20Abi as any, functionName: "withdraw", args: [amountWei] } as any);
    await pc.waitForTransactionReceipt({ hash }); return hash;
  },
  /** Wrap native HYPE -> WHYPE (deposit). Returns tx hash. Retried for flaky RPC. */
  async wrapHype(privateKey: Hex, amountWei: bigint, payToken?: Address): Promise<Hash> {
    const token = payToken ?? await this.wnative();
    const wc = walletClient(privateKey); const pc = publicClient();
    const hash = await withRetry(() => wc.writeContract({ address: token, abi: erc20Abi as any, functionName: "deposit", value: amountWei } as any), 3, 600);
    await withRetry(() => pc.waitForTransactionReceipt({ hash }), 3, 600); return hash;
  },
  /** WHYPE allowance of owner -> Kalos marketplace. */
  async paymentTokenAllowance(owner: Address, payToken: Address): Promise<bigint> {
    try {
      const v = await withRetry(() => publicClient().readContract({ address: payToken, abi: erc20Abi as any, functionName: "allowance", args: [owner, kalosAddr()!] } as any) as Promise<unknown>, 3, 400);
      return BigInt((v as any) ?? 0);
    } catch { return 0n; }
  },
  /** Approve Kalos to pull WHYPE (max). No-op if allowance already covers need. Retried + verified. */
  async approvePaymentToken(privateKey: Hex, payToken: Address, need?: bigint): Promise<Hash | null> {
    const account = privateKeyToAccount(privateKey);
    const allow = await this.paymentTokenAllowance(account.address, payToken);
    if (need !== undefined && allow >= need) return null;
    if (need === undefined && allow > 0n) return null;
    const wc = walletClient(privateKey); const pc = publicClient();
    const max = (1n << 256n) - 1n;
    const hash = await withRetry(() => wc.writeContract({ address: payToken, abi: erc20Abi as any, functionName: "approve", args: [kalosAddr()!, max] } as any), 3, 600);
    await withRetry(() => pc.waitForTransactionReceipt({ hash }), 3, 600);
    // Verify the approval actually landed — flaky RPC can return a receipt that
    // isn't yet visible to reads; without this the bid reverts InsufficientBidFunds.
    for (let i = 0; i < 3; i++) {
      const after = await this.paymentTokenAllowance(account.address, payToken).catch(() => 0n);
      if (need === undefined ? after > 0n : after >= (need ?? 0n)) return hash;
      await new Promise((r) => setTimeout(r, 600));
    }
    return hash;
  },
  /**
   * Ensure bidder can cover `need` in WHYPE: wrap native shortfall + approve Kalos.
   * Keeps a small gas buffer so the wrap doesn't strand the wallet.
   */
  async ensureBidFunds(privateKey: Hex, nftAddress: Address, need: bigint): Promise<{ wrapHash: Hash | null; approveHash: Hash | null; payToken: Address; balRaw: bigint }> {
    const account = privateKeyToAccount(privateKey);
    const payToken = await this.paymentTokenFor(nftAddress);
    const client = publicClient();
    const balObj = await this.paymentTokenBalance(account.address, nftAddress).catch(() => ({ raw: 0n } as any));
    const bal = (balObj as any).raw as bigint;
    let wrapHash: Hash | null = null;
    if (bal < need) {
      const shortfall = need - bal;
      const native = await withRetry(() => client.getBalance({ address: account.address }), 3, 400).catch(() => 0n);
      const buffer = parseEther("0.005");
      const spendable = native > buffer ? native - buffer : 0n;
      if (spendable < shortfall) {
        throw new Error(`Not enough HYPE to wrap: need ${formatEther(shortfall)} WHYPE but only ${formatEther(spendable)} HYPE is spendable after gas. Top up, then retry.`);
      }
      wrapHash = await this.wrapHype(privateKey, shortfall, payToken);
    }
    const approveHash = await this.approvePaymentToken(privateKey, payToken, need);
    const balAfter = await this.paymentTokenBalance(account.address, nftAddress).catch(() => ({ raw: bal } as any));
    return { wrapHash, approveHash, payToken, balRaw: (balAfter as any).raw as bigint };
  },
  /** One-shot approve+wrap+bid: single ensureBidFunds then bid write, both retried.
   * Fixes the old double-ensure path (handler called ensureBidFunds, then
   * createTokenBid called it again) which doubled RPC load and surfaced bare
   * "RPC Request failed" with no hashes. Returns hashes for user feedback. */
  async approveAndBid(privateKey: Hex, nftAddress: Address, tokenId: string | bigint, pricePerItemEth: string, opts?: { quantity?: number; days?: number }): Promise<{ bidHash: Hash; wrapHash: Hash | null; approveHash: Hash | null; payToken: Address }> {
    const tid = BigInt(tokenId);
    if (tid < 0n) throw new Error("Token ID must be 0 (any token) or a positive token ID.");
    const qty = BigInt(opts?.quantity ?? 1); const price = parseEther(pricePerItemEth);
    const days = Math.max(1, Math.min(30, Math.round(opts?.days ?? 7)));
    const exp = BigInt(Math.floor(Date.now() / 1000) + days * 86400);
    if (tid > 0n) {
      const ownerNow = (await withRetry(() => publicClient().readContract({
        address: nftAddress, abi: erc721Abi as any, functionName: "ownerOf", args: [tid],
      } as any), 3, 400).catch(() => null)) as Address | null;
      if (!ownerNow) throw new Error(`Token #${tid} does not exist in this collection (ownerOf reverted). Use 0 for any-token.`);
    }
    const payToken = await this.paymentTokenFor(nftAddress);
    const { wrapHash, approveHash } = await this.ensureBidFunds(privateKey, nftAddress, price * qty);
    const addr = kalosAddr()!;
    const param = { nftAddress, tokenId: tid, quantity: qty, pricePerItem: price, expirationTime: exp, paymentToken: payToken };
    try {
      await withRetry(() => publicClient().simulateContract({
        address: addr, abi: kalosAbi as any, functionName: "createOrUpdateTokenBids",
        args: [[param]], account: privateKeyToAccount(privateKey).address,
      } as any), 2, 500);
    } catch (e: any) {
      const decoded = this.decodeContractError(e);
      const cause = (e?.cause?.shortMessage || e?.shortMessage || e?.message || "unknown").slice(0, 220);
      throw new Error(`Offer would revert${decoded ? ` with ${decoded}` : ""}: ${cause}`);
    }
    const wc = walletClient(privateKey); const pc = publicClient();
    let bidHash: Hash;
    try {
      bidHash = await withRetry(() => wc.writeContract({ address: addr, abi: kalosAbi as any, functionName: "createOrUpdateTokenBids", args: [[param]] } as any), 3, 600);
    } catch (e: any) {
      const msg = e?.cause?.shortMessage || e?.shortMessage || e?.message || "unknown";
      throw new Error(`Bid write failed after approve${approveHash ? ` (approve ${approveHash.slice(0, 10)}… landed)` : ""}${wrapHash ? ` + wrap ${wrapHash.slice(0, 10)}… landed` : ""}: ${String(msg).slice(0, 220)}. Your WHYPE is safe — retry /offer (allowance now covers it).`);
    }
    await withRetry(() => pc.waitForTransactionReceipt({ hash: bidHash }), 3, 600);
    return { bidHash, wrapHash, approveHash, payToken };
  },
  async createTokenBid(privateKey: Hex, nftAddress: Address, tokenId: string | bigint, pricePerItemEth: string, opts?: { quantity?: number; days?: number }): Promise<Hash> {
    const addr = kalosAddr()!; const tid = BigInt(tokenId);
    if (tid < 0n) throw new Error("Token ID must be 0 (any token) or a positive token ID.");
    const qty = BigInt(opts?.quantity ?? 1); const price = parseEther(pricePerItemEth); const exp = BigInt(Math.floor(Date.now()/1000) + (opts?.days ?? 7)*86400);
    // tokenId 0 = collection-wide offer (any token in the collection). No per-token owner check.
    if (tid > 0n) {
      const ownerNow = (await publicClient().readContract({
        address: nftAddress, abi: erc721Abi as any, functionName: "ownerOf", args: [tid],
      } as any).catch(() => null)) as Address | null;
      if (!ownerNow) throw new Error(`Token #${tid} does not exist in this collection (ownerOf reverted). Use 0 for any-token.`);
    }
    // Collection-pinned payment token (NOT blind wnative): PaymentTokenNotSupported reverts otherwise.
    const payToken = await this.paymentTokenFor(nftAddress);
    // Auto-wrap native HYPE -> WHYPE shortfall + approve Kalos, so bids "just work".
    // (dryRunBid surfaces NEEDS_WRAP first, but createTokenBid stays self-sufficient
    // for any direct callers too.)
    try {
      await this.ensureBidFunds(privateKey, nftAddress, price * qty);
    } catch (e: any) {
      // ensureBidFunds throws only when even wrapping can't cover it — surface as-is.
      throw new Error(e?.message || "Insufficient WHYPE and not enough HYPE to wrap.");
    }
    const wc = walletClient(privateKey); const pc = publicClient();
    const param = { nftAddress, tokenId: tid, quantity: qty, pricePerItem: price, expirationTime: exp, paymentToken: payToken };
    try {
      await pc.simulateContract({
        address: addr, abi: kalosAbi as any, functionName: "createOrUpdateTokenBids",
        args: [[param]], account: privateKeyToAccount(privateKey).address,
      } as any);
    } catch (e: any) {
      const decoded = this.decodeContractError(e);
      const cause = (e?.cause?.shortMessage || e?.shortMessage || e?.message || "unknown").slice(0, 220);
      throw new Error(`Offer would revert${decoded ? ` with ${decoded}` : ""}: ${cause}`);
    }
    const hash = await wc.writeContract({ address: addr, abi: kalosAbi as any, functionName: "createOrUpdateTokenBids", args: [[param]] } as any);
    await pc.waitForTransactionReceipt({ hash }); return hash;
  },
  async createCollectionBid(privateKey: Hex, nftAddress: Address, pricePerItemEth: string, opts?: { quantity?: number; days?: number }): Promise<Hash> {
    const addr = kalosAddr()!; const qty = BigInt(opts?.quantity ?? 1); const price = parseEther(pricePerItemEth); const exp = BigInt(Math.floor(Date.now()/1000) + (opts?.days ?? 7)*86400);
    // Collection bids use the same pinned payment token as token bids.
    const payToken = await this.paymentTokenFor(nftAddress);
    const wc = walletClient(privateKey); const pc = publicClient();
    try {
      await pc.simulateContract({
        address: addr, abi: kalosAbi as any, functionName: "createOrUpdateCollectionBid",
        args: [nftAddress, qty, price, exp, payToken], account: privateKeyToAccount(privateKey).address,
      } as any);
    } catch (e: any) {
      const decoded = this.decodeContractError(e);
      const cause = (e?.cause?.shortMessage || e?.shortMessage || e?.message || "unknown").slice(0, 220);
      throw new Error(`Collection offer would revert${decoded ? ` with ${decoded}` : ""}: ${cause}`);
    }
    const hash = await wc.writeContract({ address: addr, abi: kalosAbi as any, functionName: "createOrUpdateCollectionBid", args: [nftAddress, qty, price, exp, payToken] } as any);
    await pc.waitForTransactionReceipt({ hash }); return hash;
  },
  async acceptBid(privateKey: Hex, nftAddress: Address, tokenId: string | bigint, bidder: Address, opts?: { quantity?: number; priceEth?: string }): Promise<Hash> {
    const addr = kalosAddr()!; const tid = BigInt(tokenId); const qty = BigInt(opts?.quantity ?? 1);
    let price = opts?.priceEth ? parseEther(opts.priceEth) : 0n;
    let payToken: Address | null = null;
    let bidType = 0;
    if (!price) {
      const client = publicClient();
      // Specific-token bid first, then any-token (id 0), then collection-wide.
      // getTokenBid returns (quantity, pricePerItem, expirationTime, paymentTokenAddress).
      const specific: any = await client.readContract({ address: addr, abi: kalosAbi as any, functionName: "getTokenBid", args: [nftAddress, tid, bidder] } as any).catch(() => null);
      const anyToken: any = tid !== 0n ? await client.readContract({ address: addr, abi: kalosAbi as any, functionName: "getTokenBid", args: [nftAddress, 0n, bidder] } as any).catch(() => null) : null;
      const coll: any = await client.readContract({ address: addr, abi: kalosAbi as any, functionName: "getCollectionBid", args: [nftAddress, bidder] } as any).catch(() => null);
      const pick = (b: any): { p: bigint; t: Address | null } | null => {
        if (!b) return null;
        let p = 0n;
        try { p = BigInt(b?.pricePerItem ?? b?.[1] ?? 0); } catch { p = 0n; }
        if (p <= 0n) return null;
        const t = (b?.paymentTokenAddress ?? b?.paymentToken ?? b?.[3] ?? null) as Address | null;
        return { p, t };
      };
      const s = pick(specific);
      if (s) { price = s.p; payToken = s.t; bidType = 0; }
      else {
        const a = pick(anyToken);
        const c = pick(coll);
        // Prefer the higher-priced live bid so the seller gets the best fill.
        if (a && c) {
          if (a.p >= c.p) { price = a.p; payToken = a.t; bidType = 0; }
          else { price = c.p; payToken = c.t; bidType = 1; }
        } else if (a) { price = a.p; payToken = a.t; bidType = 0; }
        else if (c) { price = c.p; payToken = c.t; bidType = 1; }
      }
      if (!price || price === 0n) throw new Error("Bid not found");
    }
    if (!payToken) payToken = await this.paymentTokenFor(nftAddress);
    await this.approveMarketplace(privateKey, nftAddress);
    const wc = walletClient(privateKey); const pc = publicClient();
    const seller = privateKeyToAccount(privateKey).address;
    // Collection-wide fills may need bidType 1 — try 0 first, fall back to 1
    // via simulation so the on-chain call is the one that actually succeeds.
    const candidates = bidType === 1 ? [1, 0] : [0, 1];
    let param: any = null;
    for (const bt of candidates) {
      const p = { bidType: bt, nftAddress, tokenId: tid, bidder, quantity: qty, pricePerItem: price, paymentToken: payToken };
      try {
        await pc.simulateContract({
          address: addr, abi: kalosAbi as any, functionName: "acceptBids",
          args: [[p]], account: seller,
        } as any);
        param = p;
        break;
      } catch { /* try next bidType */ }
    }
    if (!param) {
      // Default to the resolved bidType so the write surfaces the real revert.
      param = { bidType, nftAddress, tokenId: tid, bidder, quantity: qty, pricePerItem: price, paymentToken: payToken };
      try {
        await pc.simulateContract({
          address: addr, abi: kalosAbi as any, functionName: "acceptBids",
          args: [[param]], account: seller,
        } as any);
      } catch (e: any) {
        const decoded = this.decodeContractError(e);
        const cause = (e?.cause?.shortMessage || e?.shortMessage || e?.message || "unknown").slice(0, 220);
        throw new Error(`Accept would revert${decoded ? ` with ${decoded}` : ""}: ${cause}`);
      }
    }
    const hash = await wc.writeContract({ address: addr, abi: kalosAbi as any, functionName: "acceptBids", args: [[param]] } as any);
    await pc.waitForTransactionReceipt({ hash }); return hash;
  },
  formatPrice(bi: bigint): string { return formatEther(bi); },
  /** Discover every collection with ItemListed events in recent blocks (no hardcoding). */
  async discoverCollections(opts?: { blocksBack?: number; chunkSize?: number }): Promise<Address[]> {
    const events = await this.scanListedEvents({ blocksBack: opts?.blocksBack ?? 50_000 });
    const seen = new Set<string>();
    for (const e of events) seen.add(e.nftAddress.toLowerCase());
    return [...seen] as Address[];
  },
  /**
   * Scan recent ItemListed events with proper viem decoding (getContractEvents).
   * Chunked so the RPC range limit is never hit. Returns raw decoded events.
   */
  async scanListedEvents(opts?: { blocksBack?: number; chunkSize?: number }): Promise<ListedEvent[]> {
    const addr = kalosAddr();
    if (!addr) return [];
    const client = publicClient();
    const latest = await client.getBlockNumber();
    const blocksBack = BigInt(opts?.blocksBack ?? 50_000);
    const chunk = BigInt(opts?.chunkSize ?? 25_000);
    const from = latest > blocksBack ? latest - blocksBack : 0n;
    const ranges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    for (let s = from; s <= latest; s += chunk + 1n) {
      const e = s + chunk > latest ? latest : s + chunk;
      ranges.push({ fromBlock: s, toBlock: e });
    }
    const out: ListedEvent[] = [];
    await Promise.all(
      ranges.map(async (r) => {
        try {
          const logs = await client.getContractEvents({
            address: addr, abi: kalosAbi as any, eventName: "ItemListed",
            fromBlock: r.fromBlock, toBlock: r.toBlock,
          });
          for (const l of logs as Array<any>) {
            const a = l?.args as any;
            if (!a?.nftAddress || !/^0x[a-fA-F0-9]{40}$/.test(a.nftAddress)) continue;
            try {
              out.push({
                seller: a.seller as Address,
                nftAddress: a.nftAddress as Address,
                tokenId: BigInt(a.tokenId ?? 0),
                quantity: BigInt(a.quantity ?? 0),
                pricePerItem: BigInt(a.pricePerItem ?? 0),
                expirationTime: BigInt(a.expirationTime ?? 0),
                paymentToken: a.paymentToken as Address,
                blockNumber: typeof l?.blockNumber === "bigint" ? l.blockNumber : undefined,
              });
            } catch { /* skip malformed */ }
          }
        } catch { /* skip failed chunks */ }
      })
    );
    return out;
  },
  /** Gas-free pre-flight for createListing: ownership + approval + dry-run simulate. */
  async dryRunList(
    collection: Address, tokenId: bigint, owner: Address, priceWei: bigint, expiration: bigint
  ): Promise<{ ok: boolean; reason?: string }> {
    const client = publicClient();
    const ownerNow = (await client.readContract({
      address: collection, abi: erc721Abi as any, functionName: "ownerOf", args: [tokenId],
    } as any).catch(() => null)) as Address | null;
    if (!ownerNow) return { ok: false, reason: `Token #${tokenId} does not exist in this collection (ownerOf reverted). Check the token ID with /nfts first.` };
    if (ownerNow.toLowerCase() !== owner.toLowerCase()) {
      return { ok: false, reason: `You don't own #${tokenId}: it belongs to ${ownerNow.slice(0, 10)}…. List only tokens you hold (see /nfts).` };
    }
    const mkt = kalosAddr()!;
    const approved = (await client.readContract({
      address: collection, abi: erc721Abi as any, functionName: "isApprovedForAll", args: [owner, mkt],
    } as any).catch(() => false)) as boolean;
    if (!approved) {
      return { ok: false, needsApproval: true, reason: `Kalos is not approved to move #${tokenId} yet. Tap Approve below, wait for confirmation, then list again.` } as { ok: boolean; reason?: string };
    }
    const payToken = await this.wnative();
    const param = { nftAddress: collection, tokenId, quantity: 1n, pricePerItem: priceWei, expirationTime: expiration, paymentToken: payToken };
    try {
      await client.simulateContract({
        address: kalosAddr()!, abi: kalosAbi as any, functionName: "createOrUpdateListings",
        args: [[param]], account: owner,
      } as any);
      return { ok: true };
    } catch (e: any) {
      const decoded = this.decodeContractError(e);
      const rawShort = (e?.cause?.shortMessage || e?.shortMessage || e?.message || "unknown").slice(0, 300);
      const hint = decodeListingHint(decoded, rawShort, tokenId);
      const cause = hint ? `${hint}\n\nRaw: ${rawShort.slice(0, 180)}` : rawShort.slice(0, 220);
      return { ok: false, reason: `Listing would revert${decoded ? ` with ${decoded}` : ""}: ${cause}` };
    }
  },
  /** Gas-free pre-flight for cancelListing: verifies the caller actually has a listing. */
  async dryRunCancel(collection: Address, tokenId: bigint, seller: Address): Promise<{ ok: boolean; reason?: string }> {
    const listing = await this.getListing(collection, tokenId, seller);
    if (!listing || listing.pricePerItem === 0n) {
      return { ok: false, reason: `No live listing for #${tokenId} by your wallet — nothing to cancel. It may already be sold, delisted, or listed from a different wallet.` };
    }
    const client = publicClient();
    try {
      await client.simulateContract({
        address: kalosAddr()!, abi: kalosAbi as any, functionName: "cancelListings",
        args: [[{ nftAddress: collection, tokenId }]], account: seller,
      } as any);
      return { ok: true };
    } catch (e: any) {
      const decoded = this.decodeContractError(e);
      const cause = (e?.cause?.shortMessage || e?.shortMessage || e?.message || "unknown").slice(0, 220);
      return { ok: false, reason: `Cancel would revert${decoded ? ` with ${decoded}` : ""}: ${cause}` };
    }
  },
  /** Gas-free pre-flight for createOrUpdateTokenBids. tokenId 0 = any token (collection-wide). */
  async dryRunBid(collection: Address, tokenId: bigint, priceWei: bigint, bidder: Address, qty: bigint = 1n): Promise<{ ok: boolean; reason?: string; code?: string; need?: bigint; shortfall?: bigint; balRaw?: bigint; payToken?: Address }> {
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (priceWei <= 0n) return { ok: false, reason: "Offer price must be above 0." };
    if (tokenId < 0n) return { ok: false, reason: "Token ID must be 0 (any token) or a positive token ID." };
    if (tokenId > 0n) {
      const ownerNow = (await publicClient().readContract({
        address: collection, abi: erc721Abi as any, functionName: "ownerOf", args: [tokenId],
      } as any).catch(() => null)) as Address | null;
      if (!ownerNow) return { ok: false, reason: `Token #${tokenId} does not exist in this collection. Use 0 for an any-token offer.` };
    }
    // 1) Global + collection gates — these revert before anything else.
    const gates = await this.bidGates(collection).catch(() => ({ bidsActive: true, collectionApproved: true }));
    if (!gates.bidsActive) return { ok: false, code: "BIDS_DISABLED", reason: "Bidding is currently disabled on Kalos (areBidsActive = false). Bids cannot land until the marketplace re-enables them." };
    if (!gates.collectionApproved) return { ok: false, code: "COLLECTION_NOT_APPROVED", reason: "This collection is not approved for trading on Kalos (collectionApprovals = 0). Only approved collections accept bids/listings." };
    // 2) Bidder must hold the payment token (bids escrow in WHYPE, not native HYPE).
    //    If WHYPE is short but native HYPE covers it, return NEEDS_WRAP so the
    //    bot can one-tap wrap + approve instead of hard-failing.
    //    Balance is double-read (sequential, retried): the testnet RPC 429s and
    //    a single-shot .catch(()=>0n) is what reported "0 WHYPE" for a 0.1 wallet.
    const payToken = await this.paymentTokenFor(collection);
    let bal = await this.paymentTokenBalance(bidder, collection).catch(() => ({ symbol: "WHYPE", decimals: 18, raw: 0n }));
    if (bal.raw === 0n) {
      await new Promise((r) => setTimeout(r, 500));
      try { bal = await this.paymentTokenBalance(bidder, collection); } catch {}
    }
    const need = priceWei * (qty > 0n ? qty : 1n);
    if (bal.raw < need) {
      const shortfall = need - bal.raw;
      let nativeBal = 0n;
      try { nativeBal = await publicClient().getBalance({ address: bidder }); } catch {}
      const buffer = parseEther("0.005");
      const spendable = nativeBal > buffer ? nativeBal - buffer : 0n;
      if (spendable >= shortfall) {
        return { ok: false, code: "NEEDS_WRAP", need, shortfall, payToken, balRaw: bal.raw, reason: `Needs wrap: you hold ${kalosService.formatPrice(bal.raw)} WHYPE but this bid needs ${kalosService.formatPrice(need)} WHYPE. You have ${kalosService.formatPrice(nativeBal)} HYPE — wrap ${kalosService.formatPrice(shortfall)} HYPE to cover it.` };
      }
      return { ok: false, code: "INSUFFICIENT_WHYPE", need, shortfall, payToken, reason: `Insufficient WHYPE: you hold ${kalosService.formatPrice(bal.raw)} WHYPE but this bid needs ${kalosService.formatPrice(need)} WHYPE. You only have ${kalosService.formatPrice(nativeBal)} native HYPE, so even wrapping can't cover it — top up, then retry. Bids escrow in WHYPE (payment token ${payToken.slice(0, 10)}…), not native HYPE.` };
    }
    // 3) Kalos must be APPROVED to pull WHYPE. simulateContract runs as the
    //    bidder with the real allowance — with allowance 0 the call reverts with
    //    InsufficientBidFunds() even when the balance covers the bid.
    let allow = 0n;
    try { allow = await this.paymentTokenAllowance(bidder, payToken); } catch { allow = 0n; }
    if (allow < need) {
      return { ok: false, code: "NEEDS_APPROVE", need, payToken, reason: `Kalos isn't approved to move your WHYPE yet (allowance ${kalosService.formatPrice(allow)} < bid ${kalosService.formatPrice(need)}). One tap approves Kalos, then places the bid.` };
    }
    const param = { nftAddress: collection, tokenId, quantity: qty, pricePerItem: priceWei, expirationTime: now + 7n * 86400n, paymentToken: payToken };
    try {
      await publicClient().simulateContract({
        address: kalosAddr()!, abi: kalosAbi as any, functionName: "createOrUpdateTokenBids",
        args: [[param]], account: bidder,
      } as any);
      return { ok: true };
    } catch (e: any) {
      const decoded = this.decodeContractError(e);
      const cause = (e?.cause?.shortMessage || e?.shortMessage || e?.message || "unknown").slice(0, 260);
      const bidHint = decoded && decoded.toLowerCase().includes("insufficientbidfunds")
        ? " InsufficientBidFunds with a funded wallet almost always means Kalos lacks WHYPE allowance (approve first) — the bot now checks this automatically, retry the offer."
        : "";
      return { ok: false, reason: `Offer would revert${decoded ? ` with ${decoded}` : ""}: ${cause}.${bidHint}` };
    }
  },
  /** Gas-free pre-flight for acceptBids: verifies the bid exists and the caller owns the token. */
  async dryRunAccept(collection: Address, tokenId: bigint, bidder: Address, seller: Address): Promise<{ ok: boolean; reason?: string }> {
    const client = publicClient();
    const bid: any = await client.readContract({
      address: kalosAddr()!, abi: kalosAbi as any, functionName: "getTokenBid", args: [collection, tokenId, bidder],
    } as any).catch(() => null);
    if (!bid || bid.pricePerItem === 0n) {
      return { ok: false, reason: `No live bid on #${tokenId} from ${bidder.slice(0, 10)}…. It may have been cancelled or already accepted.` };
    }
    const ownerNow = (await client.readContract({
      address: collection, abi: erc721Abi as any, functionName: "ownerOf", args: [tokenId],
    } as any).catch(() => null)) as Address | null;
    if (!ownerNow || ownerNow.toLowerCase() !== seller.toLowerCase()) {
      return { ok: false, reason: `You don't own #${tokenId} right now — only the current owner can accept bids.` };
    }
    const param = { bidType: 0, nftAddress: collection, tokenId, bidder, quantity: 1n, pricePerItem: bid.pricePerItem as bigint, paymentToken: (bid.paymentToken ?? await this.wnative()) as Address };
    try {
      await client.simulateContract({
        address: kalosAddr()!, abi: kalosAbi as any, functionName: "acceptBids",
        args: [[param]], account: seller,
      } as any);
      return { ok: true };
    } catch (e: any) {
      const decoded = this.decodeContractError(e);
      const cause = (e?.cause?.shortMessage || e?.shortMessage || e?.message || "unknown").slice(0, 220);
      return { ok: false, reason: `Accept would revert${decoded ? ` with ${decoded}` : ""}: ${cause}` };
    }
  },
  /** List token IDs owned by `owner` in an ERC-721 collection (enumerable fast path + event fallback). */
  async tokensOfOwner(collection: Address, owner: Address, opts?: { maxScan?: number; limit?: number }): Promise<bigint[]> {
    const limit = opts?.limit ?? 25;
    try {
      const client = publicClient();
      const bal = (await client.readContract({
        address: collection,
        abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] }] as any,
        functionName: "balanceOf", args: [owner],
      } as any).catch(() => 0n)) as bigint;
      if (bal > 0n) {
        const ids: bigint[] = [];
        for (let i = 0n; i < bal && ids.length < limit; i++) {
          try {
            const tid = (await client.readContract({
              address: collection,
              abi: [{ name: "tokenOfOwnerByIndex", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "index", type: "uint256" }], outputs: [{ type: "uint256" }] }] as any,
              functionName: "tokenOfOwnerByIndex", args: [owner, i],
            } as any).catch(() => null)) as bigint | null;
            if (tid !== null) ids.push(tid);
            else break; // not enumerable — fall through to event scan
          } catch { break; }
        }
        if (ids.length > 0) return ids.slice(0, limit);
      }
    } catch {}
    // Fallback: tokenIds this owner RECEIVED in Transfer events (works for non-enumerable ERC-721).
    try {
      const client = publicClient();
      const transferEvent = {
        name: "Transfer", type: "event", stateMutability: "nonpayable",
        inputs: [
          { name: "from", type: "address", indexed: true },
          { name: "to", type: "address", indexed: true },
          { name: "tokenId", type: "uint256", indexed: true },
        ],
      } as const;
      const latest = await client.getBlockNumber();
      const blocksBack = 200_000n;
      const from = latest > blocksBack ? latest - blocksBack : 0n;
      const logs = await client.getContractEvents({
        address: collection, abi: [transferEvent] as any, eventName: "Transfer",
        args: { to: owner }, fromBlock: from, toBlock: latest,
      } as any).catch(() => []);
      const owned = new Set<string>();
      for (const l of (logs as Array<any>) ?? []) {
        try {
          const tid = BigInt((l?.args as any)?.tokenId ?? -1);
          if (tid >= 0n) owned.add(tid.toString());
        } catch {}
      }
      // Subtract tokens the owner sent away afterwards.
      try {
        const outLogs = await client.getContractEvents({
          address: collection, abi: [transferEvent] as any, eventName: "Transfer",
          args: { from: owner }, fromBlock: from, toBlock: latest,
        } as any).catch(() => []);
        for (const l of (outLogs as Array<any>) ?? []) {
          try { owned.delete(BigInt((l?.args as any)?.tokenId ?? -1).toString()); } catch {}
        }
      } catch {}
      // Confirm current ownership on-chain (cheap, bounded).
      const ids = [...owned].slice(0, limit).map(BigInt);
      const confirmed: bigint[] = await mapLimit(ids, 6, async (tid) => {
        try {
          const o = (await client.readContract({
            address: collection, abi: erc721Abi as any, functionName: "ownerOf", args: [tid],
          } as any).catch(() => null)) as Address | null;
          return o && o.toLowerCase() === owner.toLowerCase() ? tid : null;
        } catch { return null; }
      }).then((rs) => rs.filter((x): x is bigint => x !== null));
      return confirmed;
    } catch { return []; }
  },
  /** Verify one (collection, tokenId, seller) is still a live ask. Returns the live price or null. */
  async verifyListing(collection: Address, tokenId: bigint, seller: Address, opts?: { maxAgeSec?: number }): Promise<bigint | null> {
    try {
      const listing = await this.getListing(collection, tokenId, seller);
      if (!listing || listing.pricePerItem === 0n) return null;
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (listing.expirationTime > 0n && listing.expirationTime < now) return null;
      const client = publicClient();
      const ownerNow = (await client.readContract({
        address: collection,
        abi: erc721Abi as any,
        functionName: "ownerOf", args: [tokenId],
      } as any).catch(() => null)) as Address | null;
      if (!ownerNow || ownerNow.toLowerCase() !== seller.toLowerCase()) return null; // sold or transferred
      return listing.pricePerItem;
    } catch { return null; }
  },
  /**
   * Reconcile ONE tracked DB listing against the chain. Returns what happened
   * (or null if nothing changed). Marks the DB row inactive on sale/cancel.
   * This is the shared primitive behind the sale watcher AND the /nfts screen,
   * so both always agree.
   */
  async reconcileListing(
    listingId: number, userId: number
  ): Promise<{ status: "sold" | "delisted" | "expired" | "live"; buyer?: Address; priceWei?: bigint; txHash?: string } | null> {
    const row = dbService.getListing(listingId, userId);
    if (!row || row.active !== 1) return null;
    try {
      const seller = (dbService.getKey(userId)?.address ?? "") as Address;
      if (!seller || !/^0x[a-fA-F0-9]{40}$/.test(seller)) return null;
      const collection = row.contract as Address;
      const tid = BigInt(row.token_id);
      const live = await this.getListing(collection, tid, seller);
      const client = publicClient();
      const ownerNow = (await client.readContract({
        address: collection, abi: erc721Abi as any, functionName: "ownerOf", args: [tid],
      } as any).catch(() => null)) as Address | null;
      // Still listed by the seller -> nothing to do.
      if (live && live.pricePerItem > 0n && ownerNow && ownerNow.toLowerCase() === seller.toLowerCase()) {
        return { status: "live" };
      }
      // Listing gone. Find out WHY via the marketplace events for this token.
      const addr = kalosAddr()!;
      const latest = await client.getBlockNumber();
      const from = latest > 200_000n ? latest - 200_000n : 0n;
      const [soldLogs, cancelLogs] = await Promise.all([
        client.getContractEvents({ address: addr, abi: kalosAbi as any, eventName: "ItemSold", fromBlock: from, toBlock: latest } as any).catch(() => [] as any[]),
        client.getContractEvents({ address: addr, abi: kalosAbi as any, eventName: "ItemCanceled", fromBlock: from, toBlock: latest } as any).catch(() => [] as any[]),
      ]);
      // Most recent relevant event wins. Sold involving us as seller = sale.
      type Ev = { blockNumber: bigint; transactionHash?: Hex; args: any; kind: "sold" | "canceled" };
      const rel: Ev[] = [];
      for (const l of soldLogs as any[]) {
        try {
          const a = (l as any).args as any;
          if (String(a.nftAddress).toLowerCase() === collection.toLowerCase() && String(BigInt(a.tokenId)) === String(tid) && String(a.seller).toLowerCase() === seller.toLowerCase()) {
            rel.push({ blockNumber: BigInt((l as any).blockNumber ?? 0), transactionHash: (l as any).transactionHash, args: a, kind: "sold" });
          }
        } catch {}
      }
      for (const l of cancelLogs as any[]) {
        try {
          const a = (l as any).args as any;
          if (String(a.nftAddress).toLowerCase() === collection.toLowerCase() && String(BigInt(a.tokenId)) === String(tid) && String(a.seller).toLowerCase() === seller.toLowerCase()) {
            rel.push({ blockNumber: BigInt((l as any).blockNumber ?? 0), transactionHash: (l as any).transactionHash, args: a, kind: "canceled" });
          }
        } catch {}
      }
      rel.sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : a.blockNumber > b.blockNumber ? -1 : 0));
      // Expired (never sold/cancelled, just timed out) — owner usually still holds.
      if (rel.length === 0) {
        if (live && live.expirationTime > 0n && live.expirationTime < BigInt(Math.floor(Date.now() / 1000))) {
          dbService.delist(listingId, userId);
          return { status: "expired" };
        }
        if (ownerNow && ownerNow.toLowerCase() === seller.toLowerCase()) {
          dbService.delist(listingId, userId);
          return { status: "delisted" };
        }
      }
      const top = rel[0];
      if (top && top.kind === "sold") {
        const buyer = top.args.buyer as Address;
        const priceWei = BigInt(top.args.pricePerItem ?? row.price_eth ?? 0);
        dbService.delist(listingId, userId);
        try { dbService.recordTrade(userId, "elysium", row.contract, row.token_id, Number(priceWei) / 1e18, (top.transactionHash ?? "") as string, "sell"); } catch {}
        return { status: "sold", buyer, priceWei, txHash: top.transactionHash };
      }
      dbService.delist(listingId, userId);
      return { status: "delisted" };
    } catch { return null; }
  },
  /** Decode ANY Kalos custom error from a reverted call (buy, list, bid, accept…). */
  decodeContractError(err: any): string | null {
    try {
      // Viem often pre-decodes the revert: cause.data = {errorName, abiItem, args} (not hex).
      const pre = err?.cause?.data ?? err?.data;
      if (pre && typeof pre === "object") {
        const name = (pre as any).errorName ?? (pre as any).abiItem?.name;
        if (typeof name === "string" && name) {
          const a = Array.isArray((pre as any).args) ? (pre as any).args : [];
          const args = a.map((x: unknown) => (typeof x === "bigint" ? x.toString() : String(x))).join(", ");
          return `${name}(${args})`;
        }
        return null;
      }
      const data = pre;
      if (!data || data === "0x" || typeof data !== "string") return null;
      const dec = decodeErrorResult({ abi: kalosAbi, data: data as Hex }) as { errorName?: string; args?: unknown[] };
      if (!dec?.errorName) return null;
      const args = (dec.args ?? []).map((a) => (typeof a === "bigint" ? a.toString() : String(a))).join(", ");
      return `${dec.errorName}(${args})`;
    } catch { return null; }
  },
  /** Verify a batch of (tokenId, seller) candidates for one collection (verifyListing single-check above is the per-item version). */
  decodeBuyError(err: any): string | null {
    return this.decodeContractError(err);
  },
  /** Live token bids ON your tokens: who offered what, verified against getTokenBid.
   * Hardened: tolerant getTokenBid decoding (named OR ANY positional slot),
   * ownerOf gate, chunked event scan so one RPC failure can't blank everything.
   * PLUS collection-wide sweep: tokenId-0 (any-token) bids live under
   * getCollectionBid / CollectionBidCreatedOrUpdated and must ALSO surface on
   * every token you hold — otherwise collection offers are invisible. */
  async getIncomingBids(
    tokens: Array<{ collection: Address; tokenId: bigint }>,
    owner: Address,
    opts?: { perToken?: number; blocksBack?: bigint; includeCollectionBids?: boolean }
  ): Promise<Array<{ collection: Address; tokenId: bigint; bidder: Address; price: bigint; expiration: bigint; collectionWide?: boolean }>> {
    const per = opts?.perToken ?? 8;
    const addr = kalosAddr()!;
    const client = publicClient();
    const out: Array<{ collection: Address; tokenId: bigint; bidder: Address; price: bigint; expiration: bigint; collectionWide?: boolean }> = [];
    // 1) PRIMARY: kalos.fun indexer — bids per collection slug, exact match.
    try {
      const bySlug = new Map<string, Array<{ collection: Address; tokenId: bigint }>>();
      try {
        const { cols } = await getIndexDirectory();
        const addrToSlug = new Map(cols.map((c) => [c.address.toLowerCase(), c.slug]));
        for (const t of tokens) {
          const slug = addrToSlug.get(t.collection.toLowerCase());
          if (!slug) continue;
          if (!bySlug.has(slug)) bySlug.set(slug, []);
          bySlug.get(slug)!.push(t);
        }
      } catch { /* indexer down -> RPC */ }
      if (bySlug.size > 0) {
        const now = BigInt(Math.floor(Date.now() / 1000));
        for (const [slug, mine] of bySlug) {
          let idx: { bids: KalosIndexBid[] } | null = null;
          try { idx = await getIndexCollection(slug); } catch { continue; }
          if (!idx || idx.bids.length === 0) continue;
          for (const t of mine) {
            const rel = idx.bids.filter((b) =>
              b.nft.toLowerCase() === t.collection.toLowerCase() &&
              (b.tokenId === t.tokenId || b.tokenId === 0n || b.type === "collection") &&
              (b.expiration === 0n || b.expiration >= now));
            for (const b of rel.slice(0, per)) {
              out.push({
                collection: t.collection, tokenId: t.tokenId, bidder: b.bidder,
                price: b.price, expiration: b.expiration,
                collectionWide: b.tokenId === 0n || b.type === "collection",
              });
            }
          }
        }
        if (out.length > 0) {
          return out.sort((a, b) => (a.price < b.price ? 1 : a.price > b.price ? -1 : 0));
        }
      }
    } catch { /* fall through to RPC */ }
    // 2) RPC fallback: event scan + getTokenBid verify.
    const latest = await client.getBlockNumber().catch(() => 0n);
    if (latest === 0n) return [];
    // Chunk the bid-event scan so a single range-limit error can't wipe out
    // all bid visibility. Depth: bids live 1-30 days; Elysium's ~0.2s blocks
    // mean even 600k blocks is only ~1.5 days — scan deep, tolerate gaps.
    const spans: Array<{ from: bigint; to: bigint }> = [];
    {
      let e = latest;
      const depth = opts?.blocksBack ?? 600_000n;
      const floor = latest > depth ? latest - depth : 0n;
      while (e > floor && spans.length < 8) {
        const s = e > 100_000n ? e - 100_000n : 0n;
        spans.push({ from: s > floor ? s : floor, to: e });
        if (s <= floor) break;
        e = s - 1n;
      }
    }
    // Token bids AND collection bids: specific-token offers live under
    // TokenBidCreatedOrUpdated (any-token offers use tokenId 0 there too),
    // while collection-wide offers live under CollectionBidCreatedOrUpdated
    // and verify via getCollectionBid. Scan both — never one wrong name = none.
    const eventNames = ["TokenBidCreatedOrUpdated", "TokenBidCreatedOrUpdate", "CollectionBidCreatedOrUpdated", "CollectionBidCreatedOrUpdate"] as const;
    let bidLogs: any[] = [];
    for (const sp of spans) {
      for (const evName of eventNames) {
        try {
          const part = (await client.getContractEvents({
            address: addr, abi: kalosAbi as any, eventName: evName,
            fromBlock: sp.from, toBlock: sp.to,
          } as any).catch(() => [])) as any[];
          bidLogs = bidLogs.concat(part ?? []);
          if (bidLogs.length >= 500) break; // enough signal
        } catch { /* next chunk / spelling */ }
      }
      if (bidLogs.length >= 500) break;
    }
    if (bidLogs.length === 0) return [];
    // bidder+token -> newest event wins. Collection-wide bids (any-token,
    // tokenId 0) are kept alongside specific bids — they verify via
    // getCollectionBid and surface ON the token card with an "any token" tag.
    const seen = new Map<string, { collection: Address; tokenId: bigint; bidder: Address; price: bigint; expiration: bigint; bn: bigint; collWide: boolean }>();
    for (const l of bidLogs) {
      try {
        const evName = String((l as any).eventName ?? "");
        const a = (l as any).args as any;
        const col = String(a.nftAddress).toLowerCase();
        const tid = BigInt(a.tokenId ?? 0);
        const isColl = evName.toLowerCase().startsWith("collectionbid");
        const key = `${col}:${isColl ? "COLL" : tid.toString()}:${String(a.bidder).toLowerCase()}`;
        const bn = BigInt((l as any).blockNumber ?? 0);
        const price = BigInt(a.pricePerItem ?? 0);
        const exp = BigInt(a.expirationTime ?? 0);
        if (price <= 0n) continue;
        const prev = seen.get(key);
        if (!prev || bn > prev.bn) {
          seen.set(key, { collection: a.nftAddress as Address, tokenId: tid, bidder: a.bidder as Address, price, expiration: exp, bn, collWide: isColl });
        }
      } catch {}
    }
    const wanted = new Set(tokens.map((t) => `${t.collection.toLowerCase()}:${t.tokenId.toString()}`));
    const wantedColls = new Set(tokens.map((t) => t.collection.toLowerCase()));
    const includeColl = opts?.includeCollectionBids !== false;
    const cands = [...seen.values()]
      .filter((c) => wanted.has(`${String(c.collection).toLowerCase()}:${c.tokenId.toString()}`)
        || (includeColl && c.collWide && wantedColls.has(String(c.collection).toLowerCase())))
      .sort((a, b) => (a.price < b.price ? 1 : a.price > b.price ? -1 : 0))
      .slice(0, Math.max(8, per * Math.max(1, tokens.length)));
    // Fallback: events are best-effort on this RPC. If the scan found nothing
    // but the user owns the tokens, probe getTokenBid directly against recent
    // bidders seen on ANY of their tokens (covers bids older than scan depth).
    // (Direct per-bidder probing without event signal would be unbounded, so
    // we only reach here when the event path came up empty.)
    const pickBig = (...vals: any[]): bigint => {
      for (const v of vals) {
        try { const b = BigInt(v ?? -1); if (b > 0n) return b; } catch {}
      }
      return 0n;
    };
    const verified = await mapLimit(cands, 6, async (c) => {
      try {
        const now = BigInt(Math.floor(Date.now() / 1000));
        if (c.expiration > 0n && c.expiration < now) return null;
        // Collection-wide / any-token (tokenId 0) bids verify via
        // getCollectionBid (or getTokenBid with id 0) then fan out to EACH
        // owned token in that collection — otherwise the card filter
        // (collection+tokenId exact match) can never see them.
        if (c.collWide || c.tokenId === 0n) {
          let livePrice = 0n;
          let liveExp = 0n;
          try {
            const liveColl: any = await client.readContract({
              address: addr, abi: kalosAbi as any, functionName: "getCollectionBid",
              args: [c.collection, c.bidder],
            } as any).catch(() => null);
            if (liveColl) {
              livePrice = pickBig(liveColl?.[1], liveColl?.pricePerItem);
              liveExp = pickBig(liveColl?.[2], liveColl?.expirationTime);
            }
          } catch {}
          // Any-token TOKEN bids (createOrUpdateTokenBids with id 0) live
          // under getTokenBid(collection, 0, bidder) — same fan-out.
          if (livePrice <= 0n) {
            try {
              const liveAny: any = await client.readContract({
                address: addr, abi: kalosAbi as any, functionName: "getTokenBid",
                args: [c.collection, 0n, c.bidder],
              } as any).catch(() => null);
              if (liveAny) {
                livePrice = pickBig(liveAny?.[1], liveAny?.pricePerItem);
                liveExp = pickBig(liveAny?.[2], liveAny?.expirationTime);
              }
            } catch {}
          }
          if (livePrice <= 0n) return null;
          const mine = tokens.filter((t) => t.collection.toLowerCase() === String(c.collection).toLowerCase());
          const fanned: Array<{ collection: Address; tokenId: bigint; bidder: Address; price: bigint; expiration: bigint; collectionWide?: boolean }> = [];
          for (const t of mine) {
            try {
              if (liveExp > 0n && liveExp < now) continue;
              const ownerNow = (await client.readContract({
                address: c.collection, abi: erc721Abi as any, functionName: "ownerOf", args: [t.tokenId],
              } as any).catch(() => null)) as Address | null;
              if (!ownerNow || ownerNow.toLowerCase() !== owner.toLowerCase()) continue;
              fanned.push({ collection: c.collection, tokenId: t.tokenId, bidder: c.bidder, price: livePrice, expiration: liveExp > 0n ? liveExp : c.expiration, collectionWide: true });
            } catch {}
          }
          return fanned.length > 0 ? fanned : null;
        }
        const live: any = await client.readContract({
          address: addr, abi: kalosAbi as any, functionName: "getTokenBid",
          args: [c.collection, c.tokenId, c.bidder],
        } as any).catch(() => null);
        if (!live) return null;
        // getTokenBid returns (quantity, pricePerItem, expirationTime, paymentTokenAddress)
        // per the ABI — positional [1]/[2] first, named as backup.
        const livePrice = pickBig(live?.[1], live?.pricePerItem, live?.[4], live?.price, live?.amount);
        if (livePrice <= 0n) return null;
        const liveExp = pickBig(live?.[2], live?.expirationTime, live?.[5], live?.expiration, live?.expiry);
        const ownerNow = (await client.readContract({
          address: c.collection, abi: erc721Abi as any, functionName: "ownerOf", args: [c.tokenId],
        } as any).catch(() => null)) as Address | null;
        if (!ownerNow || ownerNow.toLowerCase() !== owner.toLowerCase()) return null;
        return { collection: c.collection, tokenId: c.tokenId, bidder: c.bidder, price: livePrice, expiration: liveExp > 0n ? liveExp : c.expiration };
      } catch { return null; }
    });
    for (const v of verified) {
      if (!v) continue;
      if (Array.isArray(v)) { for (const e of v) out.push(e); }
      else out.push(v as any);
    }
    return out.sort((a, b) => (a.price < b.price ? 1 : a.price > b.price ? -1 : 0));
  },
  /**
   * Dry-run a buy against the CURRENT chain state without spending gas.
   * Returns { ok: true } or { ok: false, reason } with a human explanation.
   */
  async dryRunBuy(
    collection: Address, tokenId: bigint, seller: Address, buyer: Address, qty: bigint = 1n
  ): Promise<{ ok: boolean; reason?: string; price?: bigint; item?: { nftAddress: Address; tokenId: bigint; owner: Address; quantity: bigint; maxPricePerItem: bigint; paymentToken: Address; usingNative: boolean } }> {
    const listing = await this.getListing(collection, tokenId, seller);
    if (!listing || listing.pricePerItem === 0n) {
      return { ok: false, reason: `No live listing: getListing(${collection.slice(0, 10)}…, #${tokenId}, seller ${seller.slice(0, 10)}…) returned price 0 — sold, delisted, or seller changed.` };
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (listing.expirationTime > 0n && listing.expirationTime < now) {
      return { ok: false, reason: `Listing expired at ${new Date(Number(listing.expirationTime) * 1000).toISOString()} (now ${new Date(Number(now) * 1000).toISOString()}).` };
    }
    const client = publicClient();
    const ownerNow = (await client.readContract({
      address: collection, abi: erc721Abi as any, functionName: "ownerOf", args: [tokenId],
    } as any).catch(() => null)) as Address | null;
    if (!ownerNow) return { ok: false, reason: `ownerOf(#${tokenId}) reverted — token may be burned or the collection is not ERC-721.` };
    if (ownerNow.toLowerCase() !== seller.toLowerCase()) {
      return { ok: false, reason: `Seller changed: listed by ${seller} but now owned by ${ownerNow}. Any buy from the old seller reverts with NotOwningItem()/NotListed().` };
    }
    const item = await this.buildBuyItem(collection, tokenId, seller, qty, listing);
    const price = listing.pricePerItem * qty;
    try {
      await client.simulateContract({
        address: kalosAddr()!, abi: kalosAbi as any, functionName: "buyItems",
        args: [[item]], value: price, account: buyer,
      } as any);
      return { ok: true, price, item };
    } catch (e: any) {
      const decoded = this.decodeBuyError(e);
      const cause = (e?.cause?.shortMessage || e?.shortMessage || e?.message || "unknown").slice(0, 200);
      return { ok: false, reason: `simulateContract reverted${decoded ? ` with ${decoded}` : ""}: ${cause}`, price, item };
    }
  },
  /**
   * Verify a batch of (tokenId, seller) candidates for one collection.
   * Two phases to save RPC calls: getListing for all in parallel first (dead
   * listings return price 0 and are dropped), then ownerOf only for survivors.
   * Concurrency is bounded (RPC_CONCURRENCY) to avoid testnet rate limits.
   * Returns verified live listings sorted cheapest-first.
   */
  async verifyCandidateListings(
    collection: Address,
    candidates: Array<{ tokenId: bigint; seller: Address; price?: bigint; blockNumber?: bigint }>,
    opts?: { maxPrice?: bigint; limit?: number; concurrency?: number; checkSold?: boolean }
  ): Promise<Array<{ tokenId: bigint; seller: Address; price: bigint; expiration: bigint }>> {
    const maxPrice = opts?.maxPrice;
    const limit = opts?.limit ?? 60;
    const conc = opts?.concurrency ?? 6;
    const phase1 = await mapLimit(candidates.slice(0, limit), conc, async (c) => {
      try {
        if (c.tokenId <= 0n) return null;
        const listing = await this.getListing(collection, c.tokenId, c.seller);
        if (!listing || listing.pricePerItem === 0n) return null;
        if (maxPrice !== undefined && listing.pricePerItem > maxPrice) return null;
        const now = BigInt(Math.floor(Date.now() / 1000));
        if (listing.expirationTime > 0n && listing.expirationTime < now) return null;
        return { tokenId: c.tokenId, seller: c.seller, price: listing.pricePerItem, expiration: listing.expirationTime };
      } catch { return null; }
    });
    const survivors = phase1.filter((x): x is NonNullable<typeof x> => !!x);
    if (survivors.length === 0) return [];
    const client = publicClient();
    // Optional sold-ghost filter: if an ItemSold for (tokenId, seller) exists
    // at/after the listing's block, the listing is dead even when getListing
    // still returns a stale struct. Fetched ONCE per call, not per candidate.
    let soldKeys = new Set<string>();
    if (opts?.checkSold) {
      try {
        const cur = await client.getBlockNumber().catch(() => 0n);
        const from = cur > 200_000n ? cur - 200_000n : 0n;
        const sold = (await client.getContractEvents({
          address: kalosAddr()!, abi: kalosAbi as any, eventName: "ItemSold",
          fromBlock: from, toBlock: cur,
        } as any).catch(() => [])) as any[];
        for (const l of sold ?? []) {
          try {
            const a = (l as any).args as any;
            if (String(a.nftAddress).toLowerCase() === collection.toLowerCase()) {
              soldKeys.add(`${BigInt(a.tokenId).toString()}:${String(a.seller).toLowerCase()}`);
            }
          } catch {}
        }
      } catch { /* best-effort: no sold filter this pass */ }
    }
    const checked = await mapLimit(survivors, conc, async (s) => {
      try {
        if (soldKeys.has(`${s.tokenId.toString()}:${s.seller.toLowerCase()}`)) return null;
        const ownerNow = (await client.readContract({
          address: collection, abi: erc721Abi as any,
          functionName: "ownerOf", args: [s.tokenId],
        } as any).catch(() => null)) as Address | null;
        if (!ownerNow || ownerNow.toLowerCase() !== s.seller.toLowerCase()) return null;
        return s;
      } catch { return null; }
    });
    return checked
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
  },
  /**
   * Order candidates so verification finds live asks fast: cheapest-first AND
   * most-recent-first interleaved. Stale cheap listings (already sold) cluster
   * at the old end; fresh listings cluster at the recent end. De-dupe by
   * tokenId+seller, keeping the newest event for recency and the min price
   * for ordering info.
   */
  orderCandidates(
    events: ListedEvent[],
    opts?: { maxPrice?: bigint }
  ): Array<{ tokenId: bigint; seller: Address; price: bigint; blockNumber: bigint }> {
    const maxPrice = opts?.maxPrice;
    const byKey = new Map<string, { tokenId: bigint; seller: Address; price: bigint; blockNumber: bigint }>();
    for (const e of events) {
      if (e.tokenId <= 0n || e.pricePerItem <= 0n) continue;
      if (maxPrice !== undefined && e.pricePerItem > maxPrice) continue;
      const key = `${e.tokenId.toString()}:${e.seller.toLowerCase()}`;
      const bn = e.blockNumber ?? 0n;
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, { tokenId: e.tokenId, seller: e.seller, price: e.pricePerItem, blockNumber: bn });
      } else {
        if (e.pricePerItem < prev.price) prev.price = e.pricePerItem;
        if (bn > prev.blockNumber) { prev.blockNumber = bn; prev.seller = e.seller; }
      }
    }
    const all = [...byKey.values()];
    const byPrice = [...all].sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
    const byBlock = [...all].sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : a.blockNumber > b.blockNumber ? -1 : 0));
    const out: typeof all = [];
    const seen = new Set<string>();
    for (let i = 0; i < Math.max(byPrice.length, byBlock.length); i++) {
      for (const c of [byPrice[i], byBlock[i]]) {
        if (!c) continue;
        const key = `${c.tokenId.toString()}:${c.seller.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
      }
    }
    return out;
  },
  /** Receipt-verified floor: cheapest listing that passes BOTH getListing AND
   *  an ItemSold check in the same scan window. Sold-then-relisted ghosts and
   *  stale events that never re-verify are excluded — this is what kills the
   *  phantom "19 HYPE floor / No active listings" flip-flop.
   *  PRIMARY: kalos.fun indexer (exact match). FALLBACK: on-chain RPC scan. */
  async getVerifiedFloor(
    collection: Address,
    opts?: { blocksBack?: number; candidates?: number; events?: ListedEvent[] }
  ): Promise<bigint | null> {
    // 1) Indexer first — same number kalos.fun shows.
    try {
      const slug = await slugForCollection(collection);
      if (slug) {
        const idx = await getIndexCollection(slug);
        if (idx.stats.floor && idx.stats.floor > 0n) return idx.stats.floor;
        if (idx.listings.length > 0) return idx.listings[0].price;
      }
    } catch { /* fall through to RPC */ }
    // 2) RPC fallback (unregistered CAs like Spartan, or indexer down).
    const maxCandidates = opts?.candidates ?? 80;
    const events = opts?.events ?? await this.scanListedEvents({ blocksBack: opts?.blocksBack ?? 200_000 });
    const mine = events.filter((e) => e.nftAddress.toLowerCase() === collection.toLowerCase());
    const sorted = this.orderCandidates(mine);
    const verified = await this.verifyCandidateListings(collection, sorted, { limit: maxCandidates, checkSold: true });
    if (verified.length === 0) return null;
    return verified[0].price;
  },
  /**
   * Floors for MANY collections. PRIMARY: kalos.fun indexer directory
   * (one HTTP call, every collection, exact match). FALLBACK: RPC scan.
   */
  async getCollectionFloors(
    collections: Address[],
    opts?: { blocksBack?: number; perCollection?: number; events?: ListedEvent[]; concurrency?: number }
  ): Promise<Map<string, { floor: bigint | null; liveCount: number; topBid?: bigint | null }>> {
    // 1) Indexer directory — single call covers everything.
    try {
      const { stats } = await getIndexDirectory();
      const out = new Map<string, { floor: bigint | null; liveCount: number; topBid?: bigint | null }>();
      let hits = 0;
      for (const col of collections) {
        const s = stats.get(col.toLowerCase());
        if (s && (s.floor || s.topBid)) hits++;
        out.set(col.toLowerCase(), { floor: s?.floor ?? null, liveCount: s?.floor ? 1 : 0, topBid: s?.topBid ?? null });
      }
      if (hits > 0) return out;
    } catch { /* fall through to RPC */ }
    const events = opts?.events ?? await this.scanListedEvents({ blocksBack: opts?.blocksBack ?? 200_000 });
    const perCollection = opts?.perCollection ?? 80;
    const conc = opts?.concurrency ?? 6;
    const out = new Map<string, { floor: bigint | null; liveCount: number }>();
    for (const col of collections) {
      try {
        const mine = events.filter((e) => e.nftAddress.toLowerCase() === col.toLowerCase());
        if (mine.length === 0) { out.set(col.toLowerCase(), { floor: null, liveCount: 0 }); continue; }
        const cands = this.orderCandidates(mine);
        const verified = await this.verifyCandidateListings(col, cands, { limit: perCollection, concurrency: conc });
        out.set(col.toLowerCase(), {
          floor: verified.length > 0 ? verified[0].price : null,
          liveCount: verified.length,
        });
      } catch { out.set(col.toLowerCase(), { floor: null, liveCount: 0 }); }
    }
    return out;
  },
  /** Sweep N cheapest live listings in one batch buyItems tx. */
  async sweepBuy(
    privateKey: Hex,
    collection: Address,
    count: number,
    opts?: { maxPriceEth?: string; maxScan?: number }
  ): Promise<{ hash: Hash; items: Array<{ tokenId: bigint; seller: Address; price: bigint }>; totalWei: bigint }> {
    const n = Math.max(1, Math.min(10, Math.floor(count)));
    const hits = await this.findCheapestListings(collection, { maxScan: opts?.maxScan ?? 200, maxResults: n, maxPriceEth: opts?.maxPriceEth });
    if (hits.length === 0) throw new Error("No live listings found to sweep");
    const take = hits.slice(0, n);
    const addr = kalosAddr()!;
    const wc = walletClient(privateKey);
    const pc = publicClient();
    // Re-fetch each listing + owner at execution time, build items exactly
    // like kalos.fun (listing's paymentToken, usingNative=(token==wnative)).
    const items = await Promise.all(
      take.map(async (h) => {
        const listing = await this.getListing(collection, h.tokenId, h.seller);
        if (!listing || listing.pricePerItem === 0n) {
          throw new Error(`Token #${h.tokenId} sold before the sweep could execute. Re-scan and try again.`);
        }
        return this.buildBuyItem(collection, h.tokenId, h.seller, 1n, listing);
      })
    );
    const total = items.reduce((s, it) => s + it.maxPricePerItem, 0n);
    const hash = await wc.writeContract({ address: addr, abi: kalosAbi as any, functionName: "buyItems", args: [items], value: total } as any);
    await pc.waitForTransactionReceipt({ hash });
    return { hash, items: take.map((h) => ({ tokenId: h.tokenId, seller: h.seller, price: h.price })), totalWei: total };
  },
  async findCheapestListings(
    collection: Address,
    opts?: { maxScan?: number; maxResults?: number; maxPriceEth?: string; events?: ListedEvent[] }
  ): Promise<Array<{ tokenId: bigint; seller: Address; price: bigint; expiration: bigint }>> {
    const maxScan = opts?.maxScan ?? 500;
    const maxResults = opts?.maxResults ?? 5;
    const maxPrice = opts?.maxPriceEth ? parseEther(opts.maxPriceEth) : undefined;
    const client = publicClient();
    const out: Array<{ tokenId: bigint; seller: Address; price: bigint; expiration: bigint }> = [];
    // 1) PRIMARY: kalos.fun indexer — exact live listings, cheapest-first.
    try {
      const slug = await slugForCollection(collection);
      if (slug) {
        const idx = await getIndexCollection(slug);
        const now = BigInt(Math.floor(Date.now() / 1000));
        for (const l of idx.listings) {
          if (out.length >= maxResults * 2) break;
          if (maxPrice !== undefined && l.price > maxPrice) continue;
          if (l.expiration > 0n && l.expiration < now) continue;
          out.push({ tokenId: l.tokenId, seller: l.seller, price: l.price, expiration: l.expiration });
        }
        if (out.length > 0) return out.slice(0, maxResults);
      }
    } catch { /* fall through to RPC */ }
    // 2) RPC fallback: on-chain event discovery + verify.
    try {
      const events = opts?.events ?? await this.cachedScan({ blocksBack: 200_000 });
      const mine = events.filter((e) => {
        try { return e.nftAddress.toLowerCase() === collection.toLowerCase(); } catch { return false; }
      });
      // Verify: cheapest + most-recent interleaved, getListing first, ownerOf only for survivors
      const cands = this.orderCandidates(mine, { maxPrice });
      const verified = await this.verifyCandidateListings(collection, cands, { maxPrice, limit: 80, checkSold: true });
      for (const v of verified) out.push(v);
      if (out.length > 0) {
        return out.slice(0, maxResults);
      }
    } catch {}
    // 2) Fallback: sequential tokenId scan
    const ownerAbi = [{ name: "ownerOf", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "address" }] }] as const;
    for (let start = 1; start <= maxScan; start += 10) {
      const batch: Array<Promise<void>> = [];
      for (let tid = start; tid < start + 10 && tid <= maxScan; tid++) {
        batch.push((async () => {
          try {
            const owner = (await client.readContract({ address: collection, abi: ownerAbi as any, functionName: "ownerOf", args: [BigInt(tid)] } as any)) as Address;
            const listing = await this.getListing(collection, BigInt(tid), owner);
            if (!listing || listing.pricePerItem === 0n) return;
            if (maxPrice !== undefined && listing.pricePerItem > maxPrice) return;
            const now = BigInt(Math.floor(Date.now() / 1000));
            if (listing.expirationTime > 0n && listing.expirationTime < now) return;
            out.push({ tokenId: BigInt(tid), seller: owner, price: listing.pricePerItem, expiration: listing.expirationTime });
          } catch { /* skip missing tokenIds / unlisted */ }
        })());
      }
      await Promise.all(batch);
      if (out.length >= maxResults * 2) break;
    }
    out.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
    return out.slice(0, maxResults);
  },
  /** Short-lived scan cache so burst UI actions (menu + detail + sweep) share one scan. */
  async cachedScan(opts?: { blocksBack?: number; ttlMs?: number }): Promise<ListedEvent[]> {
    const blocksBack = opts?.blocksBack ?? 50_000;
    const ttlMs = opts?.ttlMs ?? 120_000;
    const now = Date.now();
    if (scanCache && scanCache.blocksBack === blocksBack && now - scanCache.at < ttlMs) return scanCache.events;
    const events = await this.scanListedEvents({ blocksBack });
    scanCache = { at: Date.now(), blocksBack, events };
    return events;
  },
};
