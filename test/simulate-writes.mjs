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
const DUMMY_SPENDER = "0x000000000000000000000000000000000000bEEF";

const c = publicClient();
const BIG = 10n ** 30n;
const realGetBalance = c.getBalance.bind(c), realRead = c.readContract.bind(c);
c.getBalance = async (a) => (a.address === me ? parseEther("5") : realGetBalance(a));
c.readContract = async (a) => (a.functionName === "balanceOf" && a.args?.[0] === me && !a.stateOverride && a.address !== ADDR.ERC8004_IDENTITY && a.address !== ADDR.PONS_ESCROW ? BIG : realRead(a));
// Pretend balances for the throwaway wallet only, inside the simulation. Allowances stay real (zero), so approvals are exercised.
const pretend = [[ADDR.USDG, 10n ** 12n], [ADDR.WETH, parseEther("1")], [HOLBRIC, 2n * 10n ** 24n], [AMZN, parseEther("1")]];
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
const mh1 = await run("swap 0.01 ETH -> AMZN (multi-hop)", () => prepareSwap({ tokenIn: "ETH", tokenOut: AMZN, amount: "0.01" }));
multiCheck("ETH -> AMZN", mh1, "USDG");
const mh2 = await run("swap 5 USDG -> BMNR (multi-hop, exact approval)", () => prepareSwap({ tokenIn: "USDG", tokenOut: BMNR, amount: "5" }));
multiCheck("USDG -> BMNR", mh2, "WETH");
if (mh2) ok("USDG -> BMNR approves exactly 5 USDG", /Approve exactly 5 USDG/.test(mh2.summary) && !/unlimited/i.test(mh2.summary.replace("Not unlimited", "")));
const mh3 = await run("swap 0.05 AMZN -> ETH (multi-hop, unwrap)", () => prepareSwap({ tokenIn: AMZN, tokenOut: "ETH", amount: "0.05" }));
multiCheck("AMZN -> ETH", mh3, "USDG");
if (mh3) ok("AMZN -> ETH delivers native ETH to the wallet", mh3.simulation.walletDeltas.some((d) => d.symbol === "ETH" && !d.change.startsWith("-")),
  mh3.simulation.walletDeltas.map((d) => `${d.change} ${d.symbol}`).join(", "));
await run("send 0.001 ETH", () => prepareSend({ to: "0x000000000000000000000000000000000000dEaD", token: "ETH", amount: "0.001" }));
await run("send 1 USDG", () => prepareSend({ to: "0x000000000000000000000000000000000000dEaD", token: "USDG", amount: "1" }));
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
