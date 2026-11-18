// KyberSwap Aggregator on Robinhood Chain mainnet (chain id 4663, API chain slug "robinhood").
// This is a third-party API: when it is used, the tokens, the amount and (for prepare_swap) the wallet address are sent
// to KyberSwap's servers. Turn it off with HOLBRIC_NO_AGGREGATORS=1 or `holbric aggregators off`; Holbric then only
// uses its own Uniswap v3 and v4 routing, which reads the chain directly.
//
// Holbric never takes a fee and sends no fee or referral parameters. Every route KyberSwap returns is checked here:
// the router must be MetaAggregationRouterV2 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5 (docs.kyberswap.com, "Contracts &
// Addresses", Robinhood (ChainID: 4663); Sourcify exact match on chain 4663), the calldata is decoded and must name the
// right tokens, amount, recipient and minimum output with no fee receivers, and the result is simulated on mainnet.
import { getAddress, decodeFunctionData, erc20Abi } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { publicClient, fmt } from "./chain.js";
import { loadConfig } from "./config.js";
import { simulateTxs, NATIVE_TRACE } from "./simulate.js";
import { tokenOverride } from "./storage.js";
import routerAbi from "./abi/kyber-meta-router-v2.json" with { type: "json" };

export const KYBER_API = "https://aggregator-api.kyberswap.com/robinhood/api/v1";
export const KYBER_ROUTER = getAddress("0x6131B5fae19EA4f9D964eAc0408E4408b66337b5"); // MetaAggregationRouterV2
export const KYBER_EXECUTOR = getAddress("0x8F10B468b06c6FD214B65F87778827F7D113f996"); // AggregationExecutorProxy (docs)
export const KS_NATIVE = getAddress("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"); // KyberSwap's native ETH placeholder
const TIMEOUT_MS = 10_000;

/** Off when HOLBRIC_NO_AGGREGATORS is 1/true/yes, or `aggregators: false` in config.json. On otherwise. */
export function aggregatorsEnabled() {
  if (/^(1|true|yes|on)$/i.test(process.env.HOLBRIC_NO_AGGREGATORS || "")) return false;
  return loadConfig().aggregators !== false;
}
export const disabledReason = () => (process.env.HOLBRIC_NO_AGGREGATORS ? "HOLBRIC_NO_AGGREGATORS is set" : "turned off with `holbric aggregators off`");

const ksToken = (t) => (t.native ? KS_NATIVE : getAddress(t.address));

async function api(path, init = {}) {
  let r;
  for (let attempt = 0; ; attempt++) {
    try {
      r = await fetch(`${KYBER_API}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: "application/json", "content-type": "application/json", "x-client-id": "holbric", ...(init.headers || {}) } });
    } catch (e) { throw new Error(`KyberSwap API unreachable (${e.name === "TimeoutError" ? `no answer in ${TIMEOUT_MS / 1000}s` : e.message})`); }
    // The public endpoint is rate limited. Wait and retry twice, then give up (callers fall back to Holbric's own routing).
    if (r.status !== 429 || attempt === 2) break;
    await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
  }
  const body = await r.json().catch(() => null);
  if (!r.ok || !body || body.code !== 0) throw new Error(`KyberSwap API ${r.status}${body?.message ? `: ${body.message}` : ""}`);
  return body.data;
}

const symCache = new Map([[KS_NATIVE, "ETH"]]);
async function sym(address) {
  const a = getAddress(address);
  if (!symCache.has(a)) symCache.set(a, await publicClient().readContract({ address: a, abi: erc20Abi, functionName: "symbol" }).catch(() => a.slice(0, 8)));
  return symCache.get(a);
}

/** Plain description of a KyberSwap route: each split path as "WETH -uniswap-v4-> USDG", with its share of the input. */
async function describeRoute(summary) {
  const amountIn = BigInt(summary.amountIn);
  const paths = await Promise.all((summary.route || []).map(async (path) => {
    let s = await sym(path[0].tokenIn);
    for (const step of path) s += ` -${step.exchange}-> ${await sym(step.tokenOut)}`;
    const share = amountIn > 0n ? Number((BigInt(path[0].swapAmount) * 10000n) / amountIn) / 100 : 0;
    return { route: s, hops: path.length, sharePct: share, pools: path.map((x) => x.pool), sources: path.map((x) => x.exchange) };
  }));
  return { text: paths.map((p) => (paths.length > 1 ? `${p.sharePct}%: ${p.route}` : p.route)).join(" | "), paths,
    sources: [...new Set(paths.flatMap((p) => p.sources))], hops: Math.max(0, ...paths.map((p) => p.hops)) };
}

/**
 * GET /routes. Returns { amountOut, routeSummary, routerAddress, gas, description, requestedAt }. Throws on any check that fails.
 */
export async function kyberRoute({ tIn, tOut, amountIn }) {
  const q = new URLSearchParams({ tokenIn: ksToken(tIn), tokenOut: ksToken(tOut), amountIn: amountIn.toString() });
  const requestedAt = new Date();
  const d = await api(`/routes?${q}`);
  const s = d?.routeSummary;
  if (!s || !s.amountOut || !(s.route || []).length) throw new Error("KyberSwap returned no route");
  if (getAddress(d.routerAddress) !== KYBER_ROUTER) throw new Error(`KyberSwap named router ${d.routerAddress}, not the verified MetaAggregationRouterV2 ${KYBER_ROUTER}; not used`);
  if (getAddress(s.tokenIn) !== ksToken(tIn) || getAddress(s.tokenOut) !== ksToken(tOut) || BigInt(s.amountIn) !== amountIn)
    throw new Error("KyberSwap answered for different tokens or a different amount; not used");
  if (s.extraFee && s.extraFee.feeAmount && s.extraFee.feeAmount !== "0") throw new Error("KyberSwap route carries an extra fee; not used");
  return { amountOut: BigInt(s.amountOut), routeSummary: s, routerAddress: KYBER_ROUTER, gas: s.gas, gasUsd: s.gasUsd,
    description: await describeRoute(s), requestedAt, routeId: s.routeID || null };
}

/**
 * POST /route/build for `sender` (who is also the recipient). No fee or referral fields are sent.
 * The calldata is decoded and checked: router, function, tokens, amount, recipient, minimum output, no fee receivers.
 * Returns { tx: {to,data,value}, amountOut, minReturn, fn }.
 */
export async function kyberBuild({ route, tIn, tOut, amountIn, sender, slippageBps, deadline }) {
  const d = await api("/route/build", { method: "POST", body: JSON.stringify({
    routeSummary: route.routeSummary, sender, recipient: sender, slippageTolerance: slippageBps, deadline: Number(deadline), source: "holbric" }) });
  if (getAddress(d.routerAddress) !== KYBER_ROUTER) throw new Error(`KyberSwap build named router ${d.routerAddress}, not ${KYBER_ROUTER}`);
  const value = BigInt(d.transactionValue || "0");
  if (value !== (tIn.native ? amountIn : 0n)) throw new Error(`KyberSwap build asks for ${fmt(value, 18)} ETH of value; expected ${tIn.native ? fmt(amountIn, 18) : "0"}`);
  let call;
  try { call = decodeFunctionData({ abi: routerAbi, data: d.data }); } catch { throw new Error("KyberSwap calldata is not a MetaAggregationRouterV2 swap or swapSimpleMode call"); }
  const desc = call.functionName === "swap" ? call.args[0].desc : call.args[1];
  const executor = call.functionName === "swap" ? call.args[0].callTarget : call.args[0];
  const amountOut = BigInt(d.amountOut);
  const floor = (amountOut * BigInt(10000 - slippageBps)) / 10000n;
  const problems = [];
  if (getAddress(executor) !== KYBER_EXECUTOR) problems.push(`executor ${executor} is not the documented AggregationExecutorProxy ${KYBER_EXECUTOR}`);
  if (getAddress(desc.srcToken) !== ksToken(tIn)) problems.push(`srcToken ${desc.srcToken}`);
  if (getAddress(desc.dstToken) !== ksToken(tOut)) problems.push(`dstToken ${desc.dstToken}`);
  if (desc.amount !== amountIn) problems.push(`amount ${desc.amount}`);
  if (desc.srcAmounts.reduce((a, b) => a + b, 0n) > amountIn) problems.push("srcAmounts add up to more than the amount");
  if (getAddress(desc.dstReceiver) !== getAddress(sender)) problems.push(`recipient ${desc.dstReceiver}`);
  if (desc.feeReceivers.length || desc.feeAmounts.length) problems.push("fee receivers are set");
  if (desc.permit !== "0x") problems.push("a permit is attached");
  if (desc.minReturnAmount < floor || desc.minReturnAmount === 0n) problems.push(`minimum output ${desc.minReturnAmount} is below ${floor}`);
  if (problems.length) throw new Error(`KyberSwap calldata failed Holbric's checks: ${problems.join("; ")}`);
  return { tx: { to: KYBER_ROUTER, data: d.data, value }, amountOut, minReturn: desc.minReturnAmount, fn: call.functionName };
}

// A throwaway address that only exists inside simulations: it gets a pretend balance and allowance by state override.
const PROBE = privateKeyToAddress(generatePrivateKey());

/**
 * Check what a KyberSwap route really delivers: build it for a throwaway address, give that address the input by state
 * override, and run the router call with eth_simulateV1 on mainnet. Returns { simulated, received, block, reason }.
 */
export async function kyberSimulate({ route, tIn, tOut, amountIn, slippageBps = 50 }) {
  const built = await kyberBuild({ route, tIn, tOut, amountIn, sender: PROBE, slippageBps, deadline: Math.floor(Date.now() / 1000) + 600 });
  const overrides = [{ address: PROBE, balance: amountIn + 10n ** 18n }];
  if (!tIn.native) {
    const o = await tokenOverride(tIn.address, PROBE, KYBER_ROUTER, amountIn);
    if (!o) return { simulated: false, reason: `could not find ${tIn.symbol}'s balance storage slot to simulate with a pretend balance`, apiAmountOut: built.amountOut };
    overrides.push(o);
  }
  const sim = await simulateTxs(PROBE, [{ label: "KyberSwap route (simulation only)", ...built.tx }], { stateOverrides: overrides });
  if (!sim.ok) return { simulated: true, ok: false, block: sim.block, reason: sim.steps.find((s) => s.status === "failure")?.error || "reverted", apiAmountOut: built.amountOut };
  if (!sim._raw) return { simulated: false, reason: "this RPC has no eth_simulateV1 transfer trace", apiAmountOut: built.amountOut };
  const received = sim._raw.inflows.get(tOut.native ? NATIVE_TRACE : getAddress(tOut.address)) ?? 0n;
  return { simulated: true, ok: received > 0n, received, block: sim.block, apiAmountOut: built.amountOut, minReturn: built.minReturn };
}
