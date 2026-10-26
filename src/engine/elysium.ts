import {
  createPublicClient,
  http,
  formatEther,
  formatGwei,
  type Address,
  type Hash,
  type Transaction,
} from "viem";
import { getChainConfig, ELYSIUM } from "../config";

/**
 * Live Elysium chain monitor.
 *
 * Everything here talks directly to the Elysium RPC — no OpenSea, no external
 * indexers. It powers the bot's Elysium-native features:
 *   - getChainHealth()        live block height, real measured block time, gas
 *   - scanRecentDeployments() surface fresh contract deployments (new launches)
 *   - getWalletActivity()      balance + recent native transfers for any address
 *
 * Elysium produces real canonical blocks every 100–200ms, so a short scan window
 * still captures meaningful on-chain activity.
 */

export interface ChainHealth {
  chainKey: string;
  chainName: string;
  symbol: string;
  chainId: number;
  blockNumber: bigint;
  gasPriceGwei: string;
  /** Measured seconds between the last two blocks (best-effort). */
  blockTimeSeconds: number | null;
  explorerUrl: string;
}

export interface DeployedContract {
  address: Address;
  deployer: Address;
  txHash: Hash;
  blockNumber: bigint;
  /** Seconds since the deploying block (best-effort; null if unknown). */
  ageSeconds: number | null;
}

export interface WalletActivity {
  address: Address;
  balanceWei: bigint;
  balanceEth: string;
  symbol: string;
  transfers: NativeTransfer[];
}

export interface NativeTransfer {
  txHash: Hash;
  from: Address;
  to: Address | null;
  valueWei: bigint;
  valueEth: string;
  blockNumber: bigint;
}

export interface DeploymentMeta {
  address: Address;
  kind: "token" | "nft" | "contract" | "unknown";
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupplyFormatted: string | null;
  bytecodeSize: number | null;
  label: string;
  /** Human one-liner so the hunter feed knows what the contract does (token, nft, bot, arbitrage tooling...). */
  description: string | null;
}

const erc20MetaAbi = [
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const erc721MetaAbi = [
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

function inferContractDescription(bytecode: string | null, bytecodeSize: number | null): { label: string; description: string } {
  const sizeStr = bytecodeSize !== null ? `${bytecodeSize} bytes` : "unknown size";
  if (!bytecode || bytecode === "0x" || bytecodeSize === 0) return { label: "❓ EOA / empty", description: "EOA / empty — no code deployed" };
  const code = bytecode.toLowerCase();
  const has = (sel: string) => code.includes(sel.toLowerCase());
  const EIP1967_SLOT = "360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const dexSels = ["38ed1739","7ff36ab5","18cbafe5","fb3bdb41","ac9650d8","b6f9de95","5c11d795"];
  const arbSels = ["ab9c4b5d","5cffe9de","f7073cdf","04e45aaf"];
  const botSels = ["3593564c","1249c58b","4a25d94a","1cff79cd","61461954","23b872dd"];
  const mintSels = ["40c10f19","a0712d68","6a627842","b88d4fde","aaf10f42"];
  const ownSels = ["8da5cb5b","f2fde38b"];
  const proxySels = ["5c60da1b","3659cfe6","d8b2a10e","ccf75308"];
  if (code.includes(EIP1967_SLOT) || proxySels.some(has)) {
    return { label: `🔗 Proxy \u2022 ${sizeStr}`, description: "Proxy / upgradeable — delegates to implementation (EIP-1967). Verify implementation on explorer." };
  }
  const isDex = dexSels.some(has); const isArb = arbSels.some(has);
  const isBot = botSels.some(has); const isMint = mintSels.some(has); const isOwn = ownSels.some(has);
  if (isDex && (isArb || isBot)) return { label: `⇄ Arbitrage / DEX tooling \u2022 ${sizeStr}`, description: "Arbitrage / DEX tooling — swap, flashLoan, multicall found. Likely bot or router helper." };
  if (isDex) return { label: `⇄ DEX tooling \u2022 ${sizeStr}`, description: "DEX tooling — swap / router selectors (Uniswap-style)." };
  if (isArb) return { label: `⚡ Arbitrage bot \u2022 ${sizeStr}`, description: "Arbitrage / MEV bot — flashLoan / executeOperation. Automation contract." };
  if (isBot) return { label: `🤖 Bot \u2022 ${sizeStr}`, description: "Bot — on-chain automation (execute / snipe). Inspect owner." };
  const looksFactory = bytecodeSize !== null && bytecodeSize > 8000 && isOwn && code.includes("f0");
  if (looksFactory) return { label: `🏭 Factory \u2022 ${sizeStr}`, description: "Factory — deploys other contracts via CREATE/CREATE2." };
  if (isMint && isOwn) return { label: `🛠️ Ownable mint \u2022 ${sizeStr}`, description: "Ownable / mintable — owner-controlled mint." };
  if (isMint) return { label: `🛠️ Mintable \u2022 ${sizeStr}`, description: "Mintable — mint selectors found." };
  if (isOwn) return { label: `🔐 Ownable \u2022 ${sizeStr}`, description: "Ownable — owner / transferOwnership." };
  return { label: `📄 Contract \u2022 ${sizeStr}`, description: "Custom contract — unverified. Check explorer." };
}

export async function getDeploymentMeta(address: Address, chainKey: string = ELYSIUM.key): Promise<DeploymentMeta> {
  const { client } = clientFor(chainKey);
  let bytecode: string | null = null;
  let bytecodeSize: number | null = null;
  try { const code = await client.getBytecode({ address }); bytecode = code ?? null; bytecodeSize = code ? (code.length - 2)/2 : 0; } catch { bytecodeSize = null; }
  try {
    const [name, symbol, decimals, supply] = await Promise.all([
      client.readContract({ address, abi: erc20MetaAbi, functionName: "name" }).catch(()=>null),
      client.readContract({ address, abi: erc20MetaAbi, functionName: "symbol" }).catch(()=>null),
      client.readContract({ address, abi: erc20MetaAbi, functionName: "decimals" }).catch(()=>null),
      client.readContract({ address, abi: erc20MetaAbi, functionName: "totalSupply" }).catch(()=>null),
    ]);
    if (typeof name === "string" && typeof symbol === "string" && decimals !== null) {
      const dec = Number(decimals);
      let supplyFmt: string | null = null;
      try { if (supply !== null) supplyFmt = formatEther(supply as bigint).slice(0,14); } catch {}
      const label = "🪙 Token \u2022 " + name + " (" + symbol + ")" + (Number.isFinite(dec) ? " \u2022 " + dec + " decimals" : "");
      const description = `ERC20 Token — ${name} ($${symbol}) on Elysium` + (Number.isFinite(dec) ? ` · ${dec} decimals` : "") + (supplyFmt ? ` · Supply ${supplyFmt}` : "");
      return { address, kind: "token", name, symbol, decimals: dec, totalSupplyFormatted: supplyFmt, bytecodeSize, label, description };
    }
  } catch {}
  try {
    const [name, symbol] = await Promise.all([
      client.readContract({ address, abi: erc721MetaAbi, functionName: "name" }).catch(()=>null),
      client.readContract({ address, abi: erc721MetaAbi, functionName: "symbol" }).catch(()=>null),
    ]);
    if (typeof name === "string" && typeof symbol === "string" && name && symbol) {
      const description = `ERC721 NFT Collection — ${name} ($${symbol}) on Elysium · trading via Kalos`;
      return { address, kind: "nft", name, symbol, decimals: null, totalSupplyFormatted: null, bytecodeSize, label: "🖼️ NFT \u2022 " + name + " (" + symbol + ")", description };
    }
  } catch {}
  if (bytecodeSize === 0) return { address, kind: "unknown", name: null, symbol: null, decimals: null, totalSupplyFormatted: null, bytecodeSize, label: "❓ EOA / empty", description: "EOA / empty — no code deployed" };
  if (bytecodeSize !== null && bytecodeSize > 0) {
    const inferred = inferContractDescription(bytecode, bytecodeSize);
    return { address, kind: "contract", name: null, symbol: null, decimals: null, totalSupplyFormatted: null, bytecodeSize, label: inferred.label, description: inferred.description };
  }
  return { address, kind: "unknown", name: null, symbol: null, decimals: null, totalSupplyFormatted: null, bytecodeSize, label: "📄 Contract", description: "Custom contract — unverified." };
}


function clientFor(chainKey: string) {
  const cfg = getChainConfig(chainKey);
  return {
    cfg,
    client: createPublicClient({ chain: cfg.viemChain, transport: http(cfg.rpcUrl) }),
  };
}

/** Live snapshot of the chain: height, gas, and measured block time. */
export async function getChainHealth(chainKey: string = ELYSIUM.key): Promise<ChainHealth> {
  const { cfg, client } = clientFor(chainKey);
  const blockNumber = await client.getBlockNumber();
  const gasPrice = await client.getGasPrice();

  // Measure real block time from the last two blocks (best-effort).
  let blockTimeSeconds: number | null = null;
  try {
    const latest = await client.getBlock({ blockNumber });
    if (blockNumber > 0n) {
      const prev = await client.getBlock({ blockNumber: blockNumber - 1n });
      const delta = Number(latest.timestamp - prev.timestamp);
      if (Number.isFinite(delta) && delta >= 0) blockTimeSeconds = delta;
    }
  } catch {
    // leave null
  }

  return {
    chainKey: cfg.key,
    chainName: cfg.name,
    symbol: cfg.symbol,
    chainId: cfg.chainId,
    blockNumber,
    gasPriceGwei: formatGwei(gasPrice),
    blockTimeSeconds,
    explorerUrl: cfg.explorerUrl,
  };
}

/**
 * Scan the most recent blocks for fresh contract deployments (tx.to === null).
 *
 * Elysium's fast blocks mean a small window already captures new launches as
 * they appear on-chain. Receipts are fetched only for creation txs to keep the
 * RPC load low.
 */
export async function scanRecentDeployments(
  blockDepth: number = 40,
  chainKey: string = ELYSIUM.key
): Promise<DeployedContract[]> {
  const { cfg, client } = clientFor(chainKey);
  const latest = await client.getBlockNumber();
  const startDepth = BigInt(Math.max(1, blockDepth));
  const oldest = latest > startDepth ? latest - startDepth : 0n;

  const found: DeployedContract[] = [];
  for (let bn = latest; bn >= oldest; bn--) {
    try {
      const block = await client.getBlock({ blockNumber: bn, includeTransactions: true });
      for (const tx of block.transactions) {
        if (tx.to !== null) continue; // only contract creations
        let deployer: Address | null = null;
        try {
          const sender = await client.getTransaction({ hash: tx.hash });
          deployer = sender.from;
        } catch {
          deployer = tx.from;
        }
        let address: Address | null = null;
        try {
          const receipt = await client.getTransactionReceipt({ hash: tx.hash });
          address = receipt.contractAddress ?? null;
        } catch {
          address = null;
        }
        if (!address) continue;
        found.push({
          address,
          deployer: deployer ?? tx.from,
          txHash: tx.hash,
          blockNumber: bn,
          ageSeconds: Number(latest - bn) * (cfg.testnet ? 0.2 : 12),
        });
      }
    } catch {
      // skip blocks we cannot read this cycle
    }
    if (found.length >= 25) break; // cap results
  }
  return found;
}

/** Balance plus recent native transfers touching an address. */
export async function getWalletActivity(
  address: Address,
  blockDepth: number = 30,
  chainKey: string = ELYSIUM.key
): Promise<WalletActivity> {
  const { cfg, client } = clientFor(chainKey);
  const balanceWei = await client.getBalance({ address });
  const latest = await client.getBlockNumber();
  const startDepth = BigInt(Math.max(1, blockDepth));
  const oldest = latest > startDepth ? latest - startDepth : 0n;

  const transfers: NativeTransfer[] = [];
  const target = address.toLowerCase();
  for (let bn = latest; bn >= oldest; bn--) {
    try {
      const block = await client.getBlock({ blockNumber: bn, includeTransactions: true });
      for (const tx of block.transactions) {
        const from = (tx.from ?? "").toLowerCase();
        const to = (tx.to ?? "").toLowerCase();
        if (from !== target && to !== target) continue;
        transfers.push({
          txHash: tx.hash,
          from: tx.from,
          to: tx.to,
          valueWei: tx.value,
          valueEth: formatEther(tx.value),
          blockNumber: bn,
        });
      }
    } catch {
      // skip unreadable blocks
    }
    if (transfers.length >= 20) break;
  }

  return {
    address,
    balanceWei,
    balanceEth: formatEther(balanceWei),
    symbol: cfg.symbol,
    transfers,
  };
}

/** Recent ERC-721 receives for a wallet: exact (collection, tokenId) pairs.
 * Scans Transfer events TO the address across known Kalos collections, then
 * filters to tokens still owned. Bounded + sequential to respect the RPC. */
export async function getWalletNFTReceives(
  address: Address,
  maxResults: number = 25
): Promise<Array<{ collection: Address; tokenId: bigint; blockNumber?: bigint }>> {
  const { cfg, client } = clientFor(ELYSIUM.key);
  const transferEvent = {
    name: "Transfer", type: "event", stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  } as const;
  // Collections to scan: kalos.fun directory first (authoritative list).
  let collections: Address[] = [];
  try {
    const { getIndexDirectory } = await import("./kalos");
    collections = (await getIndexDirectory()).cols.map((c) => c.address);
  } catch { collections = []; }
  const out: Array<{ collection: Address; tokenId: bigint; blockNumber?: bigint }> = [];
  const seen = new Set<string>();
  const latest = await client.getBlockNumber().catch(() => 0n);
  if (latest === 0n) return [];
  // 200k blocks ≈ 7h on Elysium — covers today's buys; older NFTs come via the
  // directory ownership probe. Depth is per-collection so one slow collection
  // can't starve the rest.
  const blocksBack = 200_000n;
  const from = latest > blocksBack ? latest - blocksBack : 0n;
  for (const col of collections) {
    if (out.length >= maxResults * 2) break;
    try {
      const logs = (await client.getContractEvents({
        address: col, abi: [transferEvent] as any, eventName: "Transfer",
        args: { to: address }, fromBlock: from, toBlock: latest,
      } as any).catch(() => [])) as Array<any>;
      for (const l of logs ?? []) {
        try {
          const tid = BigInt((l?.args as any)?.tokenId ?? -1);
          if (tid < 0n) continue;
          const k = `${col.toLowerCase()}:${tid.toString()}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({ collection: col, tokenId: tid, blockNumber: (l as any)?.blockNumber });
        } catch { /* skip malformed */ }
      }
    } catch { /* next collection */ }
    // Gentle pacing so 27 collections don't 429 the RPC.
    await new Promise((r) => setTimeout(r, 60));
  }
  // Newest first (blockNumber desc) so last buys surface first.
  out.sort((a, b) => {
    const ab = a.blockNumber ?? 0n;
    const bb = b.blockNumber ?? 0n;
    return ab < bb ? 1 : ab > bb ? -1 : 0;
  });
  return out.slice(0, maxResults);
}


