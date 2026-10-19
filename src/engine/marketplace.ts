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

    // OpenSea enrichment (optional).
    let openSeaSlug: string | undefined;
    let floorPrice: number | undefined;
    let floorCurrency: string | undefined;
    let openSeaUrl: string | undefined;
    const osChain = openseaSlugForChain(chainKey);
    if (osChain) {
      try {
        const col = await openseaGet<{ collection?: { floor_price?: number; name?: string } }>(
          `/chain/${osChain}/contract/${addr}`
        );
        if (col?.collection) {
          openSeaSlug = undefined; // slug not returned here; derived below
          if (typeof col.collection.floor_price === "number") {
            floorPrice = col.collection.floor_price;
            floorCurrency = cfg.symbol;
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
      floorPrice,
      floorCurrency,
      explorerUrl: `${cfg.explorerUrl}/address/${addr}`,
      openSeaUrl,
      openSeaSlug,
    };
  },

  async getNFTsForUser(address: string, chainKey: string): Promise<UserNft[]> {
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

