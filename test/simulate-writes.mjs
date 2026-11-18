// Runs every prepare_* in-process against Robinhood Chain mainnet with a throwaway wallet and pretend balances
// (client balance reads are patched in this process, and eth_simulateV1 gets matching state overrides).
// Each prepared action is simulated on mainnet, then re-checked the way execute_prepared does before signing.
// Nothing is signed or sent: no transaction ever leaves this process.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { parseEther, encodeFunctionData, parseAbi } from "viem";
process.env.HOLBRIC_HOME = mkdtempSync(join(tmpdir(), "holbric-sim-"));
const { writeKeystore } = await import("../src/keystore.js");
const me = writeKeystore(generatePrivateKey(), "sim-only-passphrase");
const { publicClient, ADDR } = await import("../src/chain.js");
const { tokenOverride } = await import("../src/storage.js");
const { prepareSwap } = await import("../src/swap.js");
const { prepareSend } = await import("../src/send.js");
const { preparePonsTrade } = await import("../src/pons.js");
const { prepareRegisterAgent } = await import("../src/identity.js");
const { prepareWrap, prepareUnwrap } = await import("../src/weth.js");
const { prepareAddLiquidity, prepareRemoveLiquidity, prepareCollectLpFees, quoteCollectLpFees, quoteRemoveLiquidity } = await import("../src/lp.js");
const { ponsCreatorFees, preparePonsSweep, preparePonsClaim } = await import("../src/ponsfees.js");
const { _peek, recheck, execute } = await import("../src/actions.js");
const R = await import("../src/relay.js");
const { _setSimOverrides, simulateTxs, simulateMethod } = await import("../src/simulate.js");

const HOLBRIC = "0xE8D6AE09757769968d17eab44998A03E196217e7";
const HOLBRIC_CURVE = "0x4eF8D0d0210BbF85C3e4C93921C9F87d075618B6";
const CREATOR = "0x06287131cabd16ae540959bfd70c415bb04239ff";
const AMZN = "0x12f190a9F9d7D37a250758b26824B97CE941bF54"; // official Robinhood Stock Token, no WETH pool on Uniswap v3
const BMNR = "0x9a7842EDed60b0FE1e03eEc342C82A397c821eD0"; // official Robinhood Stock Token, no USDG pool on Uniswap v3
const ORBIT = "0xF1A947c6C7b8887ef6C09b8B088787b4d1fF8d0a"; // Pons V2 launch, graduated (phase 2) to a Uniswap v4 pool with the Pons hook
const DUMMY_SPENDER = "0x000000000000000000000000000000000000bEEF";

const c = publicClient();
const BIG = 10n ** 30n;
const realGetBalance = c.getBalance.bind(c), realRead = c.readContract.bind(c);
c.getBalance = async (a) => (a.address === me ? parseEther("5") : realGetBalance(a));
c.readContract = async (a) => (a.functionName === "balanceOf" && a.args?.[0] === me && !a.stateOverride && a.address !== ADDR.ERC8004_IDENTITY && a.address !== ADDR.PONS_ESCROW ? BIG : realRead(a));
// Pretend balances for the throwaway wallet only, inside the simulation. Allowances stay real (zero), so approvals are exercised.
const pretend = [[ADDR.USDG, 10n ** 12n], [ADDR.WETH, parseEther("1")], [HOLBRIC, 2n * 10n ** 24n], [AMZN, parseEther("1")], [ORBIT, 10n ** 24n]];
const pretendOverrides = (await Promise.all(pretend.map(([t, amt]) => tokenOverride(t, me, DUMMY_SPENDER, amt)))).filter(Boolean);
_setSimOverrides(async (from) => (from === me ? [{ address: me, balance: parseEther("5") }, ...pretendOverrides] : undefined));

let pass = 0, fail = 0;
const ok = (label, cond, info = "") => { if (cond) pass++; else fail++; console.log(`${cond ? "PASS" : "FAIL"} ${label}${info ? ` — ${info}` : ""}`); };

async function run(label, prep, { expectError } = {}) {
  try {
    const r = await prep();
    if (expectError) return ok(label, false, "expected a refusal but it prepared");
    console.log(`\n=== ${label}\n${r.summary}`);
    console.log("steps:", r.simulation.steps.map((s) => `${s.step}: ${s.status} (${s.gasUsed} gas)`).join(" | "));
    ok(label + " simulated", r.simulation.ok && r.simulation.method === "eth_simulateV1", r.simulation.walletDeltas.map((d) => `${d.change} ${d.symbol}`).join(", "));
    const p = _peek(r.prepareId);
    const again = await recheck(p);
    ok(label + " re-check before signing", again.ok, again.reason || `block ${again.simulation.block}`);
    return r;
  } catch (e) {
    const msg = e.shortMessage || e.message;
    if (expectError) return ok(label, expectError.test(msg), msg.split("\n")[0]);
    console.log(`\n=== ${label}\n${msg}`); ok(label, false, msg.split("\n")[0]);
  }
}

console.log(`Throwaway wallet ${me}. Run at ${new Date().toLocaleString("en-GB", { hour12: false, timeZoneName: "short" })}`);
const swap = await run("swap 5 USDG -> WETH", () => prepareSwap({ tokenIn: "USDG", tokenOut: "WETH", amount: "5" }));
await run("swap 0.001 ETH -> USDG", () => prepareSwap({ tokenIn: "ETH", tokenOut: "USDG", amount: "0.001" }));
await run("swap 2 USDG -> ETH (unwrap)", () => prepareSwap({ tokenIn: "USDG", tokenOut: "ETH", amount: "2" }));
// Multi-hop (SwapRouter02 exactInput) on routes that have no direct pool.
const multiCheck = (label, r, via) => r && ok(`${label} uses a 2-hop exactInput route through ${via}`,
  r.simulation.steps.some((s) => /exactInput, 2 hops/.test(s.step)) && r.quote.hops === 2 && r.quote.routeTokens[1] === via && /Compared \d+ routes? at block/.test(r.summary), r.quote.route);
// These three pin venue "v3": they test SwapRouter02 exactInput. Since 0.5.0 the default compares v3 and v4, and v4 can win.
const mh1 = await run("swap 0.01 ETH -> AMZN (multi-hop)", () => prepareSwap({ tokenIn: "ETH", tokenOut: AMZN, amount: "0.01", venue: "v3" }));
multiCheck("ETH -> AMZN", mh1, "USDG");
const mh2 = await run("swap 5 USDG -> BMNR (multi-hop, exact approval)", () => prepareSwap({ tokenIn: "USDG", tokenOut: BMNR, amount: "5", venue: "v3" }));
multiCheck("USDG -> BMNR", mh2, "WETH");
if (mh2) ok("USDG -> BMNR approves exactly 5 USDG", /Approve exactly 5 USDG/.test(mh2.summary) && !/unlimited/i.test(mh2.summary.replace("Not unlimited", "")));
const mh3 = await run("swap 0.05 AMZN -> ETH (multi-hop, unwrap)", () => prepareSwap({ tokenIn: AMZN, tokenOut: "ETH", amount: "0.05", venue: "v3" }));
multiCheck("AMZN -> ETH", mh3, "USDG");
if (mh3) ok("AMZN -> ETH delivers native ETH to the wallet", mh3.simulation.walletDeltas.some((d) => d.symbol === "ETH" && !d.change.startsWith("-")),
  mh3.simulation.walletDeltas.map((d) => `${d.change} ${d.symbol}`).join(", "));
await run("send 0.001 ETH", () => prepareSend({ to: "0x000000000000000000000000000000000000dEaD", token: "ETH", amount: "0.001" }));
await run("send 1 USDG", () => prepareSend({ to: "0x000000000000000000000000000000000000dEaD", token: "USDG", amount: "1" }));
// Uniswap v4 (0.5.0): Universal Router 2.1.2, native ETH in and out, ERC-20 input through exact Permit2 allowances.
const v4Step = (r) => r && r.simulation.steps.find((s) => /on Uniswap v4 \(Universal Router/.test(s.step));
const delta = (r, sym) => r?.simulation.walletDeltas.find((d) => d.symbol === sym);
const v4a = await run("v4 swap 0.01 ETH -> USDG (venue v4, native ETH in)", () => prepareSwap({ tokenIn: "ETH", tokenOut: "USDG", amount: "0.01", venue: "v4" }));
if (v4a) ok("ETH -> USDG on v4 goes through the Universal Router with ETH as msg.value", !!v4Step(v4a) && v4a.quote.bestVenue === "Uniswap v4" && !/Approve|Permit2/.test(v4a.summary), v4a.quote.route);
if (v4a) ok("ETH -> USDG on v4 receives at least the quoted minimum", BigInt(delta(v4a, "USDG")?.raw || 0) >= BigInt(v4a.quote.tokenOut.amountOutRaw) * 9950n / 10000n, `${delta(v4a, "USDG")?.change} USDG, quote ${v4a.quote.tokenOut.amountOut}`);
const v4b = await run("v4 swap 20 USDG -> ORBIT (2 hops on v4 via ETH into the Pons pool)", () => prepareSwap({ tokenIn: "USDG", tokenOut: ORBIT, amount: "20", venue: "native" }));
if (v4b) ok("USDG -> ORBIT routes USDG -> ETH -> ORBIT on v4", !!v4Step(v4b) && v4b.quote.hops === 2 && v4b.quote.routeTokens[1] === "ETH" && /v4 Pons/.test(v4b.quote.route), v4b.quote.route);
if (v4b) ok("USDG -> ORBIT approves exactly 20 USDG to Permit2 and an exact 30-minute Permit2 allowance", /Approve exactly 20 USDG for Permit2/.test(v4b.summary) && /Permit2: let Uniswap Universal Router 0x[0-9a-fA-F]{40} pull exactly 20 USDG, expiring 30 minutes from now/.test(v4b.summary), v4b.simulation.steps.map((s) => s.step).join(" | "));
const v4c = await run("pons buy 0.002 ETH of graduated ORBIT (v4 Pons pool)", () => preparePonsTrade({ token: ORBIT, side: "buy", amount: "0.002" }));
if (v4c) ok("graduated Pons buy goes through the v4 Pons pool", !!v4Step(v4c) && /graduated, so the trade goes through its Uniswap v4 pool 0x67d3f533/.test(v4c.summary) && BigInt(delta(v4c, "ORBIT")?.raw || 0) > 0n, `${delta(v4c, "ORBIT")?.change} ORBIT`);
const v4d = await run("pons sell 100000 ORBIT (graduated, ERC-20 in via Permit2, native ETH out)", () => preparePonsTrade({ token: ORBIT, side: "sell", amount: "100000" }));
if (v4d) ok("graduated Pons sell pays native ETH to the wallet", !!v4Step(v4d) && /^\+/.test(delta(v4d, "ETH")?.change || "") && /Approve exactly 100000 ORBIT for Permit2/.test(v4d.summary), `${delta(v4d, "ETH")?.change} ETH`);
// v4b and v4e pin venue "native" (Holbric's own v3 + v4 routing). Since 0.6.0 the default also asks KyberSwap, which can win.
const v4e = await run("swap 0.05 AMZN -> ETH (best of v3 and v4)", () => prepareSwap({ tokenIn: AMZN, tokenOut: "ETH", amount: "0.05", venue: "native" }));
if (v4e) ok("AMZN -> ETH best route was picked from both versions", v4e.quote.compared.v3Routes > 0 && v4e.quote.compared.v4Routes > 0 && /Compared \d+ routes at block \d+ \(\d+ on Uniswap v3, \d+ on Uniswap v4\)/.test(v4e.summary), `${v4e.quote.bestVenue}: ${v4e.quote.route}`);
if (v4b) {
  const p = _peek(v4b.prepareId);
  for (const [k, v] of p.sim._raw.inflows) p.sim._raw.inflows.set(k, v * 2n);
  try { await execute({ prepareId: v4b.prepareId, confirm: true }); ok("execute refuses a worse v4 result", false, "it did not refuse"); }
  catch (e) { ok("execute refuses a worse v4 result before signing", /^Refused before signing/.test(e.message), e.message); }
}
await run("v4 swap through a pool with an unknown hook refuses", async () => {
  const { quote } = await import("../src/swap.js");
  const { encodeV4Swap } = await import("../src/v4.js");
  const q = await quote({ tokenIn: "ETH", tokenOut: "USDG", amount: "0.01", venue: "v4" });
  encodeV4Swap({ ...q.best, keys: q.best.keys.map((k) => ({ ...k, hooks: "0x000000000000000000000000000000000000bEEF" })) }, q.amountIn, 0n, 0n);
}, { expectError: /Refusing to route through a pool with unknown hook/ });
// KyberSwap (0.6.0). The route and calldata come from KyberSwap's API for this throwaway wallet; Holbric checks the
// calldata, simulates the exact transaction from the wallet on mainnet, and re-checks it the way execute_prepared does.
const { KYBER_ROUTER } = await import("../src/kyber.js");
const { minReceiveReason } = await import("../src/actions.js");
const pause = () => new Promise((r) => setTimeout(r, 1500)); // the public KyberSwap endpoint is rate limited
const kyStep = (r) => r && r.simulation.steps.find((s) => /on KyberSwap \(MetaAggregationRouterV2\.(swap|swapSimpleMode)\)/.test(s.step));
const outCheck = (r) => r && /Output check in the simulation: the wallet receives [\d.]+ \S+, at or above the minimum [\d.]+ /.test(r.summary);
const k1 = await run("KyberSwap swap 0.01 ETH -> USDG (venue kyber, native ETH in)", () => prepareSwap({ tokenIn: "ETH", tokenOut: "USDG", amount: "0.01", venue: "kyber" }));
if (k1) ok("ETH -> USDG on KyberSwap: router call to MetaAggregationRouterV2, ETH as value, no approval", !!kyStep(k1) && k1.quote.bestVenue === "KyberSwap" && k1.quote.router === KYBER_ROUTER && !/Approve/.test(k1.summary), k1.quote.route);
if (k1) ok("ETH -> USDG on KyberSwap: simulated output is at or above the minimum", outCheck(k1) && BigInt(delta(k1, "USDG")?.raw || 0) > 0n, `${delta(k1, "USDG")?.change} USDG, min ${k1.quote.tokenOut.minOut}`);
await pause();
const k2 = await run("KyberSwap swap 20 USDG -> ETH (venue kyber, exact approval to the KyberSwap router)", () => prepareSwap({ tokenIn: "USDG", tokenOut: "ETH", amount: "20", venue: "kyber" }));
if (k2) ok("USDG -> ETH on KyberSwap approves exactly 20 USDG to the KyberSwap router and pays native ETH",
  new RegExp(`Approve exactly 20 USDG for the KyberSwap router, MetaAggregationRouterV2 ${KYBER_ROUTER} \\(current allowance`).test(k2.summary) && !!kyStep(k2) && /^\+/.test(delta(k2, "ETH")?.change || "") && outCheck(k2),
  `${delta(k2, "ETH")?.change} ETH`);
if (k2) ok("USDG -> ETH approval is exact, not unlimited", k2.simulation.approvals.some((a) => a.spender === KYBER_ROUTER && a.raw === "20000000"), JSON.stringify(k2.simulation.approvals));
await pause();
const k3 = await run("KyberSwap swap 0.05 AMZN -> ETH (venue kyber, stock token in)", () => prepareSwap({ tokenIn: AMZN, tokenOut: "ETH", amount: "0.05", venue: "kyber" }));
if (k3) ok("AMZN -> ETH on KyberSwap takes exactly 0.05 AMZN and pays ETH", BigInt(delta(k3, "AMZN")?.raw || 0) === -(5n * 10n ** 16n) && /^\+/.test(delta(k3, "ETH")?.change || ""), `${delta(k3, "AMZN")?.change} AMZN, ${delta(k3, "ETH")?.change} ETH`);
await pause();
const kb = await run("swap 0.01 ETH -> AMZN (venue best: native vs KyberSwap)", () => prepareSwap({ tokenIn: "ETH", tokenOut: AMZN, amount: "0.01" }));
if (kb) ok(`best ETH -> AMZN states which source was used and why (${kb.quote.bestVenue})`, kb.quote.bestVenue === "KyberSwap"
  ? /through KyberSwap/.test(kb.summary) && /Compared at block \d+: KyberSwap/.test(kb.summary)
  : /KyberSwap was compared and not used: /.test(kb.summary), (kb.summary.match(/KyberSwap was compared and not used: [^\n]*/) || [kb.quote.route])[0]);
// execute_prepared must refuse when the re-simulated output falls under the minimum output.
if (k2) {
  const p = _peek(k2.prepareId);
  p.minReceive = { ...p.minReceive, amount: (p.sim._raw.inflows.get(p.minReceive.token) ?? 0n) * 2n }; // demand twice what the preview showed
  const again = await recheck(p);
  ok("re-check refuses a KyberSwap swap whose output falls below the minimum", !again.ok && /below the minimum output/.test(again.reason || ""), again.reason);
  try { await execute({ prepareId: k2.prepareId, confirm: true }); ok("execute refuses below the minimum output", false, "it did not refuse"); }
  catch (e) { ok("execute refuses below the minimum output before signing", /^Refused before signing: .*below the minimum output/.test(e.message), e.message); }
}
ok("native swaps also carry the simulated minimum-output check", outCheck(v4a) && outCheck(mh1), "v4 ETH -> USDG and v3 ETH -> AMZN");
ok("minReceive check: a traced simulation under the minimum gives a reason", !!minReceiveReason({ _raw: { inflows: new Map() } }, { token: ADDR.USDG, amount: 1n, symbol: "USDG", decimals: 6 }));
// KyberSwap down or turned off: venue best prepares the native route and says why; venue kyber refuses.
{
  const realFetch = globalThis.fetch;
  let kyberCalls = 0;
  globalThis.fetch = async (url, init) => { if (String(url).includes("kyberswap.com")) { kyberCalls++; throw new TypeError("fetch failed"); } return realFetch(url, init); };
  const fb = await run("swap 0.01 ETH -> USDG with KyberSwap unreachable (falls back to native)", () => prepareSwap({ tokenIn: "ETH", tokenOut: "USDG", amount: "0.01" }));
  if (fb) ok("fallback summary names the KyberSwap failure and uses Uniswap", /KyberSwap was compared and not used: KyberSwap API unreachable/.test(fb.summary) && fb.quote.bestVenue.startsWith("Uniswap") && kyberCalls > 0, fb.quote.route);
  await run("venue kyber with KyberSwap unreachable refuses", () => prepareSwap({ tokenIn: "ETH", tokenOut: "USDG", amount: "0.01", venue: "kyber" }), { expectError: /KyberSwap route not prepared: KyberSwap API unreachable/ });
  kyberCalls = 0;
  process.env.HOLBRIC_NO_AGGREGATORS = "1";
  const offr = await run("swap 0.01 ETH -> USDG with HOLBRIC_NO_AGGREGATORS=1", () => prepareSwap({ tokenIn: "ETH", tokenOut: "USDG", amount: "0.01" }));
  if (offr) ok("HOLBRIC_NO_AGGREGATORS=1: native route, nothing sent to KyberSwap", /KyberSwap was not asked: it is turned off/.test(offr.summary) && kyberCalls === 0);
  await run("HOLBRIC_NO_AGGREGATORS=1: venue kyber refuses", () => prepareSwap({ tokenIn: "ETH", tokenOut: "USDG", amount: "0.01", venue: "kyber" }), { expectError: /KyberSwap is turned off/ });
  delete process.env.HOLBRIC_NO_AGGREGATORS;
  globalThis.fetch = realFetch;
}
await run("pons buy 0.001 ETH of HOLBRIC", () => preparePonsTrade({ token: HOLBRIC, side: "buy", amount: "0.001" }));
await run("pons sell 1000000 HOLBRIC", () => preparePonsTrade({ token: HOLBRIC, side: "sell", amount: "1000000" }));
await run("register ERC-8004 agent", () => prepareRegisterAgent({ agentURI: "https://holbric.com/agent.json" }));
await run("wrap 0.01 ETH", () => prepareWrap({ amount: "0.01" }));
await run("unwrap 0.01 WETH", () => prepareUnwrap({ amount: "0.01" }));
// The throwaway wallet is not a creator: these must refuse.
await run("pons sweep from a non-creator wallet refuses", () => preparePonsSweep({ curve: HOLBRIC_CURVE }), { expectError: /Only the creator fee recipient|nothing to sweep/ });
await run("pons claim with an empty escrow balance refuses", () => preparePonsClaim({ asset: "ETH" }), { expectError: /no ETH to claim/ });

// execute_prepared must refuse before signing when the re-simulation is worse than the preview.
if (swap) {
  const p = _peek(swap.prepareId);
  for (const [k, v] of p.sim._raw.inflows) p.sim._raw.inflows.set(k, v * 2n); // pretend the preview promised twice as much
  try { await execute({ prepareId: swap.prepareId, confirm: true }); ok("execute refuses a worse result", false, "it did not refuse"); }
  catch (e) { ok("execute refuses a worse result before signing", /^Refused before signing/.test(e.message), e.message); }
}
if (mh2) {
  const p = _peek(mh2.prepareId);
  for (const [k, v] of p.sim._raw.inflows) p.sim._raw.inflows.set(k, v * 2n);
  try { await execute({ prepareId: mh2.prepareId, confirm: true }); ok("execute refuses a worse multi-hop result", false, "it did not refuse"); }
  catch (e) { ok("execute refuses a worse multi-hop result before signing", /^Refused before signing/.test(e.message), e.message); }
}
const ext = await run("send for the unexpected-transfer check", () => prepareSend({ to: "0x000000000000000000000000000000000000dEaD", token: "USDG", amount: "1" }));
if (ext) {
  const p = _peek(ext.prepareId);
  p.sim._raw.outflows.clear(); // pretend the preview showed no outgoing transfer
  try { await execute({ prepareId: ext.prepareId, confirm: true }); ok("execute refuses an unexpected transfer", false, "it did not refuse"); }
  catch (e) { ok("execute refuses an unexpected transfer before signing", /^Refused before signing: an unexpected transfer/.test(e.message), e.message); }
}

// ---- Relay bridge out of Robinhood Chain (0.8.0). Real Relay quotes for this throwaway wallet; only the deposit side
// on chain 4663 is built and simulated. Nothing is signed or sent, so Relay never sees a deposit for these orders.
const DEPO = "0x4cD00E387622C35bDDB9b4c962C136462338BC31";
const bridgeOk = (label, r, token, raw) => {
  if (!r) return;
  const outs = r.simulation.transfersOut;
  ok(`${label}: only the deposit leaves the wallet, to the RelayDepository`, outs.length === 1 && outs[0].counterparty === DEPO && outs[0].raw === raw.toString() && outs[0].symbol === token,
    outs.map((o) => `${o.amount} ${o.symbol} to ${o.counterparty}`).join("; "));
  ok(`${label}: the deposit commits to the order id Holbric recomputed (${r.relay.orderId.slice(0, 18)}...)`, _peek(r.prepareId).txs.at(-1).data.toLowerCase().endsWith(r.relay.orderId.slice(2).toLowerCase()));
};
const b1 = await run("prepare_bridge 0.01 ETH to Base", () => R.prepareBridge({ toChain: "base", token: "ETH", amount: "0.01" }));
bridgeOk("bridge ETH -> Base", b1, "ETH", 10n ** 16n);
if (b1) ok("bridge ETH -> Base pays this wallet on Base and refunds to it", b1.relay.recipient === me && /this wallet's address/.test(b1.summary) && /every refund path in the order pays this wallet/.test(b1.summary));
const b2 = await run("prepare_bridge 25 USDG to Ethereum (USDG)", () => R.prepareBridge({ toChain: "ethereum", token: "USDG", amount: "25" }));
bridgeOk("bridge USDG -> Ethereum", b2, "USDG", 25_000_000n);
if (b2) { const ap = b2.simulation.approvals; ok("bridge USDG: approval is exactly 25 USDG to the RelayDepository", ap.length === 1 && ap[0].spender === DEPO && ap[0].raw === "25000000", ap.map((a) => `${a.amount} ${a.symbol} for ${a.spender}`).join("; ")); }
const b3 = await run("prepare_bridge 25 USDG to Arbitrum One (USDC)", () => R.prepareBridge({ toChain: "arbitrum", token: "USDG", amount: "25" }));
bridgeOk("bridge USDG -> Arbitrum", b3, "USDG", 25_000_000n);
if (b3) ok(`bridge USDG -> Arbitrum delivers USDC (${b3.relay.expectedOut}, at least ${b3.relay.minimumOut})`, /USDC$/.test(b3.relay.expectedOut));
const OTHER = "0x000000000000000000000000000000000000dEaD";
const b4 = await run("prepare_bridge 0.005 ETH to OP Mainnet for a named recipient", () => R.prepareBridge({ toChain: "optimism", token: "ETH", amount: "0.005", recipient: OTHER }));
if (b4) ok("a named recipient is flagged as not this wallet; Robinhood Chain refunds still go to the wallet", b4.relay.recipient === OTHER && /NOT this wallet/.test(b4.summary) && /a refund on Robinhood Chain pays this wallet/.test(b4.summary));

// Tampered Relay answers: fetch is patched in this process to change Relay's quote before Holbric checks it.
{
  const realFetch = globalThis.fetch;
  const withQuote = async (mutate, fn) => {
    globalThis.fetch = async (url, init) => {
      const r = await realFetch(url, init);
      if (!String(url).includes("api.relay.link/quote/v2")) return r;
      const q = await r.json(); mutate(q);
      return new Response(JSON.stringify(q), { status: 200, headers: { "content-type": "application/json" } });
    };
    try { return await fn(); } finally { globalThis.fetch = realFetch; }
  };
  const W = "0x1111111111111111111111111111111111111111";
  const depTx = (q) => q.steps.flatMap((x) => x.items).find((i) => i.data.to.toLowerCase() === DEPO.toLowerCase()).data;
  await run("Relay deposit sent to another contract is refused", () => withQuote((q) => { depTx(q).to = W; }, () => R.prepareBridge({ toChain: "base", token: "ETH", amount: "0.01" })),
    { expectError: /not the verified RelayDepository/ });
  await run("Relay deposit crediting another depositor is refused", () => withQuote((q) => { const t = depTx(q); t.data = t.data.slice(0, 34) + W.slice(2).toLowerCase() + t.data.slice(74); }, () => R.prepareBridge({ toChain: "base", token: "ETH", amount: "0.01" })),
    { expectError: /deposit calldata differs/ });
  await run("Relay order paying another recipient (order id recomputed) is refused", () => withQuote((q) => { q.protocol.v2.orderData.output.payments[0].recipient = W; q.protocol.v2.orderId = R.orderId(q.protocol.v2.orderData); },
    () => R.prepareBridge({ toChain: "base", token: "ETH", amount: "0.01" })), { expectError: /output goes to 0x1111/ });
  await run("Relay order with an app fee is refused", () => withQuote((q) => { q.protocol.v2.orderData.fees.push({ recipientChainId: "base", recipient: W, currencyChainId: "base", currency: "0x0000000000000000000000000000000000000000", amount: "1000" }); q.protocol.v2.orderId = R.orderId(q.protocol.v2.orderData); },
    () => R.prepareBridge({ toChain: "base", token: "ETH", amount: "0.01" })), { expectError: /fees to a third party/ });
  await run("Relay unlimited USDG approval is refused", () => withQuote((q) => { const a = q.steps.find((x) => x.id === "approve").items[0].data; a.data = a.data.slice(0, 74) + "f".repeat(64); },
    () => R.prepareBridge({ toChain: "ethereum", token: "USDG", amount: "25" })), { expectError: /not an exact approval/ });
  // /chains naming a different depository for Robinhood Chain.
  R._resetChainsCache();
  globalThis.fetch = async (url, init) => {
    const r = await realFetch(url, init);
    if (!String(url).endsWith("api.relay.link/chains")) return r;
    const d = await r.json(); d.chains.find((x) => x.id === 4663).protocol.v2.depository = W;
    return new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
  };
  await run("Relay /chains naming another depository is refused", () => R.prepareBridge({ toChain: "base", token: "ETH", amount: "0.01" }), { expectError: /not the verified RelayDepository/ });
  globalThis.fetch = realFetch; R._resetChainsCache();
}
// execute_prepared refuses before signing when Relay's order deadline is too close.
{
  const b = await run("prepare_bridge for the deadline check", () => R.prepareBridge({ toChain: "base", token: "ETH", amount: "0.01" }));
  if (b) {
    const at = new Date(b.relay.orderDeadline).getTime();
    _peek(b.prepareId).expiresAt = at + 3_600_000; // keep the preview alive at the pretend time; only the deadline check is tested
    const realNow = Date.now; Date.now = () => at;
    try { await execute({ prepareId: b.prepareId, confirm: true }); ok("execute refuses an order past its deadline", false, "it did not refuse"); }
    catch (e) { ok("execute refuses a Relay order at its deadline, before signing", /^Refused before signing: Relay's order deadline/.test(e.message), e.message); }
    finally { Date.now = realNow; }
  }
}
// Uniswap v4 LP (0.9.0): mint on hookless ETH/USDG and WETH/USDG pools with this throwaway wallet (pretend balances).
// Remove and collect are simulated from a real public Positions NFT holder (the PositionManager deployer); nothing is signed.
const LP_HOLDER = "0x9701fb0aDe1E269c8f64Ec0C7b3cfADB31A13A52";
const addEth = await run("mint full-range ETH/USDG v4 position (0.01 ETH + 20 USDG)", () => prepareAddLiquidity({ tokenA: "ETH", tokenB: "USDG", amountA: "0.01", amountB: "20", fullRange: true }));
if (addEth) {
  ok("ETH/USDG mint goes through PositionManager with native ETH as value and an exact USDG Permit2 allowance",
    addEth.simulation.steps.some((s) => /mint Uniswap v4 position on ETH\/USDG/.test(s.step) && s.status === "success")
    && /Approve exactly .* USDG for Permit2/.test(addEth.summary)
    && /Permit2: let Uniswap v4 PositionManager 0x58daec3116aae6D93017bAAea7749052E8a04fA7 pull exactly .* USDG/.test(addEth.summary)
    && addEth.simulation.walletDeltas.some((d) => d.symbol === "ETH" && d.change.startsWith("-"))
    && addEth.simulation.walletDeltas.some((d) => d.symbol === "USDG" && d.change.startsWith("-"))
    && !/unlimited/i.test(addEth.summary.replace(/Not unlimited/g, "")),
    addEth.simulation.walletDeltas.map((d) => `${d.change} ${d.symbol}`).join(", "));
  const used0 = BigInt(addEth.quote.uses.token0Raw), got0 = -BigInt(addEth.simulation.walletDeltas.find((d) => d.symbol === "ETH")?.raw || 0);
  const used1 = BigInt(addEth.quote.uses.token1Raw), got1 = -BigInt(addEth.simulation.walletDeltas.find((d) => d.symbol === "USDG")?.raw || 0);
  ok("ETH/USDG mint uses about the quoted amounts, within 0.5% slippage",
    got0 >= used0 * 9950n / 10000n && got0 <= used0 * 10050n / 10000n && got1 >= used1 * 9950n / 10000n && got1 <= used1 * 10050n / 10000n,
    `quoted ${used0} ETH / ${used1} USDG, simulated ${got0} / ${got1}`);
}
const addWeth = await run("mint full-range WETH/USDG v4 position (exact Permit2 for both tokens)", () => prepareAddLiquidity({ tokenA: "WETH", tokenB: "USDG", amountA: "0.01", amountB: "20", fee: 500, fullRange: true }));
if (addWeth) ok("WETH/USDG mint approves exact amounts of both tokens to Permit2 for the PositionManager",
  /Approve exactly .* WETH for Permit2/.test(addWeth.summary) && /Approve exactly .* USDG for Permit2/.test(addWeth.summary)
  && addWeth.simulation.ok && addWeth.quote.poolId !== addEth?.quote?.poolId,
  addWeth.quote.poolId);
const addTight = await run("mint a tight-range ETH/USDG v4 position around the current tick", async () => {
  const { quoteAddLiquidity } = await import("../src/lp.js");
  const q = await quoteAddLiquidity({ tokenA: "ETH", tokenB: "USDG", amountA: "0.01", amountB: "20", fee: 500, fullRange: true });
  const ts = q.poolKey.tickSpacing, lo = Math.floor((q.currentTick - 2000) / ts) * ts, hi = Math.ceil((q.currentTick + 2000) / ts) * ts;
  return prepareAddLiquidity({ tokenA: "ETH", tokenB: "USDG", amountA: "0.01", amountB: "20", fee: 500, tickLower: lo, tickUpper: hi });
});
if (addTight) ok("tight-range mint is in range and succeeds", addTight.simulation.ok && addTight.quote.inRange === true && addTight.quote.tickLower > -887270, `${addTight.quote.tickLower} to ${addTight.quote.tickUpper}`);
await run("mint on a Pons hooked pool is refused", () => prepareAddLiquidity({ tokenA: "ETH", tokenB: ORBIT, amountA: "0.01", amountB: "1000", fee: 0, tickSpacing: 200, hooks: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044", fullRange: true }), { expectError: /hookless|Pons V2 hook/ });
await run("collect fees on a position this wallet does not own is refused", () => prepareCollectLpFees({ tokenId: "1" }), { expectError: /owned by/ });
await run("remove liquidity on a position this wallet does not own is refused", () => prepareRemoveLiquidity({ tokenId: "1" }), { expectError: /owned by/ });

// Collect and burn from the real public holder, simulated only. WETH (standard Transfer) must match the quote to the wei.
const { encodeAbiParameters, encodePacked, encodeFunctionData: enc } = await import("viem");
const { POSITION_MANAGER } = await import("../src/lp.js");
const DEC = 0x01, BUR = 0x03, TAKE = 0x11, MSG = "0x0000000000000000000000000000000000000001";
const pack = (actions, params) => encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [encodePacked(actions.map(() => "uint8"), actions), params]);
const decP = (id, liq, a0, a1) => encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }], [id, liq, a0, a1, "0x"]);
const burnP = (id, a0, a1) => encodeAbiParameters([{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }], [id, a0, a1, "0x"]);
const takeP = (c0, c1) => encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [c0, c1, MSG]);
const pmCall = (data) => enc({ abi: parseAbi(["function modifyLiquidities(bytes unlockData, uint256 deadline) payable"]), functionName: "modifyLiquidities", args: [data, BigInt(Math.floor(Date.now() / 1000) + 900)] });
const colQ = await quoteCollectLpFees({ tokenId: "1" });
const colSim = await simulateTxs(LP_HOLDER, [{ label: "collect fees on position 1", to: POSITION_MANAGER, value: 0n, data: pmCall(pack([DEC, TAKE], [decP(1n, 0n, 0n, 0n), takeP(colQ.poolKey.currency0, colQ.poolKey.currency1)])) }]);
const colWeth = colSim.walletDeltas.find((d) => d.symbol === "WETH");
ok("simulated collect on position 1 succeeds and pays the quoted WETH fees to the wei",
  colSim.ok && colSim.method === "eth_simulateV1" && colWeth && colWeth.raw === colQ.uncollectedFees.token0Raw,
  colWeth ? `${colWeth.change} WETH, quoted ${colQ.uncollectedFees.token0}` : colSim.steps[0]?.error);
const remQ = await quoteRemoveLiquidity({ tokenId: "2" });
const burnSim = await simulateTxs(LP_HOLDER, [{ label: "burn position 2", to: POSITION_MANAGER, value: 0n, data: pmCall(pack([BUR, TAKE], [burnP(2n, 0n, 0n), takeP(remQ.poolKey.currency0, remQ.poolKey.currency1)])) }]);
const burnWeth = burnSim.walletDeltas.find((d) => d.symbol === "WETH");
const expectWeth = (BigInt(remQ.principalOut.token0Raw) + BigInt(remQ.uncollectedFees.token0Raw)).toString();
ok("simulated burn of position 2 pays the quoted WETH principal plus fees to the wei",
  burnSim.ok && burnWeth && burnWeth.raw === expectWeth,
  burnWeth ? `${burnWeth.change} WETH, quoted ${expectWeth}` : burnSim.steps[0]?.error);

// Read-only: the real HOLBRIC creator fee position, and what a claim and a sweep by the real creator would do.
// eth_simulateV1 needs no signature; nothing is signed or sent.
const fees = await ponsCreatorFees({ curve: HOLBRIC_CURVE, recipient: CREATOR });
console.log("\n=== HOLBRIC creator fees (read-only)\n" + JSON.stringify({ block: fees.block, escrow: fees.escrow.claimable, unswept: fees.unswept, total: fees.estimatedTotalOwed, sweep: fees.sweep }, null, 1));
ok("pons_creator_fees reads escrow and curve separately", fees.escrow.claimableRaw != null && fees.unswept.tradingFeePending != null);
const escrowAbi = parseAbi(["function claim() returns (uint256)"]);
const claimSim = await simulateTxs(CREATOR, [{ label: "claim()", to: ADDR.PONS_ESCROW, value: 0n, data: encodeFunctionData({ abi: escrowAbi, functionName: "claim" }) }]);
const claimIn = claimSim.walletDeltas.find((d) => d.symbol === "ETH");
ok("simulated creator claim() pays the escrow balance", BigInt(fees.escrow.claimableRaw) === 0n ? claimSim.steps[0].status === "failure" : claimIn && claimIn.raw === fees.escrow.claimableRaw,
  claimIn ? `${claimIn.change} ETH to the creator` : claimSim.steps[0].error);
const curveAbi = parseAbi(["function sweepFees(uint256 minBuybackTokensOut)"]);
const sweepSim = await simulateTxs(CREATOR, [{ label: "sweepFees(0)", to: HOLBRIC_CURVE, value: 0n, data: encodeFunctionData({ abi: curveAbi, functionName: "sweepFees", args: [0n] }) }]);
ok("simulated creator sweepFees(0) on the curve", fees.sweep.creatorCanSweepNow ? sweepSim.ok : true, `${sweepSim.steps[0].status}${sweepSim.steps[0].error ? " " + sweepSim.steps[0].error : ""}`);
const notCreator = await simulateTxs(me, [{ label: "sweepFees(0) from a non-creator", to: HOLBRIC_CURVE, value: 0n, data: encodeFunctionData({ abi: curveAbi, functionName: "sweepFees", args: [0n] }) }]);
ok("sweepFees from a non-creator reverts", notCreator.steps[0].status === "failure", notCreator.steps[0].error);

console.log(`\nSimulation method: ${simulateMethod() ? "eth_simulateV1" : "eth_call fallback"}. ${pass} passed, ${fail} failed. Nothing was signed or sent.`);
process.exit(fail ? 1 : 0);
