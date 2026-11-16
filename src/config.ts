import "dotenv/config";
import path from "node:path";
import { defineChain, type Chain } from "viem";

/**
 * Central configuration for Zensweep — Elysium-only.
 * Elysium (by Kinetiq): Arbitrum Orbit L2 settling to HyperEVM (chain 999), HYPE gas.
 * Testnet is live on chain 99801. https://elysium.kinetiq.xyz
 */

export interface ChainConfig {
  key: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  symbol: string;
  explorerUrl: string;
  testnet: boolean;
  viemChain: Chain;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : fallback;
}

const elysiumRpc = env("ELYSIUM_RPC_URL", "https://testnet-rpc.elysium.kinetiq.xyz");
const elysiumExplorer = env("ELYSIUM_EXPLORER_URL", "https://elysium.kinetiq.xyz/testnet-explorer");
const elysiumChainId = Number(env("ELYSIUM_CHAIN_ID", "99801"));

export const ELYSIUM: ChainConfig = {
  key: "elysium",
  name: "Elysium Testnet",
  chainId: elysiumChainId,
  rpcUrl: elysiumRpc,
  symbol: "HYPE",
  explorerUrl: elysiumExplorer,
  testnet: true,
  viemChain: defineChain({
    id: elysiumChainId,
    name: "Elysium Testnet",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: { default: { http: [elysiumRpc] } },
    blockExplorers: { default: { name: "Elysium Explorer", url: elysiumExplorer } },
    testnet: true,
  }),
};

/**
 * Elysium MAINNET — chain 99901. Ascend's launchpad lives here (and only here);
 * testnet 99801 has no Ascend contracts. Mainnet RPC is public:
 * https://rpc.elysium.kinetiq.xyz  (verified: eth_chainId -> 0x1863d)
 */
export const ELYSIUM_MAINNET: ChainConfig = {
  key: "elysium-mainnet",
  name: "Elysium",
  chainId: 99901,
  rpcUrl: env("ELYSIUM_MAINNET_RPC_URL", "https://rpc.elysium.kinetiq.xyz"),
  symbol: "HYPE",
  explorerUrl: env("ELYSIUM_MAINNET_EXPLORER_URL", "https://elysium.kinetiq.xyz/explorer"),
  testnet: false,
  viemChain: defineChain({
    id: 99901,
    name: "Elysium",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: { default: { http: [env("ELYSIUM_MAINNET_RPC_URL", "https://rpc.elysium.kinetiq.xyz")] } },
    blockExplorers: { default: { name: "Elysium Explorer", url: env("ELYSIUM_MAINNET_EXPLORER_URL", "https://elysium.kinetiq.xyz/explorer") } },
  }),
};

export const SUPPORTED_CHAINS: ChainConfig[] = [ELYSIUM, ELYSIUM_MAINNET];
const byKey = new Map<string, ChainConfig>(SUPPORTED_CHAINS.map((c) => [c.key, c]));

/**
 * Ascend only exists on Elysium mainnet (99901), so that is the default.
 * Defaulting to testnet made /start show a testnet balance while /buy traded
 * mainnet — two different wallets' worth of confusion.
 */
export const DEFAULT_CHAIN_KEY = ELYSIUM_MAINNET.key;

export function getChainConfig(key: string): ChainConfig {
  return byKey.get(key) ?? ELYSIUM_MAINNET;
}

/** Anything that is not explicitly mainnet resolves to mainnet. */
export function resolveChainKey(input?: string | null): string {
  if (!input) return DEFAULT_CHAIN_KEY;
  if (byKey.has(input)) return input;
  return DEFAULT_CHAIN_KEY;
}

export const FEE_PERCENTAGE = Number(env("FEE_PERCENTAGE", "0.025"));
export const FEE_RECIPIENT_WALLET = env("FEE_RECIPIENT_WALLET", "");
export const TELEGRAM_BOT_TOKEN = env("TELEGRAM_BOT_TOKEN", "");
export const KEY_ENCRYPTION_SECRET = env("KEY_ENCRYPTION_SECRET", "");
// ---- Persistence: Railway volume-aware ----
// Railway ephemeral FS wipes data/kiwi.db.json on every redeploy unless a Volume is mounted.
// When a Volume is mounted at /data, Railway injects RAILWAY_VOLUME_MOUNT_PATH=/data.
// We auto-detect it so the bot keeps wallets across pushes even if DB_FILE/DATA_DIR not set.
// Preferred: mount a Volume at /data on the bot service and set DATA_DIR=/data + DB_FILE=/data/kiwi.db.json.
function resolveDataDir(): string {
  const explicit = (process.env.DATA_DIR ?? "").trim();
  if (explicit && explicit !== "data") return explicit.replace(/\/$/, "");
  const vol = (process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "").trim();
  if (vol) return vol.replace(/\/$/, "");
  return "data";
}
function resolveDbFile(dataDir: string): string {
  const explicit = (process.env.DB_FILE ?? "").trim();
  if (explicit) {
    if (path.isAbsolute(explicit)) return explicit;
    if (dataDir !== "data" && path.isAbsolute(dataDir)) return path.join(dataDir, path.basename(explicit));
    return explicit;
  }
  if (dataDir !== "data" && path.isAbsolute(dataDir)) return path.join(dataDir, "kiwi.db.json");
  return "data/kiwi.db.json";
}
export const DATA_DIR = resolveDataDir();
export const DB_FILE = resolveDbFile(DATA_DIR);
export const MINT_FUNCTION_ABI = env("MINT_FUNCTION_ABI", "function mint(uint256 quantity) payable");
export const ELYSIUM_ROUTER_ADDRESS = env("ELYSIUM_ROUTER_ADDRESS", "");
export const ELYSIUM_WHYPE_ADDRESS = env("ELYSIUM_WHYPE_ADDRESS", "");
export const KALOS_API_URL = env("KALOS_API_URL", "");
export const KALOS_MARKETPLACE_ADDRESS = env("KALOS_MARKETPLACE_ADDRESS", "0x0ff8b7afc288ac42f82320f54a49c400f233bf07");
export const ALERT_POLL_INTERVAL_MS = Number(env("ALERT_POLL_INTERVAL_MS", String(5 * 60_000)));
export const BURNER_TIP = `💡 *Pro Tip:* treat this as a fast-execution burner trading wallet. Deposit only what you plan to trade with today.`;
export const OPENSEA_API_KEY = env("OPENSEA_API_KEY", "");
export const SUPPORT_URL = env("SUPPORT_URL", "https://t.me/zensweep_support");

/**
 * Renamed: Zensweep (was Kiwi). To keep existing hosts from breaking, the
 * launch API feeds from the brand name act as aliases for the primary name.
 */
export const ZENSWEEP_LAUNCH_API_URL = env("ZENSWEEP_LAUNCH_API_URL", "") || env("KIWI_LAUNCH_API_URL", "");

/**
 * Testnet HYPE faucet. Set FAUCET_PRIVATE_KEY to a testnet-funded key that
 * drips HYPE to new users (rate-limited per user). Leave empty to disable and
 * show the Elysium faucet URL instead.
 */
export const FAUCET_PRIVATE_KEY = env("FAUCET_PRIVATE_KEY", "");
export const FAUCET_DRIP_WEI = env("FAUCET_DRIP_WEI", "100000000000000000"); // 0.1 HYPE default
export const FAUCET_COOLDOWN_MS = Number(env("FAUCET_COOLDOWN_MS", String(60 * 60_000))); // 1h per user
export const FAUCET_URL = env("FAUCET_URL", "https://elysium.kinetiq.xyz");
