import { parseUnits, formatUnits, erc20Abi, encodeFunctionData, getAddress, isAddress, decodeEventLog } from "viem";
import { ADDR, publicClient, resolveToken, poolAddress, CHAIN_ID, fmt, localTime } from "./chain.js";
import { walletAddress } from "./keystore.js";
import { requireWallet, slippage, checkLimit, approveTx, store } from "./actions.js";
import { findRoutes, describe, routeView, feeText, FEE_TIERS } from "./route.js";
import { findV4Routes, currencyOf, encodeV4Swap, permit2Abi, isPonsKey, isAllowedHook, makeKey, NATIVE } from "./v4.js";

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

const VENUES = ["best", "v3", "v4"];
const V3_VENUE = `Uniswap v3 QuoterV2 ${ADDR.QUOTER_V2} (quoteExactInput), pools from factory ${ADDR.UNISWAP_V3_FACTORY}`;
const V4_VENUE = `Uniswap v4 V4Quoter ${ADDR.V4_QUOTER}, pools read from StateView ${ADDR.V4_STATE_VIEW} (PoolManager ${ADDR.V4_POOL_MANAGER})`;
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
  const [v3, v4] = await Promise.all([
    venue === "v4" ? empty : findRoutes({ tIn, tOut, addrIn: poolAddress(tIn), addrOut: poolAddress(tOut), amountIn }),
    venue === "v3" ? empty : findV4Routes({ symIn: tIn.symbol, symOut: tOut.symbol, cIn: currencyOf(tIn), cOut: currencyOf(tOut), amountIn, onlyKey }),
  ]);
  const all = [...v3.routes, ...v4.routes].sort(byOutput);
  const failed = [...v3.failed, ...v4.failed.map(describe)];
  const found = { routes: all, failed, poolsRead: v3.poolsRead + v4.poolsRead, v3: { routes: v3.routes.length, pools: v3.poolsRead, via: v3.intermediatesTried }, v4: { routes: v4.routes.length, pools: v4.poolsRead, via: v4.intermediatesTried } };
  const best = all[0];
  if (!best) throw new Error(onlyKey
    ? `Uniswap v4 returned no quote for ${tIn.symbol} -> ${tOut.symbol} on that pool key (pool not initialized, no liquidity in range, or the swap reverts).`
    : `No ${venue === "best" ? "Uniswap v3 or v4" : "Uniswap " + venue} route on Robinhood Chain quoted ${tIn.symbol} -> ${tOut.symbol}: no live pool directly and none through ${[...new Set([...v3.intermediatesTried, ...v4.intermediatesTried])].join(", ") || "any middle token"}.`);
  const block = await publicClient().getBlockNumber();
  const priceOutPerIn = Number(formatUnits(best.amountOut, tOut.decimals)) / Number(amount);
  const venueText = venue === "v3" ? V3_VENUE : venue === "v4" ? V4_VENUE : `${V3_VENUE}; ${V4_VENUE}`;
  return {
    tIn, tOut, amountIn, best, all, found, block, venue,
    view: {
      chainId: CHAIN_ID, block: block.toString(), quotedAt: new Date().toISOString(), quotedAtLocal: localTime(new Date()),
      venue: venueText, bestVenue: best.venue === "v4" ? "Uniswap v4" : "Uniswap v3",
      tokenIn: { symbol: tIn.symbol, address: tIn.address ?? "native", amount: fmt(amountIn, tIn.decimals, 18) },
      tokenOut: { symbol: tOut.symbol, address: tOut.address ?? "native", amountOut: fmt(best.amountOut, tOut.decimals, 18), amountOutRaw: best.amountOut.toString() },
      route: describe(best), hops: best.hops, routeTokens: best.symbols, feeTier: feeText(best),
      ...(best.venue === "v4" ? { poolIds: best.pools, poolKeys: best.keys } : { pools: best.pools }),
      price: `1 ${tIn.symbol} = ${priceOutPerIn.toPrecision(8)} ${tOut.symbol}`,
      gasEstimate: best.gasEstimate.toString(),
      compared: { routesQuoted: all.length, v3Routes: v3.routes.length, v4Routes: v4.routes.length, livePoolsRead: found.poolsRead,
        via: [...new Set([...v3.intermediatesTried, ...v4.intermediatesTried])], noQuote: failed.length },
      alternatives: all.slice(1, 8).map((r) => ({ route: describe(r), amountOut: fmt(r.amountOut, tOut.decimals, 18), vsBestPct: routeView(r, tOut, best).vsBestPct })),
      ...(tIn.unverified || tOut.unverified ? { warning: "One token is not in Holbric's verified list (ETH, USDG, WETH). Check the contract on the explorer." } : {}),
    },
  };
}

/** find_route: every route that was compared on v3 and v4, with pools, gas and the gap to the best one. */
export async function findRoute(args) {
  const q = await quote(args);
  const { tOut, best, found } = q;
  return {
    chainId: CHAIN_ID, block: q.view.block, quotedAtLocal: q.view.quotedAtLocal, venue: q.view.venue,
    tokenIn: q.view.tokenIn, tokenOut: { symbol: tOut.symbol, address: tOut.address ?? "native" },
    best: routeView(best, tOut, null),
    alternatives: found.routes.slice(1).map((r) => routeView(r, tOut, best)),
    compared: { v3Routes: found.v3.routes, v4Routes: found.v4.routes, livePoolsRead: found.poolsRead },
    notQuoted: found.failed,
    method: [
      q.venue !== "v4" ? `Uniswap v3: direct pools at ${FEE_TIERS.map((f) => f / 10000 + "%").join(", ")} plus 2-hop routes through ${found.v3.via.join(", ")}, read from the v3 factory, each path quoted with QuoterV2.quoteExactInput.` : null,
      q.venue !== "v3" ? `Uniswap v4: hookless pools at the standard keys (0.01%/1, 0.05%/10, 0.3%/60, 1%/200) and graduated Pons V2 pools (key from the Pons factory record, Pons hook), direct or 2 hops through ${found.v4.via.join(", ") || "none"}, liquidity read from StateView, each path quoted with V4Quoter. Pools with any other hook are skipped.` : null,
      "Pools with zero in-range liquidity are skipped, up to 3 pools per leg. A route stays on one Uniswap version. The highest output wins; prepare_swap uses the same choice.",
    ].filter(Boolean).join(" "),
    ...(q.view.warning ? { warning: q.view.warning } : {}),
  };
}

/** USD value of an input amount: USDG is 1:1, everything else is quoted into USDG. */
export async function usdValue(tIn, amountIn) {
  if (tIn.address === ADDR.USDG) return Number(formatUnits(amountIn, 6));
  if (amountIn === 0n) return 0;
  const q = await quote({ tokenIn: tIn.native ? "ETH" : tIn.address, tokenOut: "USDG", amount: formatUnits(amountIn, tIn.decimals) });
  return Number(formatUnits(q.best.amountOut, 6));
}

export async function prepareSwap({ tokenIn, tokenOut, amount, slippageBps, venue = "best", poolKey = null, kind = "uniswap_swap", extraLines = [] }) {
  const from = requireWallet();
  const slip = slippage(slippageBps);
  const q = await quote({ tokenIn, tokenOut, amount, venue, poolKey });
  const c = publicClient();
  const { tIn, tOut, amountIn, best } = q;
  const minOut = (best.amountOut * BigInt(10000 - slip)) / 10000n;
  const balance = tIn.native ? await c.getBalance({ address: from }) : await c.readContract({ address: tIn.address, abi: erc20Abi, functionName: "balanceOf", args: [from] });
  if (balance < amountIn) throw new Error(`Not enough ${tIn.symbol}: wallet ${from} holds ${fmt(balance, tIn.decimals, 18)}, swap needs ${fmt(amountIn, tIn.decimals, 18)}. Nothing was prepared.`);
  const usd = await usdValue(tIn, amountIn).catch(() => null);
  checkLimit(usd);
  const built = best.venue === "v4" ? await buildV4({ c, from, tIn, tOut, amountIn, best, minOut }) : await buildV3({ c, from, tIn, tOut, amountIn, best, minOut });
  const { txs, lines } = built;
  lines.push(`Swap ${fmt(amountIn, tIn.decimals, 18)} ${tIn.symbol} for at least ${fmt(minOut, tOut.decimals)} ${tOut.symbol} (expected ${fmt(best.amountOut, tOut.decimals)}) on ${best.venue === "v4" ? "Uniswap v4" : "Uniswap v3"}. Slippage limit ${(slip / 100).toFixed(2)}%, deadline 15 minutes from now.`);
  lines.push(built.routeLine);
  const alts = q.all.slice(1, 6).map((r) => `${describe(r)} = ${fmt(r.amountOut, tOut.decimals)} ${tOut.symbol}`);
  lines.push(`Compared ${q.all.length} route${q.all.length > 1 ? "s" : ""} at block ${q.block} (${q.found.v3.routes} on Uniswap v3, ${q.found.v4.routes} on Uniswap v4)${alts.length ? `; next best: ${alts.join("; ")}` : "; no other route had a live pool"}.`);
  lines.push(...extraLines);
  const onReceipt = async (r) => {
    if (tOut.native) return {};
    for (const log of r.logs) {
      if (getAddress(log.address) !== getAddress(tOut.address)) continue;
      try { const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
        if (ev.eventName === "Transfer" && getAddress(ev.args.to) === getAddress(from)) return { received: `${fmt(ev.args.value, tOut.decimals, 18)} ${tOut.symbol}` }; } catch {}
    }
    return {};
  };
  return store({ kind, from, txs, lines, usd, onReceipt, slippageBps: slip, extra: { quote: q.view } });
}

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
