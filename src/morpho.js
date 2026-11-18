// Morpho on Robinhood Chain mainnet (0.7.0). Read-only: nothing here builds, signs or sends a transaction.
// Writes (supply, borrow, repay, withdraw; 0.10.0) are built in morphotx.js on top of these reads.
//
// Addresses come from Morpho's own address registry (github.com/morpho-org/sdks, packages/morpho-ts/src/addresses.ts,
// ChainId.RobinhoodMainnet = 4663). Each one has code on chain and is verified on Sourcify for chain 4663 ("match":
// runtime and creation bytecode match; built with bytecodeHash none, so there is no metadata hash to compare):
//   Morpho (Morpho Blue singleton)  0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010  (registry deployment block 286)
//   AdaptiveCurveIrm                0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1
//   VaultV2Factory                  0x0FBad98595b0186dA120E41f77C102beb49f803c  (registry deployment block 288)
// The registry lists no MetaMorpho (vault V1) factory for 4663, and Morpho's API reports no V1 vaults there; vaults on
// this chain are Morpho Vault V2.
//
// Sources, in order of trust:
//   - Markets are found from Morpho's own CreateMarket events and vaults from the factory's CreateVaultV2 events.
//   - Every number Holbric reports (totals, positions, rates, oracle prices, health factor) is read on chain at one block.
//     Interest owed since the market's last update is added the way Morpho Blue does it (borrowRateView + Taylor
//     compounding), so positions match what the contract would charge at that block.
//   - Morpho's public API (api.morpho.org) is used for two things only, each labelled: whether Morpho's app lists a
//     market (spam filter), and its vault APY figures. If the API is down, Holbric says so and keeps the on-chain data.
import { getAddress, isAddress, parseAbi, parseAbiItem, erc20Abi, formatUnits, zeroAddress } from "viem";
import { publicClient, ADDR, CHAIN_ID, fmt, addrLink } from "./chain.js";
import { walletAddress } from "./keystore.js";
import { INTERMEDIATES } from "./route.js";
import { findStock } from "./stocks.js";
import { quote } from "./swap.js";
import ponsAbi from "./abi/pons-factory.json" with { type: "json" };

export const MORPHO = getAddress("0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010");
export const ADAPTIVE_IRM = getAddress("0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1");
export const VAULT_V2_FACTORY = getAddress("0x0FBad98595b0186dA120E41f77C102beb49f803c");
export const MULTICALL3 = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11");
export const MORPHO_REGISTRY = "https://github.com/morpho-org/sdks/blob/main/packages/morpho-ts/src/addresses.ts";
export const MORPHO_API = "https://api.morpho.org/graphql";
const MORPHO_FROM_BLOCK = 286n, FACTORY_FROM_BLOCK = 288n;
const LOG_SPAN = 10_000_000n; // the public RPC allows 10M blocks per address-filtered getLogs
const WAD = 10n ** 18n, YEAR = 365 * 24 * 3600;
const VIRTUAL_SHARES = 10n ** 6n, VIRTUAL_ASSETS = 1n;

const morphoAbi = parseAbi([
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
]);
const irmAbi = parseAbi([
  "function borrowRateView((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee) market) view returns (uint256)",
]);
const oracleAbi = parseAbi(["function price() view returns (uint256)"]);
const vaultAbi = parseAbi([
  "function asset() view returns (address)", "function totalAssets() view returns (uint256)", "function totalSupply() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)", "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)",
  "function owner() view returns (address)", "function curator() view returns (address)",
  "function performanceFee() view returns (uint96)", "function managementFee() view returns (uint96)",
]);
const factoryAbi = parseAbi(["function isVaultV2(address) view returns (bool)"]);
const CREATE_MARKET = parseAbiItem("event CreateMarket(bytes32 indexed id, (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams)");
const CREATE_VAULT = parseAbiItem("event CreateVaultV2(address indexed owner, address indexed asset, bytes32 salt, address indexed newVaultV2)");

// ---- small helpers --------------------------------------------------------------------------------------------------
export async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = { ok: true, value: await fn(items[k], k) }; } catch (e) { out[k] = { ok: false, error: e }; } }
  }));
  return out;
}
/** Multicall3 at one block. Returns raw {status,result} entries; failures are kept, never thrown. */
export async function multi(contracts, blockNumber) {
  if (!contracts.length) return [];
  const run = (list, batchSize) => publicClient().multicall({ contracts: list, blockNumber, allowFailure: true, multicallAddress: MULTICALL3, batchSize })
    .catch((e) => list.map(() => ({ status: "failure", error: e })));
  const out = await run(contracts, 16_384);
  // A rate-limited or dropped RPC request fails a whole batch. Retry failed calls twice in smaller batches at the same
  // block; a call that really reverts fails again and stays a failure.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const idx = out.map((r, i) => (r.status === "success" ? -1 : i)).filter((i) => i >= 0);
    if (!idx.length) break;
    await new Promise((r) => setTimeout(r, 400 * attempt));
    const again = await run(idx.map((i) => contracts[i]), 4_096);
    idx.forEach((i, k) => { out[i] = again[k]; });
  }
  return out;
}
const val = (r) => (r && r.status === "success" ? r.result : null);
const mulDivDown = (x, y, d) => (x * y) / d;
const mulDivUp = (x, y, d) => (x * y + (d - 1n)) / d;
export const toAssetsDown = (shares, ta, ts) => mulDivDown(shares, ta + VIRTUAL_ASSETS, ts + VIRTUAL_SHARES);
export const toAssetsUp = (shares, ta, ts) => mulDivUp(shares, ta + VIRTUAL_ASSETS, ts + VIRTUAL_SHARES);
const toSharesDown = (assets, ta, ts) => mulDivDown(assets, ts + VIRTUAL_SHARES, ta + VIRTUAL_ASSETS);
const wMulDown = (x, y) => (x * y) / WAD;
/** Morpho Blue's MathLib.wTaylorCompounded: e^(x*n) - 1, three terms. */
const wTaylor = (x, n) => { const first = x * n; const second = (first * first) / (2n * WAD); const third = (second * first) / (3n * WAD); return first + second + third; };
const pct = (x, digits = 4) => (x == null || !Number.isFinite(x) ? null : +(x * 100).toFixed(digits));
const ratio = (a, b) => (b === 0n ? null : Number((a * 10n ** 12n) / b) / 1e12);
const isZero = (a) => !a || /^0x0{40}$/i.test(a);

// ---- discovery: markets and vaults from Morpho's own events -----------------------------------------------------------
async function scanLogs({ address, event, from, to }) {
  const c = publicClient(); const jobs = [];
  for (let f = from; f <= to; f += LOG_SPAN) { const t = f + LOG_SPAN - 1n > to ? to : f + LOG_SPAN - 1n; jobs.push({ f, t }); }
  const res = await mapLimit(jobs, 4, (j) => c.getLogs({ address, event, fromBlock: j.f, toBlock: j.t }));
  const bad = res.find((r) => !r.ok); if (bad) throw bad.error;
  return res.flatMap((r) => r.value);
}
const marketCache = { to: MORPHO_FROM_BLOCK - 1n, list: [] };
/** Every market ever created on Morpho Blue on this chain, from CreateMarket logs (cached, extended incrementally). */
export async function allMarkets(latest) {
  if (latest > marketCache.to) {
    const logs = await scanLogs({ address: MORPHO, event: CREATE_MARKET, from: marketCache.to + 1n, to: latest });
    for (const l of logs) marketCache.list.push({ id: l.args.id, params: { ...l.args.marketParams, lltv: l.args.marketParams.lltv }, createdBlock: l.blockNumber });
    marketCache.to = latest;
  }
  return marketCache.list;
}
const vaultCache = { to: FACTORY_FROM_BLOCK - 1n, list: [] };
export async function allVaults(latest) {
  if (latest > vaultCache.to) {
    const logs = await scanLogs({ address: VAULT_V2_FACTORY, event: CREATE_VAULT, from: vaultCache.to + 1n, to: latest });
    for (const l of logs) vaultCache.list.push({ address: getAddress(l.args.newVaultV2), asset: getAddress(l.args.asset), owner: getAddress(l.args.owner), createdBlock: l.blockNumber });
    vaultCache.to = latest;
  }
  return vaultCache.list;
}

// ---- Morpho API (labelled, optional) --------------------------------------------------------------------------------
let apiCache = null;
async function gql(query) {
  const r = await fetch(MORPHO_API, { method: "POST", headers: { "content-type": "application/json", "user-agent": "holbric-mcp" }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`api.morpho.org returned HTTP ${r.status}`);
  const j = await r.json(); if (j.errors?.length) throw new Error(`api.morpho.org: ${j.errors[0].message}`);
  return j.data;
}
/** { listed: Map(id -> bool), vaults: Map(addr -> {apy, netApy}), fetchedAt } or { error }. Cached 10 minutes. */
export async function morphoApi() {
  if (apiCache && Date.now() - apiCache.at < 10 * 60 * 1000) return apiCache.data;
  try {
    const d = await gql(`{ markets(first: 1000, where: { chainId_in: [${CHAIN_ID}] }) { items { marketId listed } }
      vaultV2s(first: 1000, where: { chainId_in: [${CHAIN_ID}] }) { items { address apy netApy } } }`);
    const data = { fetchedAt: new Date().toISOString(),
      listed: new Map(d.markets.items.map((m) => [m.marketId.toLowerCase(), !!m.listed])),
      vaults: new Map(d.vaultV2s.items.map((v) => [getAddress(v.address), { apy: v.apy, netApy: v.netApy }])) };
    apiCache = { at: Date.now(), data };
    return data;
  } catch (e) { return { error: String(e?.message || e) }; }
}

// ---- token labels ---------------------------------------------------------------------------------------------------
const tokenCache = new Map();
/** symbol, decimals, and what Holbric knows about a token: USDG, WETH, cbBTC, an official Robinhood Stock Token, a Pons V2 launch, or none. */
export async function tokenMeta(address) {
  if (isZero(address)) return { address: zeroAddress, symbol: "none", decimals: 18, kind: "none" };
  const a = getAddress(address);
  if (tokenCache.has(a)) return tokenCache.get(a);
  const c = publicClient();
  const [symbol, decimals, stock, pons] = await Promise.all([
    c.readContract({ address: a, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
    c.readContract({ address: a, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
    findStock(a).catch(() => null),
    c.readContract({ address: ADDR.PONS_FACTORY, abi: ponsAbi, functionName: "getLaunchedToken", args: [a] }).catch(() => null),
  ]);
  const inter = INTERMEDIATES.find((t) => t.address === a);
  const kind = inter ? "base" : stock ? "robinhood-stock-token" : pons?.exists ? "pons-v2-launch" : "other";
  const m = { address: a, symbol: String(symbol).slice(0, 32), decimals: Number(decimals), kind };
  tokenCache.set(a, m);
  return m;
}
export const KIND_TEXT = { base: "Holbric base asset", "robinhood-stock-token": "official Robinhood Stock Token", "pons-v2-launch": "Pons V2 launch", other: "not in Holbric's lists", none: "none" };

// ---- pricing for ordering (Holbric's own quotes) ---------------------------------------------------------------------
const priceCache = new Map();
/** Approximate USDG per 1 whole token from Holbric's own Uniswap v3/v4 quote of a small amount (no third-party API). */
export async function unitUsd(meta) {
  if (meta.address === ADDR.USDG) return 1;
  const hit = priceCache.get(meta.address); if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.v;
  let v = null;
  for (const amt of ["1", "0.01", "0.0001"]) {
    try { const q = await quote({ tokenIn: meta.address, tokenOut: "USDG", amount: amt, venue: "uniswap" }); v = Number(formatUnits(q.best.amountOut, 6)) / Number(amt); break; } catch {}
  }
  priceCache.set(meta.address, { at: Date.now(), v });
  return v;
}

// ---- market math (on chain, one block) --------------------------------------------------------------------------------
/** Market totals with interest accrued up to `timestamp`, the borrow rate, and APYs, as Morpho Blue computes them. */
export function accrue(params, m, rate, timestamp) {
  let { totalSupplyAssets: tsa, totalSupplyShares: tss, totalBorrowAssets: tba, totalBorrowShares: tbs, lastUpdate, fee } = m;
  const elapsed = BigInt(timestamp) - BigInt(lastUpdate);
  if (elapsed > 0n && tba > 0n && !isZero(params.irm) && rate != null) {
    const interest = wMulDown(tba, wTaylor(rate, elapsed));
    tba += interest; tsa += interest;
    if (fee > 0n) { const feeAmount = wMulDown(interest, fee); tss += toSharesDown(feeAmount, tsa - feeAmount, tss); }
  }
  return { tsa, tss, tba, tbs, fee };
}
function apys(rate, tsa, tba, fee) {
  if (rate == null) return { borrowApy: null, supplyApy: null };
  const borrow = Math.expm1(Number(rate) / 1e18 * YEAR);
  const util = tsa === 0n ? 0 : Number((tba * 10n ** 12n) / tsa) / 1e12;
  return { borrowApy: borrow, supplyApy: borrow * util * (1 - Number(fee) / 1e18) };
}
const M_FIELDS = ["totalSupplyAssets", "totalSupplyShares", "totalBorrowAssets", "totalBorrowShares", "lastUpdate", "fee"];
const asMarket = (r) => Object.fromEntries(M_FIELDS.map((k, i) => [k, r[i]]));

/** Full on-chain state for a set of market ids at one block: totals (accrued), rate, APYs, oracle price. */
export async function marketStates(list, block) {
  const raw = await multi(list.map((x) => ({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [x.id] })), block.number);
  const markets = raw.map((r) => (val(r) ? asMarket(val(r)) : null));
  const rateCalls = list.map((x, i) => (markets[i] && !isZero(x.params.irm)
    ? { address: x.params.irm, abi: irmAbi, functionName: "borrowRateView", args: [x.params, markets[i]] } : null));
  const priceCalls = list.map((x) => (!isZero(x.params.oracle) ? { address: x.params.oracle, abi: oracleAbi, functionName: "price" } : null));
  const live = (arr) => arr.map((c, i) => [c, i]).filter(([c]) => c);
  const rl = live(rateCalls), pl = live(priceCalls);
  const [rr, pr] = await Promise.all([multi(rl.map(([c]) => c), block.number), multi(pl.map(([c]) => c), block.number)]);
  const rates = new Array(list.length).fill(null), prices = new Array(list.length).fill(null);
  rl.forEach(([, i], k) => { rates[i] = val(rr[k]); }); pl.forEach(([, i], k) => { prices[i] = val(pr[k]); });
  const unreadable = markets.filter((m) => !m).length;
  if (unreadable) throw new Error(`${unreadable} of ${list.length} Morpho market reads failed at block ${block.number} after retries (RPC busy?); not reporting a partial list. Try again.`);
  return list.map((x, i) => {
    const a = accrue(x.params, markets[i], rates[i], block.timestamp);
    return { ...x, raw: markets[i], acc: a, rate: rates[i], oraclePrice: prices[i], ...apys(rates[i], a.tsa, a.tba, a.fee) };
  });
}
/** Oracle price as "loan per 1 collateral" in whole units (Morpho oracles scale price by 1e36 * 10^(loanDec - collDec)). */
export const humanPrice = (p, loanDec, collDec) => (p == null ? null : Number(formatUnits(p, 36 + loanDec - collDec)));

function marketView(s, loan, coll, api, usdPerLoan) {
  const { tsa, tba, fee } = s.acc;
  const liquidity = tsa > tba ? tsa - tba : 0n;
  const price = humanPrice(s.oraclePrice, loan.decimals, coll.decimals);
  const supply = Number(formatUnits(tsa, loan.decimals));
  return {
    marketId: s.id,
    loanToken: { symbol: loan.symbol, address: loan.address, holbric: KIND_TEXT[loan.kind] },
    collateralToken: { symbol: coll.symbol, address: coll.address, holbric: KIND_TEXT[coll.kind] },
    lltvPct: pct(Number(s.params.lltv) / 1e18, 2),
    oracle: s.params.oracle, irm: s.params.irm, irmIsAdaptiveCurve: getAddress(s.params.irm) === ADAPTIVE_IRM,
    oraclePrice: price == null ? null : `1 ${coll.symbol} = ${price.toPrecision(8)} ${loan.symbol} (market oracle)`,
    totalSupply: `${fmt(tsa, loan.decimals, 6)} ${loan.symbol}`, totalBorrow: `${fmt(tba, loan.decimals, 6)} ${loan.symbol}`,
    liquidity: `${fmt(liquidity, loan.decimals, 6)} ${loan.symbol}`,
    utilizationPct: pct(ratio(tba, tsa) ?? 0, 2),
    supplyApyPct: pct(s.supplyApy, 3), borrowApyPct: pct(s.borrowApy, 3), feePct: pct(Number(fee) / 1e18, 2),
    approxSupplyUsd: usdPerLoan == null ? null : Math.round(supply * usdPerLoan),
    listedInMorphoApp: api?.listed ? (api.listed.get(s.id.toLowerCase()) ?? false) : null,
    createdBlock: s.createdBlock.toString(), explorerOracle: addrLink(s.params.oracle),
  };
}

const MARKET_METHOD = "Totals, positions, oracle price and rate are read from Morpho Blue, the market's oracle and its IRM at this block, with interest accrued to the block time as Morpho Blue does. APYs: borrow = e^(rate x 1 year) - 1 from the IRM's borrowRateView; supply = borrow APY x utilization x (1 - fee). They move with every block.";

export async function morphoMarkets({ loanToken, collateralToken, includeUnlisted = false, limit = 10 } = {}) {
  const c = publicClient();
  const block = await c.getBlock();
  const [all, api] = await Promise.all([allMarkets(block.number), morphoApi()]);
  const pick = (x) => (x ? (String(x).toUpperCase() === "USDG" ? ADDR.USDG : String(x).toUpperCase() === "WETH" || String(x).toUpperCase() === "ETH" ? ADDR.WETH : isAddress(x) ? getAddress(x) : null) : undefined);
  const lf = pick(loanToken), cf = pick(collateralToken);
  if (lf === null || cf === null) throw new Error("loanToken and collateralToken take USDG, WETH or a 0x token address.");
  let cand = all.filter((m) => !isZero(m.params.loanToken)
    && (!lf || getAddress(m.params.loanToken) === lf) && (!cf || getAddress(m.params.collateralToken) === cf));
  let filter;
  if (!includeUnlisted) {
    if (!api.error) { cand = cand.filter((m) => api.listed.get(m.id.toLowerCase())); filter = "markets listed in Morpho's app (api.morpho.org)"; }
    else {
      const known = async (a) => !isZero(a) && (INTERMEDIATES.some((t) => t.address === getAddress(a)) || !!(await findStock(a).catch(() => null)));
      const keep = await Promise.all(cand.map(async (m) => (await known(m.params.loanToken)) && (await known(m.params.collateralToken))));
      cand = cand.filter((_, i) => keep[i]);
      filter = `Morpho API unavailable (${api.error}), so the listing is unknown; showing only markets whose loan and collateral are both WETH, USDG, cbBTC or official Robinhood Stock Tokens`;
    }
  } else filter = "every market, listed or not (unlisted markets can use any token and any oracle)";
  const states = (await marketStates(cand, block)).filter((s) => s && s.acc.tsa > 0n);
  const metas = new Map();
  await mapLimit([...new Set(states.flatMap((s) => [s.params.loanToken, s.params.collateralToken]))], 6, async (a) => metas.set(getAddress(a), await tokenMeta(a)));
  const loans = [...new Set(states.map((s) => getAddress(s.params.loanToken)))];
  const prices = new Map(); await mapLimit(loans, 3, async (a) => prices.set(a, await unitUsd(metas.get(a))));
  const rows = states.map((s) => {
    const loan = metas.get(getAddress(s.params.loanToken)), coll = isZero(s.params.collateralToken) ? { symbol: "none", address: zeroAddress, decimals: 18, kind: "none" } : metas.get(getAddress(s.params.collateralToken));
    return marketView(s, loan, coll, api.error ? null : api, prices.get(loan.address));
  }).sort((a, b) => (b.approxSupplyUsd ?? -1) - (a.approxSupplyUsd ?? -1));
  return {
    chainId: CHAIN_ID, block: block.number.toString(), blockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
    morpho: MORPHO, addressSource: MORPHO_REGISTRY,
    marketsOnChain: all.length, matching: rows.length, returned: Math.min(rows.length, limit), filter,
    ordering: "by approximate supply in USD, each loan token priced with Holbric's own Uniswap quote of a small amount (no third-party price feed)",
    method: MARKET_METHOD,
    morphoApi: api.error ? { status: "unavailable", reason: api.error } : { status: "ok", used: "listing flag only", fetchedAt: api.fetchedAt },
    markets: rows.slice(0, limit),
    note: "A Morpho market is only as safe as its oracle and collateral. Anyone can create one. Unlisted markets can use spoofed tokens with familiar tickers; check the addresses.",
  };
}

// ---- positions --------------------------------------------------------------------------------------------------------
/** Every Morpho Blue position and Vault V2 share balance of `who`, read on chain at `block`. Used by morpho_position and portfolio. */
export async function readPositions(who, block, { marketId } = {}) {
  const all = await allMarkets(block.number);
  let list = all;
  if (marketId) {
    list = all.filter((m) => m.id.toLowerCase() === String(marketId).toLowerCase());
    if (!list.length) throw new Error(`No Morpho Blue market with id ${marketId} on Robinhood Chain (checked ${all.length} CreateMarket events).`);
  }
  const posRaw = await multi(list.map((m) => ({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [m.id, who] })), block.number);
  const failed = posRaw.filter((r) => r.status !== "success").length;
  if (failed) throw new Error(`${failed} of ${list.length} Morpho position reads failed at block ${block.number}; not reporting a partial picture.`);
  const held = list.map((m, i) => ({ m, p: posRaw[i].result })).filter(({ p }) => p[0] > 0n || p[1] > 0n || p[2] > 0n);
  const states = await marketStates(held.map((h) => h.m), block);
  const metas = new Map();
  await mapLimit([...new Set(held.flatMap((h) => [h.m.params.loanToken, h.m.params.collateralToken]).filter((a) => !isZero(a)))], 6, async (a) => metas.set(getAddress(a), await tokenMeta(a)));
  const positions = held.map(({ m, p }, i) => {
    const s = states[i];
    const loan = metas.get(getAddress(m.params.loanToken));
    const coll = isZero(m.params.collateralToken) ? { symbol: "none", address: zeroAddress, decimals: 18, kind: "none" } : metas.get(getAddress(m.params.collateralToken));
    const [supplyShares, borrowShares, collateral] = p;
    const supplied = toAssetsDown(supplyShares, s.acc.tsa, s.acc.tss);
    const borrowed = toAssetsUp(borrowShares, s.acc.tba, s.acc.tbs);
    const lltv = m.params.lltv;
    const price = s.oraclePrice;
    const collInLoan = price == null ? null : mulDivDown(collateral, price, 10n ** 36n);
    const maxBorrow = collInLoan == null ? null : wMulDown(collInLoan, lltv);
    const hf = borrowed === 0n ? null : maxBorrow == null ? null : Number((maxBorrow * 10n ** 12n) / borrowed) / 1e12;
    // Collateral price at which this position becomes liquidatable (borrow = collateral x price x LLTV).
    const liqPrice = borrowed > 0n && collateral > 0n && lltv > 0n ? Number(formatUnits((borrowed * 10n ** 36n * WAD) / (collateral * lltv), 36 + loan.decimals - coll.decimals)) : null;
    const nowPrice = humanPrice(price, loan.decimals, coll.decimals);
    return {
      marketId: m.id,
      market: `${coll.symbol} collateral / ${loan.symbol} loan, LLTV ${pct(Number(lltv) / 1e18, 2)}%`,
      loanToken: { symbol: loan.symbol, address: loan.address, decimals: loan.decimals, holbric: KIND_TEXT[loan.kind] },
      collateralToken: { symbol: coll.symbol, address: coll.address, decimals: coll.decimals, holbric: KIND_TEXT[coll.kind] },
      supplied: `${fmt(supplied, loan.decimals, 6)} ${loan.symbol}`, borrowed: `${fmt(borrowed, loan.decimals, 6)} ${loan.symbol}`,
      collateral: `${fmt(collateral, coll.decimals, 6)} ${coll.symbol}`,
      raw: { supplyShares: supplyShares.toString(), borrowShares: borrowShares.toString(), collateral: collateral.toString(), suppliedAssets: supplied.toString(), borrowedAssets: borrowed.toString() },
      collateralValueInLoan: collInLoan == null ? null : `${fmt(collInLoan, loan.decimals, 6)} ${loan.symbol} at the market oracle`,
      maxBorrow: maxBorrow == null ? null : `${fmt(maxBorrow, loan.decimals, 6)} ${loan.symbol}`,
      healthFactor: hf == null ? null : +hf.toFixed(4),
      ltvPct: borrowed > 0n && collInLoan ? pct(ratio(borrowed, collInLoan), 2) : null,
      oraclePrice: nowPrice == null ? null : `1 ${coll.symbol} = ${nowPrice.toPrecision(8)} ${loan.symbol}`,
      liquidationPrice: liqPrice == null ? null : `1 ${coll.symbol} = ${liqPrice.toPrecision(8)} ${loan.symbol}`,
      liquidationDropPct: liqPrice != null && nowPrice ? pct(1 - liqPrice / nowPrice, 2) : null,
      status: borrowed === 0n ? "no debt" : hf == null ? "health unknown (oracle read failed)" : hf < 1 ? "LIQUIDATABLE: health factor below 1" : hf < 1.05 ? "at risk: under 5% from liquidation" : "healthy",
      supplyApyPct: pct(s.supplyApy, 3), borrowApyPct: pct(s.borrowApy, 3),
      _amounts: { loan, coll, supplied, borrowed, collateral },
    };
  });
  // Vault V2 shares (ERC-4626): balanceOf on every vault the factory created, then convertToAssets.
  const vaults = marketId ? [] : await allVaults(block.number);
  const bal = await multi(vaults.map((v) => ({ address: v.address, abi: vaultAbi, functionName: "balanceOf", args: [who] })), block.number);
  const vHeld = vaults.map((v, i) => ({ v, shares: val(bal[i]) ?? 0n })).filter((x) => x.shares > 0n);
  const vMeta = await multi(vHeld.flatMap(({ v, shares }) => [
    { address: v.address, abi: vaultAbi, functionName: "convertToAssets", args: [shares] }, { address: v.address, abi: vaultAbi, functionName: "name" },
    { address: v.address, abi: vaultAbi, functionName: "symbol" }, { address: v.address, abi: vaultAbi, functionName: "decimals" }]), block.number);
  const vaultPositions = await Promise.all(vHeld.map(async ({ v, shares }, i) => {
    const asset = await tokenMeta(v.asset);
    const assets = val(vMeta[i * 4]) ?? 0n, dec = Number(val(vMeta[i * 4 + 3]) ?? 18);
    return { vault: v.address, name: val(vMeta[i * 4 + 1]) || "", symbol: val(vMeta[i * 4 + 2]) || "", asset: { symbol: asset.symbol, address: asset.address, holbric: KIND_TEXT[asset.kind] },
      shares: fmt(shares, dec, 6), assets: `${fmt(assets, asset.decimals, 6)} ${asset.symbol}`, _amounts: { asset, assets } };
  }));
  return { positions, vaultPositions, marketsChecked: list.length, vaultsChecked: vaults.length };
}

const strip = (o) => { const { _amounts, ...rest } = o; return rest; };

export async function morphoPosition({ address, marketId } = {}) {
  const who = address || walletAddress();
  if (!who) throw new Error("No address given and no Holbric wallet yet.");
  if (!isAddress(who)) throw new Error(`Not an address: ${who}`);
  if (marketId && !/^0x[0-9a-fA-F]{64}$/.test(marketId)) throw new Error("marketId is the 32-byte market id (0x + 64 hex characters).");
  const c = publicClient();
  const block = await c.getBlock();
  const r = await readPositions(getAddress(who), block, { marketId });
  return {
    address: getAddress(who), chainId: CHAIN_ID, block: block.number.toString(), blockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
    morpho: MORPHO, addressSource: MORPHO_REGISTRY, source: "on chain only (Morpho Blue position/market, market oracle, IRM; Vault V2 balanceOf/convertToAssets); no API",
    marketsChecked: r.marketsChecked, vaultsChecked: r.vaultsChecked,
    positions: r.positions.map(strip), vaultPositions: r.vaultPositions.map(strip),
    summary: r.positions.length || r.vaultPositions.length
      ? `${r.positions.length} Morpho Blue position${r.positions.length === 1 ? "" : "s"} and ${r.vaultPositions.length} Vault V2 holding${r.vaultPositions.length === 1 ? "" : "s"} at block ${block.number}.`
      : `No Morpho Blue position and no Vault V2 shares at block ${block.number} (checked ${r.marketsChecked} markets and ${r.vaultsChecked} vaults).`,
    method: MARKET_METHOD + " Health factor = collateral x oracle price x LLTV / debt; below 1 the position can be liquidated.",
  };
}

// ---- vaults -------------------------------------------------------------------------------------------------------------
export async function morphoVaults({ asset, minUsd = 1, limit = 10 } = {}) {
  const c = publicClient();
  const block = await c.getBlock();
  const [vaults, api] = await Promise.all([allVaults(block.number), morphoApi()]);
  let af;
  if (asset) { const u = String(asset).toUpperCase(); af = u === "USDG" ? ADDR.USDG : u === "WETH" || u === "ETH" ? ADDR.WETH : isAddress(asset) ? getAddress(asset) : null; if (!af) throw new Error("asset takes USDG, WETH or a 0x token address."); }
  const list = vaults.filter((v) => !af || v.asset === af);
  const F = ["totalAssets", "totalSupply", "name", "symbol", "owner", "curator", "performanceFee", "managementFee"];
  const raw = await multi(list.flatMap((v) => [...F.map((fn) => ({ address: v.address, abi: vaultAbi, functionName: fn })),
    { address: VAULT_V2_FACTORY, abi: factoryAbi, functionName: "isVaultV2", args: [v.address] }]), block.number);
  const per = F.length + 1;
  const metas = new Map(); await mapLimit([...new Set(list.map((v) => v.asset))], 6, async (a) => metas.set(a, await tokenMeta(a)));
  const withAssets = list.map((v, i) => ({ v, r: raw.slice(i * per, i * per + per).map(val) })).filter(({ r }) => r[8] === true && (r[0] ?? 0n) > 0n);
  const prices = new Map(); await mapLimit([...new Set(withAssets.map(({ v }) => v.asset))], 3, async (a) => prices.set(a, await unitUsd(metas.get(a))));
  const rows = withAssets.map(({ v, r }) => {
    const a = metas.get(v.asset); const ta = r[0]; const usd = prices.get(v.asset) == null ? null : Number(formatUnits(ta, a.decimals)) * prices.get(v.asset);
    const apiV = api.error ? null : api.vaults.get(v.address);
    return {
      vault: v.address, name: r[2] || "", symbol: r[3] || "", asset: { symbol: a.symbol, address: a.address, holbric: KIND_TEXT[a.kind] },
      totalAssets: `${fmt(ta, a.decimals, 6)} ${a.symbol}`, approxUsd: usd == null ? null : +usd.toFixed(2),
      owner: r[4], curator: r[5], performanceFeePct: r[6] == null ? null : pct(Number(r[6]) / 1e18, 2), managementFeePct: r[7] == null ? null : pct(Number(r[7]) / 1e18, 2),
      apyFromMorphoApi: apiV ? { apyPct: pct(apiV.apy, 3), netApyPct: pct(apiV.netApy, 3) } : null,
      createdBlock: v.createdBlock.toString(), explorer: addrLink(v.address),
    };
  }).filter((x) => x.approxUsd == null || x.approxUsd >= minUsd).sort((a, b) => (b.approxUsd ?? -1) - (a.approxUsd ?? -1));
  return {
    chainId: CHAIN_ID, block: block.number.toString(), blockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
    factory: VAULT_V2_FACTORY, addressSource: MORPHO_REGISTRY,
    vaultsCreated: vaults.length, withAssets: withAssets.length, matching: rows.length, returned: Math.min(rows.length, limit),
    filter: `${af ? `asset ${af}, ` : ""}at least $${minUsd} in assets (priced with Holbric's own Uniswap quote of a small amount)`,
    source: "Vaults from VaultV2Factory CreateVaultV2 events and isVaultV2, figures from each vault at this block. APY is Morpho's API figure, labelled; Holbric does not compute it because the public RPC keeps no historical state to measure share-price growth.",
    morphoApi: api.error ? { status: "unavailable", reason: api.error } : { status: "ok", used: "APY only", fetchedAt: api.fetchedAt },
    vaults: rows.slice(0, limit),
    note: "Anyone can create a Vault V2 and name it anything. The curator decides where deposits go; check the owner, curator and fees.",
  };
}
