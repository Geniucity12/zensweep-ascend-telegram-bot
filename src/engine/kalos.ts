import { createPublicClient, createWalletClient, http, parseEther, formatEther, type Address, type Hex, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getChainConfig, KALOS_MARKETPLACE_ADDRESS, ELYSIUM } from "../config";
import kalosAbi from "../abi/kalosMarketplace.json";
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const NATIVE = ZERO;
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
export const kalosService = {
  address(): Address | null { return kalosAddr(); },
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
    const value = price;
    const wc = walletClient(privateKey); const pc = publicClient();
    const hash = await wc.writeContract({ address: addr, abi: kalosAbi as any, functionName: "buyItems", args: [[{ nftAddress, tokenId: tid, owner, quantity: qty, maxPricePerItem: value, paymentToken: NATIVE, usingNative: true }]], value } as any);
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
  async findCheapestListings(collection: Address, opts?: { maxScan?: number; maxResults?: number; maxPriceEth?: string }): Promise<Array<{ tokenId: bigint; seller: Address; price: bigint; expiration: bigint }>> {
    const maxScan = opts?.maxScan ?? 60;
    const maxResults = opts?.maxResults ?? 5;
    const maxPrice = opts?.maxPriceEth ? parseEther(opts.maxPriceEth) : undefined;
    const client = publicClient();
    const out: Array<{ tokenId: bigint; seller: Address; price: bigint; expiration: bigint }> = [];
    // Bound concurrency: 10 at a time
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
};
