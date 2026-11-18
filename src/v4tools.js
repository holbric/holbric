// Read tools for Uniswap v4 on Robinhood Chain: list the v4 pools Holbric can see for a pair, and quote on v4 only.
import { getAddress, isAddress } from "viem";
import { ADDR, CHAIN_ID, publicClient, resolveToken, fmt } from "./chain.js";
import { candidateKeys, poolState, priceFromSqrt, currencyOf, NATIVE, isAllowedHook, makeKey } from "./v4.js";
import { quote } from "./swap.js";
import { routeView } from "./route.js";

const pct = (fee) => `${fee / 10000}%`;

/** v4_pools: every candidate v4 pool for a pair, with state read from StateView. */
export async function v4Pools({ tokenA, tokenB }) {
  const [a, b] = await Promise.all([resolveToken(tokenA), resolveToken(tokenB)]);
  const ca = currencyOf(a), cb = currencyOf(b);
  if (ca === cb) throw new Error("tokenA and tokenB are the same currency.");
  const cands = await candidateKeys(ca, cb);
  const [states, block] = await Promise.all([Promise.all(cands.map((c) => poolState(c.key))), publicClient().getBlockNumber()]);
  const sym = (cur) => (cur === ca ? a : b);
  const pools = cands.map((c, i) => {
    const st = states[i], t0 = sym(c.key.currency0), t1 = sym(c.key.currency1);
    const row = {
      kind: c.kind === "pons" ? "Pons V2 graduated pool (Pons hook)" : `hookless ${pct(c.key.fee)}`,
      poolId: st.id, poolKey: c.key, initialized: st.initialized, liquidity: st.liquidity.toString(), live: st.initialized && st.liquidity > 0n,
    };
    if (st.initialized) {
      const p = priceFromSqrt(st.sqrtPriceX96, t0.decimals, t1.decimals);
      Object.assign(row, { tick: st.tick, lpFee: pct(st.lpFee), protocolFee: st.protocolFee, price: `1 ${t0.symbol} = ${p.toPrecision(8)} ${t1.symbol}`, priceInverse: `1 ${t1.symbol} = ${(1 / p).toPrecision(8)} ${t0.symbol}` });
    }
    if (c.pons) Object.assign(row, { ponsHookFee: `${c.pons.hookFeeBps / 100}%`, ponsCreatorTax: `${c.pons.creatorTaxBps / 100}%`, ponsCurve: c.pons.curve,
      feeNote: "The pool's LP fee is 0; the Pons hook takes its fee and the creator tax from each swap's output." });
    return row;
  });
  return {
    chainId: CHAIN_ID, block: block.toString(), poolManager: ADDR.V4_POOL_MANAGER, stateView: ADDR.V4_STATE_VIEW,
    pair: [{ symbol: a.symbol, currency: ca === NATIVE ? "native ETH (0x0)" : ca }, { symbol: b.symbol, currency: cb === NATIVE ? "native ETH (0x0)" : cb }],
    livePools: pools.filter((p) => p.live).length, checked: pools.length, pools,
    method: "Uniswap v4 pools have no factory lookup; a pool is its key. Checked the four hookless standard keys (0.01%/1, 0.05%/10, 0.3%/60, 1%/200) and, when one side is a graduated Pons V2 launch paired with the other, the key from the Pons factory record with the Pons hook (registered on the hook). Pools with other hooks or non-standard fees are not listed. On v4, native ETH and WETH are different currencies.",
  };
}

/** quote_v4: v4-only quote, best discovered route or one given pool key. */
export async function quoteV4({ tokenIn, tokenOut, amount, poolKey }) {
  if (poolKey) {
    for (const f of ["currency0", "currency1"]) if (!isAddress(poolKey[f] || "")) throw new Error(`poolKey.${f} must be a 0x address (native ETH is 0x0000000000000000000000000000000000000000).`);
    if (poolKey.hooks && !isAddress(poolKey.hooks)) throw new Error("poolKey.hooks must be a 0x address.");
  }
  const q = await quote({ tokenIn, tokenOut, amount, venue: "v4", poolKey });
  const k = poolKey ? makeKey(poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks || NATIVE) : null;
  return {
    ...q.view,
    best: routeView(q.best, q.tOut, null),
    ...(k && !isAllowedHook(k.hooks) ? { hookWarning: `Hook ${getAddress(k.hooks)} is not one Holbric knows. This is a quote only; prepare_swap never routes through unknown hooks.` } : {}),
    note: "Uniswap v4 only. quote_swap and find_route compare v4 against v3 and pick the better one.",
  };
}
