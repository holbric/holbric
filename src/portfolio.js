// Portfolio snapshot (0.7.0). Read-only: what an address holds on Robinhood Chain mainnet at one block, valued with
// Holbric's own Uniswap v3/v4 quotes. No third-party price feed and no aggregator API is asked. No PnL: see PNL_NOTE.
import { getAddress, isAddress, erc20Abi, formatUnits, parseAbiItem, parseUnits } from "viem";
import { publicClient, ADDR, CHAIN_ID, fmt, addrLink } from "./chain.js";
import { walletAddress } from "./keystore.js";
import { INTERMEDIATES } from "./route.js";
import { stockList } from "./stocks.js";
import { quote } from "./swap.js";
import { ponsQuote } from "./pons.js";
import { multi, mapLimit, tokenMeta, readPositions, KIND_TEXT, MORPHO } from "./morpho.js";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const LOG_SPAN = 30_000n; // the public RPC allows 30,000 blocks per getLogs without an address filter
const MAX_VALUED = 40;
export const PNL_NOTE = "PnL is not included. An honest PnL needs the price of every token at every past transfer. The public RPC keeps no historical state, so Holbric cannot quote past blocks, and it will not guess a cost basis. This is a value snapshot at one block.";

const val = (r) => (r && r.status === "success" ? r.result : null);
const usd = (x) => (x == null ? null : +x.toFixed(2));

/** Token addresses that sent `who` anything in the last `hours` (Transfer logs with to = who). */
async function recentInbound(who, latest, hours) {
  const c = publicClient();
  const prev = await c.getBlock({ blockNumber: latest.number - 100_000n });
  const bps = 100_000 / Math.max(1, Number(latest.timestamp - prev.timestamp));
  const span = BigInt(Math.ceil(hours * 3600 * bps));
  const from = latest.number - span + 1n;
  const jobs = []; for (let f = from; f <= latest.number; f += LOG_SPAN) jobs.push({ f, t: f + LOG_SPAN - 1n > latest.number ? latest.number : f + LOG_SPAN - 1n });
  const res = await mapLimit(jobs, 4, (j) => c.getLogs({ event: TRANSFER, args: { to: who }, fromBlock: j.f, toBlock: j.t }));
  const failed = res.filter((r) => !r.ok).length;
  const tokens = new Set(res.flatMap((r) => (r.ok ? r.value.map((l) => getAddress(l.address)) : [])));
  return { fromBlock: from.toString(), toBlock: latest.number.toString(), hours, requests: jobs.length, failedRequests: failed, tokens: [...tokens] };
}

/** USDG out for selling `amount` of `meta` now: Holbric's best Uniswap v3/v4 exact-input quote; Pons curve tokens on the curve. */
async function sellUsd(meta, amount, ethUsd) {
  if (amount === 0n) return { usd: 0, by: "zero" };
  if (meta.address === ADDR.USDG) return { usd: Number(formatUnits(amount, 6)), by: "USDG at face value" };
  const human = formatUnits(amount, meta.decimals);
  try {
    const q = await quote({ tokenIn: meta.native ? "ETH" : meta.address, tokenOut: "USDG", amount: human, venue: "uniswap" });
    return { usd: Number(formatUnits(q.best.amountOut, 6)), by: q.view.route };
  } catch (e) {
    if (meta.kind === "pons-v2-launch") {
      try {
        const p = await ponsQuote({ token: meta.address, side: "sell", amount: human });
        const stage = `Pons V2 ${p.phase === "graduated" ? "pool" : "bonding curve"}`;
        if (/ ETH$/.test(p.amountOut)) return { usd: Number(formatUnits(BigInt(p.amountOutRaw), 18)) * ethUsd, by: `${stage}, then x ETH price` };
        // Launches paired with another token (USDG or, for example, a Robinhood Stock Token): value the pair-token output
        // with Holbric's own Uniswap v3/v4 quote into USDG.
        if (!p.pairToken || p.pairToken === "ETH") throw new Error("unknown pair");
        const pairSym = p.amountOut.split(" ").pop();
        if (getAddress(p.pairToken) === ADDR.USDG) return { usd: Number(formatUnits(BigInt(p.amountOutRaw), 6)), by: `${stage} into USDG` };
        const pd = await publicClient().readContract({ address: p.pairToken, abi: erc20Abi, functionName: "decimals" });
        const pq = await quote({ tokenIn: p.pairToken, tokenOut: "USDG", amount: formatUnits(BigInt(p.amountOutRaw), Number(pd)), venue: "uniswap" });
        return { usd: Number(formatUnits(pq.best.amountOut, 6)), by: `${stage} into ${pairSym}, then ${pq.view.route}` };
      } catch {}
    }
    return { usd: null, by: "no Uniswap v3/v4 route quoted it" };
  }
}

/** USDG per whole token from a small quote (about $100 worth), so the price is close to the pool's current price. */
const priceCache = new Map();
async function priceOf(meta, ethUsd) {
  if (meta.address === ADDR.USDG) return { usd: 1, by: "USDG at face value" };
  if (meta.native || meta.address === ADDR.WETH) return { usd: ethUsd, by: "1 ETH quote" };
  if (priceCache.has(meta.address)) return priceCache.get(meta.address);
  let out = { usd: null, by: "no Uniswap v3/v4 route quoted it" };
  for (const amt of ["1", "0.001", "1000000"]) {
    const a = parseUnits(amt, meta.decimals);
    const q = await sellUsd(meta, a, ethUsd);
    if (q.usd == null || q.usd === 0) continue;
    let unit = q.usd / Number(amt), by = `quote of ${amt} ${meta.symbol}: ${q.by}`;
    if (unit > 1000) { // 1 token is worth more than $1000: re-quote about $100 worth so the price is not skewed by size
      const small = (100 / unit).toPrecision(3);
      const q2 = await sellUsd(meta, parseUnits(small, meta.decimals), ethUsd);
      if (q2.usd) { unit = q2.usd / Number(small); by = `quote of ${small} ${meta.symbol}: ${q2.by}`; }
    }
    out = { usd: unit, by }; break;
  }
  priceCache.set(meta.address, out);
  return out;
}

export async function portfolio({ address, lookbackHours = 24, tokens = [], includeMorpho = true } = {}) {
  const who0 = address || walletAddress();
  if (!who0) throw new Error("No address given and no Holbric wallet yet.");
  if (!isAddress(who0)) throw new Error(`Not an address: ${who0}`);
  if (!(lookbackHours >= 0 && lookbackHours <= 72)) throw new Error("lookbackHours must be between 0 and 72.");
  for (const t of tokens) if (!isAddress(t)) throw new Error(`Not a token address: ${t}`);
  const who = getAddress(who0);
  const c = publicClient();
  const block = await c.getBlock();
  const B = block.number;

  // 1. Which tokens to check: base assets, every official Robinhood Stock Token, tokens you name, and tokens that reached
  //    the address in the lookback window.
  const stocks = await stockList();
  const recent = lookbackHours > 0 ? await recentInbound(who, block, lookbackHours) : { hours: 0, requests: 0, failedRequests: 0, tokens: [] };
  const fixed = [...INTERMEDIATES.map((t) => t.address), ...stocks.map((s) => s.address)];
  const named = tokens.map((t) => getAddress(t));
  const all = [...new Set([...fixed, ...named, ...recent.tokens])];
  const [eth, ...bals] = await Promise.all([c.getBalance({ address: who, blockNumber: B }),
    multi(all.map((a) => ({ address: a, abi: erc20Abi, functionName: "balanceOf", args: [who] })), B)]);
  const balOf = new Map(all.map((a, i) => [a, val(bals[0][i]) ?? 0n]));
  const unreadable = all.filter((a, i) => bals[0][i].status !== "success" && (fixed.includes(a) || named.includes(a)));
  const heldAddrs = all.filter((a) => balOf.get(a) > 0n);
  const metas = new Map(); await mapLimit(heldAddrs, 6, async (a) => metas.set(a, await tokenMeta(a)));

  // 2. Morpho positions (on chain).
  const morpho = includeMorpho ? await readPositions(who, block) : null;

  // 3. Prices: one ETH -> USDG quote for the ETH figure, then a sell-all quote per holding.
  const ethQ = await quote({ tokenIn: "ETH", tokenOut: "USDG", amount: "1", venue: "uniswap" });
  priceCache.clear();
  const ethUsd = Number(formatUnits(ethQ.best.amountOut, 6));
  const ethMeta = { native: true, symbol: "ETH", decimals: 18, address: null, kind: "base" };
  const lines = [];
  if (eth > 0n) lines.push({ group: "wallet", meta: ethMeta, amount: eth, sign: 1 });
  for (const a of heldAddrs) {
    const m = metas.get(a);
    const counted = m.kind !== "other" || named.includes(a);
    lines.push({ group: "wallet", meta: m, amount: balOf.get(a), sign: 1, counted });
  }
  if (morpho) {
    for (const p of morpho.positions) {
      const { loan, coll, supplied, borrowed, collateral } = p._amounts;
      if (supplied > 0n) lines.push({ group: "morpho", meta: loan, amount: supplied, sign: 1, label: `supplied in ${p.marketId.slice(0, 10)}`, ref: p });
      if (collateral > 0n) lines.push({ group: "morpho", meta: coll, amount: collateral, sign: 1, label: `collateral in ${p.marketId.slice(0, 10)}`, ref: p });
      if (borrowed > 0n) lines.push({ group: "morpho", meta: loan, amount: borrowed, sign: -1, label: `debt in ${p.marketId.slice(0, 10)}`, ref: p });
    }
    for (const v of morpho.vaultPositions) lines.push({ group: "morpho-vault", meta: v._amounts.asset, amount: v._amounts.assets, sign: 1, label: `${v.symbol || v.vault} vault shares`, ref: v });
  }
  for (const l of lines) if (l.counted === undefined) l.counted = l.meta.kind !== "other";
  const toValue = lines.filter((l) => l.counted).slice(0, MAX_VALUED);
  const metasToPrice = [...new Map(toValue.map((l) => [l.meta.address ?? "native", l.meta])).values()];
  const prices = new Map(); await mapLimit(metasToPrice, 3, async (m) => prices.set(m.address ?? "native", await priceOf(m, ethUsd)));
  await mapLimit(toValue, 3, async (l) => {
    const p = prices.get(l.meta.address ?? "native");
    const amt = Number(formatUnits(l.amount, l.meta.decimals));
    l.v = p.usd == null ? { usd: null, by: p.by } : { usd: amt * p.usd, by: p.by };
    // What selling all of it would return now. Skipped for debt, USDG and anything under $50 at the quoted price.
    if (l.sign > 0 && l.v.usd != null && l.v.usd >= 50 && l.meta.address !== ADDR.USDG) l.sell = await sellUsd(l.meta, l.amount, ethUsd);
  });

  const row = (l) => {
    const r = {
      symbol: l.meta.symbol, token: l.meta.address ?? "native", holbric: KIND_TEXT[l.meta.kind] || "native ETH",
      ...(l.label ? { position: l.label } : {}),
      amount: `${l.sign < 0 ? "-" : ""}${fmt(l.amount, l.meta.decimals, 8)}`,
      priceUsd: l.v?.usd != null && l.amount > 0n ? +(l.v.usd / Number(formatUnits(l.amount, l.meta.decimals))).toPrecision(8) : null,
      valueUsd: l.v?.usd == null ? null : usd(l.sign * l.v.usd), valueEth: l.v?.usd == null ? null : +(l.sign * l.v.usd / ethUsd).toPrecision(8),
      priceFrom: l.counted ? (l.v?.by ?? `not valued (more than ${MAX_VALUED} lines)`) : "not valued: not in Holbric's lists (pass it in tokens to value it)",
    };
    if (l.sell) {
      r.sellAllUsd = usd(l.sell.usd);
      r.sellAllRoute = l.sell.by;
      if (l.sell.usd != null && l.v.usd > 0 && l.sell.usd < 0.95 * l.v.usd) r.liquidityWarning = `selling all of it now would return ${(100 * (1 - l.sell.usd / l.v.usd)).toFixed(1)}% less than the quoted price implies (thin pool)`;
    }
    return r;
  };
  const sum = (g, f = (l) => l.v?.usd) => lines.filter((l) => g(l) && l.v?.usd != null).reduce((a, l) => a + l.sign * (f(l) ?? l.v.usd), 0);
  const walletUsd = sum((l) => l.group === "wallet"), morphoUsd = sum((l) => l.group !== "wallet");
  const sellAllUsd = sum(() => true, (l) => (l.sell ? l.sell.usd : l.v.usd));
  const unvalued = lines.filter((l) => l.counted && l.v?.usd == null);
  const totalUsd = walletUsd + morphoUsd;
  const holdings = lines.filter((l) => l.group === "wallet").map(row).sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
  return {
    address: who, chainId: CHAIN_ID, block: B.toString(), blockTime: new Date(Number(block.timestamp) * 1000).toISOString(), explorer: addrLink(who),
    ethPrice: `1 ETH = ${ethUsd.toFixed(2)} USDG (Holbric quote, ${ethQ.view.route}, block ${ethQ.view.block})`,
    totals: {
      walletUsd: usd(walletUsd), morphoNetUsd: morpho ? usd(morphoUsd) : null, totalUsd: usd(totalUsd), totalEth: +(totalUsd / ethUsd).toPrecision(8),
      totalIfSoldNowUsd: usd(sellAllUsd),
      complete: unvalued.length === 0 && unreadable.length === 0,
      ...(unreadable.length ? { unreadableBalances: `balanceOf failed for ${unreadable.length} listed token${unreadable.length === 1 ? "" : "s"} after retries: ${unreadable.join(", ")}` } : {}),
      ...(unvalued.length ? { missing: `${unvalued.length} holding${unvalued.length === 1 ? "" : "s"} could not be valued and ${unvalued.length === 1 ? "is" : "are"} left out of the total: ${unvalued.map((l) => l.meta.symbol).join(", ")}` } : {}),
    },
    holdings,
    morpho: morpho ? {
      positions: morpho.positions.map((p) => ({ marketId: p.marketId, market: p.market, supplied: p.supplied, collateral: p.collateral, borrowed: p.borrowed, healthFactor: p.healthFactor, liquidationPrice: p.liquidationPrice, status: p.status })),
      vaults: morpho.vaultPositions.map(({ _amounts, ...v }) => v),
      lines: lines.filter((l) => l.group !== "wallet").map(row),
      checked: `${morpho.marketsChecked} Morpho Blue markets (${MORPHO}) and ${morpho.vaultsChecked} Vault V2 vaults`,
    } : "not checked (includeMorpho: false)",
    discovery: {
      checked: `${all.length} token contracts: ETH, WETH, USDG, cbBTC, ${stocks.length} official Robinhood Stock Tokens${named.length ? `, ${named.length} you named` : ""}, and ${recent.tokens.length} that sent this address something in the last ${recent.hours} h`,
      transferLogs: recent.hours ? { fromBlock: recent.fromBlock, toBlock: recent.toBlock, requests: recent.requests, failedRequests: recent.failedRequests } : "skipped (lookbackHours 0)",
      limit: "A token that arrived before the lookback window and is not in Holbric's lists is not found. Pass it in tokens.",
    },
    method: "Balances and Morpho positions are read at this block. Prices are Holbric's own best Uniswap v3/v4 quotes into USDG for a small amount (1 token, or about $100 worth when 1 token is worth more); ETH and WETH use a 1 ETH quote; Pons V2 tokens still on their curve are quoted on the curve. valueUsd = amount x that price. sellAllUsd is a separate quote for selling the whole amount now, and totalIfSoldNowUsd uses it, so thin pools show up. Morpho debt counts as negative at face value in its loan token. Tokens not in Holbric's lists are listed but not valued. No third-party price feed or aggregator API is asked.",
    pnl: PNL_NOTE,
  };
}
