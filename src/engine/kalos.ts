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
  async approveMarketplace(privateKey: Hex, nft: Address): Promise<Hash | null> {
    const addr = kalosAddr()!; const account = privateKeyToAccount(privateKey); const pc = publicClient();
    const ok = await this.isApprovedForAll(nft, account.address); if (ok) return null;
    const wc = walletClient(privateKey); const hash = await wc.writeContract({ address: nft, abi: erc721Abi as any, functionName: "setApprovalForAll", args: [addr, true] } as any);
    await pc.waitForTransactionReceipt({ hash }); return hash;
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
    const hash = await wc.writeContract({ address: addr, abi: kalosAbi as any, functionName: "createOrUpdateListings", args: [[param]] } as any);
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
    const payToken = await this.wnative();
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
    const payToken = await this.wnative();
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
    if (!price) { const client = publicClient(); const bid:any = await client.readContract({ address: addr, abi: kalosAbi as any, functionName: "getTokenBid", args: [nftAddress, tid, bidder] } as any); if (!bid || bid.pricePerItem===0n) throw new Error("Bid not found"); price = bid.pricePerItem; payToken = (bid.paymentToken ?? null) as Address | null; }
    if (!payToken) payToken = await this.wnative();
    await this.approveMarketplace(privateKey, nftAddress);
    const wc = walletClient(privateKey); const pc = publicClient();
    const param = { bidType: 0, nftAddress, tokenId: tid, bidder, quantity: qty, pricePerItem: price, paymentToken: payToken };
    try {
      await pc.simulateContract({
        address: addr, abi: kalosAbi as any, functionName: "acceptBids",
        args: [[param]], account: privateKeyToAccount(privateKey).address,
      } as any);
    } catch (e: any) {
      const decoded = this.decodeContractError(e);
      const cause = (e?.cause?.shortMessage || e?.shortMessage || e?.message || "unknown").slice(0, 220);
      throw new Error(`Accept would revert${decoded ? ` with ${decoded}` : ""}: ${cause}`);
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
  /** Gas-free pre-flight for createOrUpdateTokenBids. */
  async dryRunBid(collection: Address, tokenId: bigint, priceWei: bigint, bidder: Address, qty: bigint = 1n): Promise<{ ok: boolean; reason?: string }> {
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (priceWei <= 0n) return { ok: false, reason: "Offer price must be above 0." };
    const payToken = await this.wnative();
    const param = { nftAddress: collection, tokenId, quantity: qty, pricePerItem: priceWei, expirationTime: now + 7n * 86400n, paymentToken: payToken };
    try {
      await publicClient().simulateContract({
        address: kalosAddr()!, abi: kalosAbi as any, functionName: "createOrUpdateTokenBids",
        args: [[param]], account: bidder,
      } as any);
      return { ok: true };
    } catch (e: any) {
      const decoded = this.decodeContractError(e);
      const cause = (e?.cause?.shortMessage || e?.shortMessage || e?.message || "unknown").slice(0, 220);
      return { ok: false, reason: `Offer would revert${decoded ? ` with ${decoded}` : ""}: ${cause}` };
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
      const data = err?.cause?.data ?? err?.data;
      if (!data || data === "0x") return null;
      const dec = decodeErrorResult({ abi: kalosAbi, data }) as { errorName?: string; args?: unknown[] };
      if (!dec?.errorName) return null;
      const args = (dec.args ?? []).map((a) => (typeof a === "bigint" ? a.toString() : String(a))).join(", ");
      return `${dec.errorName}(${args})`;
    } catch { return null; }
  },
  /** Verify a batch of (tokenId, seller) candidates for one collection (verifyListing single-check above is the per-item version). */
  decodeBuyError(err: any): string | null {
    return this.decodeContractError(err);
  },
  /** Live token bids ON your tokens: who offered what, verified against getTokenBid. */
  async getIncomingBids(
    tokens: Array<{ collection: Address; tokenId: bigint }>,
    owner: Address,
    opts?: { perToken?: number }
  ): Promise<Array<{ collection: Address; tokenId: bigint; bidder: Address; price: bigint; expiration: bigint }>> {
    const per = opts?.perToken ?? 8;
    const addr = kalosAddr()!;
    const client = publicClient();
    const out: Array<{ collection: Address; tokenId: bigint; bidder: Address; price: bigint; expiration: bigint }> = [];
    const latest = await client.getBlockNumber().catch(() => 0n);
    const from = latest > 200_000n ? latest - 200_000n : 0n;
    let bidLogs: any[] = [];
    try {
      bidLogs = (await client.getContractEvents({
        address: addr, abi: kalosAbi as any, eventName: "TokenBidCreatedOrUpdated",
        fromBlock: from, toBlock: latest,
      } as any).catch(() => [])) as any[];
    } catch { return []; }
    // bidder+token -> newest event wins
    const seen = new Map<string, { collection: Address; tokenId: bigint; bidder: Address; price: bigint; expiration: bigint; bn: bigint }>();
    for (const l of bidLogs) {
      try {
        const a = (l as any).args as any;
        const col = String(a.nftAddress).toLowerCase();
        const tid = BigInt(a.tokenId);
        const key = `${col}:${tid.toString()}:${String(a.bidder).toLowerCase()}`;
        const bn = BigInt((l as any).blockNumber ?? 0);
        const price = BigInt(a.pricePerItem ?? 0);
        const exp = BigInt(a.expirationTime ?? 0);
        if (price <= 0n) continue;
        const prev = seen.get(key);
        if (!prev || bn > prev.bn) {
          seen.set(key, { collection: a.nftAddress as Address, tokenId: tid, bidder: a.bidder as Address, price, expiration: exp, bn });
        }
      } catch {}
    }
    const wanted = new Set(tokens.map((t) => `${t.collection.toLowerCase()}:${t.tokenId.toString()}`));
    const cands = [...seen.values()]
      .filter((c) => wanted.has(`${String(c.collection).toLowerCase()}:${c.tokenId.toString()}`))
      .sort((a, b) => (a.price < b.price ? 1 : a.price > b.price ? -1 : 0))
      .slice(0, Math.max(8, per * Math.max(1, tokens.length)));
    const verified = await mapLimit(cands, 6, async (c) => {
      try {
        const now = BigInt(Math.floor(Date.now() / 1000));
        if (c.expiration > 0n && c.expiration < now) return null;
        const live: any = await client.readContract({
          address: addr, abi: kalosAbi as any, functionName: "getTokenBid",
          args: [c.collection, c.tokenId, c.bidder],
        } as any).catch(() => null);
        const livePrice = BigInt(live?.pricePerItem ?? live?.[1] ?? 0);
        if (livePrice <= 0n) return null;
        const ownerNow = (await client.readContract({
          address: c.collection, abi: erc721Abi as any, functionName: "ownerOf", args: [c.tokenId],
        } as any).catch(() => null)) as Address | null;
        if (!ownerNow || ownerNow.toLowerCase() !== owner.toLowerCase()) return null;
        return { collection: c.collection, tokenId: c.tokenId, bidder: c.bidder, price: livePrice, expiration: BigInt(live?.expirationTime ?? live?.[2] ?? c.expiration) };
      } catch { return null; }
    });
    for (const v of verified) if (v) out.push(v);
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
