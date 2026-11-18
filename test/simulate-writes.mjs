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
const { ponsCreatorFees, preparePonsSweep, preparePonsClaim } = await import("../src/ponsfees.js");
const { _peek, recheck, execute } = await import("../src/actions.js");
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
const v4b = await run("v4 swap 20 USDG -> ORBIT (2 hops on v4 via ETH into the Pons pool)", () => prepareSwap({ tokenIn: "USDG", tokenOut: ORBIT, amount: "20" }));
if (v4b) ok("USDG -> ORBIT routes USDG -> ETH -> ORBIT on v4", !!v4Step(v4b) && v4b.quote.hops === 2 && v4b.quote.routeTokens[1] === "ETH" && /v4 Pons/.test(v4b.quote.route), v4b.quote.route);
if (v4b) ok("USDG -> ORBIT approves exactly 20 USDG to Permit2 and an exact 30-minute Permit2 allowance", /Approve exactly 20 USDG for Permit2/.test(v4b.summary) && /Permit2: let Uniswap Universal Router 0x[0-9a-fA-F]{40} pull exactly 20 USDG, expiring 30 minutes from now/.test(v4b.summary), v4b.simulation.steps.map((s) => s.step).join(" | "));
const v4c = await run("pons buy 0.002 ETH of graduated ORBIT (v4 Pons pool)", () => preparePonsTrade({ token: ORBIT, side: "buy", amount: "0.002" }));
if (v4c) ok("graduated Pons buy goes through the v4 Pons pool", !!v4Step(v4c) && /graduated, so the trade goes through its Uniswap v4 pool 0x67d3f533/.test(v4c.summary) && BigInt(delta(v4c, "ORBIT")?.raw || 0) > 0n, `${delta(v4c, "ORBIT")?.change} ORBIT`);
const v4d = await run("pons sell 100000 ORBIT (graduated, ERC-20 in via Permit2, native ETH out)", () => preparePonsTrade({ token: ORBIT, side: "sell", amount: "100000" }));
if (v4d) ok("graduated Pons sell pays native ETH to the wallet", !!v4Step(v4d) && /^\+/.test(delta(v4d, "ETH")?.change || "") && /Approve exactly 100000 ORBIT for Permit2/.test(v4d.summary), `${delta(v4d, "ETH")?.change} ETH`);
const v4e = await run("swap 0.05 AMZN -> ETH (best of v3 and v4)", () => prepareSwap({ tokenIn: AMZN, tokenOut: "ETH", amount: "0.05" }));
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
