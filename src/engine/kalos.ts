import { createPublicClient, createWalletClient, http, parseEther, formatEther, decodeErrorResult, type Address, type Hex, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getChainConfig, KALOS_MARKETPLACE_ADDRESS, ELYSIUM } from "../config";
import kalosAbi from "../abi/kalosMarketplace.json";
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const NATIVE = ZERO;
/** WHYPE on Elysium testnet (verified on-chain: wnative() + paymentToken()). */
const WHYPE_FALLBACK = "0x41051f27c609dB70af05b7128f15155Dc8E49Ac7" as Address;
/** Module-level wnative cache (verified live: equals WHYPE_FALLBACK). */
let cachedWnative: Address | null = null;
function kalosAddr(): Address | null { const a = (KALOS_MARKETPLACE_ADDRESS || "0x0ff8b7afc288ac42f82320f54a49c400f233bf07").trim(); if (!a || !/^0x[a-fA-F0-9]{40}$/.test(a)) return null; return a as Address; }
export function isKalosConfigured(): boolean { return !!kalosAddr(); }
function publicClient() { const cfg = getChainConfig(ELYSIUM.key); return createPublicClient({ chain: cfg.viemChain, transport: http(cfg.rpcUrl) }); }
function walletClient(pk: Hex) { const cfg = getChainConfig(ELYSIUM.key); const account = privateKeyToAccount(pk); return createWalletClient({ account, chain: cfg.viemChain, transport: http(cfg.rpcUrl) }); }
const erc721Abi = [
  { name: "ownerOf", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "address" }] },
  { name: "isApprovedForAll", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "operator", type: "address" }], outputs: [{ type: "bool" }] },
  { name: "setApprovalForAll", type: "function", stateMutability: "nonpayable", inputs: [{ name: "operator", type: "address" }, { name: "approved", type: "bool" }], outputs: [] },
] as const;
export interface KalosListing { quantity: bigint; pricePerItem: bigint; expirationTime: bigint; paymentTokenAddress: Address; }
/** A decoded Kalos ItemListed event. */
export interface ListedEvent { seller: Address; nftAddress: Address; tokenId: bigint; quantity: bigint; pricePerItem: bigint; expirationTime: bigint; paymentToken: Address; blockNumber?: bigint; }
/** Module-level scan cache (shared across all kalosService calls in this process). */
let scanCache: { at: number; blocksBack: number; events: ListedEvent[] } | null = null;
/**
 * Bounded-parallel map. The public testnet RPC rate-limits aggressively, so
 * verification batches must NOT fire hundreds of concurrent eth_calls.
 */
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
      cachedWnative = (await client.readContract({ address: addr, abi: kalosAbi as any, functionName: "wnative" } as any)) as Address;
    } catch { cachedWnative = WHYPE_FALLBACK; }
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
  async ensureApprovedForAll(privateKey: Hex, nft: Address): Promise<Hash | null> {
    const addr = kalosAddr()!; const account = privateKeyToAccount(privateKey); const pc = publicClient();
    const ok = await this.isApprovedForAll(nft, account.address); if (ok) return null;
    const wc = walletClient(privateKey); const hash = await wc.writeContract({ address: nft, abi: erc721Abi as any, functionName: "setApprovalForAll", args: [addr, true] } as any);
    await pc.waitForTransactionReceipt({ hash }); return hash;
  },
  async createListing(privateKey: Hex, nftAddress: Address, tokenId: string | bigint, pricePerItemEth: string, opts?: { quantity?: number; days?: number }): Promise<Hash> {
    const addr = kalosAddr(); if (!addr) throw new Error("Kalos not configured");
    const tid = BigInt(tokenId); const qty = BigInt(opts?.quantity ?? 1); const price = parseEther(pricePerItemEth); if (price <= 0n) throw new Error("Price must be > 0");
    const exp = BigInt(Math.floor(Date.now()/1000) + (opts?.days ?? 7)*86400);
    await this.ensureApprovedForAll(privateKey, nftAddress);
    const wc = walletClient(privateKey); const pc = publicClient();
    const hash = await wc.writeContract({ address: addr, abi: kalosAbi as any, functionName: "createOrUpdateListings", args: [[{ nftAddress, tokenId: tid, quantity: qty, pricePerItem: price, expirationTime: exp, paymentToken: NATIVE }]] } as any);
    await pc.waitForTransactionReceipt({ hash }); return hash;
  },
  async cancelListing(privateKey: Hex, nftAddress: Address, tokenId: string | bigint): Promise<Hash> {
    const addr = kalosAddr()!; const wc = walletClient(privateKey); const pc = publicClient();
    const hash = await wc.writeContract({ address: addr, abi: kalosAbi as any, functionName: "cancelListings", args: [[{ nftAddress, tokenId: BigInt(tokenId) }]] } as any);
    await pc.waitForTransactionReceipt({ hash }); return hash;
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

  async createTokenBid(privateKey: Hex, nftAddress: Address, tokenId: string | bigint, pricePerItemEth: string, opts?: { quantity?: number; days?: number }): Promise<Hash> {
    const addr = kalosAddr()!; const tid = BigInt(tokenId); const qty = BigInt(opts?.quantity ?? 1); const price = parseEther(pricePerItemEth); const exp = BigInt(Math.floor(Date.now()/1000) + (opts?.days ?? 7)*86400);
    const wc = walletClient(privateKey); const pc = publicClient();
    const hash = await wc.writeContract({ address: addr, abi: kalosAbi as any, functionName: "createOrUpdateTokenBids", args: [[{ nftAddress, tokenId: tid, quantity: qty, pricePerItem: price, expirationTime: exp, paymentToken: NATIVE }]] } as any);
    await pc.waitForTransactionReceipt({ hash }); return hash;
  },
  async createCollectionBid(privateKey: Hex, nftAddress: Address, pricePerItemEth: string, opts?: { quantity?: number; days?: number }): Promise<Hash> {
    const addr = kalosAddr()!; const qty = BigInt(opts?.quantity ?? 1); const price = parseEther(pricePerItemEth); const exp = BigInt(Math.floor(Date.now()/1000) + (opts?.days ?? 7)*86400);
    const wc = walletClient(privateKey); const pc = publicClient();
    const hash = await wc.writeContract({ address: addr, abi: kalosAbi as any, functionName: "createOrUpdateCollectionBid", args: [nftAddress, qty, price, exp, NATIVE] } as any);
    await pc.waitForTransactionReceipt({ hash }); return hash;
  },
  async acceptBid(privateKey: Hex, nftAddress: Address, tokenId: string | bigint, bidder: Address, opts?: { quantity?: number; priceEth?: string }): Promise<Hash> {
    const addr = kalosAddr()!; const tid = BigInt(tokenId); const qty = BigInt(opts?.quantity ?? 1);
    let price = opts?.priceEth ? parseEther(opts.priceEth) : 0n;
    if (!price) { const client = publicClient(); const bid:any = await client.readContract({ address: addr, abi: kalosAbi as any, functionName: "getTokenBid", args: [nftAddress, tid, bidder] } as any); if (!bid || bid.pricePerItem===0n) throw new Error("Bid not found"); price = bid.pricePerItem; }
    await this.ensureApprovedForAll(privateKey, nftAddress);
    const wc = walletClient(privateKey); const pc = publicClient();
    const hash = await wc.writeContract({ address: addr, abi: kalosAbi as any, functionName: "acceptBids", args: [[{ bidType: 0, nftAddress, tokenId: tid, bidder, quantity: qty, pricePerItem: price, paymentToken: NATIVE }]] } as any);
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
  /** Decode the contract's custom error from a reverted buy simulation. Returns e.g. "NotListed()" or null. */
  decodeBuyError(err: any): string | null {
    try {
      const data = err?.cause?.data ?? err?.data;
      if (!data || data === "0x") return null;
      const dec = decodeErrorResult({ abi: kalosAbi, data }) as { errorName?: string; args?: unknown[] };
      if (!dec?.errorName) return null;
      const args = (dec.args ?? []).map((a) => (typeof a === "bigint" ? a.toString() : String(a))).join(", ");
      return `${dec.errorName}(${args})`;
    } catch { return null; }
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
    opts?: { maxPrice?: bigint; limit?: number; concurrency?: number }
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
    const checked = await mapLimit(survivors, conc, async (s) => {
      try {
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
  /**
   * Cheapest VERIFIED live ask for a collection. Scans recent ItemListed events,
   * verifies candidates (getListing + ownerOf + expiry), returns the minimum.
   * Replaces getMinPriceForCollection, which returns 0 on-chain for all collections.
   * Pass pre-scanned events to share one scan across many collections.
   */
  async getVerifiedFloor(
    collection: Address,
    opts?: { blocksBack?: number; candidates?: number; events?: ListedEvent[] }
  ): Promise<bigint | null> {
    const maxCandidates = opts?.candidates ?? 80;
    const events = opts?.events ?? await this.scanListedEvents({ blocksBack: opts?.blocksBack ?? 50_000 });
    const mine = events.filter((e) => e.nftAddress.toLowerCase() === collection.toLowerCase());
    const sorted = this.orderCandidates(mine);
    const verified = await this.verifyCandidateListings(collection, sorted, { limit: maxCandidates });
    if (verified.length === 0) return null;
    return verified[0].price;
  },
  /**
   * Verified live-listing counts + floors for MANY collections from ONE scan.
   * This is what /collections uses — one RPC scan, then batched verification.
   * Collections are verified SEQUENTIALLY (bounded inner concurrency) so the
   * public testnet RPC is never hammered into rate-limit errors.
   */
  async getCollectionFloors(
    collections: Address[],
    opts?: { blocksBack?: number; perCollection?: number; events?: ListedEvent[]; concurrency?: number }
  ): Promise<Map<string, { floor: bigint | null; liveCount: number }>> {
    const events = opts?.events ?? await this.scanListedEvents({ blocksBack: opts?.blocksBack ?? 50_000 });
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
    // 1) On-chain event discovery: exact tokenIds with listings (properly decoded)
    try {
      const events = opts?.events ?? await this.cachedScan({ blocksBack: 50_000 });
      const mine = events.filter((e) => {
        try { return e.nftAddress.toLowerCase() === collection.toLowerCase(); } catch { return false; }
      });
      // Verify: cheapest + most-recent interleaved, getListing first, ownerOf only for survivors
      const cands = this.orderCandidates(mine, { maxPrice });
      const verified = await this.verifyCandidateListings(collection, cands, { maxPrice, limit: 80 });
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
    const ttlMs = opts?.ttlMs ?? 45_000;
    const now = Date.now();
    if (scanCache && scanCache.blocksBack === blocksBack && now - scanCache.at < ttlMs) return scanCache.events;
    const events = await this.scanListedEvents({ blocksBack });
    scanCache = { at: Date.now(), blocksBack, events };
    return events;
  },
};
