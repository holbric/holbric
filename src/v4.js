// Uniswap v4 on Robinhood Chain mainnet: pool discovery, V4Quoter quotes, and Universal Router calldata.
// Everything here is read-only: it quotes and encodes, it never signs or sends.
//
// Uniswap v4 has no getPool(): a pool is identified by its key (currency0, currency1, fee, tickSpacing, hooks), and
// its id is keccak256(abi.encode(key)). Holbric only looks at keys it can justify:
//   - hookless pools at the four standard fee / tick-spacing pairs (0.01%/1, 0.05%/10, 0.3%/60, 1%/200);
//   - graduated Pons V2 pools, whose key is read from the Pons factory record of the launch
//     (pairToken, poolFee, tickSpacing) with the Pons V2 meme hook, and which the hook must list as registered.
// Pools with any other hook are never routed through. Native ETH is currency 0x0 in v4, so ETH routes on v4 use
// native pools and WETH routes use WETH pools.
import { encodeAbiParameters, encodeFunctionData, encodePacked, keccak256, getAddress, parseAbi } from "viem";
import { ADDR, publicClient } from "./chain.js";
import quoterAbi from "./abi/uniswap-v4-quoter.json" with { type: "json" };
import stateViewAbi from "./abi/uniswap-v4-stateview.json" with { type: "json" };
import ponsFactoryAbi from "./abi/pons-factory.json" with { type: "json" };
import ponsHookAbi from "./abi/pons-meme-hook.json" with { type: "json" };

export const NATIVE = "0x0000000000000000000000000000000000000000";
export const V4_STANDARD = [{ fee: 100, tickSpacing: 1 }, { fee: 500, tickSpacing: 10 }, { fee: 3000, tickSpacing: 60 }, { fee: 10000, tickSpacing: 200 }];
const MAX_U128 = (1n << 128n) - 1n;

/** Middle hops for 2-hop v4 routes: native ETH (v4's base asset), USDG and cbBTC (same cbBTC as the v3 router). */
export const V4_INTERMEDIATES = [
  { symbol: "ETH", address: NATIVE, decimals: 18 },
  { symbol: "USDG", address: ADDR.USDG, decimals: 6 },
  { symbol: "cbBTC", address: getAddress("0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4"), decimals: 8 },
];

/** The v4 currency for a resolved token: 0x0 for native ETH, otherwise the ERC-20 address (WETH stays WETH). */
export const currencyOf = (t) => (t.native ? NATIVE : getAddress(t.address));
const lt = (a, b) => a.toLowerCase() < b.toLowerCase();
export const sortPair = (a, b) => (lt(a, b) ? [a, b] : [b, a]);

export function makeKey(a, b, fee, tickSpacing, hooks = NATIVE) {
  const [currency0, currency1] = sortPair(getAddress(a), getAddress(b));
  return { currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks: getAddress(hooks) };
}
export const poolId = (k) => keccak256(encodeAbiParameters(
  [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
  [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
export const isPonsKey = (k) => getAddress(k.hooks) === ADDR.PONS_HOOK;
export const isAllowedHook = (h) => getAddress(h) === NATIVE || getAddress(h) === ADDR.PONS_HOOK;

async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = { ok: true, value: await fn(items[k]) }; } catch (e) { out[k] = { ok: false, error: e }; } }
  }));
  return out;
}

const sv = (fn, args) => publicClient().readContract({ address: ADDR.V4_STATE_VIEW, abi: stateViewAbi, functionName: fn, args });

// Pons launch lookups. "Not a Pons launch" and "graduated" never change back, so both are cached; a launch still on
// its bonding curve is re-read next time because it can graduate at any block.
const ponsCache = new Map();
/** Graduated Pons V2 pool for a token, or null. Key from the factory record, registration checked on the hook. */
export async function ponsPool(token) {
  if (token === NATIVE) return null;
  const t = getAddress(token);
  if (ponsCache.has(t)) return ponsCache.get(t);
  const c = publicClient();
  let L;
  try { L = await c.readContract({ address: ADDR.PONS_FACTORY, abi: ponsFactoryAbi, functionName: "getLaunchedToken", args: [t] }); }
  catch { return null; } // not cached: an RPC error is not an answer
  if (!L.exists) { ponsCache.set(t, null); return null; }
  if (Number(L.phase) === 0) return null; // still on its bonding curve
  const key = makeKey(t, L.pairToken, L.poolFee, L.tickSpacing, ADDR.PONS_HOOK);
  const id = poolId(key);
  const info = await c.readContract({ address: ADDR.PONS_HOOK, abi: ponsHookAbi, functionName: "launches", args: [id] });
  const [registered, , memecoin, quoteToken, creator, , , creatorTaxBps, protocolFeeShareBps, , hookFeeBps] = info;
  if (!registered) return null;
  const p = { token: t, pairToken: getAddress(L.pairToken), curve: getAddress(L.curve), key, id, hookFeeBps: Number(hookFeeBps), creatorTaxBps: Number(creatorTaxBps),
    protocolFeeShareBps: Number(protocolFeeShareBps), creator: getAddress(creator), memecoin: getAddress(memecoin), quoteToken: getAddress(quoteToken) };
  ponsCache.set(t, p);
  return p;
}

/** Candidate keys for a pair: four hookless standard keys, plus the Pons pool when one side is a graduated Pons launch paired with the other. */
export async function candidateKeys(a, b) {
  const keys = V4_STANDARD.map((s) => ({ key: makeKey(a, b, s.fee, s.tickSpacing), kind: "hookless" }));
  for (const [x, y] of [[a, b], [b, a]]) {
    const p = await ponsPool(x).catch(() => null);
    if (p && p.pairToken === getAddress(y)) keys.push({ key: p.key, kind: "pons", pons: p });
  }
  return keys;
}

/** Live v4 pools for a pair (in-range liquidity > 0), most liquid first. Liquidity is always read fresh. */
export async function livePoolsV4(a, b) {
  const cands = await candidateKeys(getAddress(a), getAddress(b));
  const res = await mapLimit(cands, 5, async (c) => { const id = poolId(c.key); return { ...c, id, liquidity: await sv("getLiquidity", [id]) }; });
  return res.filter((r) => r.ok && r.value.liquidity > 0n).map((r) => r.value).sort((p, q) => (q.liquidity > p.liquidity ? 1 : -1));
}

/** Pool state for one key: slot0 and liquidity from StateView. */
export async function poolState(key) {
  const id = poolId(key);
  const [[sqrtPriceX96, tick, protocolFee, lpFee], liquidity] = await Promise.all([sv("getSlot0", [id]), sv("getLiquidity", [id])]);
  return { id, sqrtPriceX96, tick: Number(tick), protocolFee: Number(protocolFee), lpFee: Number(lpFee), liquidity, initialized: sqrtPriceX96 !== 0n };
}

/** Price of currency0 in currency1 units from sqrtPriceX96 (human units). */
export function priceFromSqrt(sqrtPriceX96, dec0, dec1) {
  const r = Number(sqrtPriceX96) / 2 ** 96;
  return r * r * 10 ** (dec0 - dec1);
}

/** Quote one path with V4Quoter. path: [{ key, from, to }]. Returns { amountOut, gasEstimate }. */
export async function quotePath(hops, amountIn) {
  if (amountIn > MAX_U128) throw new Error("Amount is too large for a Uniswap v4 quote (uint128).");
  const c = publicClient();
  if (hops.length === 1) {
    const h = hops[0];
    const { result } = await c.simulateContract({ address: ADDR.V4_QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle",
      args: [{ poolKey: h.key, zeroForOne: getAddress(h.from) === h.key.currency0, exactAmount: amountIn, hookData: "0x" }] });
    return { amountOut: result[0], gasEstimate: result[1] };
  }
  const { result } = await c.simulateContract({ address: ADDR.V4_QUOTER, abi: quoterAbi, functionName: "quoteExactInput",
    args: [{ exactCurrency: hops[0].from, path: hops.map((h) => ({ intermediateCurrency: h.to, fee: h.key.fee, tickSpacing: h.key.tickSpacing, hooks: h.key.hooks, hookData: "0x" })), exactAmount: amountIn }] });
  return { amountOut: result[0], gasEstimate: result[1] };
}

/**
 * Find and quote v4 routes: direct pools plus 2-hop routes through ETH, USDG and cbBTC, every hop on v4.
 * symIn/symOut are display symbols; cIn/cOut are v4 currencies. Same result shape as route.js findRoutes, venue "v4".
 */
export async function findV4Routes({ symIn, symOut, cIn, cOut, amountIn, maxPerLeg = 3, onlyKey = null }) {
  if (amountIn > MAX_U128) return { best: null, routes: [], failed: [], poolsRead: 0, intermediatesTried: [] };
  let cands, poolsRead, mids = [];
  if (onlyKey) {
    cands = [{ hops: [{ key: onlyKey, from: cIn, to: cOut, kind: isPonsKey(onlyKey) ? "pons" : "given" }], symbols: [symIn, symOut] }];
    poolsRead = 1;
  } else {
    mids = V4_INTERMEDIATES.filter((m) => m.address !== cIn && m.address !== cOut);
    const [direct, ...legs] = await Promise.all([
      livePoolsV4(cIn, cOut),
      ...mids.map((m) => Promise.all([livePoolsV4(cIn, m.address), livePoolsV4(m.address, cOut)])),
    ]);
    cands = direct.map((p) => ({ hops: [{ key: p.key, from: cIn, to: cOut, kind: p.kind }], symbols: [symIn, symOut] }));
    mids.forEach((m, i) => {
      const [a, b] = legs[i];
      for (const p1 of a.slice(0, maxPerLeg)) for (const p2 of b.slice(0, maxPerLeg))
        cands.push({ hops: [{ key: p1.key, from: cIn, to: m.address, kind: p1.kind }, { key: p2.key, from: m.address, to: cOut, kind: p2.kind }], symbols: [symIn, m.symbol, symOut] });
    });
    poolsRead = direct.length + legs.reduce((n, [a, b]) => n + a.length + b.length, 0);
  }
  const shaped = cands.map((r) => ({ venue: "v4", tokens: [cIn, ...r.hops.map((h) => h.to)], symbols: r.symbols, fees: r.hops.map((h) => h.key.fee),
    keys: r.hops.map((h) => h.key), kinds: r.hops.map((h) => h.kind), pools: r.hops.map((h) => poolId(h.key)), hops: r.hops.length, _hops: r.hops }));
  const res = await mapLimit(shaped, 6, async (r) => { const q = await quotePath(r._hops, amountIn); return { ...r, amountOut: q.amountOut, gasEstimate: q.gasEstimate }; });
  const routes = res.filter((r) => r.ok && r.value.amountOut > 0n).map((r) => r.value);
  const failed = res.map((r, i) => (!r.ok || r.value.amountOut === 0n ? shaped[i] : null)).filter(Boolean);
  return { routes, failed, poolsRead, intermediatesTried: mids.map((m) => m.symbol) };
}

// ---------------------------------------------------------------------------------------------------------------
// Universal Router 2.1.2 calldata. Command V4_SWAP (0x10) with actions SWAP_EXACT_IN_SINGLE (0x06) or SWAP_EXACT_IN
// (0x07), then SETTLE_ALL (0x0c) and TAKE_ALL (0x0f). Values from Commands.sol / Actions.sol in the router's Sourcify
// record. The 2.1.2 structs carry minHopPriceX36; Holbric sets it to 0 (no per-hop check) and enforces the slippage
// floor with amountOutMinimum and TAKE_ALL's minimum instead.
const V4_SWAP = 0x10, SWAP_EXACT_IN_SINGLE = 0x06, SWAP_EXACT_IN = 0x07, SETTLE_ALL = 0x0c, TAKE_ALL = 0x0f;
const POOL_KEY = { type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] };
const EXACT_IN_SINGLE = { type: "tuple", components: [{ name: "poolKey", ...POOL_KEY }, { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" },
  { name: "amountOutMinimum", type: "uint128" }, { name: "minHopPriceX36", type: "uint256" }, { name: "hookData", type: "bytes" }] };
const EXACT_IN = { type: "tuple", components: [{ name: "currencyIn", type: "address" },
  { name: "path", type: "tuple[]", components: [{ name: "intermediateCurrency", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" }, { name: "hookData", type: "bytes" }] },
  { name: "minHopPriceX36", type: "uint256[]" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }] };
export const urAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
export const permit2Abi = parseAbi([
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

/** Calldata for UniversalRouter.execute that swaps amountIn along a v4 route and pays the output to the caller. */
export function encodeV4Swap(route, amountIn, minOut, deadline) {
  for (const k of route.keys) if (!isAllowedHook(k.hooks)) throw new Error(`Refusing to route through a pool with unknown hook ${k.hooks}.`);
  const cIn = route.tokens[0], cOut = route.tokens[route.tokens.length - 1];
  let action, swap;
  if (route.hops === 1) {
    const k = route.keys[0];
    action = SWAP_EXACT_IN_SINGLE;
    swap = encodeAbiParameters([EXACT_IN_SINGLE], [{ poolKey: k, zeroForOne: getAddress(cIn) === k.currency0, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: "0x" }]);
  } else {
    action = SWAP_EXACT_IN;
    swap = encodeAbiParameters([EXACT_IN], [{ currencyIn: cIn, path: route.keys.map((k, i) => ({ intermediateCurrency: route.tokens[i + 1], fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks, hookData: "0x" })),
      minHopPriceX36: [], amountIn, amountOutMinimum: minOut }]);
  }
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [cIn, amountIn]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [cOut, minOut]);
  const actions = encodePacked(["uint8", "uint8", "uint8"], [action, SETTLE_ALL, TAKE_ALL]);
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [swap, settle, take]]);
  return encodeFunctionData({ abi: urAbi, functionName: "execute", args: [encodePacked(["uint8"], [V4_SWAP]), [input], deadline] });
}
