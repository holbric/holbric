// Pre-sign simulation. Every prepared action is replayed on Robinhood Chain mainnet with eth_simulateV1
// (all steps in order, in one simulated block, traceTransfers: true) before the user sees the summary,
// and again inside execute_prepared right before signing. Nothing is signed or sent here.
import { getAddress, erc20Abi, parseAbi, decodeErrorResult } from "viem";
import { publicClient, fmt, CHAIN_ID } from "./chain.js";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
// eth_simulateV1 reports native ETH movements as Transfer logs from this pseudo-address when traceTransfers is on.
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const topicAddr = (t) => getAddress("0x" + t.slice(26));

// Custom errors from the verified Pons V2 curve, hook and escrow sources, so a refusal names the real reason.
const KNOWN_ERRORS = parseAbi([
  "error NotFeeSweepOperator()", "error InternalSwapRequiresOperator()", "error AlreadyGraduated()", "error CurveGraduated()",
  "error SlippageExceeded(uint256 actual, uint256 minimum)", "error MinimumOutputRequired()", "error NativeValueMismatch(uint256 supplied, uint256 expected)",
  "error UnexpectedNativeValue()", "error ZeroAmount()", "error NoBalance()", "error InsufficientBalance()", "error UnknownPool()", "error TransferFailed()",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)", "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
]);
function revertReason(r) {
  if (r.data && r.data.length >= 10 && !r.data.startsWith("0x08c379a0")) {
    try { const d = decodeErrorResult({ abi: KNOWN_ERRORS, data: r.data }); return `${d.errorName}(${(d.args || []).map(String).join(", ")})`; } catch {}
  }
  return String(r.error?.shortMessage || r.error?.message || "reverted").replace(/^The contract function "<unknown>" reverted with the following reason:\s*/, "").split("\n").slice(0, 2).join(" ");
}

let overrideProvider = null;
/** Tests only: supply extra state overrides (pretend balances) for simulations. Never used by the server. */
export function _setSimOverrides(fn) { overrideProvider = fn; }

const meta = new Map([[NATIVE, { symbol: "ETH", decimals: 18 }]]);
async function tokenMeta(address) {
  if (meta.has(address)) return meta.get(address);
  const c = publicClient();
  const [symbol, decimals] = await Promise.all([
    c.readContract({ address, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
    c.readContract({ address, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
  ]);
  const m = { symbol, decimals: Number(decimals) };
  meta.set(address, m);
  return m;
}

let simulateV1Supported = null;
export const simulateMethod = () => simulateV1Supported;

/** Simulate txs ([{to,data,value,label}]) from `from`. Returns a plain object with deltas, approvals, gas and per-step status. */
export async function simulateTxs(from, txs) {
  const c = publicClient();
  const me = getAddress(from);
  const stateOverrides = overrideProvider ? await overrideProvider(me, txs) : undefined;
  const calls = txs.map((t) => ({ account: me, to: t.to, data: t.data, value: t.value ?? 0n }));
  const [gasPrice, block] = await Promise.all([c.getGasPrice(), c.getBlockNumber()]);
  let res = null;
  if (simulateV1Supported !== false) {
    for (let attempt = 0; attempt < 3 && !res; attempt++) {
      try {
        res = await c.simulateBlocks({ blocks: [{ calls, stateOverrides }], traceTransfers: true, validation: false, blockTag: "latest" });
        simulateV1Supported = true;
      } catch (e) {
        const msg = String(e?.details || e?.shortMessage || e?.message || e);
        if (/method not found|not supported|does not exist|unsupported|-32601/i.test(msg)) { simulateV1Supported = false; break; }
        if (attempt === 2) throw new Error(`Simulation request failed: ${msg.split("\n")[0]}`);
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
  }
  if (!res) return fallbackCall(c, me, txs, stateOverrides, gasPrice, block);

  const steps = [], logs = [];
  let gasUsed = 0n;
  res[0].calls.forEach((r, i) => {
    gasUsed += r.gasUsed ?? 0n;
    steps.push({ step: txs[i].label, status: r.status, gasUsed: (r.gasUsed ?? 0n).toString(),
      ...(r.status !== "success" ? { error: revertReason(r) } : {}) });
    if (r.status === "success") logs.push(...(r.logs || []));
  });
  const delta = new Map(), outflows = new Map(), inflows = new Map(), approvals = new Map();
  for (const l of logs) {
    if (!l.topics?.length) continue;
    const token = getAddress(l.address);
    if (l.topics[0] === TRANSFER && l.topics.length === 3 && l.data && l.data.length >= 66) {
      const f = topicAddr(l.topics[1]), t = topicAddr(l.topics[2]), v = BigInt(l.data.slice(0, 66));
      if (f === me && t === me) continue;
      if (f === me) { delta.set(token, (delta.get(token) ?? 0n) - v); const k = `${token}>${t}`; outflows.set(k, (outflows.get(k) ?? 0n) + v); }
      if (t === me) { delta.set(token, (delta.get(token) ?? 0n) + v); inflows.set(token, (inflows.get(token) ?? 0n) + v); }
    } else if (l.topics[0] === APPROVAL && l.topics.length === 3 && topicAddr(l.topics[1]) === me) {
      approvals.set(`${token}>${topicAddr(l.topics[2])}`, BigInt(l.data.slice(0, 66)));
    }
  }
  const view = async (m) => Promise.all([...m].map(async ([k, v]) => { const [token, other] = k.split(">"); const tm = await tokenMeta(token);
    return { token: token === NATIVE ? "ETH" : token, symbol: tm.symbol, amount: fmt(v, tm.decimals, 8), raw: v.toString(), ...(other ? { counterparty: other } : {}) }; }));
  const deltas = await Promise.all([...delta].map(async ([token, v]) => { const tm = await tokenMeta(token);
    return { token: token === NATIVE ? "ETH" : token, symbol: tm.symbol, change: (v > 0n ? "+" : "") + fmt(v, tm.decimals, 8), raw: v.toString() }; }));
  const gasWithMargin = (gasUsed * 110n) / 100n;
  return {
    method: "eth_simulateV1", chainId: CHAIN_ID, block: block.toString(), simulatedAt: new Date().toISOString(),
    ok: steps.every((s) => s.status === "success"), steps,
    walletDeltas: deltas, transfersOut: await view(outflows), transfersIn: await view(inflows),
    approvals: (await view(approvals)).map(({ counterparty, ...a }) => ({ ...a, spender: counterparty })),
    gas: { simulatedGasUsed: gasUsed.toString(), estimateWithMargin: gasWithMargin.toString(), gasPriceGwei: Number(gasPrice) / 1e9,
      estimatedFeeEth: fmt(gasWithMargin * gasPrice, 18, 10) },
    _raw: { outflows, inflows, approvals },
  };
}

/** Used only if the RPC does not support eth_simulateV1: eth_call each step on its own. No transfer trace is available. */
async function fallbackCall(c, me, txs, stateOverride, gasPrice, block) {
  const steps = [];
  for (const [i, t] of txs.entries()) {
    try { await c.call({ account: me, to: t.to, data: t.data, value: t.value ?? 0n, stateOverride }); steps.push({ step: t.label, status: "success" }); }
    catch (e) {
      // Later steps that depend on an earlier approval cannot be checked without a chained simulation.
      if (i > 0) { steps.push({ step: t.label, status: "not checked", note: "depends on an earlier step; eth_call cannot chain steps" }); continue; }
      steps.push({ step: t.label, status: "failure", error: String(e?.shortMessage || e?.message || e).split("\n")[0] });
    }
  }
  return { method: "eth_call (fallback: eth_simulateV1 not supported by this RPC)", chainId: CHAIN_ID, block: block.toString(), simulatedAt: new Date().toISOString(),
    ok: steps.every((s) => s.status !== "failure"), steps, walletDeltas: null, transfersOut: null, transfersIn: null, approvals: null,
    gas: { gasPriceGwei: Number(gasPrice) / 1e9 }, _raw: null };
}

/** Plain-language lines for the prepare summary. */
export function simulationLines(sim) {
  if (!sim._raw) return [`Checked with ${sim.method} at block ${sim.block}: every step that could be checked on its own succeeded. Token changes could not be traced on this RPC.`];
  const ch = sim.walletDeltas.length ? sim.walletDeltas.map((d) => `${d.change} ${d.symbol}`).join(", ") : "no token or ETH balance change";
  const ap = sim.approvals.length ? ` Approvals set: ${sim.approvals.map((a) => `${a.amount} ${a.symbol} for ${a.spender}`).join("; ")}.` : " No approvals are set.";
  return [`Simulated on mainnet just now (eth_simulateV1, block ${sim.block}, all steps in order): wallet change ${ch}, not counting the network fee.${ap} Estimated network fee about ${sim.gas.estimatedFeeEth} ETH (${sim.gas.estimateWithMargin} gas incl. 10% margin at ${sim.gas.gasPriceGwei} gwei).`];
}

/** Public view without the internal maps. */
export const simView = ({ _raw, ...v }) => v;

const human = (token, v) => { const m = meta.get(token) || { symbol: token, decimals: 18 }; return `${fmt(v, m.decimals, 8)} ${m.symbol}`; };

/**
 * Compare a fresh simulation with the one shown to the user. Returns null when it is safe to sign, otherwise a reason.
 * Refuses when: any step now reverts; ETH or tokens would leave the wallet to an address that was not in the preview;
 * more would leave than previewed; a new approval appears; or what the wallet receives fell by more than the slippage limit.
 */
export function compareSims(before, after, slippageBps) {
  const failed = after.steps.find((s) => s.status === "failure");
  if (failed) return `the simulation now reverts at "${failed.step}" (${failed.error || "reverted"})`;
  if (!before._raw || !after._raw) return null;
  for (const [k, v] of after._raw.outflows) {
    const [token, to] = k.split(">");
    const was = before._raw.outflows.get(k);
    if (was == null) return `an unexpected transfer of ${human(token, v)} from the wallet to ${to} appeared that was not in the preview`;
    if (v > was) return `${human(token, v)} would now leave the wallet to ${to}, more than the ${human(token, was)} in the preview`;
  }
  for (const k of after._raw.approvals.keys())
    if (!before._raw.approvals.has(k)) { const [token, spender] = k.split(">"); return `an unexpected approval of ${meta.get(token)?.symbol || token} for ${spender} appeared that was not in the preview`; }
  for (const [token, was] of before._raw.inflows) {
    const now = after._raw.inflows.get(token) ?? 0n;
    const floor = (was * BigInt(10000 - slippageBps)) / 10000n;
    if (now < floor) return `the wallet would now receive ${human(token, now)} instead of the ${human(token, was)} in the preview, worse than the ${(slippageBps / 100).toFixed(2)}% slippage limit`;
  }
  return null;
}
