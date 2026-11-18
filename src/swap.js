import { parseUnits, formatUnits, erc20Abi, encodeFunctionData, getAddress, isAddress, decodeEventLog } from "viem";
import { ADDR, publicClient, resolveToken, poolAddress, CHAIN_ID, fmt, localTime } from "./chain.js";
import { walletAddress } from "./keystore.js";
import { requireWallet, slippage, checkLimit, approveTx, store } from "./actions.js";
import { findRoutes, describe, routeView, feeText, venueLabel, FEE_TIERS } from "./route.js";
import { findRamsesRoutes, buildRamses, RAMSES, TICK_SPACINGS } from "./ramses.js";
import { findV4Routes, currencyOf, encodeV4Swap, permit2Abi, isPonsKey, isAllowedHook, makeKey, NATIVE } from "./v4.js";
import { aggregatorsEnabled, disabledReason, kyberRoute, kyberSimulate, kyberBuild, KYBER_ROUTER } from "./kyber.js";
import { simulateTxs, NATIVE_TRACE } from "./simulate.js";

export { FEE_TIERS } from "./route.js";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002"; // SwapRouter02 constant

const routerAbi = [
  { type: "function", name: "exactInputSingle", stateMutability: "payable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "fee", type: "uint24" },
      { name: "recipient", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" }] }],
    outputs: [{ name: "amountOut", type: "uint256" }] },
  // SwapRouter02 (IV3SwapRouter) exactInput: no deadline in the struct; the deadline is on multicall.
  { type: "function", name: "exactInput", stateMutability: "payable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "path", type: "bytes" }, { name: "recipient", type: "address" }, { name: "amountIn", type: "uint256" },
      { name: "amountOutMinimum", type: "uint256" }] }],
    outputs: [{ name: "amountOut", type: "uint256" }] },
  { type: "function", name: "unwrapWETH9", stateMutability: "payable",
    inputs: [{ name: "amountMinimum", type: "uint256" }, { name: "recipient", type: "address" }], outputs: [] },
  { type: "function", name: "multicall", stateMutability: "payable",
    inputs: [{ name: "deadline", type: "uint256" }, { name: "data", type: "bytes[]" }], outputs: [{ name: "results", type: "bytes[]" }] },
  { type: "function", name: "WETH9", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

const VENUES = ["best", "native", "v3", "v4", "ramses", "uniswap"]; // Holbric's own routing (quote). "kyber" is handled in bestQuote / prepareSwap.
// "uniswap" (internal, not a tool option): Uniswap v3 + v4 only. Valuations (portfolio, Morpho, the daily limit) use it, as documented.
export const ALL_VENUES = ["best", "native", "kyber", "v3", "v4", "ramses"];
const V3_VENUE = `Uniswap v3 QuoterV2 ${ADDR.QUOTER_V2} (quoteExactInput), pools from factory ${ADDR.UNISWAP_V3_FACTORY}`;
const V4_VENUE = `Uniswap v4 V4Quoter ${ADDR.V4_QUOTER}, pools read from StateView ${ADDR.V4_STATE_VIEW} (PoolManager ${ADDR.V4_POOL_MANAGER})`;
const RAMSES_VENUE = `Ramses V3 QuoterV2 ${RAMSES.QUOTER_V2} (quoteExactInput), pools from factory ${RAMSES.FACTORY}`;
const byOutput = (a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : a.hops - b.hops);

/**
 * Exact-input quote over every route Holbric can find, on Uniswap v3 and Uniswap v4, and the best one.
 * v3: direct pools at all four fee tiers plus 2-hop routes through WETH, USDG and cbBTC (QuoterV2.quoteExactInput).
 * v4: hookless pools at the four standard keys and graduated Pons pools, direct or 2 hops through ETH, USDG and cbBTC
 * (V4Quoter). A route stays on one version; v3 and v4 routes are compared on output amount.
 * venue: "best" (default), "v3" or "v4". poolKey (internal / quote_v4): quote only that v4 pool.
 */
export async function quote({ tokenIn, tokenOut, amount, venue = "best", poolKey = null }) {
  if (!VENUES.includes(venue)) throw new Error(`venue must be one of ${VENUES.join(", ")}.`);
  if (venue === "native") venue = "best";
  const [tIn, tOut] = await Promise.all([resolveToken(tokenIn), resolveToken(tokenOut)]);
  if (poolAddress(tIn) === poolAddress(tOut)) throw new Error("tokenIn and tokenOut are the same asset (ETH and WETH share one pool side). Use a wrap, not a swap.");
  if (!/^\d+(\.\d+)?$/.test(String(amount))) throw new Error("amount must be a positive decimal string, e.g. \"5\" or \"0.25\".");
  const amountIn = parseUnits(String(amount), tIn.decimals);
  if (amountIn <= 0n) throw new Error("amount must be greater than zero.");
  let onlyKey = null;
  if (poolKey) {
    venue = "v4";
    onlyKey = makeKey(poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks || NATIVE);
    const cIn = currencyOf(tIn), cOut = currencyOf(tOut);
    if (!((onlyKey.currency0 === cIn && onlyKey.currency1 === cOut) || (onlyKey.currency0 === cOut && onlyKey.currency1 === cIn)))
      throw new Error(`That pool key is ${onlyKey.currency0}/${onlyKey.currency1}; it does not trade ${tIn.symbol} (${cIn}) for ${tOut.symbol} (${cOut}). On v4, native ETH is 0x0000000000000000000000000000000000000000 and WETH is its own currency.`);
  }
  const empty = { routes: [], failed: [], poolsRead: 0, intermediatesTried: [] };
  const want = (v) => venue === "best" || venue === v || (venue === "uniswap" && (v === "v3" || v === "v4"));
  const [v3, v4, ra] = await Promise.all([
    want("v3") ? findRoutes({ tIn, tOut, addrIn: poolAddress(tIn), addrOut: poolAddress(tOut), amountIn }) : empty,
    want("v4") ? findV4Routes({ symIn: tIn.symbol, symOut: tOut.symbol, cIn: currencyOf(tIn), cOut: currencyOf(tOut), amountIn, onlyKey }) : empty,
    want("ramses") ? findRamsesRoutes({ tIn, tOut, addrIn: poolAddress(tIn), addrOut: poolAddress(tOut), amountIn }) : empty,
  ]);
  const all = [...v3.routes, ...v4.routes, ...ra.routes].sort(byOutput);
  const failed = [...v3.failed, ...v4.failed.map(describe), ...ra.failed.map(describe)];
  const found = { routes: all, failed, poolsRead: v3.poolsRead + v4.poolsRead + ra.poolsRead, v3: { routes: v3.routes.length, pools: v3.poolsRead, via: v3.intermediatesTried }, v4: { routes: v4.routes.length, pools: v4.poolsRead, via: v4.intermediatesTried }, ramses: { routes: ra.routes.length, pools: ra.poolsRead, via: ra.intermediatesTried } };
  const best = all[0];
  if (!best) throw new Error(onlyKey
    ? `Uniswap v4 returned no quote for ${tIn.symbol} -> ${tOut.symbol} on that pool key (pool not initialized, no liquidity in range, or the swap reverts).`
    : `No ${venue === "best" ? "Uniswap v3, Uniswap v4 or Ramses V3" : venue === "ramses" ? "Ramses V3" : venue === "uniswap" ? "Uniswap v3 or v4" : "Uniswap " + venue} route on Robinhood Chain quoted ${tIn.symbol} -> ${tOut.symbol}: no live pool directly and none through ${[...new Set([...v3.intermediatesTried, ...v4.intermediatesTried, ...ra.intermediatesTried])].join(", ") || "any middle token"}.`);
  const block = await publicClient().getBlockNumber();
  const priceOutPerIn = Number(formatUnits(best.amountOut, tOut.decimals)) / Number(amount);
  const venueText = venue === "v3" ? V3_VENUE : venue === "v4" ? V4_VENUE : venue === "ramses" ? RAMSES_VENUE : venue === "uniswap" ? `${V3_VENUE}; ${V4_VENUE}` : `${V3_VENUE}; ${V4_VENUE}; ${RAMSES_VENUE}`;
  return {
    tIn, tOut, amountIn, best, all, found, block, venue,
    view: {
      chainId: CHAIN_ID, block: block.toString(), quotedAt: new Date().toISOString(), quotedAtLocal: localTime(new Date()),
      venue: venueText, bestVenue: venueLabel(best),
      tokenIn: { symbol: tIn.symbol, address: tIn.address ?? "native", amount: fmt(amountIn, tIn.decimals, 18) },
      tokenOut: { symbol: tOut.symbol, address: tOut.address ?? "native", amountOut: fmt(best.amountOut, tOut.decimals, 18), amountOutRaw: best.amountOut.toString() },
      route: describe(best), hops: best.hops, routeTokens: best.symbols, feeTier: feeText(best),
      ...(best.venue === "v4" ? { poolIds: best.pools, poolKeys: best.keys } : { pools: best.pools }),
      ...(best.venue === "ramses" ? { tickSpacings: best.tickSpacings } : {}),
      price: `1 ${tIn.symbol} = ${priceOutPerIn.toPrecision(8)} ${tOut.symbol}`,
      gasEstimate: best.gasEstimate.toString(),
      compared: { routesQuoted: all.length, v3Routes: v3.routes.length, v4Routes: v4.routes.length, ramsesRoutes: ra.routes.length, livePoolsRead: found.poolsRead,
        via: [...new Set([...v3.intermediatesTried, ...v4.intermediatesTried, ...ra.intermediatesTried])], noQuote: failed.length },
      alternatives: all.slice(1, 8).map((r) => ({ route: describe(r), amountOut: fmt(r.amountOut, tOut.decimals, 18), vsBestPct: routeView(r, tOut, best).vsBestPct })),
      ...(tIn.unverified || tOut.unverified ? { warning: "One token is not in Holbric's verified list (ETH, USDG, WETH). Check the contract on the explorer." } : {}),
    },
  };
}

/** USD value of an input amount: USDG is 1:1, everything else is quoted into USDG. */
export async function usdValue(tIn, amountIn) {
  if (tIn.address === ADDR.USDG) return Number(formatUnits(amountIn, 6));
  if (amountIn === 0n) return 0;
  const q = await quote({ tokenIn: tIn.native ? "ETH" : tIn.address, tokenOut: "USDG", amount: formatUnits(amountIn, tIn.decimals), venue: "uniswap" });
  return Number(formatUnits(q.best.amountOut, 6));
}

async function prepareNative({ tokenIn, tokenOut, amount, slippageBps, venue = "best", poolKey = null, kind = "uniswap_swap", extraLines = [], q: given = null }) {
  const from = requireWallet();
  const slip = slippage(slippageBps);
  const q = given || await quote({ tokenIn, tokenOut, amount, venue, poolKey });
  const c = publicClient();
  const { tIn, tOut, amountIn, best } = q;
  const minOut = (best.amountOut * BigInt(10000 - slip)) / 10000n;
  const balance = tIn.native ? await c.getBalance({ address: from }) : await c.readContract({ address: tIn.address, abi: erc20Abi, functionName: "balanceOf", args: [from] });
  if (balance < amountIn) throw new Error(`Not enough ${tIn.symbol}: wallet ${from} holds ${fmt(balance, tIn.decimals, 18)}, swap needs ${fmt(amountIn, tIn.decimals, 18)}. Nothing was prepared.`);
  const usd = await usdValue(tIn, amountIn).catch(() => null);
  checkLimit(usd);
  const built = best.venue === "v4" ? await buildV4({ c, from, tIn, tOut, amountIn, best, minOut })
    : best.venue === "ramses" ? await buildRamses({ c, from, tIn, tOut, amountIn, best, minOut, poolAddress, approveTx, deadline: deadlineIn(15) })
    : await buildV3({ c, from, tIn, tOut, amountIn, best, minOut });
  const { txs, lines } = built;
  lines.push(`Swap ${fmt(amountIn, tIn.decimals, 18)} ${tIn.symbol} for at least ${fmt(minOut, tOut.decimals)} ${tOut.symbol} (expected ${fmt(best.amountOut, tOut.decimals)}) on ${venueLabel(best)}. Slippage limit ${(slip / 100).toFixed(2)}%, deadline 15 minutes from now.`);
  lines.push(built.routeLine);
  const alts = q.all.slice(1, 6).map((r) => `${describe(r)} = ${fmt(r.amountOut, tOut.decimals)} ${tOut.symbol}`);
  lines.push(`Compared ${q.all.length} route${q.all.length > 1 ? "s" : ""} at block ${q.block} (${q.found.v3.routes} on Uniswap v3, ${q.found.v4.routes} on Uniswap v4, ${q.found.ramses.routes} on Ramses V3)${alts.length ? `; next best: ${alts.join("; ")}` : "; no other route had a live pool"}.`);
  lines.push(...extraLines);
  return store({ kind, from, txs, lines, usd, onReceipt: receiptReader(from, tOut), slippageBps: slip, extra: { quote: q.view },
    minReceive: { token: outKey(tOut), amount: minOut, symbol: tOut.symbol, decimals: tOut.decimals } });
}

/** Key of the output token in a traced simulation (native ETH shows up under the eth_simulateV1 pseudo-address). */
const outKey = (t) => (t.native ? NATIVE_TRACE : getAddress(t.address));

const receiptReader = (from, tOut) => async (r) => {
  if (tOut.native) return {};
  for (const log of r.logs) {
    if (getAddress(log.address) !== getAddress(tOut.address)) continue;
    try { const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      if (ev.eventName === "Transfer" && getAddress(ev.args.to) === getAddress(from)) return { received: `${fmt(ev.args.value, tOut.decimals, 18)} ${tOut.symbol}` }; } catch {}
  }
  return {};
};

const deadlineIn = (min) => BigInt(Math.floor(Date.now() / 1000) + min * 60);

/** Uniswap v3 through SwapRouter02: exactInputSingle or exactInput, inside multicall(deadline), unwrap for native ETH out. */
async function buildV3({ c, from, tIn, tOut, amountIn, best, minOut }) {
  const txs = [], lines = [];
  if (!tIn.native) {
    const allowance = await c.readContract({ address: tIn.address, abi: erc20Abi, functionName: "allowance", args: [from, ADDR.SWAP_ROUTER_02] });
    if (allowance < amountIn) {
      txs.push(approveTx(tIn.address, ADDR.SWAP_ROUTER_02, amountIn, tIn.symbol, tIn.decimals));
      lines.push(`Approve exactly ${fmt(amountIn, tIn.decimals, 18)} ${tIn.symbol} for Uniswap SwapRouter02 ${ADDR.SWAP_ROUTER_02} (current allowance ${fmt(allowance, tIn.decimals, 18)}). Not unlimited.`);
    }
  }
  const unwrap = tOut.native;
  const recipient = unwrap ? ADDRESS_THIS : from;
  const swapCall = best.hops === 1
    ? encodeFunctionData({ abi: routerAbi, functionName: "exactInputSingle", args: [{
      tokenIn: poolAddress(tIn), tokenOut: poolAddress(tOut), fee: best.fees[0], recipient, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] })
    : encodeFunctionData({ abi: routerAbi, functionName: "exactInput", args: [{ path: best.path, recipient, amountIn, amountOutMinimum: minOut }] });
  const calls = [swapCall];
  if (unwrap) calls.push(encodeFunctionData({ abi: routerAbi, functionName: "unwrapWETH9", args: [minOut, from] }));
  txs.push({ label: `swap ${fmt(amountIn, tIn.decimals, 18)} ${tIn.symbol} -> ${tOut.symbol} on Uniswap v3 (${best.hops === 1 ? "exactInputSingle" : "exactInput, " + best.hops + " hops"})`, to: ADDR.SWAP_ROUTER_02,
    data: encodeFunctionData({ abi: routerAbi, functionName: "multicall", args: [deadlineIn(15), calls] }), value: tIn.native ? amountIn : 0n });
  return { txs, lines, routeLine: `Route: ${describe(best)}${tIn.native ? " (ETH goes in as WETH)" : ""}${unwrap ? " (WETH is unwrapped to ETH at the end)" : ""}. Pools: ${best.pools.join(", ")}.` };
}

/**
 * Uniswap v4 through Universal Router 2.1.2: execute(V4_SWAP) with SWAP_EXACT_IN(_SINGLE), SETTLE_ALL, TAKE_ALL.
 * Native ETH goes in as msg.value and comes out as ETH. An ERC-20 input is pulled by Permit2, so it needs an exact
 * ERC-20 approval to Permit2 and an exact Permit2 allowance for the router that expires in 30 minutes.
 */
async function buildV4({ c, from, tIn, tOut, amountIn, best, minOut }) {
  for (const k of best.keys) if (!isAllowedHook(k.hooks)) throw new Error(`Refusing to prepare a swap through a v4 pool with unknown hook ${k.hooks}. Holbric only swaps through hookless pools and the Pons V2 hook.`);
  const txs = [], lines = [];
  if (!tIn.native) {
    const allowance = await c.readContract({ address: tIn.address, abi: erc20Abi, functionName: "allowance", args: [from, ADDR.PERMIT2] });
    if (allowance < amountIn) {
      txs.push(approveTx(tIn.address, ADDR.PERMIT2, amountIn, tIn.symbol, tIn.decimals));
      lines.push(`Approve exactly ${fmt(amountIn, tIn.decimals, 18)} ${tIn.symbol} for Permit2 ${ADDR.PERMIT2}, which the Uniswap Universal Router uses to pull tokens (current allowance ${fmt(allowance, tIn.decimals, 18)}). Not unlimited.`);
    }
    const [p2amount, p2exp] = await c.readContract({ address: ADDR.PERMIT2, abi: permit2Abi, functionName: "allowance", args: [from, tIn.address, ADDR.UNIVERSAL_ROUTER] });
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (p2amount < amountIn || BigInt(p2exp) < now + 15n * 60n) {
      const exp = now + 30n * 60n;
      txs.push({ label: `Permit2: allow Universal Router to pull exactly ${fmt(amountIn, tIn.decimals, 18)} ${tIn.symbol}, expires in 30 minutes`, to: ADDR.PERMIT2, value: 0n,
        data: encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [tIn.address, ADDR.UNIVERSAL_ROUTER, amountIn, Number(exp)] }) });
      lines.push(`Permit2: let Uniswap Universal Router ${ADDR.UNIVERSAL_ROUTER} pull exactly ${fmt(amountIn, tIn.decimals, 18)} ${tIn.symbol}, expiring 30 minutes from now. Not unlimited.`);
    }
  }
  txs.push({ label: `swap ${fmt(amountIn, tIn.decimals, 18)} ${tIn.symbol} -> ${tOut.symbol} on Uniswap v4 (Universal Router, ${best.hops === 1 ? "exact in, single pool" : "exact in, " + best.hops + " hops"})`,
    to: ADDR.UNIVERSAL_ROUTER, data: encodeV4Swap(best, amountIn, minOut, deadlineIn(15)), value: tIn.native ? amountIn : 0n });
  const pons = best.keys.some(isPonsKey) ? " The Pons pool's hook takes its fee and creator tax from the output; both are already inside the expected amount." : "";
  return { txs, lines, routeLine: `Route: ${describe(best)}${tIn.native ? " (native ETH, no wrapping)" : ""}${tOut.native ? " (paid out as native ETH)" : ""}. v4 pool ids: ${best.pools.join(", ")}.${pons}` };
}

export async function balances({ address, tokens = [] }) {
  const who = address || walletAddress();
  if (!who) throw new Error("No address given and no Holbric wallet yet.");
  if (!isAddress(who)) throw new Error(`Not an address: ${who}`);
  const c = publicClient();
  const list = [await resolveToken("USDG"), await resolveToken("WETH"), ...(await Promise.all(tokens.map(resolveToken)))];
  const [eth, block, ...erc] = await Promise.all([
    c.getBalance({ address: who }), c.getBlockNumber(),
    ...list.map((t) => c.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [who] })),
  ]);
  return {
    address: getAddress(who), chainId: CHAIN_ID, block: block.toString(), readAt: new Date().toISOString(),
    balances: [{ symbol: "ETH", type: "native", amount: fmt(eth, 18, 18), raw: eth.toString() },
      ...list.map((t, i) => ({ symbol: t.symbol, contract: t.address, amount: fmt(erc[i], t.decimals, 18), raw: erc[i].toString(), decimals: t.decimals }))],
  };
}

export async function routerWeth() {
  return publicClient().readContract({ address: ADDR.SWAP_ROUTER_02, abi: routerAbi, functionName: "WETH9" });
}

// ---------------------------------------------------------------------------------------------------------------------
// KyberSwap next to Holbric's own routing (0.6.0). Holbric's routes come from on-chain quoters; KyberSwap's come from its
// third-party API and are only counted after the router call is simulated on mainnet. The higher simulated output wins.

/** a vs b in percent, 4 decimals (positive when a is larger). */
const pctDiff = (a, b) => (b > 0n ? Number(((a - b) * 1000000n) / b) / 10000 : null);
const venueName = (r) => venueLabel(r);

async function resolvePair(tokenIn, tokenOut, amount) {
  const [tIn, tOut] = await Promise.all([resolveToken(tokenIn), resolveToken(tokenOut)]);
  if (poolAddress(tIn) === poolAddress(tOut)) throw new Error("tokenIn and tokenOut are the same asset (ETH and WETH share one pool side). Use a wrap, not a swap.");
  if (!/^\d+(\.\d+)?$/.test(String(amount))) throw new Error("amount must be a positive decimal string, e.g. \"5\" or \"0.25\".");
  const amountIn = parseUnits(String(amount), tIn.decimals);
  if (amountIn <= 0n) throw new Error("amount must be greater than zero.");
  return { tIn, tOut, amountIn };
}

/** KyberSwap leg of a comparison. Never throws: returns { status, route, sim, apiAmountOut, amountOut (simulated), reason }. */
async function kyberLeg({ tIn, tOut, amountIn }) {
  if (!aggregatorsEnabled()) return { status: "off", reason: `KyberSwap is turned off (${disabledReason()}); nothing was sent to it.` };
  let route;
  try { route = await kyberRoute({ tIn, tOut, amountIn }); } catch (e) { return { status: "failed", reason: e.message }; }
  const sim = await kyberSimulate({ route, tIn, tOut, amountIn }).catch((e) => ({ simulated: false, reason: e.message }));
  const base = { route, sim, apiAmountOut: route.amountOut };
  if (sim.simulated && sim.ok) return { ...base, status: "simulated", amountOut: sim.received };
  if (sim.simulated) return { ...base, status: "reverts", reason: `the router call reverts in a mainnet simulation (${sim.reason})` };
  return { ...base, status: "not simulated", reason: sim.reason };
}

function kyberView(k, tOut, nativeOut) {
  if (!k.route) return { status: k.status, reason: k.reason };
  const r = k.route, d = r.description;
  return {
    status: k.status, source: "KyberSwap Aggregator API (third party), aggregator-api.kyberswap.com/robinhood",
    route: d.text, sources: d.sources, splits: d.paths.length, hops: d.hops, pools: d.paths.flatMap((p) => p.pools),
    apiAmountOut: fmt(k.apiAmountOut, tOut.decimals, 18), apiAmountOutRaw: k.apiAmountOut.toString(),
    ...(k.amountOut != null ? { simulatedAmountOut: fmt(k.amountOut, tOut.decimals, 18), simulatedAmountOutRaw: k.amountOut.toString(),
      simulatedAtBlock: k.sim.block, simulatedVsApiPct: pctDiff(k.amountOut, k.apiAmountOut) } : {}),
    ...(nativeOut != null && k.amountOut != null ? { vsHolbricNativePct: pctDiff(k.amountOut, nativeOut) } : {}),
    ...(k.reason ? { reason: k.reason } : {}),
    router: KYBER_ROUTER, gasEstimate: String(r.gas), requestedAt: r.requestedAt.toISOString(), routeId: r.routeId,
    check: "Counted only after its router call was simulated on mainnet (eth_simulateV1) from a throwaway address with a pretend balance. Your wallet address is not sent for a quote.",
  };
}

/**
 * Best quote over Holbric's own routing and KyberSwap. venue: "best" (default: native v3+v4 and KyberSwap), "native"
 * (v3+v4 only, nothing sent to KyberSwap), "kyber" (KyberSwap only), "v3" or "v4".
 * KyberSwap wins only when its simulated output is higher than the best native route.
 */
export async function bestQuote({ tokenIn, tokenOut, amount, venue = "best" }) {
  if (!ALL_VENUES.includes(venue)) throw new Error(`venue must be one of ${ALL_VENUES.join(", ")}.`);
  if (venue === "kyber" && !aggregatorsEnabled()) throw new Error(`KyberSwap is turned off (${disabledReason()}). Use venue "native", or turn it on with \`holbric aggregators on\`.`);
  const { tIn, tOut, amountIn } = await resolvePair(tokenIn, tokenOut, amount);
  const wantKyber = venue === "best" || venue === "kyber";
  const [nr, k] = await Promise.all([
    venue === "kyber" ? null : quote({ tokenIn, tokenOut, amount, venue }).then((v) => ({ v }), (e) => ({ e })),
    wantKyber ? kyberLeg({ tIn, tOut, amountIn }) : null,
  ]);
  const n = nr?.v || null;
  const kOut = k ? (k.amountOut ?? (venue === "kyber" && k.status === "not simulated" ? k.apiAmountOut : null)) : null;
  let winner;
  if (venue === "kyber") {
    if (kOut == null) throw new Error(`KyberSwap gave no usable route for ${tIn.symbol} -> ${tOut.symbol}: ${k.reason}`);
    winner = "kyber";
  } else if (!n) {
    if (kOut == null) throw new Error(`${nr.e.message}${k ? ` KyberSwap: ${k.reason}` : ""}`);
    winner = "kyber";
  } else winner = kOut != null && kOut > n.best.amountOut ? "kyber" : "native";
  const nativeOut = n ? n.best.amountOut : null;
  const kv = k ? kyberView(k, tOut, nativeOut) : { status: "not asked", reason: `venue "${venue}" uses Holbric's own routing only; nothing was sent to KyberSwap.` };
  const block = n ? n.block : await publicClient().getBlockNumber();
  let view;
  if (winner === "native") view = { ...n.view, bestSource: "Holbric (Uniswap routing read from the chain)", kyberswap: kv };
  else {
    const d = k.route.description;
    view = {
      chainId: CHAIN_ID, block: block.toString(), quotedAt: new Date().toISOString(), quotedAtLocal: localTime(new Date()),
      venue: "KyberSwap Aggregator API (third party), output checked by a mainnet simulation", bestVenue: "KyberSwap", bestSource: "KyberSwap",
      tokenIn: { symbol: tIn.symbol, address: tIn.address ?? "native", amount: fmt(amountIn, tIn.decimals, 18) },
      tokenOut: { symbol: tOut.symbol, address: tOut.address ?? "native", amountOut: fmt(kOut, tOut.decimals, 18), amountOutRaw: kOut.toString() },
      route: d.text, hops: d.hops, sources: d.sources, router: KYBER_ROUTER,
      price: `1 ${tIn.symbol} = ${(Number(formatUnits(kOut, tOut.decimals)) / Number(amount)).toPrecision(8)} ${tOut.symbol}`,
      gasEstimate: String(k.route.gas),
      holbricNative: n ? { bestVenue: n.view.bestVenue, route: n.view.route, amountOut: n.view.tokenOut.amountOut, amountOutRaw: n.view.tokenOut.amountOutRaw,
        vsKyberPct: pctDiff(n.best.amountOut, kOut), routesQuoted: n.all.length } : { status: "no route", reason: nr ? nr.e.message : "not asked (venue kyber)" },
      kyberswap: kv,
      ...(k.amountOut == null ? { warning: `KyberSwap's amount is its own API estimate and could not be simulated: ${k.reason}` } : {}),
      ...(tIn.unverified || tOut.unverified ? { warning2: "One token is not in Holbric's verified list (ETH, USDG, WETH). Check the contract on the explorer." } : {}),
    };
  }
  return { tIn, tOut, amountIn, native: n, kyber: k, winner, block, view, venue, kOut };
}

/** find_route: every Uniswap v3 and v4 route Holbric compared, KyberSwap next to them, and the winner. */
export async function findRoute(args) {
  const b = await bestQuote(args);
  const { tOut, native: q, kyber: k, winner, kOut } = b;
  const kEntry = winner === "kyber" ? { venue: "KyberSwap", route: k.route.description.text, hops: k.route.description.hops, sources: k.route.description.sources,
    amountOut: fmt(kOut, tOut.decimals, 18), amountOutRaw: kOut.toString(), gasEstimate: String(k.route.gas), router: KYBER_ROUTER } : null;
  const best = winner === "kyber" ? kEntry : routeView(q.best, tOut, null);
  const alternatives = q ? (winner === "kyber" ? q.found.routes.map((r) => ({ ...routeView(r, tOut, null), vsBestPct: pctDiff(r.amountOut, kOut) }))
    : q.found.routes.slice(1).map((r) => routeView(r, tOut, q.best))) : [];
  const v = q ? q.view : b.view;
  return {
    chainId: CHAIN_ID, block: b.block.toString(), quotedAtLocal: v.quotedAtLocal, venue: b.venue, winner: winner === "kyber" ? "KyberSwap" : "Holbric",
    tokenIn: v.tokenIn, tokenOut: { symbol: tOut.symbol, address: tOut.address ?? "native" },
    best, alternatives,
    kyberswap: b.view.kyberswap,
    compared: q ? { v3Routes: q.found.v3.routes, v4Routes: q.found.v4.routes, ramsesRoutes: q.found.ramses.routes, livePoolsRead: q.found.poolsRead } : { v3Routes: 0, v4Routes: 0, ramsesRoutes: 0, livePoolsRead: 0 },
    notQuoted: q ? q.found.failed : [],
    method: [
      q && ["best", "v3"].includes(q.venue) ? `Uniswap v3: direct pools at ${FEE_TIERS.map((f) => f / 10000 + "%").join(", ")} plus 2-hop routes through ${q.found.v3.via.join(", ")}, read from the v3 factory, each path quoted with QuoterV2.quoteExactInput.` : null,
      q && ["best", "v4"].includes(q.venue) ? `Uniswap v4: hookless pools at the standard keys (0.01%/1, 0.05%/10, 0.3%/60, 1%/200) and graduated Pons V2 pools (key from the Pons factory record, Pons hook), direct or 2 hops through ${q.found.v4.via.join(", ") || "none"}, liquidity read from StateView, each path quoted with V4Quoter. Pools with any other hook are skipped.` : null,
      q && ["best", "ramses"].includes(q.venue) ? `Ramses V3: pools from the Ramses factory at tick spacings ${TICK_SPACINGS.join(", ")} (each pool's fee read at this block; Ramses can change it), direct or 2 hops through ${q.found.ramses.via.join(", ") || "none"}, each path quoted with the Ramses QuoterV2.` : null,
      q ? "Pools with zero in-range liquidity are skipped, up to 3 pools per leg (2 on Ramses). A route stays on one venue." : null,
      k ? "KyberSwap: route from its third-party API, router call simulated on mainnet; it only counts with a simulated output." : null,
      "The highest output wins; prepare_swap uses the same choice and simulates again from your wallet.",
    ].filter(Boolean).join(" "),
    ...(v.warning ? { warning: v.warning } : {}),
  };
}

/** compare_quotes: Holbric's own best route against KyberSwap, side by side, at one block. */
export async function compareQuotes({ tokenIn, tokenOut, amount }) {
  const b = await bestQuote({ tokenIn, tokenOut, amount, venue: "best" });
  const { tIn, tOut, native: n, kyber: k, winner, kOut } = b;
  const blk = await publicClient().getBlock({ blockNumber: b.block });
  const nativeView = n ? { venue: venueName(n.best), route: describe(n.best), hops: n.best.hops, amountOut: fmt(n.best.amountOut, tOut.decimals, 18),
    amountOutRaw: n.best.amountOut.toString(), gasEstimate: n.best.gasEstimate.toString(), routesCompared: n.all.length,
    method: "Uniswap v3 QuoterV2 and v4 V4Quoter, read from the chain at this block" } : { status: "no route", reason: "Holbric found no live Uniswap v3 or v4 route" };
  const nOut = n ? n.best.amountOut : null;
  const margin = winner === "kyber" ? (nOut ? pctDiff(kOut, nOut) : null) : (k?.amountOut != null ? pctDiff(nOut, k.amountOut) : null);
  return {
    chainId: CHAIN_ID, block: b.block.toString(), blockTime: new Date(Number(blk.timestamp) * 1000).toISOString(), quotedAtLocal: localTime(new Date()),
    tokenIn: { symbol: tIn.symbol, address: tIn.address ?? "native", amount: fmt(b.amountIn, tIn.decimals, 18) },
    tokenOut: { symbol: tOut.symbol, address: tOut.address ?? "native" },
    holbric: nativeView,
    kyberswap: b.view.kyberswap,
    winner: winner === "kyber" ? "KyberSwap" : "Holbric",
    ...(margin != null ? { winnerAheadPct: margin } : { note: k?.status === "off" ? "KyberSwap is off, so only Holbric was quoted." : `KyberSwap did not give a simulated output: ${k?.reason}` }),
    prepareSwap: "prepare_swap with venue \"best\" makes the same choice, then builds and simulates the real transaction from your wallet before you sign.",
    privacy: "KyberSwap is a third-party API. This comparison sent the two token addresses and the amount to aggregator-api.kyberswap.com, not your wallet address. prepare_swap sends your wallet address only when KyberSwap's quote is ahead. Turn it off with HOLBRIC_NO_AGGREGATORS=1 or `holbric aggregators off`.",
  };
}

/**
 * prepare_swap. venue "best" (default) quotes Holbric's own routes and KyberSwap. If KyberSwap's quote is higher, Holbric
 * asks KyberSwap to build the transaction for this wallet, decodes and checks the calldata, and simulates it from the
 * wallet; KyberSwap is used only if that simulated output still beats the best native route. Any KyberSwap failure falls
 * back to the native route with the reason in the summary. "kyber" uses KyberSwap only; "native", "v3", "v4" never ask it.
 */
export async function prepareSwap(args) {
  const { tokenIn, tokenOut, amount, slippageBps, venue = "best", poolKey = null } = args;
  if (!ALL_VENUES.includes(venue)) throw new Error(`venue must be one of ${ALL_VENUES.join(", ")}.`);
  if (poolKey || venue === "v3" || venue === "v4" || venue === "ramses" || venue === "native") return prepareNative(args);
  if (!aggregatorsEnabled()) {
    if (venue === "kyber") throw new Error(`KyberSwap is turned off (${disabledReason()}). Use venue "native", or turn it on with \`holbric aggregators on\`.`);
    return prepareNative({ ...args, venue: "best", extraLines: [...(args.extraLines || []), `KyberSwap was not asked: it is turned off (${disabledReason()}).`] });
  }
  const from = requireWallet();
  const slip = slippage(slippageBps);
  const { tIn, tOut, amountIn } = await resolvePair(tokenIn, tokenOut, amount);
  const c = publicClient();
  // Balance and daily limit first, so an action that cannot go ahead never sends anything to KyberSwap.
  const balance = tIn.native ? await c.getBalance({ address: from }) : await c.readContract({ address: tIn.address, abi: erc20Abi, functionName: "balanceOf", args: [from] });
  if (balance < amountIn) throw new Error(`Not enough ${tIn.symbol}: wallet ${from} holds ${fmt(balance, tIn.decimals, 18)}, swap needs ${fmt(amountIn, tIn.decimals, 18)}. Nothing was prepared.`);
  const usd = await usdValue(tIn, amountIn).catch(() => null);
  checkLimit(usd);
  const [nr, kr] = await Promise.all([
    venue === "best" ? quote({ tokenIn, tokenOut, amount, venue: "best" }).then((v) => ({ v }), (e) => ({ e })) : null,
    kyberRoute({ tIn, tOut, amountIn }).then((v) => ({ v }), (e) => ({ e })),
  ]);
  const n = nr?.v || null;
  const fallback = (why) => {
    if (venue === "kyber") throw new Error(`KyberSwap route not prepared: ${why}. Nothing was prepared. venue "best" or "native" uses Holbric's own routing.`);
    if (!n) throw new Error(`${nr.e.message} KyberSwap was not usable either: ${why}.`);
    return prepareNative({ ...args, venue: "best", q: n, extraLines: [...(args.extraLines || []), `KyberSwap was compared and not used: ${why}.`] });
  };
  if (kr.e) return fallback(kr.e.message);
  const r = kr.v;
  const nOut = n ? n.best.amountOut : null;
  const nText = n ? `${fmt(nOut, tOut.decimals)} ${tOut.symbol} on Holbric's best ${venueName(n.best)} route (${describe(n.best)})` : null;
  if (n && r.amountOut <= nOut) return fallback(`its quote of ${fmt(r.amountOut, tOut.decimals)} ${tOut.symbol} is not above ${nText}`);
  // KyberSwap quotes higher: only now is the wallet address sent to KyberSwap, to build the transaction.
  let built;
  try { built = await kyberBuild({ route: r, tIn, tOut, amountIn, sender: from, slippageBps: slip, deadline: deadlineIn(15) }); }
  catch (e) { return fallback(e.message); }
  const txs = [], lines = [];
  if (!tIn.native) {
    const allowance = await c.readContract({ address: tIn.address, abi: erc20Abi, functionName: "allowance", args: [from, KYBER_ROUTER] });
    if (allowance < amountIn) {
      txs.push(approveTx(tIn.address, KYBER_ROUTER, amountIn, tIn.symbol, tIn.decimals));
      lines.push(`Approve exactly ${fmt(amountIn, tIn.decimals, 18)} ${tIn.symbol} for the KyberSwap router, MetaAggregationRouterV2 ${KYBER_ROUTER} (current allowance ${fmt(allowance, tIn.decimals, 18)}). Not unlimited.`);
    }
  }
  txs.push({ label: `swap ${fmt(amountIn, tIn.decimals, 18)} ${tIn.symbol} -> ${tOut.symbol} on KyberSwap (MetaAggregationRouterV2.${built.fn})`, ...built.tx });
  const sim = await simulateTxs(from, txs);
  if (!sim.ok) { const bad = sim.steps.find((x) => x.status === "failure"); return fallback(`its transaction reverts in a mainnet simulation at "${bad.step}" (${bad.error})`); }
  const received = sim._raw ? (sim._raw.inflows.get(outKey(tOut)) ?? 0n) : null;
  if (received == null) return fallback("this RPC cannot trace the simulated output");
  if (received < built.minReturn) return fallback(`the simulated transaction delivers ${fmt(received, tOut.decimals)} ${tOut.symbol}, below its own minimum of ${fmt(built.minReturn, tOut.decimals)}`);
  if (n && received <= nOut) return fallback(`KyberSwap quoted ${fmt(r.amountOut, tOut.decimals)} ${tOut.symbol}, but its simulated transaction delivers ${fmt(received, tOut.decimals)}, not above ${nText}`);
  const inKey = tIn.native ? NATIVE_TRACE : getAddress(tIn.address);
  let spent = 0n;
  for (const [key, v] of sim._raw.outflows) if (key.split(">")[0] === inKey) spent += v;
  if (spent > amountIn) return fallback(`the simulation takes ${fmt(spent, tIn.decimals)} ${tIn.symbol} from the wallet, more than ${fmt(amountIn, tIn.decimals)}`);
  const d = r.description;
  lines.push(`Swap ${fmt(amountIn, tIn.decimals, 18)} ${tIn.symbol} for at least ${fmt(built.minReturn, tOut.decimals)} ${tOut.symbol} (KyberSwap expects ${fmt(built.amountOut, tOut.decimals)}, the mainnet simulation of this exact transaction gives ${fmt(received, tOut.decimals)}) through KyberSwap. Slippage limit ${(slip / 100).toFixed(2)}%, deadline 15 minutes from now.`);
  lines.push(`Route from the KyberSwap Aggregator API (third party): ${d.text}. Sources: ${d.sources.join(", ")}. KyberSwap built the calldata; Holbric decoded it and checked the router ${KYBER_ROUTER}, the executor, the tokens, the amount, that the output goes to this wallet, the minimum output, and that no fee receivers or permit are set.`);
  lines.push(n ? `Compared at block ${n.block}: KyberSwap ${fmt(received, tOut.decimals)} ${tOut.symbol} (simulated) vs ${nText}, ${pctDiff(received, nOut) >= 0 ? "+" : ""}${pctDiff(received, nOut)}% for KyberSwap. No Holbric fee and no KyberSwap fee parameter.` : (nr ? `Holbric found no native route (${nr.e.message}).` : "Holbric's own routing was not compared (venue kyber)."));
  lines.push(...(args.extraLines || []));
  const view = { chainId: CHAIN_ID, block: (n ? n.block : sim.block).toString(), bestVenue: "KyberSwap", route: d.text, sources: d.sources, router: KYBER_ROUTER,
    tokenIn: { symbol: tIn.symbol, address: tIn.address ?? "native", amount: fmt(amountIn, tIn.decimals, 18) },
    tokenOut: { symbol: tOut.symbol, address: tOut.address ?? "native", apiAmountOut: fmt(built.amountOut, tOut.decimals, 18), simulatedAmountOut: fmt(received, tOut.decimals, 18), minOut: fmt(built.minReturn, tOut.decimals, 18) },
    ...(n ? { holbricNative: { bestVenue: venueName(n.best), route: describe(n.best), amountOut: fmt(nOut, tOut.decimals, 18), amountOutRaw: nOut.toString() } } : {}) };
  return store({ kind: "kyberswap_swap", from, txs, lines, usd, onReceipt: receiptReader(from, tOut), slippageBps: slip, extra: { quote: view },
    minReceive: { token: outKey(tOut), amount: built.minReturn, symbol: tOut.symbol, decimals: tOut.decimals } });
}
