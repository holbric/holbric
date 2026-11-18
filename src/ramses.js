// Ramses V3 (concentrated liquidity) on Robinhood Chain mainnet: pools, quotes and swap transactions.
// Addresses are the ones Ramses publishes for Robinhood (ramses.xyz/docs/contract-addresses, "Robinhood" -> "V3 AMM"),
// each an exact or full match on Sourcify for chain 4663, and wired together on chain: the factory's
// ramsesV3PoolDeployer() is the pool deployer, which is also deployer() on the SwapRouter and the QuoterV2, and both
// read WETH9() as Holbric's WETH. test/live.mjs checks all of this on every run.
// Ramses V3 is a Uniswap v3 design keyed by tickSpacing instead of a fee tier: getPool(a, b, tickSpacing), paths are
// token (20 bytes) + tickSpacing (3 bytes) + token, and each pool's fee can be changed by Ramses governance, so the fee
// is always read from the pool and the quote and the simulation are what count. No hooks, extensions or oracles.
import { encodePacked, getAddress, parseAbi, encodeFunctionData, erc20Abi } from "viem";
import { publicClient, fmt } from "./chain.js";
import { INTERMEDIATES } from "./route.js";

export const RAMSES = {
  FACTORY: getAddress("0xE0c4ceb92d08CA985bB70fe0a22fEb121A9854A8"),
  POOL_DEPLOYER: getAddress("0x4b37359BF291AbE8453692DB58d515a8b013Dca9"),
  SWAP_ROUTER: getAddress("0xFCBBe2Af83F94e7E2a9C35a535B3A04719aFD2Ae"),
  QUOTER_V2: getAddress("0x4730e03EB4a58A5e20244062D5f9A99bCf5770a6"),
};
// tickSpacingInitialFee(ts) > 0 on the factory for exactly these at the time of writing; live.mjs re-checks the list.
export const TICK_SPACINGS = [1, 5, 10, 50, 100, 200, 500];
const ZERO = "0x0000000000000000000000000000000000000000";

export const factoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address pool)",
  "function tickSpacingInitialFee(int24 tickSpacing) view returns (uint24)",
  "function ramsesV3PoolDeployer() view returns (address)",
]);
export const poolAbi = parseAbi([
  "function liquidity() view returns (uint128)", "function fee() view returns (uint24)", "function tickSpacing() view returns (int24)",
  "function token0() view returns (address)", "function token1() view returns (address)", "function factory() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint24 feeProtocol, bool unlocked)",
]);
const quoterAbi = [{
  type: "function", name: "quoteExactInput", stateMutability: "nonpayable",
  inputs: [{ name: "path", type: "bytes" }, { name: "amountIn", type: "uint256" }],
  outputs: [{ name: "amountOut", type: "uint256" }, { name: "sqrtPriceX96AfterList", type: "uint160[]" },
    { name: "initializedTicksCrossedList", type: "uint32[]" }, { name: "gasEstimate", type: "uint256" }],
}];
export const routerAbi = [
  { type: "function", name: "exactInputSingle", stateMutability: "payable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "tickSpacing", type: "int24" },
      { name: "recipient", type: "address" }, { name: "deadline", type: "uint256" }, { name: "amountIn", type: "uint256" },
      { name: "amountOutMinimum", type: "uint256" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }],
    outputs: [{ name: "amountOut", type: "uint256" }] },
  { type: "function", name: "exactInput", stateMutability: "payable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "path", type: "bytes" }, { name: "recipient", type: "address" }, { name: "deadline", type: "uint256" },
      { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" }] }],
    outputs: [{ name: "amountOut", type: "uint256" }] },
  { type: "function", name: "unwrapWETH9", stateMutability: "payable", inputs: [{ name: "amountMinimum", type: "uint256" }, { name: "recipient", type: "address" }], outputs: [] },
  { type: "function", name: "multicall", stateMutability: "payable", inputs: [{ name: "data", type: "bytes[]" }], outputs: [{ name: "results", type: "bytes[]" }] },
  { type: "function", name: "WETH9", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "deployer", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = { ok: true, value: await fn(items[k]) }; } catch (e) { out[k] = { ok: false, error: e }; } }
  }));
  return out;
}

// Pool addresses never move, so a found pool is cached for good. "No pool" is cached for 10 minutes: a pool can be created
// later, and without this every quote for a pair Ramses does not list would ask the factory again.
const MULTICALL3 = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11");
const NO_POOL_MS = 10 * 60 * 1000;
const poolCache = new Map(); // "a>b>ts" -> { pool } or { none: expiresAt }
const sortPair = (a, b) => (a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]);

/** Pool addresses for a pair at every enabled tick spacing, one multicall for the ones not cached. */
async function getPools(a, b) {
  const [x, y] = sortPair(a, b);
  const now = Date.now();
  const missing = TICK_SPACINGS.filter((ts) => { const e = poolCache.get(`${x}>${y}>${ts}`); return !e || (e.none && e.none < now); });
  if (missing.length) {
    const res = await publicClient().multicall({ multicallAddress: MULTICALL3, allowFailure: true,
      contracts: missing.map((ts) => ({ address: RAMSES.FACTORY, abi: factoryAbi, functionName: "getPool", args: [x, y, ts] })) });
    missing.forEach((ts, i) => {
      const r = res[i];
      if (r.status !== "success") return; // not cached: ask again next time
      poolCache.set(`${x}>${y}>${ts}`, r.result === ZERO ? { none: now + NO_POOL_MS } : { pool: getAddress(r.result) });
    });
  }
  return TICK_SPACINGS.map((ts) => ({ tickSpacing: ts, pool: poolCache.get(`${x}>${y}>${ts}`)?.pool ?? null })).filter((p) => p.pool);
}

/** Live Ramses V3 pools (liquidity > 0 in range) for a pair, every enabled tick spacing, with each pool's current fee. */
export async function ramsesLivePools(a, b) {
  const pools = await getPools(a, b);
  if (!pools.length) return [];
  const res = await publicClient().multicall({ multicallAddress: MULTICALL3, allowFailure: true,
    contracts: pools.flatMap((p) => [{ address: p.pool, abi: poolAbi, functionName: "liquidity" }, { address: p.pool, abi: poolAbi, functionName: "fee" }]) });
  return pools.map((p, i) => ({ ...p, liquidity: res[2 * i].status === "success" ? res[2 * i].result : 0n, fee: res[2 * i + 1].status === "success" ? Number(res[2 * i + 1].result) : null }))
    .filter((p) => p.liquidity > 0n && p.fee != null).sort((p, q) => (q.liquidity > p.liquidity ? 1 : -1));
}

/** Ramses path: token (20) + tickSpacing (uint24, 3 bytes) + token ... (Path.sol reads the spacing with toUint24). */
export const encodeRamsesPath = (tokens, spacings) => {
  const types = [], vals = [];
  tokens.forEach((t, i) => { types.push("address"); vals.push(t); if (i < spacings.length) { types.push("uint24"); vals.push(spacings[i]); } });
  return encodePacked(types, vals);
};

/**
 * Ramses V3 routes, same shape as findRoutes (route.js): direct pools and 2 hops through WETH, USDG and cbBTC, each path
 * quoted with Ramses QuoterV2.quoteExactInput. Route objects carry venue "ramses", fees (pool fee in pips, read now),
 * tickSpacings, pools and the encoded path.
 */
export async function findRamsesRoutes({ tIn, tOut, addrIn, addrOut, amountIn, maxPerLeg = 2 }) {
  const mids = INTERMEDIATES.filter((m) => m.address !== addrIn && m.address !== addrOut);
  const [direct, ...legs] = await Promise.all([
    ramsesLivePools(addrIn, addrOut),
    ...mids.map((m) => Promise.all([ramsesLivePools(addrIn, m.address), ramsesLivePools(m.address, addrOut)])),
  ]);
  const cands = direct.map((p) => ({ venue: "ramses", tokens: [addrIn, addrOut], symbols: [tIn.symbol, tOut.symbol], fees: [p.fee], tickSpacings: [p.tickSpacing], pools: [p.pool] }));
  mids.forEach((m, i) => {
    const [a, b] = legs[i];
    for (const p1 of a.slice(0, maxPerLeg)) for (const p2 of b.slice(0, maxPerLeg))
      cands.push({ venue: "ramses", tokens: [addrIn, m.address, addrOut], symbols: [tIn.symbol, m.symbol, tOut.symbol], fees: [p1.fee, p2.fee], tickSpacings: [p1.tickSpacing, p2.tickSpacing], pools: [p1.pool, p2.pool] });
  });
  const poolsRead = direct.length + legs.reduce((n, [a, b]) => n + a.length + b.length, 0);
  if (!cands.length) return { routes: [], failed: [], poolsRead, intermediatesTried: mids.map((m) => m.symbol) };
  const c = publicClient();
  const res = await mapLimit(cands, 6, async (r) => {
    const path = encodeRamsesPath(r.tokens, r.tickSpacings);
    const { result } = await c.simulateContract({ address: RAMSES.QUOTER_V2, abi: quoterAbi, functionName: "quoteExactInput", args: [path, amountIn] });
    return { ...r, path, hops: r.fees.length, amountOut: result[0], gasEstimate: result[3], ticksCrossed: result[2].map(Number) };
  });
  const routes = res.filter((r) => r.ok && r.value.amountOut > 0n).map((r) => r.value);
  const failed = res.map((r, i) => (!r.ok || r.value.amountOut === 0n ? cands[i] : null)).filter(Boolean);
  return { routes, failed, poolsRead, intermediatesTried: mids.map((m) => m.symbol) };
}

/**
 * Swap transaction on the Ramses SwapRouter: exact ERC-20 approval to the router when needed, then exactInputSingle or
 * exactInput (deadline inside the params). Native ETH goes in as msg.value (the router wraps it). Native ETH out: the
 * router keeps the WETH (recipient address(0) = the router) and unwrapWETH9 pays the wallet, inside multicall.
 */
export async function buildRamses({ c, from, tIn, tOut, amountIn, best, minOut, poolAddress, approveTx, deadline }) {
  const txs = [], lines = [];
  if (!tIn.native) {
    const allowance = await c.readContract({ address: tIn.address, abi: erc20Abi, functionName: "allowance", args: [from, RAMSES.SWAP_ROUTER] });
    if (allowance < amountIn) {
      txs.push(approveTx(tIn.address, RAMSES.SWAP_ROUTER, amountIn, tIn.symbol, tIn.decimals));
      lines.push(`Approve exactly ${fmt(amountIn, tIn.decimals, 18)} ${tIn.symbol} for the Ramses V3 SwapRouter ${RAMSES.SWAP_ROUTER} (current allowance ${fmt(allowance, tIn.decimals, 18)}). Not unlimited.`);
    }
  }
  const unwrap = tOut.native;
  const recipient = unwrap ? ZERO : from;
  const swapCall = best.hops === 1
    ? encodeFunctionData({ abi: routerAbi, functionName: "exactInputSingle", args: [{ tokenIn: poolAddress(tIn), tokenOut: poolAddress(tOut), tickSpacing: best.tickSpacings[0], recipient, deadline, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] })
    : encodeFunctionData({ abi: routerAbi, functionName: "exactInput", args: [{ path: best.path, recipient, deadline, amountIn, amountOutMinimum: minOut }] });
  const data = unwrap
    ? encodeFunctionData({ abi: routerAbi, functionName: "multicall", args: [[swapCall, encodeFunctionData({ abi: routerAbi, functionName: "unwrapWETH9", args: [minOut, from] })]] })
    : swapCall;
  txs.push({ label: `swap ${fmt(amountIn, tIn.decimals, 18)} ${tIn.symbol} -> ${tOut.symbol} on Ramses V3 (${best.hops === 1 ? "exactInputSingle" : "exactInput, " + best.hops + " hops"})`, to: RAMSES.SWAP_ROUTER, data, value: tIn.native ? amountIn : 0n });
  const fees = best.fees.map((f, i) => `tick spacing ${best.tickSpacings[i]}, fee ${f / 10000}% now`).join("; ");
  return { txs, lines, routeLine: `Route: ${best.symbols.join(" -> ")} on Ramses V3 (${fees})${tIn.native ? " (ETH goes in as WETH)" : ""}${unwrap ? " (WETH is unwrapped to ETH at the end)" : ""}. Pools: ${best.pools.join(", ")}. Ramses can change a pool's fee; the quote and the simulation use the fee at this block.` };
}

/** ramses_pools tool: Ramses V3 pools for a pair with liquidity, current fee and price. */
export async function ramsesPools({ tokenA, tokenB, resolveToken, poolAddress }) {
  const [a, b] = await Promise.all([resolveToken(tokenA), resolveToken(tokenB)]);
  const [x, y] = [poolAddress(a), poolAddress(b)];
  if (x === y) throw new Error("Both sides are the same asset (ETH and WETH share one pool side).");
  const c = publicClient();
  const block = await c.getBlockNumber();
  const out = [];
  for (const { tickSpacing: ts, pool } of await getPools(x, y)) {
    const [liquidity, fee, slot0, token0] = await Promise.all([
      c.readContract({ address: pool, abi: poolAbi, functionName: "liquidity", blockNumber: block }),
      c.readContract({ address: pool, abi: poolAbi, functionName: "fee", blockNumber: block }),
      c.readContract({ address: pool, abi: poolAbi, functionName: "slot0", blockNumber: block }),
      c.readContract({ address: pool, abi: poolAbi, functionName: "token0" }),
    ]);
    const [t0, t1] = getAddress(token0) === getAddress(x) ? [a, b] : [b, a];
    const p = Number(slot0[0]) / 2 ** 96;
    const price1per0 = p * p * 10 ** (t0.decimals - t1.decimals);
    out.push({ pool, tickSpacing: ts, feePct: Number(fee) / 10000, liquidity: liquidity.toString(), inRange: liquidity > 0n, tick: Number(slot0[1]),
      price: liquidity > 0n ? `1 ${t0.symbol} = ${price1per0.toPrecision(8)} ${t1.symbol}` : null });
  }
  return { venue: `Ramses V3, factory ${RAMSES.FACTORY}`, block: block.toString(), pair: `${a.symbol}/${b.symbol}`, pools: out,
    note: out.length ? "Pools with liquidity 0 have no liquidity in range at this block and are skipped by routing. Fees are read from each pool; Ramses can change them." : "Ramses V3 has no pool for this pair at any enabled tick spacing." };
}
