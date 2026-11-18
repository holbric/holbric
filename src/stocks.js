// Robinhood Stock Tokens: the official list behind docs.robinhood.com/chain/contracts (api.robinhood.com/rhj/assets).
import { getAddress, isAddress } from "viem";
import { RH_ASSETS, CHAIN_ID, getJson, addrLink } from "./chain.js";
import { quote } from "./swap.js";

let cache = null;
async function load() {
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return cache;
  const j = await getJson(RH_ASSETS, 20000);
  const rows = [];
  for (const a of j.assets || []) {
    const dep = (a.deployments || []).find((d) => d.chainId === CHAIN_ID);
    if (!dep) continue;
    rows.push({ symbol: a.tokenSymbol, name: a.tokenName, address: getAddress(dep.contractAddress), decimals: a.tokenDecimals, multiplier: a.currentMultiplier,
      status: a.status, marketTrading: a.tradingCapabilities?.market?.whole || null, isin: a.isin || null });
  }
  cache = { at: Date.now(), fetchedAt: new Date().toISOString(), rows };
  return cache;
}

export async function findStock(x) {
  const { rows } = await load();
  if (isAddress(x)) return rows.find((r) => r.address === getAddress(x)) || null;
  const q = String(x).trim().toUpperCase();
  return rows.find((r) => r.symbol.toUpperCase() === q) || null;
}

export async function stockTokens({ search, limit = 50 } = {}) {
  const { rows, fetchedAt } = await load();
  let list = rows;
  if (search) { const q = search.toUpperCase(); list = rows.filter((r) => r.symbol.toUpperCase().includes(q) || r.name.toUpperCase().includes(q)); }
  return { source: RH_ASSETS, fetchedAt, totalOnChain4663: rows.length, returned: Math.min(list.length, limit),
    note: "Only these contract addresses are canonical Robinhood Stock Tokens. A token with the same ticker at another address is not one.",
    tokens: list.slice(0, limit).map((r) => ({ ...r, explorer: addrLink(r.address) })) };
}

export async function stockQuote({ stock, side = "sell", amount }) {
  const s = await findStock(stock);
  if (!s) throw new Error(`"${stock}" is not in the official Robinhood Stock Token list. Call stock_tokens to search.`);
  const [tokenIn, tokenOut] = side === "buy" ? ["USDG", s.address] : [s.address, "USDG"];
  let q;
  try { q = await quote({ tokenIn, tokenOut, amount }); }
  catch { throw new Error(`No Uniswap v3 or v4 route against USDG quoted ${s.symbol} right now. There may be no pool for this stock token.`); }
  // Price impact vs a 1/100 size quote, so thin pools are obvious.
  const small = (Number(amount) / 100).toFixed(side === "buy" ? 6 : Math.min(s.decimals, 12));
  let impactPct = null;
  try {
    const qs = await quote({ tokenIn, tokenOut, amount: small });
    const p = Number(q.view.tokenOut.amountOut) / Number(amount), ps = Number(qs.view.tokenOut.amountOut) / Number(small);
    impactPct = +(((ps - p) / ps) * 100).toFixed(3);
  } catch {}
  const { warning, ...view } = q.view;
  return { stock: { symbol: s.symbol, name: s.name, address: s.address, multiplier: s.multiplier, listedBy: RH_ASSETS }, side, ...view,
    priceImpactVsSmallPct: impactPct,
    note: "Uniswap pool price on Robinhood Chain, not the stock-market price. Thin pools can quote far from the market. To trade, call prepare_swap with the contract address. Availability depends on your jurisdiction." };
}
