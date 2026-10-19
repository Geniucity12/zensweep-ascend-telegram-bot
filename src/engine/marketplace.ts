import { createPublicClient, http, type Address, type Hex, formatEther } from "viem";
import { SUPPORTED_CHAINS, getChainConfig, KALOS_MARKETPLACE_ADDRESS, ELYSIUM } from "../config";
import { openseaGet, openseaSlugForChain } from "./opensea";
import { kalosService } from "./kalos";

/**
 * Marketplace service: chain auto-detection, collection stats, and NFT inventory.
 *
 * Chain detection works by checking for deployed bytecode at the address across
 * every supported RPC (Elysium first). Floor prices and OpenSea slugs are read
 * from the OpenSea API when a key is configured; otherwise those fields are
 * simply omitted and the UI degrades gracefully.
 */

export interface CollectionStats {
  name: string;
  symbol?: string;
  chain: string;
  chainKey: string;
  contract: string;
  floorPrice?: number;
  floorCurrency?: string;
  explorerUrl: string;
  openSeaUrl?: string;
  openSeaSlug?: string;
}

export interface UserNft {
  title: string;
  contract: string;
  tokenId: string;
}

const erc721Abi = [
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

async function hasCode(contract: Address, chainKey: string): Promise<boolean> {
  const cfg = getChainConfig(chainKey);
  try {
    const client = createPublicClient({ chain: cfg.viemChain, transport: http(cfg.rpcUrl) });
    const code = await client.getCode({ address: contract });
    return !!code && code !== "0x";
  } catch {
    return false;
  }
}

async function detectChain(contract: Address): Promise<string | undefined> {
  for (const chain of SUPPORTED_CHAINS) {
    if (await hasCode(contract, chain.key)) return chain.key;
  }
  return undefined;
}

export const marketplaceService = {
  async autoDetectAndGetStats(contract: string): Promise<CollectionStats> {
    if (!/^0x[a-fA-F0-9]{40}$/.test(contract)) {
      throw new Error("Invalid EVM contract address.");
    }
    const addr = contract as Address;
    const chainKey = await detectChain(addr);
    if (!chainKey) {
      throw new Error("No deployed contract found at that address on any supported chain.");
    }
    const cfg = getChainConfig(chainKey);

    // Best-effort metadata read.
    let name = `${cfg.name} collection`;
    let symbol: string | undefined;
    try {
      const client = createPublicClient({ chain: cfg.viemChain, transport: http(cfg.rpcUrl) });
      const readName = await client.readContract({
        address: addr,
        abi: erc721Abi,
        functionName: "name",
      }).catch(() => undefined);
      if (typeof readName === "string" && readName.length > 0) name = readName;
      const readSymbol = await client.readContract({
        address: addr,
        abi: erc721Abi,
        functionName: "symbol",
      }).catch(() => undefined);
      if (typeof readSymbol === "string" && readSymbol.length > 0) symbol = readSymbol;
    } catch {
      // ignore; fall back to defaults
    }

    // Enrichment variables
    let floorPrice: number | undefined;
    let floorCurrency: string | undefined;

    // Kalos marketplace enrichment for Elysium
    if (chainKey === ELYSIUM.key) {
      try {
        const minPriceWei = await kalosService.getMinPriceForCollection(addr);
        if (minPriceWei && minPriceWei > 0n) {
          floorPrice = Number(formatEther(minPriceWei));
          floorCurrency = "HYPE";
        }
      } catch {
        // Kalos read failed or no floor set
      }
    }

    // OpenSea enrichment (fallback for cross-chain).
    let openSeaSlug: string | undefined;

    let floorPriceOs: number | undefined;
    let floorCurrencyOs: string | undefined;
    let openSeaUrl: string | undefined;
    const osChain = openseaSlugForChain(chainKey);
    if (osChain) {
      try {
        const col = await openseaGet<{ collection?: { floor_price?: number; name?: string } }>(
          `/chain/${osChain}/contract/${addr}`
        );
        if (col?.collection) {
          openSeaSlug = undefined;
          if (typeof col.collection.floor_price === "number") {
            floorPriceOs = col.collection.floor_price;
            floorCurrencyOs = cfg.symbol;
          }
          if (col.collection.name) name = col.collection.name;
        }
      } catch {
        // OpenSea not configured / rate-limited — degrade gracefully.
      }
    }

    if (openSeaSlug) openSeaUrl = `https://opensea.io/collection/${openSeaSlug}`;

    return {
      name,
      symbol,
      chain: cfg.name,
      chainKey,
      contract: addr,
      floorPrice: floorPrice ?? floorPriceOs,
      floorCurrency: floorCurrency ?? floorCurrencyOs,
      explorerUrl: `${cfg.explorerUrl}/address/${addr}`,
      openSeaUrl,
      openSeaSlug,
    };
  },

  async getNFTsForUser(address: string, chainKey: string): Promise<UserNft[]> {
    if (chainKey === ELYSIUM.key) {
      const results: UserNft[] = [];
      const cfg = getChainConfig(ELYSIUM.key);
      try {
        const client = createPublicClient({ chain: cfg.viemChain, transport: http(cfg.rpcUrl) });
        // Check known / tracked launches and contracts
        const { kiwiLaunches } = await import("../data/launches");
        const candidates = new Set<string>();
        for (const l of kiwiLaunches) {
          if (l.contractAddress && /^0x[a-fA-F0-9]{40}$/.test(l.contractAddress)) {
            candidates.add(l.contractAddress.toLowerCase());
          }
        }
        // Also check any active user listings from local DB
        const { dbService } = await import("../db");
        for (const row of dbService.getUserListings(0)) {
          if (row.contract && /^0x[a-fA-F0-9]{40}$/.test(row.contract)) {
            candidates.add(row.contract.toLowerCase());
          }
        }

        const balAbi = [
          { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
          { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
          { name: "tokenOfOwnerByIndex", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "index", type: "uint256" }], outputs: [{ type: "uint256" }] },
        ] as const;

        for (const col of Array.from(candidates)) {
          try {
            const colAddr = col as Address;
            const bal = await client.readContract({
              address: colAddr,
              abi: balAbi,
              functionName: "balanceOf",
              args: [address as Address],
            }) as bigint;

            if (bal > 0n) {
              let colName = "Elysium NFT";
              try {
                colName = await client.readContract({ address: colAddr, abi: balAbi, functionName: "name" }) as string;
              } catch {}

              const count = Number(bal);
              for (let i = 0; i < Math.min(count, 5); i++) {
                let tid = String(i + 1);
                try {
                  const onChainTid = await client.readContract({
                    address: colAddr,
                    abi: balAbi,
                    functionName: "tokenOfOwnerByIndex",
                    args: [address as Address, BigInt(i)],
                  }) as bigint;
                  tid = onChainTid.toString();
                } catch {
                  // Not ERC721Enumerable, use sequential index placeholder
                }
                results.push({
                  title: `${colName} #${tid}`,
                  contract: colAddr,
                  tokenId: tid,
                });
              }
            }
          } catch {
            // Ignore non-NFT contracts or failed queries
          }
        }
      } catch {
        // Fall back gracefully
      }
      return results;
    }

    const osChain = openseaSlugForChain(chainKey);
    if (!osChain) return [];
    try {
      const res = await openseaGet<{ nfts?: Array<{ identifier: string; name?: string; contract: string }> }>(
        `/chain/${osChain}/account/${address}/nfts`
      );
      return (res?.nfts ?? []).map((n) => ({
        title: n.name || `#${n.identifier}`,
        contract: n.contract,
        tokenId: n.identifier,
      }));
    } catch {
      return [];
    }
  },
};


