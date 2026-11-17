// Runs every prepare_* in-process against mainnet with pretend balances (the client's balance reads are patched in this
// process only), then replays each prepared transaction with eth_call + state overrides. Nothing is signed or sent.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { parseEther, erc20Abi } from "viem";
process.env.HOLBRIC_HOME = mkdtempSync(join(tmpdir(), "holbric-sim-"));
const { writeKeystore } = await import("../src/keystore.js");
const me = writeKeystore(generatePrivateKey(), "sim-only-passphrase");
const { publicClient, ADDR } = await import("../src/chain.js");
const { tokenOverride } = await import("../src/storage.js");
const { prepareSwap } = await import("../src/swap.js");
const { prepareSend } = await import("../src/send.js");
const { preparePonsTrade } = await import("../src/pons.js");
const { prepareRegisterAgent } = await import("../src/identity.js");
const { _peek } = await import("../src/actions.js");

const c = publicClient();
const BIG = 10n ** 30n;
const realGetBalance = c.getBalance.bind(c), realRead = c.readContract.bind(c);
c.getBalance = async (a) => (a.address === me ? parseEther("5") : realGetBalance(a));
c.readContract = async (a) => (a.functionName === "balanceOf" && a.args?.[0] === me && !a.stateOverride && a.address !== ADDR.ERC8004_IDENTITY ? BIG : realRead(a));

const HOLBRIC = "0xE8D6AE09757769968d17eab44998A03E196217e7";
async function run(label, prep) {
  try {
    const r = await prep();
    console.log(`\n=== ${label}\n${r.summary}`);
    const p = _peek(r.prepareId);
    const last = p.txs[p.txs.length - 1];
    const overrides = [{ address: me, balance: parseEther("5") }];
    const approve = p.txs.length > 1 ? p.txs[0] : null;
    if (approve) { const spender = "0x" + approve.data.slice(34, 74); const amt = BigInt("0x" + approve.data.slice(74, 138)); overrides.push(await tokenOverride(approve.to, me, spender, amt)); }
    if (label.startsWith("send USDG")) overrides.push(await tokenOverride(ADDR.USDG, me, me, 10n ** 9n));
    const res = await c.call({ account: me, to: last.to, data: last.data, value: last.value, stateOverride: overrides });
    console.log(`eth_call of final tx (${last.label}): OK, returned ${res.data ? res.data.slice(0, 66) : "0x"}…`);
  } catch (e) { console.log(`\n=== ${label}\nFAILED: ${e.shortMessage || e.message}`); }
}
await run("swap 5 USDG -> WETH", () => prepareSwap({ tokenIn: "USDG", tokenOut: "WETH", amount: "5" }));
await run("swap 0.001 ETH -> USDG", () => prepareSwap({ tokenIn: "ETH", tokenOut: "USDG", amount: "0.001" }));
await run("swap 2 USDG -> ETH (unwrap)", () => prepareSwap({ tokenIn: "USDG", tokenOut: "ETH", amount: "2" }));
await run("send 0.001 ETH", () => prepareSend({ to: "0x000000000000000000000000000000000000dEaD", token: "ETH", amount: "0.001" }));
await run("send USDG 1", () => prepareSend({ to: "0x000000000000000000000000000000000000dEaD", token: "USDG", amount: "1" }));
await run("pons buy 0.001 ETH of HOLBRIC", () => preparePonsTrade({ token: HOLBRIC, side: "buy", amount: "0.001" }));
await run("pons sell 1000000 HOLBRIC", () => preparePonsTrade({ token: HOLBRIC, side: "sell", amount: "1000000" }));
await run("register ERC-8004 agent", () => prepareRegisterAgent({ agentURI: "https://holbric.com/agent.json" }));
