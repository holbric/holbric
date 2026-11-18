// Live mainnet test over MCP stdio. Calls read tools and prepare tools on Robinhood Chain (4663). Never signs or sends.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";

const home = process.env.HOLBRIC_HOME || mkdtempSync(join(tmpdir(), "holbric-test-"));
process.env.HOLBRIC_HOME = home;
const { writeKeystore, keystoreExists } = await import("../src/keystore.js");
if (!keystoreExists()) writeKeystore(generatePrivateKey(), "test-passphrase-not-used");

const transport = new StdioClientTransport({ command: process.execPath, args: [new URL("../bin/holbric.js", import.meta.url).pathname, "mcp"], env: { ...process.env, HOLBRIC_HOME: home } });
const client = new Client({ name: "holbric-live-test", version: "0.0.0" });
await client.connect(transport);
const tools = await client.listTools();
console.log(`TOOLS (${tools.tools.length}):`, tools.tools.map((t) => t.name).join(", "));
console.log("Run at", new Date().toLocaleString("en-GB", { hour12: false, timeZoneName: "short" }));

const MAX = Number(process.env.MAX || 1800);
let pass = 0, fail = 0;
const check = (label, cond) => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} ${label}`); };
// expect: "ok" (must succeed), or a RegExp the error text must match (prepare tools with an empty wallet must refuse).
const call = async (name, args = {}, expect = "ok") => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text).join("\n");
  console.log(`\n=== ${name} ${JSON.stringify(args)} ${r.isError ? "(error)" : ""}\n${text.length > MAX ? text.slice(0, MAX) + "\n...[truncated]" : text}`);
  check(`${name}${expect === "ok" ? "" : " refuses"}`, expect === "ok" ? !r.isError : !!r.isError && expect.test(text));
  return text;
};
check(`tool count is 27 (got ${tools.tools.length})`, tools.tools.length === 27);
const HOLBRIC = "0xE8D6AE09757769968d17eab44998A03E196217e7";
await call("wallet_address");
await call("chain_status");
await call("get_balances", { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" });
await call("token_info", { token: HOLBRIC });
await call("token_info", { token: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" });
const direct = JSON.parse(await call("quote_swap", { tokenIn: "USDG", tokenOut: "WETH", amount: "5" }));
check(`USDG -> WETH stays a direct route (${direct.route})`, direct.hops === 1 && direct.compared.routesQuoted > 1);
// Multi-hop: official Robinhood Stock Tokens with no live direct Uniswap v3 pool against the input token.
// The factory check below proves there is no direct route, so the router has to find a 2-hop one.
const { livePools } = await import("../src/route.js");
const AMZN = "0x12f190a9F9d7D37a250758b26824B97CE941bF54", BMNR = "0x9a7842EDed60b0FE1e03eEc342C82A397c821eD0";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
check("factory: no live WETH/AMZN pool at any fee tier", (await livePools(WETH, AMZN)).length === 0);
check("factory: no live USDG/BMNR pool at any fee tier", (await livePools(USDG, BMNR)).length === 0);
const amzn = JSON.parse(await call("quote_swap", { tokenIn: "ETH", tokenOut: AMZN, amount: "0.01" }));
check(`ETH -> AMZN routes in 2 hops (${amzn.route})`, amzn.hops === 2 && amzn.routeTokens[2] === "AMZN" && BigInt(amzn.tokenOut.amountOutRaw) > 0n);
const bmnr = JSON.parse(await call("find_route", { tokenIn: "USDG", tokenOut: BMNR, amount: "5" }));
check(`USDG -> BMNR best route is 2 hops through WETH (${bmnr.best.route})`, bmnr.best.hops === 2 && bmnr.best.tokens[1] === WETH);
check("find_route lists the alternatives it compared, all worse or equal", bmnr.alternatives.every((a) => BigInt(a.amountOutRaw) <= BigInt(bmnr.best.amountOutRaw)));
const sell = JSON.parse(await call("find_route", { tokenIn: AMZN, tokenOut: "ETH", amount: "0.05" }));
check(`AMZN -> ETH routes in 2 hops (${sell.best.route})`, sell.best.hops === 2);
// Uniswap v4 (0.5.0). ORBIT is a Pons V2 launch that graduated to a v4 pool with the Pons hook.
const ORBIT = "0xF1A947c6C7b8887ef6C09b8B088787b4d1fF8d0a", NATIVE = "0x0000000000000000000000000000000000000000";
const PONS_HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044", ORBIT_POOL = "0x67d3f53386c92850be8a0bd4d174acaf97316850a216fb5b38d7f72711021042";
// Independent check of the pool key: the PoolManager's own Initialize event for that pool id.
{
  const { publicClient } = await import("../src/chain.js");
  const { parseAbiItem } = await import("viem");
  const ev = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");
  const logs = await publicClient().getLogs({ address: "0x8366a39CC670B4001A1121B8F6A443A643e40951", event: ev, args: { id: ORBIT_POOL }, fromBlock: 116806359n, toBlock: 116806359n });
  const a = logs[0]?.args;
  check("PoolManager Initialize event matches the Pons key Holbric derives (ETH/ORBIT, fee 0, tickSpacing 200, Pons hook)",
    logs.length === 1 && a.currency0 === NATIVE && a.currency1 === ORBIT && a.fee === 0 && a.tickSpacing === 200 && a.hooks === PONS_HOOK);
}
const pools = JSON.parse(await call("v4_pools", { tokenA: "ETH", tokenB: ORBIT }));
const pp = pools.pools.find((p) => p.poolId === ORBIT_POOL);
check("v4_pools finds the graduated ORBIT pool, live, with the Pons hook", pp && pp.live && pp.poolKey.hooks === PONS_HOOK && pp.poolKey.fee === 0 && pp.poolKey.tickSpacing === 200);
const ethUsdg = JSON.parse(await call("v4_pools", { tokenA: "ETH", tokenB: "USDG" }));
check(`v4_pools: native ETH/USDG has live hookless pools (${ethUsdg.livePools})`, ethUsdg.livePools > 0 && ethUsdg.pools.every((p) => p.poolKey.hooks === NATIVE));
const qv4 = JSON.parse(await call("quote_v4", { tokenIn: "ETH", tokenOut: "USDG", amount: "0.1" }));
check(`quote_v4 ETH -> USDG stays on v4 (${qv4.route})`, qv4.bestVenue === "Uniswap v4" && qv4.compared.v3Routes === 0 && BigInt(qv4.tokenOut.amountOutRaw) > 0n);
const qkey = JSON.parse(await call("quote_v4", { tokenIn: "ETH", tokenOut: ORBIT, amount: "0.01", poolKey: { currency0: NATIVE, currency1: ORBIT, fee: 0, tickSpacing: 200, hooks: PONS_HOOK } }));
check("quote_v4 with an explicit pool key quotes that pool only", qkey.compared.routesQuoted === 1 && qkey.poolIds[0] === ORBIT_POOL);
await call("quote_v4", { tokenIn: "ETH", tokenOut: "USDG", amount: "0.01", poolKey: { currency0: NATIVE, currency1: ORBIT, fee: 0, tickSpacing: 200, hooks: PONS_HOOK } }, /does not trade ETH/);
const both = JSON.parse(await call("find_route", { tokenIn: "ETH", tokenOut: "USDG", amount: "0.5" }));
check(`find_route ETH -> USDG compares v3 and v4 (${both.compared.v3Routes} v3, ${both.compared.v4Routes} v4; best ${both.best.venue})`, both.compared.v3Routes > 0 && both.compared.v4Routes > 0 &&
  [both.best, ...both.alternatives].some((r) => r.venue === "Uniswap v3") && [both.best, ...both.alternatives].some((r) => r.venue === "Uniswap v4") && both.alternatives.every((a) => BigInt(a.amountOutRaw) <= BigInt(both.best.amountOutRaw)));
const toOrbit = JSON.parse(await call("quote_swap", { tokenIn: "USDG", tokenOut: ORBIT, amount: "20" }));
check(`USDG -> ORBIT routes through ETH into the Pons pool on v4 (${toOrbit.route})`, toOrbit.bestVenue === "Uniswap v4" && toOrbit.hops === 2 && toOrbit.poolIds[1] === ORBIT_POOL);
const pt = JSON.parse(await call("pons_token", { token: ORBIT }));
check("pons_token on a graduated token reads its v4 pool", pt.status === "graduated" && pt.uniswapV4Pool?.poolId === ORBIT_POOL && pt.priceSource === "Uniswap v4 pool slot0");
const pq = JSON.parse(await call("pons_quote", { token: ORBIT, side: "buy", amount: "0.01" }));
check("pons_quote on a graduated token quotes its v4 pool", pq.phase === "graduated" && pq.venue.includes(ORBIT_POOL) && BigInt(pq.amountOutRaw) > 0n);
await call("pons_quote", { token: ORBIT, side: "sell", amount: "100000" });
await call("stock_tokens", { search: "TSLA", limit: 3 });
await call("stock_quote", { stock: "NVDA", side: "sell", amount: "1" });
await call("pons_token", { token: HOLBRIC });
await call("pons_quote", { token: HOLBRIC, side: "buy", amount: "0.001" });
await call("pons_quote", { token: HOLBRIC, side: "sell", amount: "1000000" });
await call("pons_recent_launches", { hours: 3, limit: 5 });
await call("agent_identity", {});
await call("agent_identity", { agentId: 1 });
await call("agent_reputation", { agentId: 1 });
await call("market_token", { token: HOLBRIC });
await call("market_trending", { limit: 3 });
// Real HOLBRIC creator fee position (read-only): escrow and unswept curve fees, kept separate.
const fees = JSON.parse(await call("pons_creator_fees", { curve: "0x4eF8D0d0210BbF85C3e4C93921C9F87d075618B6", recipient: "0x06287131cabd16ae540959bfd70c415bb04239ff" }, "ok"));
check("pons_creator_fees has escrow and unswept apart", fees.escrow?.claimable && fees.unswept?.tradingFeePending && fees.caveat);
// prepare tools with an empty wallet must refuse; execute must refuse unknown ids
const EMPTY = /not enough|Not enough|no ETH|Only the creator|nothing to sweep|Fund it/;
await call("prepare_swap", { tokenIn: "USDG", tokenOut: "WETH", amount: "5" }, EMPTY);
await call("prepare_swap", { tokenIn: "ETH", tokenOut: AMZN, amount: "0.01" }, EMPTY);
await call("prepare_send", { to: "0x000000000000000000000000000000000000dEaD", token: "ETH", amount: "0.001" }, EMPTY);
await call("prepare_wrap_eth", { amount: "0.001" }, EMPTY);
await call("prepare_unwrap_weth", { amount: "0.001" }, EMPTY);
await call("prepare_pons_trade", { token: HOLBRIC, side: "buy", amount: "0.001" }, EMPTY);
await call("prepare_swap", { tokenIn: "ETH", tokenOut: "USDG", amount: "0.01", venue: "v4" }, EMPTY);
await call("prepare_pons_trade", { token: ORBIT, side: "buy", amount: "0.001" }, EMPTY);
await call("prepare_pons_claim", { asset: "ETH" }, EMPTY);
await call("prepare_pons_sweep", { token: HOLBRIC }, EMPTY);
await call("prepare_register_agent", { agentURI: "https://holbric.com/agent.json" }, EMPTY);
await call("execute_prepared", { prepareId: "hp_doesnotexist", confirm: true }, /Unknown or expired prepareId/);
await client.close();
console.log(`\n${pass} passed, ${fail} failed. Nothing was signed or sent.`);
process.exit(fail ? 1 : 0);
