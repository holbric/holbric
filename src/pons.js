// Pons V2 launchpad on Robinhood Chain: token state, recent launches, bonding-curve quotes and trades.
// Factory 0x7ed5…ec7e is an exact match on Sourcify (PonsV2LaunchFactory). Curve calls: buy/sell(uint256 amountIn, uint256 minOut, address to).
import { parseAbi, parseUnits, erc20Abi, encodeFunctionData, isAddress, getAddress, parseEther, decodeEventLog } from "viem";
import { publicClient, ADDR, fmt, addrLink, CHAIN_ID } from "./chain.js";
import { walletAddress } from "./keystore.js";
import { requireWallet, slippage, checkLimit, approveTx, store } from "./actions.js";
import { tokenOverride } from "./storage.js";
import { quote as uniQuote } from "./swap.js";
import factoryAbi from "./abi/pons-factory.json" with { type: "json" };

const curveAbi = parseAbi([
  "function buy(uint256 amountIn, uint256 minOut, address to) payable returns (uint256)",
  "function sell(uint256 amountIn, uint256 minOut, address to) returns (uint256)",
  "function quoteReserve() view returns (uint256)", "function tokenReserve() view returns (uint256)",
  "function realQuoteReserve() view returns (uint256)", "function graduationThreshold() view returns (uint256)",
  "function feeBps() view returns (uint256)", "function creatorTaxBps() view returns (uint256)",
  "function graduated() view returns (bool)", "function readyToGraduate() view returns (bool)",
  "function isNativeQuote() view returns (bool)", "function launchedAt() view returns (uint256)",
  "function currentSnipeTaxBps(address) view returns (uint256)",
]);
const PROBE_FROM = "0x00000000000000000000000000000000000A11CE";

async function launched(token) {
  if (!isAddress(token || "")) throw new Error("token must be a 0x contract address.");
  const t = getAddress(token);
  const L = await publicClient().readContract({ address: ADDR.PONS_FACTORY, abi: factoryAbi, functionName: "getLaunchedToken", args: [t] });
  if (!L.exists) throw new Error(`${t} was not launched through the Pons V2 factory ${ADDR.PONS_FACTORY}.`);
  return { t, L };
}

async function pairMeta(L) {
  if (/^0x0{40}$/i.test(L.pairToken)) return { native: true, symbol: "ETH", decimals: 18, address: null };
  const c = publicClient();
  const [symbol, decimals] = await Promise.all([c.readContract({ address: L.pairToken, abi: erc20Abi, functionName: "symbol" }), c.readContract({ address: L.pairToken, abi: erc20Abi, functionName: "decimals" })]);
  return { native: false, symbol, decimals: Number(decimals), address: getAddress(L.pairToken) };
}

export async function ponsToken({ token }) {
  const { t, L } = await launched(token);
  const c = publicClient();
  const r = (fn, args = []) => c.readContract({ address: L.curve, abi: curveAbi, functionName: fn, args });
  const [pair, qR, tR, real, thr, fee, tax, grad, ready, at, name, symbol, supply, dead, block] = await Promise.all([
    pairMeta(L), r("quoteReserve"), r("tokenReserve"), r("realQuoteReserve"), r("graduationThreshold"), r("feeBps"), r("creatorTaxBps"),
    r("graduated"), r("readyToGraduate"), r("launchedAt").catch(() => null),
    c.readContract({ address: t, abi: erc20Abi, functionName: "name" }), c.readContract({ address: t, abi: erc20Abi, functionName: "symbol" }),
    c.readContract({ address: t, abi: erc20Abi, functionName: "totalSupply" }),
    c.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: ["0x000000000000000000000000000000000000dEaD"] }),
    c.getBlockNumber(),
  ]);
  const price = Number(qR) / 10 ** pair.decimals / (Number(tR) / 1e18);
  let priceUsd = null;
  if (pair.native) { try { const q = await uniQuote({ tokenIn: "WETH", tokenOut: "USDG", amount: "1" }); priceUsd = price * Number(q.view.tokenOut.amountOut); } catch {} }
  else if (pair.address === ADDR.USDG) priceUsd = price;
  return {
    token: t, name, symbol, totalSupply: fmt(supply, 18, 4), deadAddressBalance: fmt(dead, 18, 4),
    curve: L.curve, deployer: L.deployer, creatorFeeRecipient: L.creatorFeeRecipient, pair: pair.symbol,
    status: grad || Number(L.phase) !== 0 ? "graduated" : "bonding curve",
    phase: Number(L.phase), readyToGraduate: ready,
    pricePerToken: `${price.toPrecision(6)} ${pair.symbol}`, priceUsdApprox: priceUsd != null ? +priceUsd.toPrecision(6) : null,
    marketCapUsdApprox: priceUsd != null ? Math.round(priceUsd * Number(supply) / 1e18) : null,
    curveRealReserve: `${fmt(real, pair.decimals, 6)} ${pair.symbol}`, graduationThreshold: `${fmt(thr, pair.decimals, 6)} ${pair.symbol}`,
    progressPct: +((Number(real) / Number(thr)) * 100).toFixed(2),
    curveFeeBps: Number(fee), creatorTaxBps: Number(tax),
    launchedAt: at ? new Date(Number(at) * 1000).toISOString() : null,
    block: block.toString(), explorer: addrLink(t), pons: `https://ponsfamily.com/launchpad/${t.toLowerCase()}`,
  };
}

export async function ponsRecent({ hours = 6, limit = 20 } = {}) {
  if (hours <= 0 || hours > 72) throw new Error("hours must be between 0 and 72.");
  const c = publicClient();
  const latest = await c.getBlock();
  const prev = await c.getBlock({ blockNumber: latest.number - 10000n });
  const bps = 10000 / Math.max(1, Number(latest.timestamp - prev.timestamp));
  const span = BigInt(Math.ceil(hours * 3600 * bps));
  const ev = factoryAbi.find((x) => x.name === "TokenLaunched");
  const logs = [];
  const CH = 100000n;
  for (let to = latest.number; to > latest.number - span; to -= CH) {
    const from = to - CH + 1n > latest.number - span ? to - CH + 1n : latest.number - span + 1n;
    logs.push(...await c.getLogs({ address: ADDR.PONS_FACTORY, event: ev, fromBlock: from, toBlock: to }));
  }
  logs.sort((a, b) => Number(b.blockNumber - a.blockNumber));
  const rows = await Promise.all(logs.slice(0, limit).map(async (l) => {
    const t = l.args.token;
    const [name, symbol] = await Promise.all([c.readContract({ address: t, abi: erc20Abi, functionName: "name" }).catch(() => null), c.readContract({ address: t, abi: erc20Abi, functionName: "symbol" }).catch(() => null)]);
    return { token: t, name, symbol, curve: l.args.curve, deployer: l.args.deployer, pair: /^0x0{40}$/i.test(l.args.pairToken) ? "ETH" : l.args.pairToken, block: l.blockNumber.toString(), tx: l.transactionHash };
  }));
  return { factory: ADDR.PONS_FACTORY, lookbackHours: hours, fromBlock: (latest.number - span + 1n).toString(), toBlock: latest.number.toString(), launchesFound: logs.length, returned: rows.length, launches: rows };
}

async function simulate({ L, pair, side, amountIn, from }) {
  const c = publicClient();
  const overrides = [];
  let value = 0n;
  if (side === "buy") {
    if (pair.native) { value = amountIn; overrides.push({ address: from, balance: amountIn + parseEther("1") }); }
    else { const o = await tokenOverride(pair.address, from, L.curve, amountIn); if (!o) throw new Error("Could not simulate: unknown storage layout for the pair token."); overrides.push(o, { address: from, balance: parseEther("1") }); }
  } else {
    const o = await tokenOverride(L.token, from, L.curve, amountIn); if (!o) throw new Error("Could not simulate: unknown storage layout for this token.");
    overrides.push(o, { address: from, balance: parseEther("1") });
  }
  const { result } = await c.simulateContract({ account: from, address: L.curve, abi: curveAbi, functionName: side, args: [amountIn, 0n, from], value, stateOverride: overrides });
  return result;
}

export async function ponsQuote({ token, side, amount }) {
  if (side !== "buy" && side !== "sell") throw new Error('side must be "buy" or "sell".');
  if (!/^\d+(\.\d+)?$/.test(String(amount))) throw new Error("amount must be a positive decimal string.");
  const { t, L } = await launched(token);
  const c = publicClient();
  if (await c.readContract({ address: L.curve, abi: curveAbi, functionName: "graduated" }) || Number(L.phase) !== 0)
    throw new Error("This Pons token has graduated from its bonding curve. Holbric does not trade graduated Pons pools yet.");
  const pair = await pairMeta(L);
  const symbol = await c.readContract({ address: t, abi: erc20Abi, functionName: "symbol" });
  const inDec = side === "buy" ? pair.decimals : 18, outDec = side === "buy" ? 18 : pair.decimals;
  const amountIn = parseUnits(String(amount), inDec);
  const from = walletAddress() || PROBE_FROM;
  const out = await simulate({ L: { ...L, token: t }, pair, side, amountIn, from });
  const snipe = await c.readContract({ address: L.curve, abi: curveAbi, functionName: "currentSnipeTaxBps", args: [from] }).catch(() => null);
  const block = await c.getBlockNumber();
  return {
    token: t, symbol, side, curve: L.curve, block: block.toString(), quotedAt: new Date().toISOString(),
    amountIn: `${fmt(amountIn, inDec, 18)} ${side === "buy" ? pair.symbol : symbol}`,
    amountOut: `${fmt(out, outDec, side === "buy" ? 4 : 10)} ${side === "buy" ? symbol : pair.symbol}`, amountOutRaw: out.toString(),
    method: "eth_call simulation of the curve's own buy/sell with temporary balance overrides; nothing is signed",
    snipeTaxBpsForWallet: snipe != null ? Number(snipe) : null,
  };
}

export async function preparePonsTrade({ token, side, amount, slippageBps }) {
  const from = requireWallet();
  const slip = slippage(slippageBps);
  const q = await ponsQuote({ token, side, amount });
  const { t, L } = await launched(token);
  const pair = await pairMeta(L);
  const c = publicClient();
  const inDec = side === "buy" ? pair.decimals : 18, outDec = side === "buy" ? 18 : pair.decimals;
  const amountIn = parseUnits(String(amount), inDec);
  const inToken = side === "buy" ? (pair.native ? null : pair.address) : t;
  const bal = inToken ? await c.readContract({ address: inToken, abi: erc20Abi, functionName: "balanceOf", args: [from] }) : await c.getBalance({ address: from });
  if (bal < amountIn) throw new Error(`Not enough ${side === "buy" ? pair.symbol : q.symbol}: wallet holds ${fmt(bal, inDec, 18)}, trade needs ${fmt(amountIn, inDec, 18)}. Nothing was prepared.`);
  const minOut = (BigInt(q.amountOutRaw) * BigInt(10000 - slip)) / 10000n;
  let usd = null;
  try {
    const ethOrPair = side === "buy" ? amountIn : BigInt(q.amountOutRaw);
    if (pair.native) usd = Number((await uniQuote({ tokenIn: "WETH", tokenOut: "USDG", amount: fmt(ethOrPair, 18, 18) })).view.tokenOut.amountOut);
    else if (pair.address === ADDR.USDG) usd = Number(fmt(ethOrPair, 6, 6));
  } catch {}
  checkLimit(usd);
  const txs = [], lines = [];
  if (inToken) {
    const allowance = await c.readContract({ address: inToken, abi: erc20Abi, functionName: "allowance", args: [from, L.curve] });
    const sym = side === "buy" ? pair.symbol : q.symbol;
    if (allowance < amountIn) { txs.push(approveTx(inToken, L.curve, amountIn, sym, inDec)); lines.push(`Approve exactly ${fmt(amountIn, inDec, 18)} ${sym} for the Pons curve ${L.curve}. Not unlimited.`); }
  }
  txs.push({ label: `pons ${side} ${q.symbol}`, to: L.curve, value: side === "buy" && pair.native ? amountIn : 0n,
    data: encodeFunctionData({ abi: curveAbi, functionName: side, args: [amountIn, minOut, from] }) });
  lines.push(side === "buy"
    ? `Buy ${q.symbol} on its Pons bonding curve with ${q.amountIn}; receive at least ${fmt(minOut, outDec, 6)} ${q.symbol} (expected ${q.amountOut}).`
    : `Sell ${q.amountIn} on its Pons bonding curve; receive at least ${fmt(minOut, outDec, 8)} ${pair.symbol} (expected ${q.amountOut}).`);
  lines.push(`Slippage limit ${(slip / 100).toFixed(2)}%. The curve charges its own fee and creator tax; they are already inside the expected amount.${q.snipeTaxBpsForWallet ? ` Snipe tax for this wallet right now: ${q.snipeTaxBpsForWallet / 100}%.` : ""}`);
  return store({ kind: "pons_trade", from, txs, lines, usd, extra: { quote: q } });
}
