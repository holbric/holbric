// Morpho Blue writes on Robinhood Chain mainnet (0.10.0): supply, borrow (with optional collateral), repay, withdraw.
//
// Every action is built here, simulated on mainnet with eth_simulateV1 through store(), and only signed by
// execute_prepared after the user's yes. Calls go straight to the Morpho Blue singleton
// 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010 (Morpho's address registry for chain 4663; Sourcify "match" for chain 4663,
// contract Morpho). Function signatures are taken from its verified ABI. No bundler, no callback data, no authorization:
// every call acts for this wallet (onBehalf = receiver = the wallet itself).
//
// Safety rules on top of what Morpho Blue enforces:
//   - Only markets listed in Morpho's app, or, if Morpho's API is down, markets whose two tokens Holbric knows. Any other
//     market needs allowUnlisted: true and carries a warning (anyone can create a market with any oracle).
//   - Approvals are exact. A full repay approves the debt projected 15 minutes ahead, then sets the allowance back to 0
//     in the same action, so no allowance is left behind.
//   - Borrowing, or withdrawing collateral while in debt, is refused if the health factor afterwards would be under 1.10
//     at the market oracle (Morpho itself only stops at 1.00). The check runs again right before signing.
import { getAddress, parseAbi, parseUnits, encodeFunctionData, erc20Abi } from "viem";
import { publicClient, fmt, addrLink } from "./chain.js";
import { requireWallet, store, checkLimit, approveTx } from "./actions.js";
import { INTERMEDIATES } from "./route.js";
import { findStock } from "./stocks.js";
import { MORPHO, MORPHO_REGISTRY, allMarkets, marketStates, morphoApi, tokenMeta, unitUsd, readPositions, accrue, toAssetsDown, toAssetsUp, humanPrice, KIND_TEXT } from "./morpho.js";

export const MIN_HEALTH = 1.1;
const WAD = 10n ** 18n;
const MP = "(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams";
const morphoWriteAbi = parseAbi([
  `function supply(${MP}, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)`,
  `function withdraw(${MP}, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)`,
  `function borrow(${MP}, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)`,
  `function repay(${MP}, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)`,
  `function supplyCollateral(${MP}, uint256 assets, address onBehalf, bytes data)`,
  `function withdrawCollateral(${MP}, uint256 assets, address onBehalf, address receiver)`,
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
]);
const isZero = (a) => !a || /^0x0{40}$/i.test(a);
const tuple = (p) => ({ loanToken: p.loanToken, collateralToken: p.collateralToken, oracle: p.oracle, irm: p.irm, lltv: p.lltv });

function parseAmount(amount, decimals, name = "amount") {
  if (!/^\d+(\.\d+)?$/.test(String(amount ?? ""))) throw new Error(`${name} must be a positive decimal string, e.g. "5" or "0.25".`);
  const v = parseUnits(String(amount), decimals);
  if (v <= 0n) throw new Error(`${name} must be greater than zero.`);
  return v;
}

/** Health factor = collateral x oracle price x LLTV / debt (null when there is no debt). Same math as Morpho Blue's isHealthy. */
export function healthFactor(collateral, borrowed, price, lltv) {
  if (borrowed === 0n) return null;
  if (price == null) return 0;
  const maxBorrow = (((collateral * price) / 10n ** 36n) * lltv) / WAD;
  return Number((maxBorrow * 10n ** 12n) / borrowed) / 1e12;
}

/** One market and this wallet's position in it, at one block, with interest accrued to the block time. */
export async function loadMarket(who, marketId, { allowUnlisted = false } = {}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(marketId ?? ""))) throw new Error("marketId is the 32-byte Morpho market id (0x + 64 hex characters). morpho_markets lists them.");
  const c = publicClient();
  const block = await c.getBlock();
  const [all, api] = await Promise.all([allMarkets(block.number), morphoApi()]);
  const m = all.find((x) => x.id.toLowerCase() === marketId.toLowerCase());
  if (!m) throw new Error(`No Morpho Blue market with id ${marketId} on Robinhood Chain (checked ${all.length} CreateMarket events). Nothing was prepared.`);
  if (isZero(m.params.loanToken)) throw new Error("This market has no loan token. Nothing was prepared.");
  let listing;
  if (!api.error) listing = api.listed.get(m.id.toLowerCase()) ? "listed" : "unlisted";
  else {
    const known = async (a) => !isZero(a) && (INTERMEDIATES.some((t) => t.address === getAddress(a)) || !!(await findStock(a).catch(() => null)));
    listing = (await known(m.params.loanToken)) && (await known(m.params.collateralToken)) ? "known-tokens" : "unknown";
  }
  if ((listing === "unlisted" || listing === "unknown") && !allowUnlisted)
    throw new Error(listing === "unlisted"
      ? `Market ${m.id} is not listed in Morpho's app. Anyone can create a Morpho market with any token and any oracle, so Holbric does not write to unlisted markets unless the user explicitly asks (allowUnlisted: true). Nothing was prepared.`
      : `Morpho's API is unavailable (${api.error}), so the listing is unknown, and this market's tokens are not all WETH, USDG, cbBTC or official Robinhood Stock Tokens. Holbric only writes to it with allowUnlisted: true. Nothing was prepared.`);
  const [s] = await marketStates([m], block);
  const [loan, coll] = await Promise.all([tokenMeta(m.params.loanToken), tokenMeta(m.params.collateralToken)]);
  const p = await c.readContract({ address: MORPHO, abi: morphoWriteAbi, functionName: "position", args: [m.id, who], blockNumber: block.number });
  const [supplyShares, borrowShares, collateral] = p;
  const supplied = toAssetsDown(supplyShares, s.acc.tsa, s.acc.tss);
  const borrowed = toAssetsUp(borrowShares, s.acc.tba, s.acc.tbs);
  const liquidity = s.acc.tsa > s.acc.tba ? s.acc.tsa - s.acc.tba : 0n;
  return { block, m, s, api, listing, loan, coll, pos: { supplyShares, borrowShares, collateral, supplied, borrowed }, liquidity, params: tuple(m.params) };
}

const marketLabel = (x) => `${x.coll.symbol} collateral / ${x.loan.symbol} loan market ${x.m.id.slice(0, 10)}...${x.m.id.slice(-6)} (LLTV ${(Number(x.m.params.lltv) / 1e16).toFixed(2)}%)`;
const listingLine = (x) => ({
  listed: "The market is listed in Morpho's app (api.morpho.org).",
  unlisted: "WARNING: this market is NOT listed in Morpho's app. Anyone can create a Morpho market; check the tokens and the oracle before saying yes.",
  "known-tokens": "Morpho's API is unavailable, so the listing is unknown; both tokens are on Holbric's known lists.",
  unknown: "WARNING: Morpho's API is unavailable and this market uses tokens Holbric does not know. Check the tokens and the oracle before saying yes.",
}[x.listing]);
const tokenLine = (x) => `Loan token ${x.loan.symbol} ${x.loan.address} (${KIND_TEXT[x.loan.kind]}); collateral ${x.coll.symbol} ${x.coll.address} (${KIND_TEXT[x.coll.kind]}); oracle ${x.m.params.oracle}.`;
const hfText = (h) => (h == null ? "no debt" : h.toFixed(4));
const priceText = (x) => { const p = humanPrice(x.s.oraclePrice, x.loan.decimals, x.coll.decimals); return p == null ? "unreadable" : `1 ${x.coll.symbol} = ${p.toPrecision(8)} ${x.loan.symbol}`; };

async function balanceOf(token, who) {
  return publicClient().readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
}
async function allowanceOf(token, who) {
  return publicClient().readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [who, MORPHO] });
}
async function usdOf(meta, raw) {
  const u = await unitUsd(meta).catch(() => null);
  return u == null ? null : (Number(raw) / 10 ** meta.decimals) * u;
}
const call = (label, fn, args) => ({ label, to: MORPHO, value: 0n, data: encodeFunctionData({ abi: morphoWriteAbi, functionName: fn, args }) });
/** Exact approval for Morpho when the current allowance is short. A non-zero allowance below the need is reset to 0 first. */
async function approvalsFor(meta, who, amount) {
  const cur = await allowanceOf(meta.address, who);
  if (cur >= amount) return { txs: [], line: `Current ${meta.symbol} allowance for Morpho is already ${fmt(cur, meta.decimals, 18)}; no approval needed.` };
  const txs = [];
  if (cur > 0n) txs.push({ ...approveTx(meta.address, MORPHO, 0n, meta.symbol, meta.decimals), label: `reset ${meta.symbol} allowance for Morpho ${MORPHO} to 0` });
  txs.push({ ...approveTx(meta.address, MORPHO, amount, meta.symbol, meta.decimals), label: `approve exactly ${fmt(amount, meta.decimals, 18)} ${meta.symbol} for Morpho ${MORPHO}` });
  return { txs, line: `Approve exactly ${fmt(amount, meta.decimals, 18)} ${meta.symbol} for Morpho Blue ${MORPHO} (current allowance ${fmt(cur, meta.decimals, 18)}). Not unlimited.` };
}
/** A fresh read used right before signing: refuses if the health factor after the action would be under MIN_HEALTH. */
function healthGuard(who, marketId, after) {
  return async () => {
    const x = await loadMarket(who, marketId, { allowUnlisted: true });
    const { collateral, borrowed } = after(x);
    const h = healthFactor(collateral, borrowed, x.s.oraclePrice, x.m.params.lltv);
    return h != null && h < MIN_HEALTH ? `the health factor after this action would now be ${h.toFixed(4)} at the market oracle, under Holbric's minimum of ${MIN_HEALTH}` : null;
  };
}
const positionAfter = (who, marketId) => async () => {
  const c = publicClient(); const block = await c.getBlock();
  const r = await readPositions(who, block, { marketId });
  const p = r.positions[0];
  return { positionAfter: p ? { supplied: p.supplied, borrowed: p.borrowed, collateral: p.collateral, healthFactor: p.healthFactor, status: p.status } : "no position left in this market" };
};
const extraOf = (x, more = {}) => ({ morpho: { marketId: x.m.id, market: marketLabel(x), listing: x.listing, block: x.block.number.toString(), oraclePrice: priceText(x), addressSource: MORPHO_REGISTRY, explorer: addrLink(MORPHO), ...more } });

// ---- supply (lend the loan token) ------------------------------------------------------------------------------------
async function planMorphoSupply(from, { marketId, amount, allowUnlisted = false }) {
  const x = await loadMarket(from, marketId, { allowUnlisted });
  const v = parseAmount(amount, x.loan.decimals);
  const bal = await balanceOf(x.loan.address, from);
  if (bal < v) throw new Error(`Not enough ${x.loan.symbol}: wallet holds ${fmt(bal, x.loan.decimals, 18)}, supplying needs ${fmt(v, x.loan.decimals, 18)}. Nothing was prepared.`);
  const usd = await usdOf(x.loan, v); checkLimit(usd);
  const ap = await approvalsFor(x.loan, from, v);
  const txs = [...ap.txs, call(`supply ${fmt(v, x.loan.decimals, 18)} ${x.loan.symbol} to Morpho market ${x.m.id.slice(0, 10)}...`, "supply", [x.params, v, 0n, from, "0x"])];
  const lines = [
    `Lend ${fmt(v, x.loan.decimals, 18)} ${x.loan.symbol} on Morpho Blue in the ${marketLabel(x)}. It earns the supply rate, ${x.s.supplyApy == null ? "unknown" : (x.s.supplyApy * 100).toFixed(3) + "%"} APY at block ${x.block.number}, which moves with utilization.`,
    tokenLine(x), listingLine(x), ap.line,
    `You can withdraw while the market has free liquidity (now ${fmt(x.liquidity, x.loan.decimals, 6)} ${x.loan.symbol}). If borrowers use it all, withdrawals wait until it frees up. Bad debt in this market is shared by its lenders.`,
  ];
  return ({ kind: "morpho_supply", from, txs, lines, usd, onReceipt: positionAfter(from, x.m.id),
    valueLine: usd != null ? `Approximate value supplied: $${usd.toFixed(2)}.` : "Approximate USD value: not available.", extra: extraOf(x, { supplying: `${fmt(v, x.loan.decimals, 18)} ${x.loan.symbol}` }) });
}

// ---- borrow (optionally adding collateral first) -----------------------------------------------------------------------
async function planMorphoBorrow(from, { marketId, amount, collateralAmount, allowUnlisted = false }) {
  const x = await loadMarket(from, marketId, { allowUnlisted });
  if (isZero(x.m.params.collateralToken) || isZero(x.m.params.oracle)) throw new Error("This market has no collateral token or no oracle, so it cannot be borrowed from. Nothing was prepared.");
  if (x.s.oraclePrice == null) throw new Error(`The market oracle ${x.m.params.oracle} could not be read, so the position's health cannot be checked. Nothing was prepared.`);
  const v = parseAmount(amount, x.loan.decimals);
  const addColl = collateralAmount != null && collateralAmount !== "" ? parseAmount(collateralAmount, x.coll.decimals, "collateralAmount") : 0n;
  if (addColl === 0n && x.pos.collateral === 0n) throw new Error(`This wallet has no ${x.coll.symbol} collateral in this market. Pass collateralAmount to deposit some in the same action. Nothing was prepared.`);
  if (v > x.liquidity) throw new Error(`The market only has ${fmt(x.liquidity, x.loan.decimals, 6)} ${x.loan.symbol} free to borrow at block ${x.block.number}. Nothing was prepared.`);
  const collAfter = x.pos.collateral + addColl, debtAfter = x.pos.borrowed + v;
  const h = healthFactor(collAfter, debtAfter, x.s.oraclePrice, x.m.params.lltv);
  if (h < MIN_HEALTH) {
    const maxDebt = (((collAfter * x.s.oraclePrice) / 10n ** 36n) * x.m.params.lltv) / WAD;
    const room = (maxDebt * 1000n) / BigInt(Math.round(MIN_HEALTH * 1000)) - x.pos.borrowed;
    throw new Error(`Health factor after this borrow would be ${h.toFixed(4)} at the market oracle (${priceText(x)}), under Holbric's minimum of ${MIN_HEALTH}. With ${fmt(collAfter, x.coll.decimals, 6)} ${x.coll.symbol} as collateral you can borrow at most about ${fmt(room > 0n ? room : 0n, x.loan.decimals, 6)} ${x.loan.symbol} more. Add collateral (collateralAmount) or borrow less. Nothing was prepared.`);
  }
  const txs = []; const lines = [];
  let usd = 0;
  if (addColl > 0n) {
    const bal = await balanceOf(x.coll.address, from);
    if (bal < addColl) throw new Error(`Not enough ${x.coll.symbol}: wallet holds ${fmt(bal, x.coll.decimals, 18)}, the collateral needs ${fmt(addColl, x.coll.decimals, 18)}. Nothing was prepared.`);
    usd = await usdOf(x.coll, addColl); checkLimit(usd);
    const ap = await approvalsFor(x.coll, from, addColl);
    txs.push(...ap.txs, call(`supply ${fmt(addColl, x.coll.decimals, 18)} ${x.coll.symbol} as collateral to Morpho market ${x.m.id.slice(0, 10)}...`, "supplyCollateral", [x.params, addColl, from, "0x"]));
    lines.push(`Deposit ${fmt(addColl, x.coll.decimals, 18)} ${x.coll.symbol} as collateral in the ${marketLabel(x)}. Collateral earns nothing and can be liquidated.`, ap.line);
  }
  txs.push(call(`borrow ${fmt(v, x.loan.decimals, 18)} ${x.loan.symbol} from Morpho market ${x.m.id.slice(0, 10)}... to this wallet`, "borrow", [x.params, v, 0n, from, from]));
  const liqPrice = Number(fmt((debtAfter * 10n ** 36n * WAD) / (collAfter * x.m.params.lltv), 36 + x.loan.decimals - x.coll.decimals, 12));
  const nowPrice = humanPrice(x.s.oraclePrice, x.loan.decimals, x.coll.decimals);
  lines.push(
    `Borrow ${fmt(v, x.loan.decimals, 18)} ${x.loan.symbol} to this wallet at the variable borrow rate, ${x.s.borrowApy == null ? "unknown" : (x.s.borrowApy * 100).toFixed(3) + "%"} APY at block ${x.block.number}.`,
    tokenLine(x), listingLine(x),
    `Position after: ${fmt(collAfter, x.coll.decimals, 6)} ${x.coll.symbol} collateral, ${fmt(debtAfter, x.loan.decimals, 6)} ${x.loan.symbol} debt, health factor ${hfText(h)} at the oracle price ${priceText(x)}.`,
    `Liquidation: if 1 ${x.coll.symbol} falls to about ${liqPrice.toPrecision(6)} ${x.loan.symbol} at the oracle (${nowPrice ? ((1 - liqPrice / nowPrice) * 100).toFixed(2) + "% below now" : "distance unknown"}), anyone can liquidate part of the collateral. Interest raises the debt over time.`,
  );
  return ({ kind: "morpho_borrow", from, txs, lines, usd, onReceipt: positionAfter(from, x.m.id),
    minReceive: { token: x.loan.address, amount: v, symbol: x.loan.symbol, decimals: x.loan.decimals },
    beforeSign: healthGuard(from, x.m.id, (y) => ({ collateral: y.pos.collateral + addColl, borrowed: y.pos.borrowed + v })),
    valueLine: addColl > 0n ? (usd != null ? `Approximate value of the collateral deposited: $${usd.toFixed(2)}. The borrowed ${x.loan.symbol} comes to this wallet.` : "Approximate USD value of the collateral: not available.") : `No tokens leave the wallet; the borrowed ${x.loan.symbol} comes to it.`,
    extra: extraOf(x, { borrowing: `${fmt(v, x.loan.decimals, 18)} ${x.loan.symbol}`, collateralAdded: `${fmt(addColl, x.coll.decimals, 18)} ${x.coll.symbol}`, healthFactorAfter: +h.toFixed(4), minimumHealthFactor: MIN_HEALTH }) });
}

// ---- repay -----------------------------------------------------------------------------------------------------------------
async function planMorphoRepay(from, { marketId, amount, all = false, allowUnlisted = true }) {
  // Repaying lowers risk, so it is allowed on any market the wallet already borrows from.
  const x = await loadMarket(from, marketId, { allowUnlisted });
  if (x.pos.borrowShares === 0n) throw new Error(`This wallet has no ${x.loan.symbol} debt in market ${x.m.id}. Nothing was prepared.`);
  const bal = await balanceOf(x.loan.address, from);
  let txs, lines, usd, outflowSlackBps = 0;
  if (all || amount == null || amount === "") {
    if (!all) throw new Error("Give amount, or all: true to repay the whole debt.");
    // Repay by shares so no dust is left. Interest keeps accruing until signing, so approve the debt projected 15 minutes
    // ahead, and set the allowance back to 0 afterwards in the same action.
    const ahead = accrue(x.m.params, x.s.raw, x.s.rate, x.block.timestamp + 900n);
    const cap = toAssetsUp(x.pos.borrowShares, ahead.tba, ahead.tbs);
    if (bal < cap) throw new Error(`Not enough ${x.loan.symbol}: the debt is ${fmt(x.pos.borrowed, x.loan.decimals, 18)} ${x.loan.symbol} now and up to ${fmt(cap, x.loan.decimals, 18)} with 15 minutes of interest; the wallet holds ${fmt(bal, x.loan.decimals, 18)}. Nothing was prepared.`);
    usd = await usdOf(x.loan, x.pos.borrowed); checkLimit(usd);
    const cur = await allowanceOf(x.loan.address, from);
    txs = [
      ...(cur > 0n ? [{ ...approveTx(x.loan.address, MORPHO, 0n, x.loan.symbol, x.loan.decimals), label: `reset ${x.loan.symbol} allowance for Morpho ${MORPHO} to 0` }] : []),
      { ...approveTx(x.loan.address, MORPHO, cap, x.loan.symbol, x.loan.decimals), label: `approve exactly ${fmt(cap, x.loan.decimals, 18)} ${x.loan.symbol} for Morpho ${MORPHO} (debt plus at most 15 minutes of interest)` },
      call(`repay the whole ${x.loan.symbol} debt (${x.pos.borrowShares} borrow shares) in Morpho market ${x.m.id.slice(0, 10)}...`, "repay", [x.params, 0n, x.pos.borrowShares, from, "0x"]),
      { ...approveTx(x.loan.address, MORPHO, 0n, x.loan.symbol, x.loan.decimals), label: `set the ${x.loan.symbol} allowance for Morpho back to 0` },
    ];
    outflowSlackBps = 5; // interest between prepare and signing; still capped by the exact approval above
    lines = [
      `Repay the whole ${x.loan.symbol} debt in the ${marketLabel(x)}: ${fmt(x.pos.borrowed, x.loan.decimals, 18)} ${x.loan.symbol} at block ${x.block.number}, plus the few seconds of interest until it is mined.`,
      `Approve exactly ${fmt(cap, x.loan.decimals, 18)} ${x.loan.symbol} (the debt with up to 15 minutes of interest) for Morpho Blue ${MORPHO}, then set the allowance back to 0 after the repay. Nothing is left approved.`,
      tokenLine(x),
      x.pos.collateral > 0n ? `Your ${fmt(x.pos.collateral, x.coll.decimals, 18)} ${x.coll.symbol} collateral stays in the market; take it out with prepare_morpho_withdraw (what: collateral).` : "There is no collateral to take back.",
    ];
  } else {
    const v = parseAmount(amount, x.loan.decimals);
    if (v > x.pos.borrowed) throw new Error(`The debt is ${fmt(x.pos.borrowed, x.loan.decimals, 18)} ${x.loan.symbol}; repaying ${fmt(v, x.loan.decimals, 18)} is more than that. Use all: true to repay everything. Nothing was prepared.`);
    if (v === x.pos.borrowed) throw new Error("That is the whole debt. Use all: true, which repays by shares so no dust of interest is left. Nothing was prepared.");
    if (bal < v) throw new Error(`Not enough ${x.loan.symbol}: wallet holds ${fmt(bal, x.loan.decimals, 18)}, repaying needs ${fmt(v, x.loan.decimals, 18)}. Nothing was prepared.`);
    usd = await usdOf(x.loan, v); checkLimit(usd);
    const ap = await approvalsFor(x.loan, from, v);
    txs = [...ap.txs, call(`repay ${fmt(v, x.loan.decimals, 18)} ${x.loan.symbol} in Morpho market ${x.m.id.slice(0, 10)}...`, "repay", [x.params, v, 0n, from, "0x"])];
    const h = healthFactor(x.pos.collateral, x.pos.borrowed - v, x.s.oraclePrice, x.m.params.lltv);
    lines = [
      `Repay ${fmt(v, x.loan.decimals, 18)} ${x.loan.symbol} of the ${fmt(x.pos.borrowed, x.loan.decimals, 18)} ${x.loan.symbol} debt in the ${marketLabel(x)}.`,
      tokenLine(x), ap.line,
      `Health factor goes from ${hfText(healthFactor(x.pos.collateral, x.pos.borrowed, x.s.oraclePrice, x.m.params.lltv))} to ${hfText(h)} at the oracle price ${priceText(x)}.`,
    ];
  }
  return ({ kind: "morpho_repay", from, txs, lines, usd, outflowSlackBps, onReceipt: positionAfter(from, x.m.id),
    valueLine: usd != null ? `Approximate value repaid: $${usd.toFixed(2)}.` : "Approximate USD value: not available.", extra: extraOf(x, { debtBefore: `${fmt(x.pos.borrowed, x.loan.decimals, 18)} ${x.loan.symbol}` }) });
}

// ---- withdraw (supplied loan token or collateral) ---------------------------------------------------------------------------
async function planMorphoWithdraw(from, { marketId, what = "supply", amount, all = false, allowUnlisted = true }) {
  // Withdrawing only returns the wallet's own tokens, so it is allowed on any market.
  const x = await loadMarket(from, marketId, { allowUnlisted });
  if (what !== "supply" && what !== "collateral") throw new Error('what is "supply" (lent loan token) or "collateral".');
  if (!all && (amount == null || amount === "")) throw new Error("Give amount, or all: true.");
  let txs, lines, minReceive, beforeSign;
  if (what === "supply") {
    if (x.pos.supplyShares === 0n) throw new Error(`This wallet has nothing supplied in market ${x.m.id}. Nothing was prepared.`);
    const v = all ? x.pos.supplied : parseAmount(amount, x.loan.decimals);
    if (!all && v > x.pos.supplied) throw new Error(`Supplied is ${fmt(x.pos.supplied, x.loan.decimals, 18)} ${x.loan.symbol}; ${fmt(v, x.loan.decimals, 18)} is more than that. Use all: true to withdraw everything. Nothing was prepared.`);
    if (v > x.liquidity) throw new Error(`The market only has ${fmt(x.liquidity, x.loan.decimals, 6)} ${x.loan.symbol} free liquidity at block ${x.block.number}; withdrawing ${fmt(v, x.loan.decimals, 6)} has to wait until borrowers repay or the rate pulls in more supply. Nothing was prepared.`);
    txs = [all
      ? call(`withdraw all supplied ${x.loan.symbol} (${x.pos.supplyShares} supply shares) from Morpho market ${x.m.id.slice(0, 10)}... to this wallet`, "withdraw", [x.params, 0n, x.pos.supplyShares, from, from])
      : call(`withdraw ${fmt(v, x.loan.decimals, 18)} ${x.loan.symbol} from Morpho market ${x.m.id.slice(0, 10)}... to this wallet`, "withdraw", [x.params, v, 0n, from, from])];
    minReceive = { token: x.loan.address, amount: v, symbol: x.loan.symbol, decimals: x.loan.decimals };
    lines = [`Withdraw ${all ? "everything supplied, " : ""}${fmt(v, x.loan.decimals, 18)} ${x.loan.symbol}${all ? " at this block plus interest until it is mined," : ""} from the ${marketLabel(x)} to this wallet.`, tokenLine(x)];
  } else {
    if (x.pos.collateral === 0n) throw new Error(`This wallet has no ${x.coll.symbol} collateral in market ${x.m.id}. Nothing was prepared.`);
    const v = all ? x.pos.collateral : parseAmount(amount, x.coll.decimals, "amount");
    if (v > x.pos.collateral) throw new Error(`Collateral is ${fmt(x.pos.collateral, x.coll.decimals, 18)} ${x.coll.symbol}; ${fmt(v, x.coll.decimals, 18)} is more than that. Nothing was prepared.`);
    const h = healthFactor(x.pos.collateral - v, x.pos.borrowed, x.s.oraclePrice, x.m.params.lltv);
    if (h != null && h < MIN_HEALTH) throw new Error(x.pos.collateral === v
      ? `This position still owes ${fmt(x.pos.borrowed, x.loan.decimals, 6)} ${x.loan.symbol}; repay it first (prepare_morpho_repay, all: true). Nothing was prepared.`
      : `Health factor after this withdrawal would be ${h.toFixed(4)} at the market oracle (${priceText(x)}), under Holbric's minimum of ${MIN_HEALTH}. Withdraw less or repay first. Nothing was prepared.`);
    txs = [call(`withdraw ${fmt(v, x.coll.decimals, 18)} ${x.coll.symbol} collateral from Morpho market ${x.m.id.slice(0, 10)}... to this wallet`, "withdrawCollateral", [x.params, v, from, from])];
    minReceive = { token: x.coll.address, amount: v, symbol: x.coll.symbol, decimals: x.coll.decimals };
    if (x.pos.borrowShares > 0n) beforeSign = healthGuard(from, x.m.id, (y) => ({ collateral: y.pos.collateral - v, borrowed: y.pos.borrowed }));
    lines = [`Withdraw ${fmt(v, x.coll.decimals, 18)} ${x.coll.symbol} collateral from the ${marketLabel(x)} to this wallet.`, tokenLine(x),
      x.pos.borrowShares > 0n ? `Health factor goes from ${hfText(healthFactor(x.pos.collateral, x.pos.borrowed, x.s.oraclePrice, x.m.params.lltv))} to ${hfText(h)} at the oracle price ${priceText(x)}.` : "There is no debt in this market, so the collateral is free to take back."];
  }
  return ({ kind: "morpho_withdraw", from, txs, lines, usd: 0, minReceive, beforeSign, onReceipt: positionAfter(from, x.m.id),
    valueLine: "Tokens come back to this wallet; only the network fee is paid.", extra: extraOf(x, { withdrawing: what }) });
}

export const prepareMorphoSupply = async (a = {}) => store(await planMorphoSupply(requireWallet(), a));
export const prepareMorphoBorrow = async (a = {}) => store(await planMorphoBorrow(requireWallet(), a));
export const prepareMorphoRepay = async (a = {}) => store(await planMorphoRepay(requireWallet(), a));
export const prepareMorphoWithdraw = async (a = {}) => store(await planMorphoWithdraw(requireWallet(), a));
/** Tests only: the same plans (transactions, lines, checks) for any address, without storing or signing anything. */
export const _plan = { supply: planMorphoSupply, borrow: planMorphoBorrow, repay: planMorphoRepay, withdraw: planMorphoWithdraw };
