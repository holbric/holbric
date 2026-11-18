// Prepared actions: every write is built here first, shown as a plain summary, and only signed after confirm: true.
import { createWalletClient, getAddress, formatUnits, erc20Abi, encodeFunctionData } from "viem";
import { randomBytes } from "node:crypto";
import { publicClient, robinhoodChain, transport, txLink, CHAIN_ID, localTime, fmt, ADDR } from "./chain.js";
import { loadConfig, spentToday, recordSpend } from "./config.js";
import { walletAddress, loadAccount } from "./keystore.js";
import { simulateTxs, simulationLines, simView, compareSims } from "./simulate.js";

const TTL_MS = 5 * 60 * 1000;
const pending = new Map();
const sweep = () => { const now = Date.now(); for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k); };

export function requireWallet() {
  const from = walletAddress();
  if (!from) throw new Error("No Holbric wallet yet. Ask the user to run `holbric init` in their own terminal.");
  return from;
}

export function slippage(bps) {
  const s = bps ?? loadConfig().slippageBps ?? 50;
  if (!Number.isInteger(s) || s < 1 || s > 500) throw new Error("slippageBps must be an integer between 1 and 500 (0.01% to 5%).");
  return s;
}

/** Throws if the daily USD limit would be crossed. usd may be null when the value is unknown. */
export function checkLimit(usd) {
  const limit = loadConfig().dailyLimitUsd;
  if (limit == null) return;
  if (usd == null) throw new Error("A daily USD limit is set and this action could not be valued in USDG, so it is blocked. The user can change the limit with `holbric limit` in their terminal.");
  const spent = spentToday();
  if (spent + usd > limit) throw new Error(`Daily limit $${limit}: spent today $${spent.toFixed(2)}, this action is about $${usd.toFixed(2)}. Blocked. The user can change the limit with \`holbric limit\` in their terminal.`);
}

export function approveTx(token, spender, amount, symbol, decimals) {
  return { label: `approve exactly ${fmt(amount, decimals, 18)} ${symbol} for ${spender}`, to: token, value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }) };
}

/** Store an action. txs: [{label,to,data,value}]; lines: plain-language steps. */
/**
 * minReceive check on a traced simulation: what the wallet receives of `token` must be at least `amount`.
 * Returns null when it holds, otherwise a reason. Untraced (eth_call fallback) simulations cannot be checked and return null.
 */
export function minReceiveReason(sim, m) {
  if (!m || !sim._raw) return null;
  const got = sim._raw.inflows.get(m.token) ?? 0n;
  if (got >= m.amount) return null;
  return `the wallet would receive ${fmt(got, m.decimals, 18)} ${m.symbol}, below the minimum output of ${fmt(m.amount, m.decimals, 18)} ${m.symbol}`;
}

export async function store({ kind, from, txs, lines, usd, extra = {}, onReceipt, slippageBps, valueLine, minReceive }) {
  sweep();
  const c = publicClient();
  const ethBal = await c.getBalance({ address: from });
  const valueOut = txs.reduce((a, t) => a + (t.value ?? 0n), 0n);
  if (ethBal === 0n || ethBal <= valueOut) throw new Error(`Wallet ${from} has ${fmt(ethBal, 18)} ETH, which is not enough for the network fee${valueOut ? " on top of the ETH being sent" : ""}. Fund it with ETH on Robinhood Chain first. Nothing was prepared.`);
  const sim = await simulateTxs(from, txs);
  if (!sim.ok) {
    const bad = sim.steps.find((s) => s.status === "failure");
    throw new Error(`Pre-sign simulation on mainnet failed at "${bad.step}": ${bad.error}. Nothing was prepared.`);
  }
  const short = minReceiveReason(sim, minReceive);
  if (short) throw new Error(`Pre-sign simulation on mainnet: ${short}. Nothing was prepared.`);
  const minLine = minReceive && sim._raw ? [`Output check in the simulation: the wallet receives ${fmt(sim._raw.inflows.get(minReceive.token) ?? 0n, minReceive.decimals, 18)} ${minReceive.symbol}, at or above the minimum ${fmt(minReceive.amount, minReceive.decimals, 18)} ${minReceive.symbol}. execute_prepared checks this again before signing.`] : [];
  const slip = slippageBps ?? slippage();
  const limit = loadConfig().dailyLimitUsd;
  const id = "hp_" + randomBytes(6).toString("hex");
  const expiresAt = Date.now() + TTL_MS;
  pending.set(id, { id, kind, from, txs, usd, expiresAt, onReceipt, sim, slippageBps: slip, minReceive });
  const summary = [
    `From wallet ${from} on Robinhood Chain mainnet (chain id ${CHAIN_ID}).`,
    ...lines.map((s, i) => `${i + 1}. ${s}`),
    ...simulationLines(sim),
    ...minLine,
    `${txs.length} transaction${txs.length > 1 ? "s" : ""} to sign. Network fee is paid in ETH (wallet holds ${fmt(ethBal, 18)} ETH). No Holbric fee.`,
    valueLine ? valueLine : usd === 0 ? "No tokens leave the wallet; only the network fee is paid." : usd != null ? `Approximate value: $${usd.toFixed(2)}${limit != null ? ` (daily limit $${limit}, spent today $${spentToday().toFixed(2)})` : ""}.` : "Approximate USD value: not available.",
    `This preview expires at ${localTime(new Date(expiresAt))}. Show it to the user and ask for a clear yes or no before calling execute_prepared.`,
  ].join("\n");
  return { prepareId: id, kind, expiresAt: new Date(expiresAt).toISOString(), transactions: txs.length, summary, simulation: simView(sim), ...extra };
}

/** Re-simulate a prepared action and compare with its preview. Returns { ok, reason, simulation }. Never signs. */
export async function recheck(p) {
  const sim = await simulateTxs(p.from, p.txs);
  const reason = compareSims(p.sim, sim, p.slippageBps) || minReceiveReason(sim, p.minReceive);
  return { ok: !reason, reason, simulation: simView(sim) };
}

export async function execute({ prepareId, confirm }) {
  sweep();
  if (confirm !== true) throw new Error("execute_prepared needs confirm: true, sent only after the user said yes to the summary in chat.");
  const p = pending.get(prepareId);
  if (!p) throw new Error("Unknown or expired prepareId. Prepare again and show the user the new summary.");
  pending.delete(prepareId);
  // Re-simulate right before signing. Refuse if anything got worse than the preview the user agreed to.
  const check = await recheck(p);
  if (!check.ok) throw new Error(`Refused before signing: ${check.reason}. Nothing was signed or sent. Prepare again and show the user the new summary.`);
  const account = loadAccount();
  if (getAddress(account.address) !== getAddress(p.from)) throw new Error("Keystore address changed since prepare. Prepare again.");
  checkLimit(p.usd);
  const c = publicClient();
  const w = createWalletClient({ account, chain: robinhoodChain, transport: transport() });
  const out = { prepareId, kind: p.kind, preSignCheck: `re-simulated at block ${check.simulation.block} (${check.simulation.method}); matches the preview within the ${(p.slippageBps / 100).toFixed(2)}% slippage limit`, transactions: [] };
  for (const tx of p.txs) {
    const hash = await w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0n });
    const r = await c.waitForTransactionReceipt({ hash, timeout: 120_000 });
    out.transactions.push({ step: tx.label, hash, status: r.status, block: r.blockNumber.toString(), explorer: txLink(hash) });
    if (r.status !== "success") { out.result = `Reverted at: ${tx.label}. Later steps were not sent.`; return out; }
    if (tx === p.txs[p.txs.length - 1] && p.onReceipt) Object.assign(out, await p.onReceipt(r).catch(() => ({})));
  }
  if (p.usd != null) out.spentTodayUsd = +recordSpend(p.usd).toFixed(2);
  out.result = "Confirmed on Robinhood Chain mainnet.";
  return out;
}

/** In-process inspection for tests only (not exposed as a tool). */
export const _peek = (id) => pending.get(id);
