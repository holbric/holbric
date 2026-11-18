// Relay (relay.link) bridging between Robinhood Chain mainnet (chain id 4663) and a few major EVM chains.
// Relay is a third-party API and a third-party settlement protocol. A quote sends Relay the chains, tokens and amount;
// prepare_bridge also sends the wallet address (as sender and refund address) and the recipient. Turn it off with
// HOLBRIC_NO_BRIDGES=1 or `holbric bridges off`.
//
// What Holbric checks before it lets a bridge be signed (Relay's own "Input Validation" procedure,
// docs.relay.link/references/api/api_core_concepts/input-validation):
//  - the deposit goes to the RelayDepository 0x4cD00E387622C35bDDB9b4c962C136462338BC31 on chain 4663 (pinned here,
//    exact match on Sourcify as RelayDepository, and it must also be the depository Relay's /chains lists for chain 4663);
//  - the order id is recomputed locally from the order data (EIP-712 hashStruct, same types as Relay's settlement SDK)
//    and the deposit calldata must commit to that id;
//  - the order pays the right token and amount on the right chain to the recipient, with a minimum output no worse than
//    the slippage limit, no destination calls, no fees to anyone, every refund to the wallet, and a deadline ahead;
//  - Holbric encodes the deposit (and an exact approval for USDG) itself, compares it byte for byte with Relay's, and
//    simulates it on mainnet. Only transactions on Robinhood Chain are prepared: bridging in is quote-only.
// No Holbric fee. Holbric sends no app fee, referrer or fee parameters to Relay.
import { getAddress, isAddress, hashStruct, encodeFunctionData, decodeFunctionData, parseAbi, parseUnits, formatUnits, erc20Abi, decodeEventLog } from "viem";
import { publicClient, ADDR, CHAIN_ID, fmt, localTime, txLink, EXPLORER } from "./chain.js";
import { loadConfig } from "./config.js";
import { requireWallet, slippage, checkLimit, approveTx, store, discard } from "./actions.js";

export const RELAY_API = "https://api.relay.link";
// RelayDepository on Robinhood Chain: Relay /chains (protocol.v2.depository for chain 4663) and Sourcify exact match (RelayDepository).
export const RELAY_DEPOSITORY = getAddress("0x4cD00E387622C35bDDB9b4c962C136462338BC31");
const ZERO = "0x0000000000000000000000000000000000000000";
const PLACEHOLDER = getAddress("0x000000000000000000000000000000000000dEaD"); // quotes are asked for this address, not the wallet
const TIMEOUT_MS = 15_000;

// Chains Holbric bridges with. `relay` is Relay's protocol chain id; `tokens` are the only currencies accepted on that side.
// Stablecoin addresses are the issuers' contracts as Relay lists them in /chains.
export const CHAINS = {
  4663: { name: "Robinhood Chain", relay: "robinhood", explorer: EXPLORER, tokens: { ETH: { address: ZERO, decimals: 18 }, USDG: { address: ADDR.USDG, decimals: 6 } } },
  1: { name: "Ethereum", relay: "ethereum", explorer: "https://etherscan.io", tokens: { ETH: { address: ZERO, decimals: 18 }, USDC: { address: getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"), decimals: 6 }, USDG: { address: getAddress("0xe343167631d89b6ffc58b88d6b7fb0228795491d"), decimals: 6 } } },
  8453: { name: "Base", relay: "base", explorer: "https://basescan.org", tokens: { ETH: { address: ZERO, decimals: 18 }, USDC: { address: getAddress("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"), decimals: 6 } } },
  42161: { name: "Arbitrum One", relay: "arbitrum", explorer: "https://arbiscan.io", tokens: { ETH: { address: ZERO, decimals: 18 }, USDC: { address: getAddress("0xaf88d065e77c8cc2239327c5edb3a432268e5831"), decimals: 6 } } },
  10: { name: "OP Mainnet", relay: "optimism", explorer: "https://optimistic.etherscan.io", tokens: { ETH: { address: ZERO, decimals: 18 }, USDC: { address: getAddress("0x0b2c639c533813f4aa9d7837caf62653d097ff85"), decimals: 6 } } },
  130: { name: "Unichain", relay: "unichain", explorer: "https://uniscan.xyz", tokens: { ETH: { address: ZERO, decimals: 18 }, USDC: { address: getAddress("0x078d782b760474a361dda0af3839290b0ef57ad6"), decimals: 6 } } },
};
const ALIASES = { robinhood: 4663, "robinhood chain": 4663, rh: 4663, ethereum: 1, eth: 1, mainnet: 1, base: 8453, arbitrum: 42161, "arbitrum one": 42161, arb: 42161,
  optimism: 10, op: 10, "op mainnet": 10, unichain: 130 };
const RELAY_TO_ID = Object.fromEntries(Object.entries(CHAINS).map(([id, c]) => [c.relay, Number(id)]));
export const chainList = () => Object.entries(CHAINS).map(([id, c]) => `${c.name} (${id}): ${Object.keys(c.tokens).join(", ")}`).join("; ");

/** Off when HOLBRIC_NO_BRIDGES is 1/true/yes/on, or `bridges: false` in config.json. On otherwise. */
export function bridgesEnabled() {
  if (/^(1|true|yes|on)$/i.test(process.env.HOLBRIC_NO_BRIDGES || "")) return false;
  return loadConfig().bridges !== false;
}
const offReason = () => (/^(1|true|yes|on)$/i.test(process.env.HOLBRIC_NO_BRIDGES || "") ? "HOLBRIC_NO_BRIDGES is set" : "turned off with `holbric bridges off`");
function requireOn() {
  if (!bridgesEnabled()) throw new Error(`Bridging through Relay is turned off (${offReason()}); nothing was sent to Relay. Turn it on with \`holbric bridges on\`.`);
}

export function resolveChain(input) {
  if (input == null || input === "") throw new Error(`Chain is required. Supported: ${chainList()}.`);
  const k = String(input).trim().toLowerCase();
  const id = /^\d+$/.test(k) ? Number(k) : ALIASES[k];
  if (!id || !CHAINS[id]) throw new Error(`Unsupported chain "${input}". Holbric bridges between Robinhood Chain (4663) and: ${chainList()}.`);
  return { id, ...CHAINS[id] };
}
function resolveToken(chain, sym) {
  const k = String(sym || "").trim().toUpperCase();
  const t = chain.tokens[k];
  if (!t) throw new Error(`${chain.name}: token "${sym}" is not supported for bridging. Use ${Object.keys(chain.tokens).join(" or ")}.`);
  return { symbol: k, ...t, native: t.address === ZERO };
}
/** Default output token: same symbol if the other side has it, otherwise USDG <-> USDC. */
function defaultOut(chain, symIn) {
  if (chain.tokens[symIn]) return symIn;
  if ((symIn === "USDG" || symIn === "USDC") && chain.tokens.USDG) return "USDG";
  if ((symIn === "USDG" || symIn === "USDC") && chain.tokens.USDC) return "USDC";
  throw new Error(`No default output token for ${symIn} on ${chain.name}; name toToken.`);
}

async function api(path, init = {}) {
  let r;
  for (let attempt = 0; ; attempt++) {
    try {
      r = await fetch(`${RELAY_API}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: "application/json", "content-type": "application/json", "user-agent": "holbric-mcp", ...(init.headers || {}) } });
    } catch (e) { throw new Error(`Relay API unreachable (${e.name === "TimeoutError" ? `no answer in ${TIMEOUT_MS / 1000}s` : e.message})`); }
    if (r.status !== 429 || attempt === 2) break;
    await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
  }
  const body = await r.json().catch(() => null);
  if (!r.ok || !body) throw new Error(`Relay API ${r.status}${body?.message ? `: ${body.message}` : ""}`);
  return body;
}

// /chains, cached for 10 minutes. Only the chains in CHAINS are ever read from it.
let chainsCache = null;
/** Tests only: forget the cached /chains answer. */
export const _resetChainsCache = () => { chainsCache = null; };
export async function relayChains() {
  if (chainsCache && Date.now() - chainsCache.at < 600_000) return chainsCache.byId;
  const { chains } = await api("/chains");
  const byId = new Map();
  for (const c of chains || []) if (CHAINS[c.id]) byId.set(c.id, c);
  chainsCache = { at: Date.now(), byId };
  return byId;
}
/** Relay must list both chains, enabled, as EVM chains with the protocol id Holbric expects, and the 4663 depository must match. */
async function checkChains(...ids) {
  const byId = await relayChains();
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) throw new Error(`Relay's /chains does not list chain ${id} (${CHAINS[id].name}) right now; nothing was quoted.`);
    if (c.disabled || c.depositEnabled === false) throw new Error(`Relay lists ${CHAINS[id].name} as disabled right now; nothing was quoted.`);
    if (c.vmType !== "evm" || c.protocol?.v2?.chainId !== CHAINS[id].relay) throw new Error(`Relay's /chains entry for ${CHAINS[id].name} changed (vm ${c.vmType}, protocol id ${c.protocol?.v2?.chainId}); Holbric will not use it until it is re-verified.`);
  }
  const rh = byId.get(CHAIN_ID);
  if (!rh || getAddress(rh.protocol?.v2?.depository || ZERO) !== RELAY_DEPOSITORY)
    throw new Error(`Relay's /chains names depository ${rh?.protocol?.v2?.depository} for Robinhood Chain, not the verified RelayDepository ${RELAY_DEPOSITORY}. Not used.`);
  return byId;
}

// ---- Order id: EIP-712 hashStruct over the order, the same types as Relay's settlement SDK (getOrderId). EVM chains only.
const ORDER_TYPES = {
  Order: [{ name: "version", type: "string" }, { name: "solverChainId", type: "string" }, { name: "solver", type: "address" }, { name: "salt", type: "uint256" },
    { name: "inputs", type: "Input[]" }, { name: "output", type: "Output" }, { name: "fees", type: "Fee[]" }],
  Input: [{ name: "payment", type: "InputPayment" }, { name: "refunds", type: "InputRefund[]" }],
  InputPayment: [{ name: "chainId", type: "string" }, { name: "currency", type: "bytes" }, { name: "amount", type: "uint256" }, { name: "weight", type: "uint256" }],
  InputRefund: [{ name: "chainId", type: "string" }, { name: "recipient", type: "bytes" }, { name: "currency", type: "bytes" }, { name: "minimumAmount", type: "uint256" },
    { name: "deadline", type: "uint32" }, { name: "extraData", type: "bytes" }],
  Output: [{ name: "chainId", type: "string" }, { name: "payments", type: "OutputPayment[]" }, { name: "deadline", type: "uint32" }, { name: "calls", type: "bytes[]" }, { name: "extraData", type: "bytes" }],
  OutputPayment: [{ name: "recipient", type: "bytes" }, { name: "currency", type: "bytes" }, { name: "minimumAmount", type: "uint256" }, { name: "expectedAmount", type: "uint256" }],
  Fee: [{ name: "recipientChainId", type: "string" }, { name: "recipient", type: "bytes" }, { name: "currencyChainId", type: "string" }, { name: "currency", type: "bytes" }, { name: "amount", type: "uint256" }],
};
const evmChain = (id) => { if (!RELAY_TO_ID[id]) throw new Error(`the order names chain "${id}", which is not one of Holbric's bridge chains`); return id; };
const addrBytes = (a, chain) => { evmChain(chain); if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`bad address ${a} in the order`); return a.toLowerCase(); };
const hexBytes = (h) => { if (!/^0x([0-9a-fA-F]{2})*$/.test(h)) throw new Error("bad bytes in the order"); return h.toLowerCase(); };
export function orderId(o) {
  const data = {
    version: o.version, solverChainId: evmChain(o.solverChainId), solver: o.solver, salt: BigInt(o.salt),
    inputs: o.inputs.map((i) => ({
      payment: { chainId: i.payment.chainId, currency: addrBytes(i.payment.currency, i.payment.chainId), amount: BigInt(i.payment.amount), weight: BigInt(i.payment.weight) },
      refunds: i.refunds.map((r) => ({ chainId: r.chainId, recipient: addrBytes(r.recipient, r.chainId), currency: addrBytes(r.currency, r.chainId),
        minimumAmount: BigInt(r.minimumAmount), deadline: Number(r.deadline), extraData: hexBytes(r.extraData) })) })),
    output: { chainId: o.output.chainId, payments: o.output.payments.map((p) => ({ recipient: addrBytes(p.recipient, o.output.chainId), currency: addrBytes(p.currency, o.output.chainId),
      minimumAmount: BigInt(p.minimumAmount), expectedAmount: BigInt(p.expectedAmount) })), deadline: Number(o.output.deadline), calls: o.output.calls.map(hexBytes), extraData: hexBytes(o.output.extraData) },
    fees: o.fees.map((f) => ({ recipientChainId: f.recipientChainId, recipient: addrBytes(f.recipient, f.recipientChainId), currencyChainId: f.currencyChainId,
      currency: addrBytes(f.currency, f.currencyChainId), amount: BigInt(f.amount) })),
  };
  return hashStruct({ types: ORDER_TYPES, primaryType: "Order", data });
}

const DEPOSIT_ABI = parseAbi([
  "function depositNative(address depositor, bytes32 id) payable",
  "function depositErc20(address depositor, address token, uint256 amount, bytes32 id)",
  "event RelayNativeDeposit(address from, uint256 amount, bytes32 id)",
  "event RelayErc20Deposit(address from, address token, uint256 amount, bytes32 id)",
]);
const lc = (a) => String(a).toLowerCase();

/**
 * Check an order (quote.protocol.v2) against what was asked. Returns a list of problems; empty means it passed.
 * want: { from: {chain, token}, to: {chain, token}, amountIn, recipient, refundTo|null, slippageBps, minDeadline }
 */
export function checkOrder(q, want) {
  const p = [];
  const v2 = q?.protocol?.v2;
  if (!v2?.orderData || !v2.orderId) return ["Relay returned no protocol order data, so the order cannot be verified"];
  const o = v2.orderData;
  let id;
  try { id = orderId(o); } catch (e) { return [`the order could not be hashed: ${e.message}`]; }
  if (lc(id) !== lc(v2.orderId)) p.push(`the order id Relay returned (${v2.orderId}) is not the hash of its order data (${id})`);
  if (o.version !== "v1") p.push(`order version ${o.version}`);
  if (o.inputs.length !== 1) p.push(`${o.inputs.length} inputs`);
  const pay = o.inputs[0]?.payment;
  if (pay && (pay.chainId !== want.from.chain.relay || lc(pay.currency) !== lc(want.from.token.address) || BigInt(pay.amount) !== want.amountIn))
    p.push(`the order's payment is ${pay.amount} of ${pay.currency} on ${pay.chainId}, not what was asked`);
  for (const r of o.inputs[0]?.refunds || []) {
    if (!RELAY_TO_ID[r.chainId]) p.push(`a refund goes to chain ${r.chainId}`);
    // Origin-chain refunds must pay the wallet. On the destination chain Relay may refund to the recipient instead
    // (it does when a recipient other than the sender is named), which is the address the user chose to pay there.
    const okTo = r.chainId === want.to.chain.relay ? [want.refundTo, want.recipient] : [want.refundTo];
    if (want.refundTo && !okTo.some((a) => lc(r.recipient) === lc(a))) p.push(`a refund on ${r.chainId} goes to ${r.recipient}, not ${okTo.length > 1 ? "the wallet or the recipient" : "the wallet"}`);
  }
  if (o.output.chainId !== want.to.chain.relay) p.push(`the output is on ${o.output.chainId}`);
  if (o.output.payments.length !== 1) p.push(`${o.output.payments.length} output payments`);
  const out = o.output.payments[0];
  if (out) {
    if (lc(out.recipient) !== lc(want.recipient)) p.push(`the output goes to ${out.recipient}, not ${want.recipient}`);
    if (lc(out.currency) !== lc(want.to.token.address)) p.push(`the output currency is ${out.currency}`);
    const min = BigInt(out.minimumAmount), exp = BigInt(out.expectedAmount);
    if (min < (exp * BigInt(10000 - want.slippageBps)) / 10000n) p.push(`the guaranteed minimum ${out.minimumAmount} is more than ${want.slippageBps / 100}% below the expected ${out.expectedAmount}`);
    if (min === 0n) p.push("the guaranteed minimum is zero");
  }
  if (o.output.calls.length) p.push(`the order carries ${o.output.calls.length} destination call(s)`);
  if (o.fees.some((f) => BigInt(f.amount) > 0n)) p.push("the order carries fees to a third party");
  if (Number(o.output.deadline) < want.minDeadline) p.push(`the order deadline ${new Date(Number(o.output.deadline) * 1000).toISOString()} is too close`);
  if (want.from.chain.relay === "robinhood" && getAddress(v2.paymentDetails?.depository || ZERO) !== RELAY_DEPOSITORY) p.push(`the quote names depository ${v2.paymentDetails?.depository}`);
  return p;
}

async function relayQuote({ from, to, amountIn, user, recipient, refundTo, slippageBps }) {
  const body = { user, recipient, originChainId: from.chain.id, destinationChainId: to.chain.id, originCurrency: lc(from.token.address), destinationCurrency: lc(to.token.address),
    amount: amountIn.toString(), tradeType: "EXACT_INPUT", includeProtocolData: true, slippageTolerance: String(slippageBps) };
  if (refundTo) body.refundTo = refundTo;
  const requestedAt = new Date();
  const q = await api("/quote/v2", { method: "POST", body: JSON.stringify(body) });
  if (!q?.details || !q?.steps) throw new Error(`Relay returned no quote${q?.message ? `: ${q.message}` : ""}`);
  return { q, requestedAt };
}

const feeView = (f) => (f && f.amount != null ? { amount: `${f.amountFormatted} ${f.currency?.symbol}`, usd: f.amountUsd != null ? Number(f.amountUsd) : null } : null);

function side(chainIn, tokenIn, chainOut, tokenOut) {
  const a = resolveChain(chainIn), b = resolveChain(chainOut);
  if (a.id === b.id) throw new Error("fromChain and toChain are the same chain. Use a swap on Robinhood Chain instead.");
  if (a.id !== CHAIN_ID && b.id !== CHAIN_ID) throw new Error("One side must be Robinhood Chain (4663).");
  const tIn = resolveToken(a, tokenIn || "ETH");
  const tOut = resolveToken(b, tokenOut || defaultOut(b, tIn.symbol));
  if (tIn.native !== tOut.native) throw new Error(`Holbric bridges ETH to ETH and stablecoins to stablecoins only (asked ${tIn.symbol} to ${tOut.symbol}). Swap first on Robinhood Chain if you need another asset.`);
  return { from: { chain: a, token: tIn }, to: { chain: b, token: tOut } };
}
const amountRaw = (t, amount) => {
  if (typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount.trim())) throw new Error('amount must be a decimal string like "0.01".');
  const v = parseUnits(amount.trim(), t.decimals);
  if (v <= 0n) throw new Error("amount must be above zero.");
  return v;
};

/** bridge_quote: read-only. Asks Relay for the bridge as a neutral placeholder address unless a recipient is given. */
export async function bridgeQuote({ fromChain = 4663, toChain, token = "ETH", toToken, amount, recipient, slippageBps }) {
  requireOn();
  const s = side(fromChain, token, toChain, toToken);
  const amountIn = amountRaw(s.from.token, amount);
  const slip = slippage(slippageBps);
  if (recipient != null && !isAddress(recipient)) throw new Error("recipient must be a 0x address.");
  const to = recipient ? getAddress(recipient) : PLACEHOLDER;
  await checkChains(s.from.chain.id, s.to.chain.id);
  const block = await publicClient().getBlock();
  const { q, requestedAt } = await relayQuote({ ...s, amountIn, user: PLACEHOLDER, recipient: to, refundTo: PLACEHOLDER, slippageBps: slip });
  const problems = checkOrder(q, { ...s, amountIn, recipient: to, refundTo: PLACEHOLDER, slippageBps: slip, minDeadline: Math.floor(Date.now() / 1000) + 60 });
  const d = q.details, outT = d.currencyOut;
  const inbound = s.to.chain.id === CHAIN_ID;
  return {
    source: "Relay (relay.link), a third-party bridge. Figures below are Relay's quote, not a Holbric measurement.",
    from: `${fmt(amountIn, s.from.token.decimals, 18)} ${s.from.token.symbol} on ${s.from.chain.name} (${s.from.chain.id})`,
    to: `${s.to.token.symbol} on ${s.to.chain.name} (${s.to.chain.id})`,
    expectedOut: `${outT.amountFormatted} ${s.to.token.symbol}`, expectedOutRaw: outT.amount,
    minimumOut: `${formatUnits(BigInt(outT.minimumAmount), s.to.token.decimals)} ${s.to.token.symbol}`, minimumOutRaw: outT.minimumAmount,
    slippageBps: slip,
    fees: { relayer: feeView(q.fees?.relayer), relayerService: feeView(q.fees?.relayerService), relayerGas: feeView(q.fees?.relayerGas), originGas: feeView(q.fees?.gas),
      app: feeView(q.fees?.app), holbric: "none" },
    totalCostPct: d.totalImpact?.percent != null ? -Number(d.totalImpact.percent) : null,
    totalCostNote: "Relay's figure: value lost between input and expected output, fees and price included, in percent of the input.",
    timeEstimateSeconds: d.timeEstimate ?? null,
    orderCheck: problems.length ? { passed: false, problems } : { passed: true, orderId: q.protocol.v2.orderId, note: "order id recomputed locally from the order data; payment, output, recipient, minimum, deadline and fees checked" },
    requestId: q.requestId,
    robinhoodBlock: block.number.toString(), robinhoodBlockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
    quotedAt: requestedAt.toISOString(), quotedAtLocal: localTime(requestedAt),
    canPrepare: inbound
      ? `No. Bridging into Robinhood Chain starts with a deposit on ${s.from.chain.name}; Holbric only reads and simulates Robinhood Chain, so it does not build or sign that transaction. Use Relay's own app or your wallet on ${s.from.chain.name}.`
      : "Yes: prepare_bridge builds the Robinhood Chain deposit, checks it and simulates it before you sign.",
    privacy: `Sent to Relay (api.relay.link): the two chains, the tokens and the amount${recipient ? ", and the recipient you named" : ""}. Not your wallet address (the quote is asked for ${PLACEHOLDER}). Turn Relay off with HOLBRIC_NO_BRIDGES=1 or \`holbric bridges off\`.`,
  };
}

/**
 * prepare_bridge: bridge out of Robinhood Chain only. Builds an exact approval (USDG) and the deposit into the
 * RelayDepository, after every order check passes and Holbric's own encoding matches Relay's calldata.
 */
export async function prepareBridge({ toChain, token = "ETH", toToken, amount, recipient, slippageBps }) {
  requireOn();
  const from = requireWallet();
  const s = side(CHAIN_ID, token, toChain, toToken);
  const amountIn = amountRaw(s.from.token, amount);
  const slip = slippage(slippageBps);
  if (recipient != null && !isAddress(recipient)) throw new Error("recipient must be a 0x address.");
  const to = recipient ? getAddress(recipient) : from;
  const c = publicClient();
  if (!s.from.token.native) {
    const bal = await c.readContract({ address: s.from.token.address, abi: erc20Abi, functionName: "balanceOf", args: [from] });
    if (bal < amountIn) throw new Error(`Wallet ${from} has ${fmt(bal, 6, 6)} USDG, less than ${fmt(amountIn, 6, 6)}. Nothing was prepared.`);
  }
  const { usdValue } = await import("./swap.js");
  const usd = await usdValue({ ...s.from.token, address: s.from.token.native ? undefined : s.from.token.address }, amountIn).catch(() => null);
  checkLimit(usd);
  await checkChains(CHAIN_ID, s.to.chain.id);
  const { q, requestedAt } = await relayQuote({ ...s, amountIn, user: from, recipient: to, refundTo: from, slippageBps: slip });
  const problems = checkOrder(q, { ...s, amountIn, recipient: to, refundTo: from, slippageBps: slip, minDeadline: Math.floor(Date.now() / 1000) + 3600 });
  const id = q.protocol?.v2?.orderId;
  // Every transaction Relay asks for must be on chain 4663 and go to the depository, or be an approval of the input token.
  const relayTxs = q.steps.flatMap((st) => (st.items || []).map((it) => ({ step: st.id, kind: st.kind, ...(it.data || {}) })));
  for (const st of q.steps) if (st.kind !== "transaction") problems.push(`Relay asks for a "${st.kind}" step (${st.id}); Holbric only prepares transactions`);
  for (const t of relayTxs) {
    if (Number(t.chainId) !== CHAIN_ID) problems.push(`Relay step ${t.step} is on chain ${t.chainId}`);
    if (!t.to) { problems.push(`Relay step ${t.step} has no target`); continue; }
    const target = getAddress(t.to);
    if (target === RELAY_DEPOSITORY) continue;
    if (!s.from.token.native && target === s.from.token.address) {
      try {
        const a = decodeFunctionData({ abi: erc20Abi, data: t.data });
        if (a.functionName !== "approve" || getAddress(a.args[0]) !== RELAY_DEPOSITORY || a.args[1] !== amountIn) problems.push(`Relay's approval step is ${a.functionName}(${a.args.join(", ")}), not an exact approval for the depository`);
      } catch { problems.push("Relay's token step is not an ERC-20 call"); }
      continue;
    }
    problems.push(`Relay step ${t.step} targets ${target}, which is not the verified RelayDepository ${RELAY_DEPOSITORY}`);
  }
  const deposits = relayTxs.filter((t) => t.to && getAddress(t.to) === RELAY_DEPOSITORY);
  if (deposits.length !== 1) problems.push(`Relay returned ${deposits.length} deposit transactions, expected 1`);
  // Holbric's own encoding of the deposit, which must equal Relay's byte for byte.
  const mine = id ? (s.from.token.native
    ? { to: RELAY_DEPOSITORY, value: amountIn, data: encodeFunctionData({ abi: DEPOSIT_ABI, functionName: "depositNative", args: [from, id] }) }
    : { to: RELAY_DEPOSITORY, value: 0n, data: encodeFunctionData({ abi: DEPOSIT_ABI, functionName: "depositErc20", args: [from, s.from.token.address, amountIn, id] }) }) : null;
  if (deposits.length === 1 && mine) {
    const r = deposits[0];
    if (lc(r.data) !== lc(mine.data)) problems.push("Relay's deposit calldata differs from the deposit Holbric encodes for this order (depositor, token, amount or order id)");
    if (BigInt(r.value || "0") !== mine.value) problems.push(`Relay's deposit sends ${r.value} wei of ETH, expected ${mine.value}`);
  }
  if (problems.length) throw new Error(`Relay's quote failed Holbric's checks, so nothing was prepared:\n- ${problems.join("\n- ")}`);

  const d = q.details, o = q.protocol.v2.orderData, outP = o.output.payments[0];
  const deadline = Number(o.output.deadline);
  const txs = [], lines = [];
  if (!s.from.token.native) {
    const allowance = await c.readContract({ address: s.from.token.address, abi: erc20Abi, functionName: "allowance", args: [from, RELAY_DEPOSITORY] });
    if (allowance < amountIn) {
      txs.push(approveTx(s.from.token.address, RELAY_DEPOSITORY, amountIn, "USDG", 6));
      lines.push(`Approve exactly ${fmt(amountIn, 6, 6)} USDG for the RelayDepository ${RELAY_DEPOSITORY} (current allowance ${fmt(allowance, 6, 6)}). Not unlimited.`);
    }
  }
  txs.push({ label: `deposit ${fmt(amountIn, s.from.token.decimals, 18)} ${s.from.token.symbol} into the RelayDepository for order ${id}`, ...mine });
  const outMin = `${formatUnits(BigInt(outP.minimumAmount), s.to.token.decimals)} ${s.to.token.symbol}`;
  const outExp = `${formatUnits(BigInt(outP.expectedAmount), s.to.token.decimals)} ${s.to.token.symbol}`;
  lines.push(`Deposit ${fmt(amountIn, s.from.token.decimals, 18)} ${s.from.token.symbol} into the RelayDepository ${RELAY_DEPOSITORY} (Sourcify exact match) with ${s.from.token.native ? "depositNative" : "depositErc20"}, tagged with Relay order ${id}. The order id was recomputed by Holbric from the order data.`);
  lines.push(`Relay's order pays ${to}${to === from ? " (this wallet's address)" : " (NOT this wallet: a recipient you named)"} on ${s.to.chain.name} (${s.to.chain.id}): expected ${outExp}, guaranteed at least ${outMin} (slippage limit ${(slip / 100).toFixed(2)}%). Relay estimates ${d.timeEstimate ?? "?"} s.`);
  lines.push(`If Relay's solver does not fill the order (deadline ${new Date(deadline * 1000).toISOString()}), ${to === from ? `every refund path in the order pays this wallet ${from}, on Robinhood Chain or ${s.to.chain.name}` : `a refund on Robinhood Chain pays this wallet ${from}; a refund on ${s.to.chain.name} may pay the recipient ${to}`}, less the refund gas. The delivery on ${s.to.chain.name} is done by Relay's solver, not by this transaction, so the simulation can only show the deposit.`);
  lines.push(`Relay's fees are inside the quote (relayer ${q.fees?.relayer?.amountFormatted ?? "?"} ${q.fees?.relayer?.currency?.symbol ?? ""}, total cost ${d.totalImpact?.percent != null ? -Number(d.totalImpact.percent) : "?"}% of the input by Relay's figure). No app fee, no referrer, no Holbric fee.`);
  const expectedOut = [[s.from.token.native ? "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" : s.from.token.address, amountIn]];
  const r = await store({ kind: "relay_bridge", from, txs, lines, usd, slippageBps: slip,
    beforeSign: () => (Date.now() / 1000 > deadline - 120 ? `Relay's order deadline ${new Date(deadline * 1000).toISOString()} is too close` : null),
    valueLine: usd != null ? `Approximate value: $${usd.toFixed(2)} (valued with Holbric's own quote on Robinhood Chain).` : "Approximate USD value: not available.",
    onReceipt: async (rc) => ({ relay: { requestId: q.requestId, orderId: id, depositTx: txLink(rc.transactionHash), next: "Call bridge_status with this requestId or the deposit hash to follow the fill." } }),
    extra: { relay: { requestId: q.requestId, orderId: id, toChain: `${s.to.chain.name} (${s.to.chain.id})`, recipient: to, expectedOut: outExp, minimumOut: outMin,
      timeEstimateSeconds: d.timeEstimate ?? null, orderDeadline: new Date(deadline * 1000).toISOString(), quotedAt: requestedAt.toISOString(),
      privacy: "Sent to Relay (api.relay.link): this wallet's address (sender and refund address), the recipient, the chains, the token and the amount." } } });
  // The simulation must show exactly the deposit leaving the wallet, to the depository, and nothing else.
  const outs = r.simulation.transfersOut;
  if (outs) {
    const ok = outs.length === 1 && getAddress(outs[0].counterparty) === RELAY_DEPOSITORY && BigInt(outs[0].raw) === amountIn
      && lc(outs[0].token === "ETH" ? expectedOut[0][0] : outs[0].token) === lc(expectedOut[0][0]);
    if (!ok) { discard(r.prepareId); throw new Error(`Pre-sign simulation: the wallet's outgoing transfers were ${JSON.stringify(outs.map((x) => `${x.amount} ${x.symbol} to ${x.counterparty}`))}, not exactly the deposit to the RelayDepository. Nothing was prepared.`); }
  }
  return r;
}

const chainLabel = (id) => (CHAINS[id] ? `${CHAINS[id].name} (${id})` : `chain ${id} (not one of Holbric's bridge chains)`);
const txUrl = (id, h) => (CHAINS[id] && /^0x[0-9a-fA-F]{64}$/.test(h) ? `${CHAINS[id].explorer}/tx/${h}` : null);

/** bridge_status: Relay's status for a request id or a transaction hash, plus an on-chain read of a deposit on Robinhood Chain. */
export async function bridgeStatus({ requestId, txHash }) {
  requireOn();
  const isHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
  if (!requestId && !txHash) throw new Error("Give a Relay requestId or a transaction hash.");
  if (requestId && !isHash(requestId)) throw new Error("requestId must be a 0x-prefixed 32-byte hex string.");
  if (txHash && !isHash(txHash)) throw new Error("txHash must be a 0x-prefixed 32-byte hex string.");
  const list = await api(`/requests/v2?${requestId ? `id=${requestId}` : `hash=${txHash}`}`);
  const req = list?.requests?.[0];
  if (!req) {
    if (requestId) {
      const st = await api(`/intents/status/v3?requestId=${requestId}`);
      return { source: "Relay API (third party)", requestId, status: st.status, note: st.status === "waiting" ? "Relay has no deposit for this request yet (or does not know the id)." : undefined };
    }
    return { source: "Relay API (third party)", txHash, status: "unknown", note: "Relay has no request with this transaction hash." };
  }
  const st = await api(`/intents/status/v3?requestId=${req.id}`).catch(() => null);
  const m = req.data?.metadata || {};
  const cur = (x) => (x?.currency ? { amount: `${x.amountFormatted} ${x.currency.symbol}`, chain: chainLabel(x.currency.chainId) } : null);
  const tx = (t) => ({ chain: chainLabel(t.chainId), hash: t.hash, block: t.block ?? null, time: t.timestamp ? new Date(t.timestamp * 1000).toISOString() : null, explorer: txUrl(t.chainId, t.hash) });
  const out = {
    source: "Relay API (third party), with the Robinhood Chain deposit read on chain where there is one.",
    requestId: req.id, status: st?.status || req.status,
    from: cur(m.currencyIn), to: cur(m.currencyOut),
    inTxs: (req.data?.inTxs || []).map(tx), outTxs: (req.data?.outTxs || []).map(tx),
    createdAt: req.createdAt, updatedAt: req.updatedAt,
    ...(req.data?.failReason && req.data.failReason !== "N/A" ? { failReason: req.data.failReason } : {}),
    ...(req.data?.refundFailReason && req.data.refundFailReason !== "N/A" ? { refundFailReason: req.data.refundFailReason } : {}),
  };
  // Independent check: decode the RelayDepository deposit event from the Robinhood Chain receipt.
  const rhIn = (req.data?.inTxs || []).find((t) => t.chainId === CHAIN_ID && isHash(t.hash));
  if (rhIn) {
    const rc = await publicClient().getTransactionReceipt({ hash: rhIn.hash }).catch(() => null);
    const ev = rc?.logs.filter((l) => getAddress(l.address) === RELAY_DEPOSITORY).map((l) => { try { return decodeEventLog({ abi: DEPOSIT_ABI, data: l.data, topics: l.topics }); } catch { return null; } }).find(Boolean);
    out.onChainDeposit = !rc ? { found: false, note: "receipt not found on Robinhood Chain" } : ev ? {
      found: true, status: rc.status, block: rc.blockNumber.toString(), sender: rc.from, depositor: ev.args.from,
      depositorNote: "the address the RelayDepository records for this deposit; it can differ from the sender",
      amountRaw: ev.args.amount.toString(),
      amount: ev.eventName === "RelayNativeDeposit" ? `${fmt(ev.args.amount, 18, 18)} ETH` : `${ev.args.amount.toString()} raw of ${ev.args.token}${getAddress(ev.args.token) === ADDR.USDG ? ` (${fmt(ev.args.amount, 6, 6)} USDG)` : ""}`,
      orderId: ev.args.id, explorer: txLink(rhIn.hash) } : { found: false, status: rc.status, note: "no RelayDepository deposit event in this transaction" };
  }
  return out;
}
