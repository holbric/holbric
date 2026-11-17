// Uniswap v3 route finder for Robinhood Chain mainnet. Reads pools from the Uniswap v3 factory, quotes every
// candidate path with QuoterV2.quoteExactInput, and picks the best output. Read-only: nothing is signed or sent.
import { encodePacked, getAddress, parseAbi, formatUnits } from "viem";
import { ADDR, publicClient, fmt } from "./chain.js";

export const FEE_TIERS = [100, 500, 3000, 10000];
const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Tokens tried as the middle hop of 2-hop routes. WETH and USDG are the chain's two base assets. cbBTC is checked on
 * chain: Sourcify exact match (TransparentUpgradeableProxy), name() "Coinbase Wrapped BTC", and live Uniswap v3 pools
 * against both WETH (0.05%, 0.3%) and USDG (0.05%). Robinhood Stock Tokens are never used as a middle hop.
 */
export const INTERMEDIATES = [
  { symbol: "WETH", address: ADDR.WETH, decimals: 18 },
  { symbol: "USDG", address: ADDR.USDG, decimals: 6 },
  { symbol: "cbBTC", address: getAddress("0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4"), decimals: 8 },
];

const factoryAbi = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"]);
const poolAbi = parseAbi(["function liquidity() view returns (uint128)"]);
const quoterAbi = [{
  type: "function", name: "quoteExactInput", stateMutability: "nonpayable",
  inputs: [{ name: "path", type: "bytes" }, { name: "amountIn", type: "uint256" }],
  outputs: [{ name: "amountOut", type: "uint256" }, { name: "sqrtPriceX96AfterList", type: "uint160[]" },
    { name: "initializedTicksCrossedList", type: "uint32[]" }, { name: "gasEstimate", type: "uint256" }],
}];

/** Run fn over items with at most `n` in flight, so a public RPC is not flooded. */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = { ok: true, value: await fn(items[k]) }; } catch (e) { out[k] = { ok: false, error: e }; } }
  }));
  return out;
}

const poolCache = new Map(); // "a>b>fee" -> pool address (pools never move, so the address is cached; liquidity is always read fresh)
async function getPool(a, b, fee) {
  const [x, y] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  const k = `${x}>${y}>${fee}`;
  if (!poolCache.has(k)) {
    const p = await publicClient().readContract({ address: ADDR.UNISWAP_V3_FACTORY, abi: factoryAbi, functionName: "getPool", args: [x, y, fee] });
    if (p === ZERO) return null; // not cached: a pool can be created later
    poolCache.set(k, getAddress(p));
  }
  return poolCache.get(k);
}

/** Live pools (liquidity > 0 in range) for a token pair, every fee tier, read from the factory. */
export async function livePools(a, b) {
  const found = await mapLimit(FEE_TIERS, 4, async (fee) => {
    const pool = await getPool(a, b, fee);
    if (!pool) return null;
    const liquidity = await publicClient().readContract({ address: pool, abi: poolAbi, functionName: "liquidity" });
    return { fee, pool, liquidity };
  });
  return found.filter((r) => r.ok && r.value && r.value.liquidity > 0n).map((r) => r.value).sort((p, q) => (q.liquidity > p.liquidity ? 1 : -1));
}

export const encodePath = (tokens, fees) => {
  const types = [], vals = [];
  tokens.forEach((t, i) => { types.push("address"); vals.push(t); if (i < fees.length) { types.push("uint24"); vals.push(fees[i]); } });
  return encodePacked(types, vals);
};

const pct = (fee) => `${fee / 10000}%`;

/**
 * Find and quote routes. tIn/tOut are resolved tokens; addrIn/addrOut are their pool-side ERC-20 addresses (ETH as WETH).
 * Returns { best, routes (sorted best first), failed, poolsRead, intermediatesTried }.
 */
export async function findRoutes({ tIn, tOut, addrIn, addrOut, amountIn, maxPerLeg = 3 }) {
  const mids = INTERMEDIATES.filter((m) => m.address !== addrIn && m.address !== addrOut);
  const [direct, ...legs] = await Promise.all([
    livePools(addrIn, addrOut),
    ...mids.map((m) => Promise.all([livePools(addrIn, m.address), livePools(m.address, addrOut)])),
  ]);
  const cands = direct.map((p) => ({ tokens: [addrIn, addrOut], symbols: [tIn.symbol, tOut.symbol], fees: [p.fee], pools: [p.pool] }));
  mids.forEach((m, i) => {
    const [a, b] = legs[i];
    for (const p1 of a.slice(0, maxPerLeg)) for (const p2 of b.slice(0, maxPerLeg))
      cands.push({ tokens: [addrIn, m.address, addrOut], symbols: [tIn.symbol, m.symbol, tOut.symbol], fees: [p1.fee, p2.fee], pools: [p1.pool, p2.pool] });
  });
  const poolsRead = direct.length + legs.reduce((n, [a, b]) => n + a.length + b.length, 0);
  if (!cands.length) return { best: null, routes: [], failed: [], poolsRead, intermediatesTried: mids.map((m) => m.symbol) };
  const c = publicClient();
  const res = await mapLimit(cands, 6, async (r) => {
    const path = encodePath(r.tokens, r.fees);
    const { result } = await c.simulateContract({ address: ADDR.QUOTER_V2, abi: quoterAbi, functionName: "quoteExactInput", args: [path, amountIn] });
    return { ...r, path, hops: r.fees.length, amountOut: result[0], gasEstimate: result[3], ticksCrossed: result[2].map(Number) };
  });
  const routes = res.filter((r) => r.ok && r.value.amountOut > 0n).map((r) => r.value)
    .sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : a.hops - b.hops));
  const failed = res.map((r, i) => (!r.ok || r.value.amountOut === 0n ? describe(cands[i]) : null)).filter(Boolean);
  return { best: routes[0] || null, routes, failed, poolsRead, intermediatesTried: mids.map((m) => m.symbol) };
}

/** "USDG -0.3%-> WETH -0.05%-> TSLA" style text. */
export function describe(r) {
  let s = r.symbols[0];
  r.fees.forEach((f, i) => { s += ` -${pct(f)}-> ${r.symbols[i + 1]}`; });
  return s;
}

/** Plain view of one route for tool output. */
export function routeView(r, tOut, best) {
  const diff = best && best !== r && best.amountOut > 0n ? Number(formatUnits((r.amountOut - best.amountOut) * 1000000n / best.amountOut, 4)) : 0;
  return {
    route: describe(r), hops: r.hops, fees: r.fees.map(pct), tokens: r.tokens, pools: r.pools,
    amountOut: fmt(r.amountOut, tOut.decimals, 18), amountOutRaw: r.amountOut.toString(), gasEstimate: r.gasEstimate.toString(),
    ...(best && best !== r ? { vsBestPct: +diff.toFixed(4) } : {}),
  };
}
