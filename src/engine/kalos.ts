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
  /** Discover every collection with ItemListed events in recent blocks (no hardcoding). */
  async discoverCollections(opts?: { blocksBack?: number; chunkSize?: number }): Promise<Address[]> {
    const addr = kalosAddr();
    if (!addr) return [];
    const client = publicClient();
    try {
      const latest = await client.getBlockNumber();
      const blocksBack = BigInt(opts?.blocksBack ?? 500_000);
      const chunk = BigInt(opts?.chunkSize ?? 50_000);
      const from = latest > blocksBack ? latest - blocksBack : 0n;
      const ranges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
      for (let s = from; s <= latest; s += chunk + 1n) {
        const e = s + chunk > latest ? latest : s + chunk;
        ranges.push({ fromBlock: s, toBlock: e });
      }
      const seen = new Set<string>();
      await Promise.all(
        ranges.map(async (r) => {
          try {
            const logs = (await client.getLogs({ address: addr, abi: kalosAbi as any, eventName: "ItemListed", fromBlock: r.fromBlock, toBlock: r.toBlock } as any)) as Array<any>;
            for (const l of logs) {
              const nft = (l?.args?.nftAddress ?? l?.args?.nftaddress) as string | undefined;
              if (nft && /^0x[a-fA-F0-9]{40}$/.test(nft)) seen.add(nft.toLowerCase());
            }
          } catch { /* skip failed chunks */ }
        })
      );
      return [...seen] as Address[];
    } catch {
      return [];
    }
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
    const items = take.map((h) => ({
      nftAddress: collection,
      tokenId: h.tokenId,
      owner: h.seller,
      quantity: 1n,
      maxPricePerItem: h.price,
      paymentToken: NATIVE,
      usingNative: true,
    }));
    const total = take.reduce((s, h) => s + h.price, 0n);
    const hash = await wc.writeContract({ address: addr, abi: kalosAbi as any, functionName: "buyItems", args: [items], value: total } as any);
    await pc.waitForTransactionReceipt({ hash });
    return { hash, items: take.map((h) => ({ tokenId: h.tokenId, seller: h.seller, price: h.price })), totalWei: total };
  },
  async findCheapestListings(collection: Address, opts?: { maxScan?: number; maxResults?: number; maxPriceEth?: string }): Promise<Array<{ tokenId: bigint; seller: Address; price: bigint; expiration: bigint }>> {
    const maxScan = opts?.maxScan ?? 500;
    const maxResults = opts?.maxResults ?? 5;
    const maxPrice = opts?.maxPriceEth ? parseEther(opts.maxPriceEth) : undefined;
    const client = publicClient();
    const out: Array<{ tokenId: bigint; seller: Address; price: bigint; expiration: bigint }> = [];
    // 1) Prefer on-chain event discovery: exact tokenIds with listings
    try {
      const addr = kalosAddr();
      if (addr) {
        const latest = await client.getBlockNumber();
        const back = 500_000n;
        const from = latest > back ? latest - back : 0n;
        const logs = (await client.getLogs({ address: addr, abi: kalosAbi as any, eventName: "ItemListed", fromBlock: from, toBlock: latest } as any)) as Array<any>;
        const seen = new Map<string, { seller: Address; price: bigint; expiration: bigint }>();
        for (const l of logs) {
          try {
            const nft = (l?.args?.nftAddress ?? "") as string;
            if (nft.toLowerCase() !== collection.toLowerCase()) continue;
            const tid = BigInt(l?.args?.tokenId ?? 0);
            const price = BigInt(l?.args?.pricePerItem ?? 0);
            if (tid <= 0n || price <= 0n) continue;
            if (maxPrice !== undefined && price > maxPrice) continue;
            const seller = (l?.args?.seller ?? "") as Address;
            const exp = BigInt(l?.args?.expirationTime ?? 0);
            const key = `${tid.toString()}:${seller.toLowerCase()}`;
            const prev = seen.get(key);
            if (!prev || price < prev.price) seen.set(key, { seller, price, expiration: exp });
          } catch {}
        }
        // Verify each is still listed + owned by seller
        const ownerAbi = [{ name: "ownerOf", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "address" }] }] as const;
        const entries = [...seen.entries()].slice(0, 40);
        await Promise.all(
          entries.map(async ([key, v]) => {
            try {
              const tid = BigInt(key.split(":")[0]);
              const [ownerNow, listing] = await Promise.all([
                client.readContract({ address: collection, abi: ownerAbi as any, functionName: "ownerOf", args: [tid] } as any) as Promise<Address>,
                this.getListing(collection, tid, v.seller),
              ]);
              if (!listing || listing.pricePerItem === 0n) return;
              if (ownerNow.toLowerCase() !== v.seller.toLowerCase()) return;
              const now = BigInt(Math.floor(Date.now() / 1000));
              if (listing.expirationTime > 0n && listing.expirationTime < now) return;
              out.push({ tokenId: tid, seller: v.seller, price: listing.pricePerItem, expiration: listing.expirationTime });
            } catch {}
          })
        );
        if (out.length > 0) {
          out.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
          return out.slice(0, maxResults);
        }
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
};
