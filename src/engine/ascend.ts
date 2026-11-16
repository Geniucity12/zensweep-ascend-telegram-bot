import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  encodeAbiParameters,
  keccak256,
  formatEther,
  formatUnits,
  type Address,
  type Hex,
  decodeEventLog,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ELYSIUM_MAINNET } from "../config";

/**
 * Ascend launchpad engine — Elysium MAINNET (chain 99901) only.
 *
 * Every Ascend launch pool is a Uniswap v4 pool. The hook is the Ascend launchpad,
 * which takes the whole fee through its swap deltas (the pool's stored LP fee is 0).
 *
 * Three things that silently break naive integrations:
 *  1. The UniversalRouter is 2.2.0 — SWAP_EXACT_IN_SINGLE carries an EXTRA
 *     `uint256 minHopPriceX36` field between amountOutMinimum and hookData.
 *  2. The fee is per-pool (`currentFee(poolId)`, 1%–10%), charged in the pair asset.
 *     Reading the pool's LP fee gives 0 and would misreport every quote.
 *  3. HYPE pairs settle in WHYPE: deposit() before a buy, withdraw() after a sell.
 *
 * Verified live 2026-11-16: eth_chainId -> 0x1863d, launchpad.paused() -> false.
 */

// ---- Ascend mainnet addresses (read back from chain, docs: 4 Nov 2026) ----
export const ASCEND = {
  universalRouter: "0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a" as Address,
  v4Quoter: "0x379F556c5a748BD7Cc9baF0F7A344094Ac1814f5" as Address,
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
  poolManager: "0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1" as Address,
  stateView: "0x27eD73aE0652fdCf71d6793412A7525f32bE9dfE" as Address,
  positionManager: "0x1d1C51b9d07fD27d36412A2b66CC23D19Eb3E518" as Address,
  launchpad: "0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC" as Address,
  escrowFactory: "0x63f6a8A8d0257c0363251a50cdE8A8b1046e4d19" as Address,
  tokenFactory: "0xCde2fffa95c9543dEC0dcEDdfe8d1182ECeE438f" as Address,
} as const;

/**
 * Ascend's HYPE pair asset: a WRAPPED-HYPE ERC-20 at this address — NOT the
 * zero address. Verified on chain: symbol() == "WHYPE", 18 decimals.
 * Because it is a real ERC-20, the Universal Router pulls it through Permit2,
 * which needs an approval before the first swap.
 */
export const ASCEND_WHYPE = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81" as Address;

export const ASCEND_DEPLOYMENT_BLOCK = 422319n;
export const ASCEND_CHAIN_ID = 99901;

/** v4 dynamic-fee flag as the poolKey's `fee` field. */
export const ASCEND_POOL_FEE_FLAG = 0x800000;
export const ASCEND_TICK_SPACING = 200;
/** 1,000,000 = 100%. Launchpad fees live in pips. */
const FEE_DENOM = 1_000_000n;

/** Universal Router 2.2.0 command ids. */
const UR_V4_SWAP = 0x10;
const UR_WRAP_ETH = 0x0b;
const UR_UNWRAP_WETH = 0x0c;
/** v4 sub-actions — verified by decoding a real mainnet swap (actions 0x060c0f). */
const V4_SWAP_EXACT_IN_SINGLE = 0x06;
const V4_SETTLE = 0x0c;
const V4_TAKE = 0x0f;
/** "use the contract's own balance" sentinel: 1 << 255. */
const CONTRACT_BALANCE = 1n << 255n;

const launchpadAbi = parseAbi([
  "function currentFee(bytes32 poolId) view returns (uint24)",
  "function poolLaunchedAt(bytes32 poolId) view returns (uint40)",
  "function poolTokenIs0(bytes32 poolId) view returns (bool)",
  "function poolStartTick(bytes32 poolId) view returns (int24)",
  "function poolCreator(bytes32 poolId) view returns (address)",
  "function paused() view returns (bool)",
  "function quoteConfig(address quote) view returns ((bool allowed, int24 startTick, uint128 maxClip))",
  "event Launched(bytes32 indexed poolId, address indexed token, address indexed creator, address quote, uint256 supplySeeded, uint256 devBuyTokens, uint24 fee, uint24 builderFee)",
]);

const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

const whypeAbi = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

const routerAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);

const quoterAbi = parseAbi([
  "function quoteExactInputSingle(((address,address,uint24,int24,address) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

/** A Uniswap v4 pool key. */
export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

function cfg() {
  return ELYSIUM_MAINNET;
}
function pub() {
  const c = cfg();
  return createPublicClient({ chain: c.viemChain, transport: http(c.rpcUrl) });
}
export function walletFor(pk: Hex) {
  const c = cfg();
  const account = privateKeyToAccount(pk);
  return createWalletClient({ account, chain: c.viemChain, transport: http(c.rpcUrl) });
}


/**
 * Build a pool key for a launched coin against its quote asset.
 * v4 requires currency0 < currency1 by address.
 */
export function buildPoolKey(token: Address, quote: Address): PoolKey {
  const [currency0, currency1] =
    token.toLowerCase() < quote.toLowerCase() ? [token, quote] : [quote, token];
  return {
    currency0,
    currency1,
    fee: ASCEND_POOL_FEE_FLAG,
    tickSpacing: ASCEND_TICK_SPACING,
    hooks: ASCEND.launchpad,
  };
}

/** poolId = keccak256(abi.encode(poolKey)). */
export function poolIdFor(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    )
  );
}

/** The pool's live fee in pips (1,000,000 = 100%). Creator picks 1%–10%. */
export async function currentFee(poolId: Hex): Promise<number> {
  return (await pub().readContract({
    address: ASCEND.launchpad,
    abi: launchpadAbi,
    functionName: "currentFee",
    args: [poolId],
  })) as number;
}

/** Fee pips -> decimal fraction, e.g. 50000 -> 0.05. */
export function feeFraction(feePips: number): number {
  return feePips / Number(FEE_DENOM);
}

/** Fee pips -> "5.00%". */
export function formatFeePct(feePips: number): string {
  return `${((feePips / Number(FEE_DENOM)) * 100).toFixed(2)}%`;
}

export interface PoolInfo {
  token: Address;
  quote: Address;
  poolKey: PoolKey;
  poolId: Hex;
  fee: number;
  feePct: string;
  launchedAt: number | null;
  tokenIs0: boolean;
  paused: boolean;
  exists: boolean;
  creator?: Address;
}

/**
 * Everything needed to describe a pool before trading, resolved from the chain.
 *
 * The quote asset is read from the pool's Launched event — never guessed.
 * Returns `exists: false` when the CA was never launched via Ascend.
 */
export async function getPoolInfo(token: Address): Promise<PoolInfo> {
  const client = pub();

  const launches = await findLaunchesForToken(token);
  if (launches.length === 0) {
    return {
      token,
      quote: "0x0000000000000000000000000000000000000000",
      poolKey: buildPoolKey(token, "0x0000000000000000000000000000000000000000"),
      poolId: "0x" as Hex,
      fee: 0,
      feePct: "—",
      launchedAt: null,
      tokenIs0: false,
      paused: false,
      exists: false,
    };
  }

  const launch = launches[0];
  const poolKey = buildPoolKey(launch.token, launch.quote);
  const poolId = poolIdFor(poolKey);

  // Prefer the live fee (creators/builder can move it); fall back to the launch fee.
  let fee = launch.fee;
  try {
    fee = await currentFee(poolId);
  } catch {}

  let tokenIs0 = false;
  try {
    tokenIs0 = (await client.readContract({
      address: ASCEND.launchpad,
      abi: launchpadAbi,
      functionName: "poolTokenIs0",
      args: [poolId],
    })) as boolean;
  } catch {}

  let launchedAt: number | null = null;
  let exists = false;
  try {
    const ts = (await client.readContract({
      address: ASCEND.launchpad,
      abi: launchpadAbi,
      functionName: "poolLaunchedAt",
      args: [poolId],
    })) as unknown as bigint;
    launchedAt = Number(ts);
    exists = launchedAt > 0;
  } catch {
    exists = false;
  }

  let paused = false;
  try {
    paused = (await client.readContract({
      address: ASCEND.launchpad,
      abi: launchpadAbi,
      functionName: "paused",
    })) as boolean;
  } catch {}

  return {
    token,
    quote: launch.quote,
    poolKey,
    poolId,
    fee,
    feePct: formatFeePct(fee),
    launchedAt,
    tokenIs0,
    paused,
    exists,
    creator: launch.creator,
  };
}

export interface TokenMeta {
  address: Address;
  name: string | null;
  symbol: string | null;
  decimals: number;
}

/** On-chain ERC-20 basics. Ascend coins are 18 decimals by default. */
export async function getTokenMeta(token: Address): Promise<TokenMeta> {
  const client = pub();
  let name: string | null = null;
  let symbol: string | null = null;
  let decimals = 18;
  try {
    symbol = (await client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" })) as string;
  } catch {}
  try {
    name = (await client.readContract({ address: token, abi: erc20Abi, functionName: "name" })) as string;
  } catch {}
  try {
    decimals = (await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })) as number;
  } catch {}
  return { address: token, name, symbol, decimals };
}

/** Token metadata API — public, no key. null on 404 (no published claim yet). */
export interface AscendMetaApi {
  metadataUri?: string;
  imageUri?: string;
  name?: string;
  symbol?: string;
  description?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  creator?: string;
  verified?: boolean;
}

export async function fetchAscendMetadata(token: Address): Promise<AscendMetaApi | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`https://api.ascendlaunch.xyz/v1/tokens/${token}/metadata`, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as AscendMetaApi;
  } catch {
    return null;
  }
}

/** Pool price/tick from StateView. Note: lpFee here is 0 — the hook owns the fee. */
export async function getSlot0(poolId: Hex): Promise<{ sqrtPriceX96: bigint; tick: number } | null> {
  try {
    const r = (await pub().readContract({
      address: ASCEND.stateView,
      abi: stateViewAbi,
      functionName: "getSlot0",
      args: [poolId],
    })) as readonly [bigint, number, number, number];
    return { sqrtPriceX96: r[0], tick: r[1] };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Discovering a pool from a CA
// ---------------------------------------------------------------------------

/**
 * The pool's quote asset is NOT guessable — Ascend pools pair coins against
 * HYPE, USDC or KNTQ, and the only authoritative source is the Launched event.
 * (Hardcoding a quote produces a valid but WRONG poolId, silently pointing at
 * a pool that does not exist.) So we resolve it from the launchpad's events.
 */
export interface LaunchedInfo {
  poolId: Hex;
  token: Address;
  creator: Address;
  quote: Address;
  fee: number;
  builderFee: number;
  supplySeeded: bigint;
  devBuyTokens: bigint;
  blockNumber: bigint;
}

const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

const launchedEventAbi = parseAbi([
  "event Launched(bytes32 indexed poolId, address indexed token, address indexed creator, address quote, uint256 supplySeeded, uint256 devBuyTokens, uint24 fee, uint24 builderFee)",
]) as readonly any[];
/** Same fragment, unwrapped as a single event for decodeEventLog. */
const LAUNCHED_EVENT = launchedEventAbi[0];

const LAUNCHED_TOPIC = "0xe03d17b1e529b1975da402258d101e5f5240440f266b80122f331f42dea41bd7" as Hex;

/** Scan window per eth_getLogs call. Elysium produces blocks quickly. */
const LOG_CHUNK = 50_000n;

/**
 * Find the Launched event(s) for a token by scanning the launchpad's logs.
 * Returns newest first. Returns [] when the token was never launched via Ascend.
 */
export async function findLaunchesForToken(token: Address, lookbackBlocks: bigint = 2_000_000n): Promise<LaunchedInfo[]> {
  const client = pub();
  const head = await client.getBlockNumber();
  const tokenTopic = `0x${token.toLowerCase().replace(/^0x/, "").padStart(64, "0")}` as Hex;

  const out: LaunchedInfo[] = [];
  let to = head;
  const floor = head > lookbackBlocks ? head - lookbackBlocks : 0n;

  // Walk backwards in bounded chunks; stop at the first hit (newest launch wins).
  while (to > floor) {
    const from = to - LOG_CHUNK + 1n > floor ? to - LOG_CHUNK + 1n : floor;
    try {
      const logs = (await client.getLogs({
        address: ASCEND.launchpad,
        event: LAUNCHED_EVENT,
        args: { token },
        fromBlock: from,
        toBlock: to,
      })) as any[];
      for (const l of logs) {
        const a: any = l.args ?? {};
        if (!a.poolId) continue;
        out.push({
          poolId: a.poolId,
          token: a.token,
          creator: a.creator,
          quote: a.quote,
          fee: Number(a.fee),
          builderFee: Number(a.builderFee),
          supplySeeded: a.supplySeeded,
          devBuyTokens: a.devBuyTokens,
          blockNumber: l.blockNumber ?? 0n,
        });
      }
      if (out.length > 0) break;
    } catch {
      // A rejected range should not kill the search; shrink and continue.
    }
    if (from <= floor) break;
    to = from - 1n;
  }

  return out.sort((a, b) => Number(b.blockNumber - a.blockNumber));
}


export interface Quote {
  amountIn: bigint;
  amountOut: bigint;
  amountOutFormatted: string;
  gasEstimate: bigint;
}

/**
 * Quote an exact-input swap through the V4Quoter.
 *
 * `zeroForOne` is true when we are selling currency0 for currency1.
 * On a BUY of the coin, we pay the quote asset: if the coin is currency1 we are
 * quote->token which is zeroForOne only when the quote asset is currency0.
 */
export async function quoteExactIn(
  poolKey: PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
  decimalsOut: number = 18
): Promise<Quote> {
  const r = (await pub().readContract({
    address: ASCEND.v4Quoter,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        poolKey: [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
        zeroForOne,
        exactAmount: amountIn,
        hookData: "0x" as Hex,
      },
    ],
  })) as readonly [bigint, bigint];

  return {
    amountIn,
    amountOut: r[0],
    amountOutFormatted: formatUnits(r[0], decimalsOut),
    gasEstimate: r[1],
  };
}

/**
 * Quote buying `token` with `quoteAmountIn` of the pair asset.
 * Returns null when the pool does not exist or quoting reverts.
 */
export async function quoteBuy(
  info: PoolInfo,
  quoteAmountIn: bigint,
  tokenDecimals: number = 18
): Promise<Quote | null> {
  if (!info.exists) return null;
  try {
    // Paying the quote asset: that is currency0 when the token is currency1.
    const zeroForOne = !info.tokenIs0;
    return await quoteExactIn(info.poolKey, zeroForOne, quoteAmountIn, tokenDecimals);
  } catch {
    return null;
  }
}

/**
 * Quote selling `tokenAmountIn` of `token`.
 * Returns null when the pool does not exist or quoting reverts.
 */
export async function quoteSell(
  info: PoolInfo,
  tokenAmountIn: bigint,
  quoteDecimals: number = 18
): Promise<Quote | null> {
  if (!info.exists) return null;
  try {
    // Receiving the quote asset: token->quote is zeroForOne when the token is currency0.
    const zeroForOne = info.tokenIs0;
    return await quoteExactIn(info.poolKey, zeroForOne, tokenAmountIn, quoteDecimals);
  } catch {
    return null;
  }
}

/**
 * Apply slippage to a quoted output. Returns the minimum acceptable output.
 * slippageBps = 500 means 5%.
 */
export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** Ascend's fee on an exact-input swap, taken in the pair asset. */
export function ascendFeeOn(amountIn: bigint, feePips: number): bigint {
  const f = BigInt(feePips);
  // ceil(in * f / 1e6)
  return (amountIn * f + FEE_DENOM - 1n) / FEE_DENOM;
}

// ---------------------------------------------------------------------------
// Swap encoding — Universal Router 2.2.0
// ---------------------------------------------------------------------------

/**
 * Encode `SWAP_EXACT_IN_SINGLE` for Universal Router 2.2.0.
 *
 * NOTE the extra `minHopPriceX36` field between amountOutMinimum and hookData.
 * Omitting it (as older v4 examples do) makes every swap revert on this router.
 * Pass 0 to disable the per-hop price floor.
 */
function encodeSwapExactInSingle(
  poolKey: PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
  amountOutMin: bigint
): Hex {
  // Layout verified word-by-word against a real mainnet swap:
  //   [0] offset | [1..5] poolKey | [6] zeroForOne | [7] amountIn |
  //   [8] amountOutMinimum | [9] minHopPriceX36 | [10] hookData offset
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          {
            type: "tuple",
            name: "poolKey",
            components: [
              { type: "address", name: "currency0" },
              { type: "address", name: "currency1" },
              { type: "uint24", name: "fee" },
              { type: "int24", name: "tickSpacing" },
              { type: "address", name: "hooks" },
            ],
          },
          { type: "bool", name: "zeroForOne" },
          { type: "uint128", name: "amountIn" },
          { type: "uint128", name: "amountOutMinimum" },
          { type: "uint256", name: "minHopPriceX36" },
          { type: "bytes", name: "hookData" },
        ],
      },
    ],
    [
      {
        poolKey: {
          currency0: poolKey.currency0,
          currency1: poolKey.currency1,
          fee: poolKey.fee,
          tickSpacing: poolKey.tickSpacing,
          hooks: poolKey.hooks,
        },
        zeroForOne,
        amountIn,
        amountOutMinimum: amountOutMin,
        minHopPriceX36: 0n,
        hookData: "0x" as Hex,
      },
    ]
  );
}

/**
 * v4 SETTLE action: (currency, amount). 2 words. Verified from a real swap.
 * For a buy the amount is the exact input; for a sell it is CONTRACT_BALANCE.
 */
function encodeSettle(currency: Address, amount: bigint): Hex {
  return encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [currency, amount]);
}

/**
 * v4 TAKE action: (currency, amount). 2 words — NO recipient.
 * Verified from a real swap: the router takes to the caller.
 */
function encodeTake(currency: Address, amount: bigint): Hex {
  return encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [currency, amount]);
}

/**
 * Wrap v4 sub-actions into `abi.encode(bytes actions, bytes[] params)`.
 *
 * `actions` is passed straight through — it is ALREADY raw bytes. Encoding it
 * again adds a spurious offset word and the router reverts with SliceOutOfBounds.
 * Verified byte-for-byte against a real mainnet swap.
 */
function v4Actions(actions: Hex, params: Hex[]): Hex {
  return encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [actions, params]
  ) as Hex;
}

// ---------------------------------------------------------------------------
// Execute / simulate
// ---------------------------------------------------------------------------

/**
 * Whether real transactions may be sent. Default OFF.
 * The bot ALWAYS simulates first; execution only happens when this is "true".
 */
export function tradingEnabled(): boolean {
  return (process.env.ASCEND_TRADING_ENABLED ?? "").trim().toLowerCase() === "true";
}

export interface SwapPlan {
  commands: Hex;
  inputs: Hex[];
  deadline: bigint;
  value: bigint;
}

/** Build the v4 swap input shared by buys and sells. */
function buildV4SwapInput(
  info: PoolInfo,
  zeroForOne: boolean,
  amountIn: bigint,
  minOut: bigint,
  settleCurrency: Address,
  takeCurrency: Address,
  settleAmount: bigint
): Hex {
  const swapParams = encodeSwapExactInSingle(info.poolKey, zeroForOne, amountIn, minOut);
  const settleParams = encodeSettle(settleCurrency, settleAmount);
  const takeParams = encodeTake(takeCurrency, minOut);
  const actions = `0x${V4_SWAP_EXACT_IN_SINGLE.toString(16).padStart(2, "0")}${V4_SETTLE.toString(16)
    .padStart(2, "0")}${V4_TAKE.toString(16).padStart(2, "0")}` as Hex;
  return v4Actions(actions, [swapParams, settleParams, takeParams]);
}

/**
 * Build the Universal Router calldata for a BUY.
 *
 * HYPE pair: user sends native HYPE as msg.value.
 *   UR_WRAP_ETH -> wrap into WHYPE held by the router
 *   UR_V4_SWAP  -> [SWAP_EXACT_IN_SINGLE, SETTLE, TAKE]
 *
 * For a non-native quote asset the caller must have approved Permit2 -> router;
 * that path is not built here.
 */
export function buildBuyPlan(
  info: PoolInfo,
  amountInQuote: bigint,
  minOut: bigint,
  recipient: Address,
  wrapNative: boolean
): SwapPlan {
  const zeroForOne = !info.tokenIs0;
  const quoteCurrency = zeroForOne ? info.poolKey.currency0 : info.poolKey.currency1;
  const tokenCurrency = zeroForOne ? info.poolKey.currency1 : info.poolKey.currency0;

  // Wrap native HYPE into WHYPE first so the router can settle the quote asset
  // it holds. The real UI tx used commands=0x10; we prepend 0x0b (WRAP_ETH)
  // because we send native value rather than pre-wrapped WHYPE.
  const v4Input = buildV4SwapInput(
    info, zeroForOne, amountInQuote, minOut,
    quoteCurrency, tokenCurrency, amountInQuote
  );

  const commands = `0x${UR_V4_SWAP.toString(16).padStart(2, "0")}` as Hex;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  if (wrapNative) {
    const wrapInput = encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [ASCEND.universalRouter, CONTRACT_BALANCE]
    );
    return {
      commands: `0x${UR_WRAP_ETH.toString(16).padStart(2, "0")}${commands.slice(2)}` as Hex,
      inputs: [wrapInput, v4Input],
      deadline,
      value: amountInQuote,
    };
  }

  return { commands, inputs: [v4Input], deadline, value: 0n };
}

/**
 * Build the Universal Router calldata for a SELL back into the HYPE pair.
 * The user must approve Permit2 -> UniversalRouter for the token first.
 */
export function buildSellPlan(
  info: PoolInfo,
  amountInToken: bigint,
  minOut: bigint,
  recipient: Address,
  unwrapNative: boolean
): SwapPlan {
  const zeroForOne = info.tokenIs0;
  const tokenCurrency = zeroForOne ? info.poolKey.currency0 : info.poolKey.currency1;
  const quoteCurrency = zeroForOne ? info.poolKey.currency1 : info.poolKey.currency0;

  // Selling: settle the token amount the router holds (it pulls via Permit2),
  // take the quote asset back out.
  const v4Input = buildV4SwapInput(
    info, zeroForOne, amountInToken, minOut,
    tokenCurrency, quoteCurrency, amountInToken
  );

  const commands = `0x${UR_V4_SWAP.toString(16).padStart(2, "0")}` as Hex;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  if (unwrapNative) {
    const unwrapInput = encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [recipient, CONTRACT_BALANCE]
    );
    return {
      commands: `${commands}${UR_UNWRAP_WETH.toString(16).padStart(2, "0")}` as Hex,
      inputs: [v4Input, unwrapInput],
      deadline,
      value: 0n,
    };
  }

  return { commands, inputs: [v4Input], deadline, value: 0n };
}

export interface SimResult {
  ok: boolean;
  error: string | null;
}

/**
 * Simulate a plan with eth_call from the sender. NO gas is spent.
 * This is the gate: a plan must simulate clean before we ever show a confirm button.
 */
export async function simulatePlan(plan: SwapPlan, from: Address): Promise<SimResult> {
  try {
    await pub().simulateContract({
      address: ASCEND.universalRouter,
      abi: routerAbi,
      functionName: "execute",
      args: [plan.commands, plan.inputs, plan.deadline],
      value: plan.value,
      account: from,
    });
    return { ok: true, error: null };
  } catch (e: any) {
    const msg: string = e?.shortMessage ?? e?.message ?? String(e);
    return { ok: false, error: msg.slice(0, 400) };
  }
}

/** Send a plan. Refuses unless ASCEND_TRADING_ENABLED=true. */
export async function executePlan(pk: Hex, plan: SwapPlan): Promise<{ txHash: Hex }> {
  if (!tradingEnabled()) {
    throw new Error("Ascend trading is disabled (set ASCEND_TRADING_ENABLED=true to enable).");
  }
  const client = walletFor(pk);
  const account = client.account!;
  const pubClient = pub();

  const hash = await client.writeContract({
    address: ASCEND.universalRouter,
    abi: routerAbi,
    functionName: "execute",
    args: [plan.commands, plan.inputs, plan.deadline],
    value: plan.value,
    chain: cfg().viemChain,
    account,
  });
  await pubClient.waitForTransactionReceipt({ hash });
  return { txHash: hash };
}

/** Native HYPE balance (gas + buy size). */
export async function getNativeBalance(addr: Address): Promise<bigint> {
  try {
    return await pub().getBalance({ address: addr });
  } catch {
    return 0n;
  }
}

/** ERC-20 balance for a coin. */
export async function getTokenBalance(token: Address, owner: Address): Promise<bigint> {
  try {
    return (await pub().readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    })) as bigint;
  } catch {
    return 0n;
  }
}

/** Format wei -> fixed-decimal string, safe for huge/odd values. */
export function fmtHype(wei: bigint, dp: number = 4): string {
  const s = formatEther(wei);
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return n.toFixed(dp);
}

/** Format raw token units to a decimal string. */
export function quoteOutToUnit(raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals);
}

/**
 * Ensure the wallet can pay the quote asset.
 *
 * The quote asset is a wrapped-HYPE ERC-20, so this:
 *   1. wraps native HYPE -> WHYPE up to `amount`,
 *   2. approves Permit2 on WHYPE (ERC-20 approve),
 *   3. approves the Universal Router as a Permit2 spender.
 * Returns the tx hashes that were sent (empty when nothing was needed).
 */
export async function ensureQuoteAllowance(
  pk: Hex,
  owner: Address,
  amount: bigint
): Promise<{ hashes: Hex[] }> {
  const client = walletFor(pk);
  const account = client.account!;
  const pubClient = pub();
  const w = ASCEND_WHYPE;
  const hashes: Hex[] = [];

  // 1. Wrap enough native HYPE into WHYPE.
  const bal = (await pubClient.readContract({
    address: w,
    abi: whypeAbi,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;
  if (bal < amount) {
    const h = await client.writeContract({
      address: w,
      abi: whypeAbi,
      functionName: "deposit",
      args: [],
      value: amount - bal,
      chain: cfg().viemChain,
      account,
    });
    await pubClient.waitForTransactionReceipt({ hash: h });
    hashes.push(h);
  }

  // 2. ERC-20 approve Permit2 to spend WHYPE.
  const ercAllow = (await pubClient.readContract({
    address: w,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, ASCEND.permit2],
  })) as bigint;
  if (ercAllow < amount) {
    const h = await client.writeContract({
      address: w,
      abi: erc20Abi,
      functionName: "approve",
      args: [ASCEND.permit2, amount * 10n],
      chain: cfg().viemChain,
      account,
    });
    await pubClient.waitForTransactionReceipt({ hash: h });
    hashes.push(h);
  }

  // 3. Permit2 approve the router as a spender.
  const permitAllow = (await pubClient.readContract({
    address: ASCEND.permit2,
    abi: permit2Abi,
    functionName: "allowance",
    args: [owner, w, ASCEND.universalRouter],
  })) as readonly [bigint, number, number];
  const now = Math.floor(Date.now() / 1000);
  if (permitAllow[0] < amount || permitAllow[1] < now) {
    const h = await client.writeContract({
      address: ASCEND.permit2,
      abi: permit2Abi,
      functionName: "approve",
      args: [w, ASCEND.universalRouter, 2n ** 160n - 1n, Number(now) + 30 * 86400],
      chain: cfg().viemChain,
      account,
    });
    await pubClient.waitForTransactionReceipt({ hash: h });
    hashes.push(h);
  }

  return { hashes };
}

/** Do the contracts actually have code on this chain? Guards against wrong-network sends. */
export async function verifyDeployment(): Promise<{ ok: boolean; missing: string[] }> {
  const client = pub();
  const checks: Array<[string, Address]> = [
    ["UniversalRouter", ASCEND.universalRouter],
    ["V4Quoter", ASCEND.v4Quoter],
    ["PoolManager", ASCEND.poolManager],
    ["Launchpad", ASCEND.launchpad],
  ];
  const missing: string[] = [];
  for (const [label, addr] of checks) {
    try {
      const code = await client.getCode({ address: addr });
      if (!code || code === "0x") missing.push(label);
    } catch {
      missing.push(label);
    }
  }
  return { ok: missing.length === 0, missing };
}
