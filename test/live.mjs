// Live mainnet test over MCP stdio. Calls read tools and prepare tools on Robinhood Chain (4663). Never signs or sends.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey } from "viem/accounts";

const home = process.env.HOLBRIC_HOME || mkdtempSync(join(tmpdir(), "holbric-test-"));
process.env.HOLBRIC_HOME = home;
const { writeKeystore, keystoreExists } = await import("../src/keystore.js");
if (!keystoreExists()) writeKeystore(generatePrivateKey(), "test-passphrase-not-used");

const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../bin/holbric.js", import.meta.url)), "mcp"], env: { ...process.env, HOLBRIC_HOME: home } });
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
check(`tool count is 50 (got ${tools.tools.length})`, tools.tools.length === 50);
const HOLBRIC = "0xE8D6AE09757769968d17eab44998A03E196217e7";
await call("wallet_address");
await call("chain_status");
await call("get_balances", { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" });
await call("token_info", { token: HOLBRIC });
await call("token_info", { token: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" });
const direct = JSON.parse(await call("quote_swap", { tokenIn: "USDG", tokenOut: "WETH", amount: "5", venue: "native" }));
check(`USDG -> WETH stays a direct route (${direct.route})`, direct.hops === 1 && direct.compared.routesQuoted > 1);
// The route-shape checks below pin venue "native": they test Holbric's own Uniswap routing. Since 0.6.0 the default
// also asks KyberSwap, which can win with a different route shape.
// Multi-hop: official Robinhood Stock Tokens with no live direct Uniswap v3 pool against the input token.
// The factory check below proves there is no direct route, so the router has to find a 2-hop one.
const { livePools } = await import("../src/route.js");
const AMZN = "0x12f190a9F9d7D37a250758b26824B97CE941bF54", BMNR = "0x9a7842EDed60b0FE1e03eEc342C82A397c821eD0";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
check("factory: no live WETH/AMZN pool at any fee tier", (await livePools(WETH, AMZN)).length === 0);
check("factory: no live USDG/BMNR pool at any fee tier", (await livePools(USDG, BMNR)).length === 0);
const amzn = JSON.parse(await call("quote_swap", { tokenIn: "ETH", tokenOut: AMZN, amount: "0.01", venue: "native" }));
check(`ETH -> AMZN routes in 2 hops (${amzn.route})`, amzn.hops === 2 && amzn.routeTokens[2] === "AMZN" && BigInt(amzn.tokenOut.amountOutRaw) > 0n);
const bmnr = JSON.parse(await call("find_route", { tokenIn: "USDG", tokenOut: BMNR, amount: "5", venue: "native" }));
check(`USDG -> BMNR best route is 2 hops through WETH (${bmnr.best.route})`, bmnr.best.hops === 2 && bmnr.best.tokens[1] === WETH);
check("find_route lists the alternatives it compared, all worse or equal", bmnr.alternatives.every((a) => BigInt(a.amountOutRaw) <= BigInt(bmnr.best.amountOutRaw)));
const sell = JSON.parse(await call("find_route", { tokenIn: AMZN, tokenOut: "ETH", amount: "0.05", venue: "native" }));
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
const both = JSON.parse(await call("find_route", { tokenIn: "ETH", tokenOut: "USDG", amount: "0.5", venue: "native" }));
check(`find_route ETH -> USDG compares v3 and v4 (${both.compared.v3Routes} v3, ${both.compared.v4Routes} v4; best ${both.best.venue})`, both.compared.v3Routes > 0 && both.compared.v4Routes > 0 &&
  [both.best, ...both.alternatives].some((r) => r.venue === "Uniswap v3") && [both.best, ...both.alternatives].some((r) => r.venue === "Uniswap v4") && both.alternatives.every((a) => BigInt(a.amountOutRaw) <= BigInt(both.best.amountOutRaw)));
const toOrbit = JSON.parse(await call("quote_swap", { tokenIn: "USDG", tokenOut: ORBIT, amount: "20", venue: "native" }));
check(`USDG -> ORBIT routes through ETH into the Pons pool on v4 (${toOrbit.route})`, toOrbit.bestVenue === "Uniswap v4" && toOrbit.hops === 2 && toOrbit.poolIds[1] === ORBIT_POOL);
const pt = JSON.parse(await call("pons_token", { token: ORBIT }));
check("pons_token on a graduated token reads its v4 pool", pt.status === "graduated" && pt.uniswapV4Pool?.poolId === ORBIT_POOL && pt.priceSource === "Uniswap v4 pool slot0");
const pq = JSON.parse(await call("pons_quote", { token: ORBIT, side: "buy", amount: "0.01" }));
check("pons_quote on a graduated token quotes its v4 pool", pq.phase === "graduated" && pq.venue.includes(ORBIT_POOL) && BigInt(pq.amountOutRaw) > 0n);
await call("pons_quote", { token: ORBIT, side: "sell", amount: "100000" });
// Uniswap v4 liquidity positions (0.9.0). Public Positions NFT holder who deployed the PositionManager (create2, block 9073); not a Holbric wallet.
const LP_HOLDER = "0x9701fb0aDe1E269c8f64Ec0C7b3cfADB31A13A52";
const lps = JSON.parse(await call("lp_positions", { address: LP_HOLDER }));
check("lp_positions recovers both Positions NFTs from Transfer logs, matching balanceOf", lps.total === 2 && lps.discovery?.balanceOf === "2" && lps.discovery?.failedRequests === 0 && lps.positions.map((p) => p.tokenId).join(",") === "1,2");
const p1 = lps.positions[0];
check("position 1 is a hookless in-range WETH/SMK4 0.3% full-range position with uncollected fees",
  p1 && p1.tokenId === "1" && p1.owner.toLowerCase() === LP_HOLDER.toLowerCase() && p1.inRange === true && p1.hook === "hookless" && p1.fee === "0.3%"
  && p1.token0.symbol === "WETH" && p1.tickLower === -887220 && p1.tickUpper === 887220
  && BigInt(p1.liquidity) > 0n && BigInt(p1.uncollectedFees.token0Raw) > 0n && BigInt(p1.principal.token0Raw) > 0n);
const { publicClient: pc } = await import("../src/chain.js");
const { parseAbi } = await import("viem");
const owner1 = await pc().readContract({ address: "0x58daec3116aae6D93017bAAea7749052E8a04fA7", abi: parseAbi(["function ownerOf(uint256 id) view returns (address)"]), functionName: "ownerOf", args: [1n] });
check("PositionManager.ownerOf(1) matches lp_positions", owner1.toLowerCase() === p1.owner.toLowerCase());
const one = JSON.parse(await call("lp_positions", { tokenId: "1" }));
check("lp_positions by tokenId skips the log scan and returns that NFT", one.total === 1 && one.positions[0].tokenId === "1" && one.method?.includes("token id"));
const addQ = JSON.parse(await call("quote_add_liquidity", { tokenA: "ETH", tokenB: "USDG", amountA: "0.01", amountB: "20", fullRange: true }));
check(`quote_add_liquidity ETH/USDG picks a live hookless pool and uses both tokens (${addQ.fee}, liquidity ${addQ.liquidity})`,
  addQ.hook === "hookless" && addQ.inRange === true && addQ.token0.symbol === "ETH" && addQ.token1.symbol === "USDG"
  && addQ.tickLower < addQ.tickUpper && BigInt(addQ.liquidity) > 0n && BigInt(addQ.uses.token0Raw) > 0n && BigInt(addQ.uses.token1Raw) > 0n
  && BigInt(addQ.uses.token0Raw) <= 10n ** 16n && BigInt(addQ.uses.token1Raw) <= 20n * 10n ** 6n);
const colQ = JSON.parse(await call("quote_collect_lp_fees", { tokenId: "1" }));
check("quote_collect_lp_fees on position 1 matches lp_positions fees", colQ.uncollectedFees.token0Raw === p1.uncollectedFees.token0Raw && colQ.uncollectedFees.token1Raw === p1.uncollectedFees.token1Raw && colQ.action.includes("collect"));
const remQ = JSON.parse(await call("quote_remove_liquidity", { tokenId: "1" }));
check("quote_remove_liquidity of all of position 1 burns the NFT and includes principal plus fees",
  remQ.burnNft === true && remQ.liquidityToRemove === p1.liquidity
  && remQ.expectedTotal.token0 && BigInt(remQ.principalOut.token0Raw) === BigInt(p1.principal.token0Raw));
await call("quote_add_liquidity", { tokenA: "ETH", tokenB: ORBIT, amountA: "0.01", amountB: "1000", fee: 0, tickSpacing: 200, hooks: PONS_HOOK, fullRange: true }, /hookless|Pons V2 hook/);
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
await call("prepare_add_liquidity", { tokenA: "ETH", tokenB: "USDG", amountA: "0.01", amountB: "20", fullRange: true }, EMPTY);
await call("prepare_remove_liquidity", { tokenId: "1" }, /owned by|Not enough|no ETH|Fund it|not a current/);
await call("prepare_collect_lp_fees", { tokenId: "1" }, /owned by|Not enough|no ETH|Fund it|not a current/);
await call("execute_prepared", { prepareId: "hp_doesnotexist", confirm: true }, /Unknown or expired prepareId/);
// 0.10.0: Morpho writes and ERC-8004 feedback, from the empty test wallet.
const NVDA_USDG_LISTED = "0xf5ff7d546af5e72f3912d2aa723088fd0bf66fddc158714995637714d9db6e4c";
await call("prepare_morpho_supply", { marketId: NVDA_USDG_LISTED, amount: "5" }, EMPTY);
await call("prepare_morpho_borrow", { marketId: NVDA_USDG_LISTED, amount: "5" }, /no NVDA collateral/);
await call("prepare_morpho_borrow", { marketId: NVDA_USDG_LISTED, amount: "5", collateralAmount: "1" }, EMPTY);
await call("prepare_morpho_repay", { marketId: NVDA_USDG_LISTED, all: true }, /no USDG debt/);
await call("prepare_morpho_withdraw", { marketId: NVDA_USDG_LISTED, what: "collateral", all: true }, /no NVDA collateral/);
await call("prepare_morpho_supply", { marketId: "0x1234", amount: "5" }, /32-byte Morpho market id/);
await call("prepare_agent_feedback", { agentId: 1, value: "5" }, EMPTY);
await call("prepare_agent_feedback", { agentId: 1, value: "1e5" }, /value must be a number/);
await call("prepare_revoke_feedback", { agentId: 1, feedbackIndex: 1 }, /there is no number 1/);
await call("prepare_swap", { tokenIn: "ETH", tokenOut: "USDG", amount: "0.01", venue: "kyber" }, EMPTY);
await call("prepare_swap", { tokenIn: "USDG", tokenOut: "ETH", amount: "5", venue: "best" }, EMPTY);

// KyberSwap (0.6.0): third-party aggregator next to Holbric's own routing. Read-only checks and quote simulations.
{
  const { publicClient } = await import("../src/chain.js");
  const { KYBER_ROUTER, KYBER_EXECUTOR } = await import("../src/kyber.js");
  const c = publicClient();
  const [code, execCode] = await Promise.all([c.getCode({ address: KYBER_ROUTER }), c.getCode({ address: KYBER_EXECUTOR })]);
  check(`KyberSwap router ${KYBER_ROUTER} and executor have code on chain 4663`, code && code.length > 2 && execCode && execCode.length > 2);
  const sf = await fetch(`https://sourcify.dev/server/v2/contract/4663/${KYBER_ROUTER}?fields=compilation`, { signal: AbortSignal.timeout(20000) }).then((r) => r.json()).catch(() => null);
  check(`Sourcify: ${sf?.compilation?.name} is an exact match on chain 4663`, sf?.match === "exact_match" && sf?.compilation?.name === "MetaAggregationRouterV2");
}
const pause = () => new Promise((r) => setTimeout(r, 1500)); // the public KyberSwap endpoint is rate limited
const consistent = (x) => {
  const h = x.holbric?.amountOutRaw ? BigInt(x.holbric.amountOutRaw) : null, k = x.kyberswap?.simulatedAmountOutRaw ? BigInt(x.kyberswap.simulatedAmountOutRaw) : null;
  if (h == null || k == null) return false;
  return x.winner === (k > h ? "KyberSwap" : "Holbric");
};
const cmp1 = JSON.parse(await call("compare_quotes", { tokenIn: AMZN, tokenOut: "ETH", amount: "0.05" }));
check(`compare_quotes AMZN -> ETH: Holbric ${cmp1.holbric?.amountOut} vs KyberSwap ${cmp1.kyberswap?.simulatedAmountOut} (simulated), winner ${cmp1.winner} at block ${cmp1.block}`,
  consistent(cmp1) && cmp1.kyberswap.status === "simulated" && /^\d+$/.test(cmp1.block) && cmp1.blockTime && cmp1.kyberswap.router === "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5");
await pause();
const cmp2 = JSON.parse(await call("compare_quotes", { tokenIn: "ETH", tokenOut: "USDG", amount: "0.01" }));
check(`compare_quotes ETH -> USDG: winner ${cmp2.winner} is the larger output`, consistent(cmp2));
await pause();
const qb = JSON.parse(await call("quote_swap", { tokenIn: "USDG", tokenOut: "ETH", amount: "20" }));
check(`quote_swap (best) USDG -> ETH reports KyberSwap next to the native route (best: ${qb.bestVenue})`, qb.kyberswap && (qb.bestVenue === "KyberSwap"
  ? qb.tokenOut.amountOutRaw === qb.kyberswap.simulatedAmountOutRaw && BigInt(qb.holbricNative.amountOutRaw) < BigInt(qb.tokenOut.amountOutRaw)
  : qb.kyberswap.simulatedAmountOutRaw == null || BigInt(qb.kyberswap.simulatedAmountOutRaw) <= BigInt(qb.tokenOut.amountOutRaw)));
await pause();
const fb = JSON.parse(await call("find_route", { tokenIn: "ETH", tokenOut: AMZN, amount: "0.01" }));
check(`find_route (best) ETH -> AMZN: winner ${fb.winner}, every alternative at or below the best`, fb.kyberswap && fb.alternatives.every((a) => BigInt(a.amountOutRaw) <= BigInt(fb.best.amountOutRaw)));
await pause();
const qk = JSON.parse(await call("quote_swap", { tokenIn: "ETH", tokenOut: "USDG", amount: "0.01", venue: "kyber" }));
check("quote_swap venue kyber answers from KyberSwap only", qk.bestVenue === "KyberSwap" && qk.holbricNative?.status === "no route" && BigInt(qk.tokenOut.amountOutRaw) > 0n);
const qn = JSON.parse(await call("quote_swap", { tokenIn: "ETH", tokenOut: "USDG", amount: "0.01", venue: "native" }));
check(`quote_swap venue native does not ask KyberSwap (best: ${qn.bestVenue})`, qn.kyberswap?.status === "not asked" && ["Uniswap v3", "Uniswap v4", "Ramses V3"].includes(qn.bestVenue));
// In-process: the opt-out and the failure fallback. fetch is wrapped to count and, where needed, break KyberSwap requests.
{
  const { bestQuote } = await import("../src/swap.js");
  const { kyberRoute, kyberBuild } = await import("../src/kyber.js");
  const { resolveToken } = await import("../src/chain.js");
  const realFetch = globalThis.fetch;
  let kyberCalls = 0, mode = "count";
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("kyberswap.com")) { kyberCalls++; if (mode === "down") throw new TypeError("fetch failed"); }
    return realFetch(url, init);
  };
  process.env.HOLBRIC_NO_AGGREGATORS = "1";
  const off = await bestQuote({ tokenIn: "ETH", tokenOut: "USDG", amount: "0.01" });
  check("HOLBRIC_NO_AGGREGATORS=1: quote uses native routing and sends nothing to KyberSwap", off.winner === "native" && off.view.kyberswap.status === "off" && kyberCalls === 0);
  let refused = null; try { await bestQuote({ tokenIn: "ETH", tokenOut: "USDG", amount: "0.01", venue: "kyber" }); } catch (e) { refused = e.message; }
  check("HOLBRIC_NO_AGGREGATORS=1: venue kyber refuses", /turned off/.test(refused || "") && kyberCalls === 0);
  delete process.env.HOLBRIC_NO_AGGREGATORS;
  mode = "down";
  const down = await bestQuote({ tokenIn: "ETH", tokenOut: "USDG", amount: "0.01" });
  check(`KyberSwap unreachable: quote falls back to Holbric's route (${down.view.kyberswap.reason})`, down.winner === "native" && down.view.kyberswap.status === "failed" && BigInt(down.view.tokenOut.amountOutRaw) > 0n);
  mode = "count";
  // Calldata checks: a build whose recipient is not the sender, and a route that carries a fee, are refused.
  const [tIn, tOut] = await Promise.all([resolveToken("ETH"), resolveToken("USDG")]);
  const amountIn = 10n ** 16n, sender = "0x1111111111111111111111111111111111111234";
  await pause();
  const route = await kyberRoute({ tIn, tOut, amountIn });
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/route/build")) { const b = JSON.parse(init.body); b.recipient = "0x000000000000000000000000000000000000dEaD"; init = { ...init, body: JSON.stringify(b) }; }
    return realFetch(url, init);
  };
  let bad = null; try { await kyberBuild({ route, tIn, tOut, amountIn, sender, slippageBps: 50, deadline: Math.floor(Date.now() / 1000) + 600 }); } catch (e) { bad = e.message; }
  check(`KyberSwap calldata that pays someone else is refused (${bad})`, /recipient 0x000000000000000000000000000000000000dEaD/i.test(bad || ""));
  globalThis.fetch = async (url, init) => {
    const r = await realFetch(url, init);
    if (!String(url).includes("/routes?")) return r;
    const j = await r.json(); j.data.routeSummary.extraFee = { feeAmount: "10", chargeFeeBy: "currency_out", isInBps: true, feeReceiver: "0x000000000000000000000000000000000000dEaD" };
    return new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });
  };
  await pause();
  let fee = null; try { await kyberRoute({ tIn, tOut, amountIn }); } catch (e) { fee = e.message; }
  check(`a KyberSwap route carrying a fee is refused (${fee})`, /extra fee/.test(fee || ""));
  globalThis.fetch = realFetch;
}

// ---- 0.7.0: Morpho (read-only) and portfolio --------------------------------------------------------------------------
{
  const { getAddress, keccak256, encodeAbiParameters, parseAbi } = await import("viem");
  const { publicClient: pc } = await import("../src/chain.js");
  const { sourcify } = await import("../src/tokeninfo.js");
  const M = await import("../src/morpho.js");
  const c = pc();
  // Real public positions on Robinhood Chain mainnet, found through Morpho's own CreateMarket logs and position reads.
  const SAFE = "0x498752D5fa0600CBd613074C151Abe15B3FeC7CB"; // a Safe borrowing USDG against official stock tokens
  const NVDA_MKT = "0x8b16891f032a93b771347c9cb470a780e6699dd701553d3402aa3cdba6189c3e"; // NVDA collateral / USDG loan, LLTV 62.5%
  const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
  for (const [a, name] of [[M.MORPHO, "Morpho"], [M.ADAPTIVE_IRM, "AdaptiveCurveIrm"], [M.VAULT_V2_FACTORY, "VaultV2Factory"]]) {
    const [code, sf] = await Promise.all([c.getCode({ address: a }), sourcify(a)]);
    check(`${name} ${a} (Morpho's address registry) has code and is verified on Sourcify as ${name} (${sf.match})`, code && code.length > 2 && ["match", "exact_match"].includes(sf.match) && sf.contractName === name);
  }
  const latest = await c.getBlockNumber();
  const markets = await M.allMarkets(latest);
  check(`CreateMarket logs on Morpho Blue give ${markets.length} markets`, markets.length >= 500);
  const P = { type: "tuple", components: [{ name: "loanToken", type: "address" }, { name: "collateralToken", type: "address" }, { name: "oracle", type: "address" }, { name: "irm", type: "address" }, { name: "lltv", type: "uint256" }] };
  const ab = parseAbi(["function idToMarketParams(bytes32) view returns (address,address,address,address,uint256)"]);
  const sample = [markets.find((m) => m.id === NVDA_MKT), markets[1], markets[markets.length - 1]];
  let same = true;
  for (const m of sample) {
    const on = await c.readContract({ address: M.MORPHO, abi: ab, functionName: "idToMarketParams", args: [m.id] });
    const idOk = keccak256(encodeAbiParameters([P], [m.params])) === m.id;
    same &&= idOk && getAddress(on[0]) === getAddress(m.params.loanToken) && getAddress(on[1]) === getAddress(m.params.collateralToken) && getAddress(on[2]) === getAddress(m.params.oracle) && on[4] === m.params.lltv;
  }
  check("logged market params hash to the market id and match idToMarketParams on chain (3 markets)", same);

  const mk = JSON.parse(await call("morpho_markets", { limit: 8 }));
  check(`morpho_markets lists Morpho-app-listed markets read at block ${mk.block} (${mk.matching} of ${mk.marketsOnChain})`, mk.morphoApi.status === "ok" && mk.matching >= 10 && mk.markets.every((x) => x.listedInMorphoApp === true));
  check("morpho_markets: largest market lends USDG (0x5fc5...) and rows are sorted by size", getAddress(mk.markets[0].loanToken.address) === "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" && mk.markets.every((x, i) => i === 0 || (mk.markets[i - 1].approxSupplyUsd ?? -1) >= (x.approxSupplyUsd ?? -1)));
  check("morpho_markets: utilization within 0-100% and supply APY at or below borrow APY", mk.markets.every((x) => x.utilizationPct >= 0 && x.utilizationPct <= 100 && x.supplyApyPct <= x.borrowApyPct + 1e-9));
  {
    const r = await fetch(M.MORPHO_API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: `{ marketById(marketId: "${mk.markets[0].marketId}", chainId: 4663) { state { supplyApy borrowApy } } }` }) }).then((r) => r.json()).catch(() => null);
    const st = r?.data?.marketById?.state;
    check(`supply APY computed on chain (${mk.markets[0].supplyApyPct}%) is within 10% of Morpho's API figure (${st ? (st.supplyApy * 100).toFixed(3) : "n/a"}%)`, st && Math.abs(mk.markets[0].supplyApyPct - st.supplyApy * 100) <= 0.1 * st.supplyApy * 100 + 0.01);
  }
  const mu = JSON.parse(await call("morpho_markets", { includeUnlisted: true, limit: 3 }));
  check(`includeUnlisted shows more markets (${mu.matching} > ${mk.matching})`, mu.matching > mk.matching);
  const mn = JSON.parse(await call("morpho_markets", { collateralToken: NVDA, includeUnlisted: true, limit: 20 }));
  check(`collateralToken filter: ${mn.matching} NVDA-collateral markets, all with NVDA ${NVDA}`, mn.matching >= 1 && mn.markets.every((x) => getAddress(x.collateralToken.address) === NVDA && x.collateralToken.holbric === "official Robinhood Stock Token"));

  const pos = JSON.parse(await call("morpho_position", { address: SAFE }));
  const np = pos.positions.find((p) => p.marketId === NVDA_MKT);
  check(`morpho_position finds the Safe's NVDA/USDG position at block ${pos.block}: borrowed ${np?.borrowed}, collateral ${np?.collateral}, health factor ${np?.healthFactor}`, np && BigInt(np.raw.borrowedAssets) > 0n && BigInt(np.raw.collateral) > 0n && np.healthFactor > 0);
  {
    // Independent check: recompute the health factor from raw position, market and oracle reads at the same block.
    const B = BigInt(pos.block);
    const mAbi = parseAbi(["function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)", "function position(bytes32,address) view returns (uint256,uint128,uint128)"]);
    const [mm, pp, price] = await Promise.all([
      c.readContract({ address: M.MORPHO, abi: mAbi, functionName: "market", args: [NVDA_MKT], blockNumber: B }),
      c.readContract({ address: M.MORPHO, abi: mAbi, functionName: "position", args: [NVDA_MKT, SAFE], blockNumber: B }),
      c.readContract({ address: markets.find((m) => m.id === NVDA_MKT).params.oracle, abi: parseAbi(["function price() view returns (uint256)"]), functionName: "price", blockNumber: B }),
    ]);
    const debtNoAccrual = (pp[1] * (mm[2] + 1n)) / (mm[3] + 10n ** 6n);
    const hf = Number((((pp[2] * price) / 10n ** 36n) * 625000000000000000n / 10n ** 18n) * 10n ** 9n / debtNoAccrual) / 1e9;
    check(`health factor matches raw reads (${hf.toFixed(4)} without accrual vs ${np.healthFactor} with interest to the block)`, Math.abs(hf - np.healthFactor) / hf < 0.001 && np.healthFactor <= hf + 1e-4);
    check(`status matches the health factor (${np.status}); liquidation price ${np.liquidationPrice} is below the oracle price ${np.oraclePrice}`, (np.healthFactor >= 1) === !/LIQUIDATABLE/.test(np.status) && (np.healthFactor < 1 || np.liquidationDropPct > 0));
  }
  const vp = pos.vaultPositions[0];
  if (vp) {
    const onAssets = await c.readContract({ address: vp.vault, abi: parseAbi(["function balanceOf(address) view returns (uint256)", "function convertToAssets(uint256) view returns (uint256)"]), functionName: "convertToAssets",
      args: [await c.readContract({ address: vp.vault, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [SAFE] })] });
    check(`Vault V2 shares: ${vp.shares} ${vp.symbol} = ${vp.assets}, same as convertToAssets on chain (${onAssets})`, vp.assets.startsWith(String(Number(onAssets) / 1e6).split(".")[0]));
  } else check("Vault V2 shares: none held (no vault check)", true);
  const one = JSON.parse(await call("morpho_position", { address: SAFE, marketId: NVDA_MKT }));
  check("morpho_position with marketId reads only that market", one.marketsChecked === 1 && one.positions.length === 1 && one.positions[0].marketId === NVDA_MKT);
  const none = JSON.parse(await call("morpho_position"));
  check("morpho_position on the empty test wallet: no positions, every market checked", none.positions.length === 0 && none.vaultPositions.length === 0 && none.marketsChecked >= 500 && /No Morpho Blue position/.test(none.summary));
  await call("morpho_position", { address: SAFE, marketId: "0x1234" }, /32-byte market id/);
  await call("morpho_position", { address: SAFE, marketId: "0x" + "ab".repeat(32) }, /No Morpho Blue market with id/);

  const vs = JSON.parse(await call("morpho_vaults", { limit: 6 }));
  let allV2 = true;
  for (const v of vs.vaults) allV2 &&= await c.readContract({ address: M.VAULT_V2_FACTORY, abi: parseAbi(["function isVaultV2(address) view returns (bool)"]), functionName: "isVaultV2", args: [v.vault] });
  check(`morpho_vaults: ${vs.vaultsCreated} vaults from the factory, top ${vs.vaults.length} all confirmed by isVaultV2 and sorted by size (largest ${vs.vaults[0]?.name}, ${vs.vaults[0]?.totalAssets})`, vs.vaultsCreated >= 50 && vs.vaults.length > 0 && allV2 && vs.vaults.every((x, i) => i === 0 || vs.vaults[i - 1].approxUsd >= x.approxUsd));
  const vu = JSON.parse(await call("morpho_vaults", { asset: "USDG", limit: 3 }));
  check("morpho_vaults asset filter returns only USDG vaults", vu.vaults.length > 0 && vu.vaults.every((v) => v.asset.symbol === "USDG" && getAddress(v.asset.address) === "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"));

  const pf = JSON.parse(await call("portfolio", { address: SAFE }));
  const sumOk = Math.abs(pf.totals.walletUsd + pf.totals.morphoNetUsd - pf.totals.totalUsd) < 0.05;
  check(`portfolio of the Safe at block ${pf.block}: wallet $${pf.totals.walletUsd} + Morpho net $${pf.totals.morphoNetUsd} = $${pf.totals.totalUsd} (${pf.totals.totalEth} ETH)`, sumOk && pf.totals.complete && pf.holdings.length > 0);
  check("portfolio: stock tokens are recognised and valued, Morpho debt counts as negative", pf.holdings.some((h) => h.holbric === "official Robinhood Stock Token" && h.valueUsd > 0) && pf.morpho.lines.some((l) => /debt/.test(l.position) && l.valueUsd < 0));
  check("portfolio: sell-everything-now total is at or below the quoted total, and PnL is declared not included", pf.totals.totalIfSoldNowUsd <= pf.totals.totalUsd + 1 && /PnL is not included/.test(pf.pnl));
  check(`portfolio: checked ${pf.discovery.checked.split(":")[0]} plus Transfer logs (${pf.discovery.transferLogs.requests} requests, 0 failed)`, pf.discovery.transferLogs.failedRequests === 0 && /203|2\d\d official Robinhood Stock Tokens/.test(pf.discovery.checked));
  const pe = JSON.parse(await call("portfolio", { lookbackHours: 1 }));
  check("portfolio of the empty test wallet is $0 and complete", pe.totals.totalUsd === 0 && pe.totals.complete && pe.holdings.length === 0);
  await call("portfolio", { address: SAFE, lookbackHours: 100 }, /72|lookbackHours|too_big|less than or equal/i);
  // A Pons V2 token still on its curve, valued on the curve: the launch's own curve holds its token.
  let curveCase = null;
  {
    const rec = JSON.parse(await call("pons_recent_launches", { hours: 48, limit: 30 }));
    for (const l of rec.launches) {
      const st = JSON.parse((await client.callTool({ name: "pons_token", arguments: { token: l.token } })).content[0].text);
      if (st.status === "bonding curve" && st.progressPct >= 1) { curveCase = l; break; } // a curve with real buys, so a sell quote exists
    }
    if (curveCase) {
      const pp = JSON.parse(await call("portfolio", { address: curveCase.curve, tokens: [curveCase.token], lookbackHours: 0, includeMorpho: false }));
      const h = pp.holdings.find((x) => getAddress(x.token) === getAddress(curveCase.token));
      check(`portfolio values a named Pons V2 token on its curve (${curveCase.symbol}, held by its curve ${curveCase.curve}): ${h ? `${h.amount} at $${h.priceUsd} via ${h.priceFrom}` : "not held"}`, h && h.holbric === "Pons V2 launch" && h.priceUsd > 0 && /Pons V2 bonding curve/.test(h.priceFrom));
    } else check("no Pons launch on its curve with 1% progress in the last 48 h (curve valuation not exercised)", true);
  }
  // pons_quote without a Holbric wallet uses a probe address (0.6.0 had it mis-checksummed, so this failed).
  {
    const { ponsQuote } = await import("../src/pons.js");
    const ks = await import("../src/keystore.js");
    const saved = process.env.HOLBRIC_HOME; process.env.HOLBRIC_HOME = mkdtempSync(join(tmpdir(), "holbric-nowallet-"));
    const tok = curveCase?.token;
    let msg = "ok"; if (tok) { try { await ponsQuote({ token: tok, side: "buy", amount: "0.001" }); } catch (e) { msg = e.message; } }
    const noWallet = ks.walletAddress() === null;
    process.env.HOLBRIC_HOME = saved;
    check(`pons_quote on a curve works with no Holbric wallet (probe address): ${tok ? msg.slice(0, 80) : "no curve launch found, not exercised"}`, noWallet && msg === "ok");
  }
  // In-process: what portfolio and morpho_position send off-chain, and the Morpho API being down.
  {
    const { portfolio } = await import("../src/portfolio.js");
    const realFetch = globalThis.fetch;
    const hosts = []; let down = false;
    globalThis.fetch = async (url, init) => { const h = new URL(String(url)).host; hosts.push(h); if (down && h === "api.morpho.org") throw new TypeError("fetch failed"); return realFetch(url, init); };
    await portfolio({ address: SAFE, lookbackHours: 1 });
    const rpcHost = new URL((await import("../src/chain.js")).rpcUrl()).host;
    const offChain = [...new Set(hosts)].filter((h) => h !== "api.robinhood.com" && h !== rpcHost);
    check(`portfolio asks no price feed or aggregator: hosts other than the RPC and Robinhood's token list = [${offChain.join(", ")}]`, offChain.length === 0 && hosts.includes(rpcHost));
    hosts.length = 0;
    await M.morphoPosition({ address: SAFE, marketId: NVDA_MKT });
    check("morpho_position reads only the chain (no API call)", hosts.filter((h) => h === "api.morpho.org").length === 0);
    down = true;
    await new Promise((r) => setTimeout(r, 10)); // cache is per process; force a fresh API read by importing a fresh copy
    const fresh = await import("../src/morpho.js?down=" + Date.now());
    const md = await fresh.morphoMarkets({ limit: 5 });
    check(`Morpho API down: morpho_markets still answers from chain, known tokens only (${md.matching} markets; ${md.morphoApi.status})`, md.morphoApi.status === "unavailable" && md.matching > 0 && md.markets.every((x) => x.loanToken.holbric !== "not in Holbric's lists" && x.collateralToken.holbric !== "not in Holbric's lists"));
    globalThis.fetch = realFetch;
  }
}
// ---- Relay bridging (0.8.0). Read-only quotes and status over MCP, plus in-process checks of the order verification.
{
  const DEPO = "0x4cD00E387622C35bDDB9b4c962C136462338BC31";
  const { publicClient } = await import("../src/chain.js");
  const code = await publicClient().getCode({ address: DEPO });
  check(`RelayDepository ${DEPO} has code on chain 4663 (${(code?.length - 2) / 2} bytes)`, !!code && code.length > 2);
  const sf = await (await fetch(`https://sourcify.dev/server/v2/contract/4663/${DEPO}?fields=compilation`)).json();
  check(`RelayDepository is an exact match on Sourcify as ${sf.compilation?.name}`, sf.match === "exact_match" && sf.compilation?.name === "RelayDepository");
  const { chains } = await (await fetch("https://api.relay.link/chains")).json();
  const rh = chains.find((x) => x.id === 4663);
  check(`Relay /chains lists Robinhood Chain 4663 (protocol id ${rh?.protocol?.v2?.chainId}, depository ${rh?.protocol?.v2?.depository}, ETH + USDG)`,
    rh && !rh.disabled && rh.depositEnabled && rh.vmType === "evm" && rh.protocol.v2.chainId === "robinhood" && rh.protocol.v2.depository.toLowerCase() === DEPO.toLowerCase()
    && rh.solverCurrencies.some((t) => t.symbol === "ETH") && rh.solverCurrencies.some((t) => t.symbol === "USDG"));
  const cs = JSON.parse(await call("chain_status"));
  check("chain_status shows the Relay switch", /^Relay on/.test(cs.bridges));
  const q1 = JSON.parse(await call("bridge_quote", { toChain: "base", token: "ETH", amount: "0.01" }));
  check(`bridge_quote 0.01 ETH Robinhood Chain -> Base: order verified, expected ${q1.expectedOut}, min ${q1.minimumOut}, ${q1.timeEstimateSeconds} s, block ${q1.robinhoodBlock}`,
    q1.orderCheck.passed && BigInt(q1.expectedOutRaw) > BigInt(q1.minimumOutRaw) && BigInt(q1.minimumOutRaw) >= (BigInt(q1.expectedOutRaw) * 9950n) / 10000n
    && BigInt(q1.expectedOutRaw) < 10n ** 16n && q1.fees.holbric === "none" && q1.fees.app.usd === 0 && /^Yes/.test(q1.canPrepare));
  const q2 = JSON.parse(await call("bridge_quote", { toChain: "ethereum", token: "USDG", amount: "100" }));
  check(`bridge_quote 100 USDG -> Ethereum defaults to USDG there (${q2.expectedOut})`, q2.orderCheck.passed && /USDG$/.test(q2.expectedOut) && /Ethereum \(1\)/.test(q2.to));
  const q3 = JSON.parse(await call("bridge_quote", { toChain: 42161, token: "USDG", amount: "100" }));
  check(`bridge_quote 100 USDG -> Arbitrum One defaults to USDC (${q3.expectedOut})`, q3.orderCheck.passed && /USDC$/.test(q3.expectedOut));
  const q4 = JSON.parse(await call("bridge_quote", { fromChain: "base", toChain: "robinhood", token: "ETH", amount: "0.01" }));
  check(`bridge_quote Base -> Robinhood Chain is quote-only (${q4.expectedOut})`, q4.orderCheck.passed && /^No\./.test(q4.canPrepare) && /Robinhood Chain \(4663\)/.test(q4.to));
  await call("bridge_quote", { toChain: "solana", token: "ETH", amount: "0.01" }, /Unsupported chain/);
  await call("bridge_quote", { fromChain: "base", toChain: "arbitrum", amount: "0.01" }, /One side must be Robinhood Chain/);
  await call("bridge_quote", { toChain: "base", token: "ETH", toToken: "USDC", amount: "0.01" }, /ETH to ETH and stablecoins to stablecoins/);
  await call("prepare_bridge", { toChain: "base", token: "ETH", amount: "0.001" }, /not enough for the network fee/);
  await call("prepare_bridge", { toChain: "robinhood", token: "ETH", amount: "0.001" }, /same chain/);

  // bridge_status. Relay's request lookup is GET /requests/v3 (v2 is retired on 24 Nov 2026), which needs an API key.
  // With RELAY_API_KEY set: the most recent finished request out of Robinhood Chain to one of Holbric's chains, by hash and by id.
  // Without it: a real finished request (USDG on Robinhood Chain -> USDC on Base, from Relay's public request listing on
  // 18 Nov 2026), followed by id through GET /intents/status/v3 (no key), and its deposit hash read on chain.
  const KNOWN = { id: "0x17949844303a8d49384c8b1ee8af9aba3f4d66d45e071f9e37981e930a612434", deposit: "0x5c14ff5db1be8dd062fcc4877fbcc87679d944da959e000387360b77d0266949",
    fill: "0xec400d7e3c7fdff256be764de05a4263675fdc7da1f6a6915aa92fa89eaede27", amountInRaw: "162360000", block: "117208330" };
  if (process.env.RELAY_API_KEY) {
    const list = await (await fetch("https://api.relay.link/requests/v3?originChainId=4663&status=success&limit=50", { headers: { "x-api-key": process.env.RELAY_API_KEY } })).json();
    const inOf = (r) => r.data?.route?.actual?.origin?.inputCurrency || r.data?.route?.quoted?.origin?.inputCurrency;
    const outOf = (r) => r.data?.route?.actual?.destination?.outputCurrency || r.data?.route?.quoted?.destination?.outputCurrency;
    const recent = (list.requests || []).find((r) => r.status === "success" && [1, 8453, 42161, 10, 130].includes(outOf(r)?.currency?.chainId)
      && ["ETH", "USDG"].includes(inOf(r)?.currency?.symbol) && r.data?.inTxs?.[0]?.chainId === 4663);
    check(`Relay /requests/v3 with RELAY_API_KEY lists a finished request out of Robinhood Chain (${recent?.id?.slice(0, 12)}...)`, !!recent);
    if (recent) {
      const byHash = JSON.parse(await call("bridge_status", { txHash: recent.data.inTxs[0].txHash }));
      const byId = JSON.parse(await call("bridge_status", { requestId: recent.id }));
      const dep = byHash.onChainDeposit;
      check(`bridge_status by hash and by id agree (${byHash.requestId?.slice(0, 12)}..., ${byHash.status}, ${byHash.from?.amount} -> ${byHash.to?.amount} on ${byHash.to?.chain})`,
        byHash.requestId === recent.id && byId.requestId === recent.id && byHash.status === "success" && byHash.outTxs.length > 0 && !!byHash.from && !!byHash.to);
      check(`bridge_status reads the deposit on chain: RelayDepository event at block ${dep?.block}, ${dep?.amount}`,
        dep?.found && dep.status === "success" && dep.depositor.toLowerCase() === (recent.user || "").toLowerCase() && BigInt(dep.amountRaw) === BigInt(inOf(recent).amount));
    }
  } else {
    const byId = JSON.parse(await call("bridge_status", { requestId: KNOWN.id }));
    const dep = byId.onChainDeposit;
    check(`bridge_status by id without a Relay key (GET /intents/status/v3): ${byId.status}, ${byId.fromChain} -> ${byId.toChain}, fill ${byId.outTxs?.[0]?.hash?.slice(0, 12)}...`,
      byId.status === "success" && /\(4663\)/.test(byId.fromChain) && /Base \(8453\)/.test(byId.toChain)
      && byId.inTxs?.[0]?.hash === KNOWN.deposit && byId.outTxs?.[0]?.hash === KNOWN.fill && /RELAY_API_KEY/.test(byId.note));
    check(`bridge_status reads the deposit on chain: RelayDepository event at block ${dep?.block}, ${dep?.amount}`,
      dep?.found && dep.status === "success" && dep.block === KNOWN.block && dep.amountRaw === KNOWN.amountInRaw);
    const byHash = JSON.parse(await call("bridge_status", { txHash: KNOWN.deposit }));
    check(`bridge_status by hash without a Relay key reads the deposit on chain and says the key is needed (${byHash.onChainDeposit?.amount})`,
      byHash.onChainDeposit?.found && byHash.onChainDeposit.orderId === dep?.orderId && /RELAY_API_KEY/.test(byHash.note) && /dashboard\.relay\.link/.test(byHash.note));
  }
  const unknown = JSON.parse(await call("bridge_status", { requestId: "0x" + "ab".repeat(32) }));
  check(`bridge_status on an unknown id says so (${unknown.status})`, unknown.status === "waiting" || unknown.status === "unknown");
  await call("bridge_status", { txHash: "0x1234" }, /32-byte hex/);

  // In-process: the order checks catch a tampered order even when the order id is recomputed to match it.
  const R = await import("../src/relay.js");
  const U = "0x000000000000000000000000000000000000dEaD", W = "0x1111111111111111111111111111111111111111";
  const body = { user: U, recipient: U, refundTo: U, originChainId: 4663, destinationChainId: 8453, originCurrency: "0x0000000000000000000000000000000000000000",
    destinationCurrency: "0x0000000000000000000000000000000000000000", amount: "10000000000000000", tradeType: "EXACT_INPUT", includeProtocolData: true, slippageTolerance: "50" };
  const real = await (await fetch("https://api.relay.link/quote/v2", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const want = { from: { chain: R.resolveChain(4663), token: { address: "0x0000000000000000000000000000000000000000" } }, to: { chain: R.resolveChain(8453), token: { address: "0x0000000000000000000000000000000000000000" } },
    amountIn: 10n ** 16n, recipient: U, refundTo: U, slippageBps: 50, minDeadline: Math.floor(Date.now() / 1000) + 60 };
  check(`order id recomputed locally equals Relay's (${real.protocol.v2.orderId.slice(0, 18)}...)`, R.orderId(real.protocol.v2.orderData) === real.protocol.v2.orderId && R.checkOrder(real, want).length === 0);
  const tamper = (fn, rehash = true) => { const t = structuredClone(real); fn(t.protocol.v2.orderData, t); if (rehash) t.protocol.v2.orderId = R.orderId(t.protocol.v2.orderData); return R.checkOrder(t, want); };
  const cases = [
    ["order id that does not match the order data", (o) => { o.salt = "1"; }, /not the hash of its order data/, false],
    ["output paid to another address", (o) => { o.output.payments[0].recipient = W; }, /output goes to/],
    ["an origin-chain refund paid to another address", (o) => { o.inputs[0].refunds.find((r) => r.chainId === "robinhood").recipient = W; }, /refund on robinhood goes to/],
    ["a destination-chain refund paid to a third address", (o) => { o.inputs[0].refunds.find((r) => r.chainId === "base").recipient = W; }, /refund on base goes to/],
    ["a fee to a third party", (o) => { o.fees.push({ recipientChainId: "base", recipient: W, currencyChainId: "base", currency: "0x0000000000000000000000000000000000000000", amount: "1000" }); }, /fees to a third party/],
    ["a destination call", (o) => { o.output.calls.push("0x1234"); }, /destination call/],
    ["a minimum 1% under the expected output", (o) => { o.output.payments[0].minimumAmount = ((BigInt(o.output.payments[0].expectedAmount) * 99n) / 100n).toString(); }, /guaranteed minimum/],
    ["a bigger payment than asked", (o) => { o.inputs[0].payment.amount = "20000000000000000"; }, /payment is/],
    ["another depository", (o, t) => { t.protocol.v2.paymentDetails.depository = W; }, /names depository/],
    ["an expired deadline", (o) => { o.output.deadline = Math.floor(Date.now() / 1000) - 10; }, /deadline/],
  ];
  for (const [label, fn, re, rehash] of cases) { const p = tamper(fn, rehash !== false); check(`order check refuses ${label}: ${p[0] || "nothing flagged"}`, p.some((x) => re.test(x))); }

  // In-process: RELAY_API_KEY is sent as x-api-key only when set, only to api.relay.link, and the v3 response is read
  // (route amounts, txHash). Only GET /requests/v3 is answered locally, in the documented v3 shape with the values of the
  // real request above; GET /intents/status/v3 and the deposit receipt are read live.
  {
    const realFetch0 = globalThis.fetch; const seen = []; const savedKey = process.env.RELAY_API_KEY;
    const cur = (chainId, symbol, amount, amountFormatted) => ({ currency: { chainId, symbol, decimals: 6 }, amount, amountFormatted });
    const v3 = { requests: [{ id: KNOWN.id, status: "success", createdAt: "2026-11-18T06:47:17.603Z", updatedAt: "2026-11-18T06:47:48.044Z",
      data: { failReason: null, refundFailReason: null,
        inTxs: [{ txHash: KNOWN.deposit, chainId: 4663, block: Number(KNOWN.block) }], outTxs: [{ txHash: KNOWN.fill, chainId: 8453 }],
        route: { actual: { origin: { inputCurrency: cur(4663, "USDG", KNOWN.amountInRaw, "162.36") }, destination: { outputCurrency: cur(8453, "USDC", "161866170", "161.86617") } } } } }] };
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(String(url)); const h = new Headers(init.headers || {});
      seen.push({ host: u.host, path: u.pathname, key: h.get("x-api-key") });
      if (u.host === "api.relay.link" && u.pathname === "/requests/v3") return new Response(JSON.stringify(v3), { status: 200, headers: { "content-type": "application/json" } });
      return realFetch0(url, init);
    };
    try {
      process.env.RELAY_API_KEY = "holbric-test-key";
      const r = await R.bridgeStatus({ txHash: KNOWN.deposit });
      const relayCalls = seen.filter((x) => x.host === "api.relay.link");
      check(`with RELAY_API_KEY: x-api-key goes to api.relay.link only, and /requests/v3 is asked by term (${relayCalls.map((x) => x.path).join(", ")})`,
        relayCalls.some((x) => x.path === "/requests/v3") && relayCalls.every((x) => x.key === "holbric-test-key") && seen.filter((x) => x.host !== "api.relay.link").every((x) => !x.key));
      check(`v3 response read: ${r.from?.amount} on ${r.from?.chain} -> ${r.to?.amount} on ${r.to?.chain}, status ${r.status}, deposit ${r.onChainDeposit?.amount}`,
        r.requestId === KNOWN.id && r.from?.amount === "162.36 USDG" && r.to?.amount === "161.86617 USDC" && /Base \(8453\)/.test(r.to.chain)
        && r.inTxs[0].hash === KNOWN.deposit && r.outTxs[0].hash === KNOWN.fill && r.status === "success" && r.onChainDeposit?.amountRaw === KNOWN.amountInRaw && !r.failReason);
      delete process.env.RELAY_API_KEY; seen.length = 0;
      await R.bridgeStatus({ requestId: KNOWN.id });
      check("without RELAY_API_KEY: no x-api-key header is sent and /requests/v3 is not asked", seen.every((x) => !x.key) && !seen.some((x) => x.path === "/requests/v3"));
    } finally { globalThis.fetch = realFetch0; if (savedKey) process.env.RELAY_API_KEY = savedKey; else delete process.env.RELAY_API_KEY; }
  }

  // Privacy and the opt-out, in-process.
  const realFetch = globalThis.fetch; const sent = [];
  globalThis.fetch = async (url, init) => { sent.push({ host: new URL(String(url)).host, body: init?.body || "" }); return realFetch(url, init); };
  const wallet = (await import("../src/keystore.js")).walletAddress();
  await R.bridgeQuote({ toChain: "base", token: "ETH", amount: "0.01" });
  check("bridge_quote does not send the wallet address to Relay", sent.some((x) => x.host === "api.relay.link") && !sent.some((x) => x.body.toLowerCase().includes(wallet.slice(2).toLowerCase())));
  sent.length = 0; process.env.HOLBRIC_NO_BRIDGES = "1";
  let msg = ""; try { await R.bridgeQuote({ toChain: "base", token: "ETH", amount: "0.01" }); } catch (e) { msg = e.message; }
  let msg2 = ""; try { await R.bridgeStatus({ requestId: "0x" + "ab".repeat(32) }); } catch (e) { msg2 = e.message; }
  delete process.env.HOLBRIC_NO_BRIDGES;
  check("HOLBRIC_NO_BRIDGES=1: bridge tools refuse and nothing reaches Relay", /turned off/.test(msg) && /turned off/.test(msg2) && !sent.some((x) => x.host === "api.relay.link"));
  const { loadConfig, saveConfig } = await import("../src/config.js");
  saveConfig({ ...loadConfig(), bridges: false }); sent.length = 0; msg = "";
  try { await R.bridgeQuote({ toChain: "base", token: "ETH", amount: "0.01" }); } catch (e) { msg = e.message; }
  saveConfig({ ...loadConfig(), bridges: true });
  check("`holbric bridges off` (config) refuses the same way", /holbric bridges off/.test(msg) && !sent.some((x) => x.host === "api.relay.link"));
  globalThis.fetch = async (url, init) => { if (new URL(String(url)).host === "api.relay.link") throw new TypeError("fetch failed"); return realFetch(url, init); };
  R._resetChainsCache(); msg = "";
  try { await R.bridgeQuote({ toChain: "base", token: "ETH", amount: "0.01" }); } catch (e) { msg = e.message; }
  globalThis.fetch = realFetch;
  check(`Relay API down: bridge_quote says so (${msg})`, /Relay API unreachable/.test(msg));
}
// ---- 0.10.0: contracts behind the new writes ----------------------------------------------------------------------------
{
  const { getAddress, parseAbi } = await import("viem");
  const { publicClient: pc, ADDR } = await import("../src/chain.js");
  const { sourcify } = await import("../src/tokeninfo.js");
  const c = pc();
  const SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"; // EIP-1967 implementation slot
  for (const [proxy, name] of [[ADDR.ERC8004_REPUTATION, "ReputationRegistryUpgradeable"], [ADDR.ERC8004_IDENTITY, "IdentityRegistryUpgradeable"]]) {
    const impl = getAddress("0x" + (await c.getStorageAt({ address: proxy, slot: SLOT })).slice(26));
    const sf = await sourcify(impl);
    check(`ERC-8004 proxy ${proxy} points to ${impl}, verified on Sourcify as ${sf.contractName} (${sf.match})`, sf.match === "exact_match" && sf.contractName === name);
  }
  const idReg = await c.readContract({ address: ADDR.ERC8004_REPUTATION, abi: parseAbi(["function getIdentityRegistry() view returns (address)"]), functionName: "getIdentityRegistry" });
  check("the reputation registry's identity registry is the one Holbric uses", getAddress(idReg) === ADDR.ERC8004_IDENTITY);
  const M = await import("../src/morpho.js");
  const sm = await sourcify(M.MORPHO);
  check(`Morpho Blue ${M.MORPHO}, the only contract the Morpho writes call, is verified on Sourcify as Morpho (${sm.match})`, ["match", "exact_match"].includes(sm.match) && sm.contractName === "Morpho");
}
// ---- spend history (after 0.10.0, unreleased): local record, read over MCP ---------------------------------------------
{
  const { appendFileSync } = await import("node:fs");
  const { publicClient: pc } = await import("../src/chain.js");
  const H = await import("../src/history.js");
  const empty = JSON.parse(await call("spend_history"));
  check("spend_history on a new wallet: no actions, and it says what the record does not cover", empty.totals.actions === 0 && empty.entries.length === 0 && empty.notes.some((n) => /Earlier actions/.test(n)));
  // A real public transaction stands in for one Holbric signed: its receipt gives a real network fee. Nothing is sent.
  const c = pc(); let rc = null;
  for (let b = await c.getBlockNumber(), i = 0; !rc && i < 40; i++, b--) {
    const blk = await c.getBlock({ blockNumber: b });
    for (const h of blk.transactions.slice(-3)) { const r = await c.getTransactionReceipt({ hash: h }); if (r.gasUsed > 0n && r.status === "success") { rc = r; break; } }
  }
  check(`found a recent public transaction with a fee (${rc?.transactionHash})`, !!rc);
  const fee = rc.gasUsed * rc.effectiveGasPrice;
  const p = { id: "hp_live", kind: "send", from: rc.from, usd: 1.234, txs: [{ label: "public tx" }] };
  const out = { transactions: [{ step: "public tx", hash: rc.transactionHash, status: "success", block: rc.blockNumber.toString() }], result: "Confirmed on Robinhood Chain mainnet." };
  const e = H.historyEntry(p, out, [rc], new Date("2026-11-18T05:00:00Z"));
  appendFileSync(join(home, "history.jsonl"), JSON.stringify(e) + "\n{not json\n");
  const h = JSON.parse(await call("spend_history"));
  check(`spend_history reads it back over MCP: fee ${h.totals.networkFeeEth} ETH = gasUsed x effectiveGasPrice from the receipt`, h.totals.actions === 1 && h.entries[0].networkFeeWei === fee.toString() && h.entries[0].steps[0].explorer.endsWith(rc.transactionHash));
  check("spend_history labels the USD figure as an estimate and counts the unreadable line", h.totals.usdEstimate === 1.23 && h.notes.some((n) => /not a price at the time/.test(n)) && h.notes.some((n) => /1 line\(s\) .* could not be read/.test(n)));
  const csv = JSON.parse(await call("spend_history", { format: "csv" })).csv.trim().split("\n");
  check("spend_history as CSV: header and one row with the hash", csv.length === 2 && csv[0].startsWith("time,date,kind,result,usdEstimate,networkFeeEth,txHashes") && csv[1].includes(rc.transactionHash));
  const later = JSON.parse(await call("spend_history", { from: "2099-01-01" }));
  const other = JSON.parse(await call("spend_history", { kind: "swap" }));
  check("spend_history filters by day and by kind", later.totals.actions === 0 && other.totals.actions === 0);
  await call("spend_history", { from: "18/11/2026" }, /YYYY-MM-DD/);
  await call("spend_history", { from: "2026-11-19", to: "2026-11-18" }, /from is after to/);
  const realFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (...a) => { calls++; return realFetch(...a); };
  H.spendHistory({ format: "csv" });
  globalThis.fetch = realFetch;
  check("spend_history makes no network call", calls === 0);
}
// ---- Ramses V3 (after 0.10.0, unreleased): addresses as published by Ramses for Robinhood, checked on chain ------------
{
  const { getAddress, parseAbi } = await import("viem");
  const { publicClient: pc, ADDR } = await import("../src/chain.js");
  const { sourcify } = await import("../src/tokeninfo.js");
  const R = await import("../src/ramses.js");
  const c = pc();
  for (const [a, name] of [[R.RAMSES.FACTORY, "RamsesV3Factory"], [R.RAMSES.POOL_DEPLOYER, "RamsesV3PoolDeployer"], [R.RAMSES.SWAP_ROUTER, "SwapRouter"], [R.RAMSES.QUOTER_V2, "QuoterV2"]]) {
    const code = await c.getCode({ address: a });
    const sf = await sourcify(a);
    check(`Ramses ${name} ${a} has code and is verified on Sourcify (${sf.match} ${sf.contractName})`, code && code.length > 2 && ["match", "exact_match"].includes(sf.match) && sf.contractName === name);
  }
  const dep = await c.readContract({ address: R.RAMSES.FACTORY, abi: R.factoryAbi, functionName: "ramsesV3PoolDeployer" });
  const rDep = await c.readContract({ address: R.RAMSES.SWAP_ROUTER, abi: R.routerAbi, functionName: "deployer" });
  const qDep = await c.readContract({ address: R.RAMSES.QUOTER_V2, abi: R.routerAbi, functionName: "deployer" });
  check("Ramses factory, SwapRouter and QuoterV2 all point at the same pool deployer", getAddress(dep) === R.RAMSES.POOL_DEPLOYER && getAddress(rDep) === R.RAMSES.POOL_DEPLOYER && getAddress(qDep) === R.RAMSES.POOL_DEPLOYER);
  const [rWeth, qWeth] = await Promise.all([R.RAMSES.SWAP_ROUTER, R.RAMSES.QUOTER_V2].map((a) => c.readContract({ address: a, abi: R.routerAbi, functionName: "WETH9" })));
  check("Ramses SwapRouter and QuoterV2 use Holbric's WETH", getAddress(rWeth) === ADDR.WETH && getAddress(qWeth) === ADDR.WETH);
  const probe = [1, 5, 10, 20, 50, 60, 100, 200, 500, 1000, 2000];
  const enabled = [];
  for (const ts of probe) if ((await c.readContract({ address: R.RAMSES.FACTORY, abi: R.factoryAbi, functionName: "tickSpacingInitialFee", args: [ts] })) > 0) enabled.push(ts);
  check(`enabled Ramses tick spacings match Holbric's list (${enabled.join(", ")})`, enabled.join() === R.TICK_SPACINGS.join());
  const pools = await R.ramsesLivePools(ADDR.WETH, ADDR.USDG);
  check(`Ramses has live WETH/USDG pools (${pools.map((p) => `ts ${p.tickSpacing} fee ${p.fee / 10000}%`).join(", ")})`, pools.length >= 1);
  const p0 = pools[0];
  const [pf, pts] = await Promise.all([c.readContract({ address: p0.pool, abi: R.poolAbi, functionName: "factory" }), c.readContract({ address: p0.pool, abi: R.poolAbi, functionName: "tickSpacing" })]);
  check("that pool's factory() is the Ramses factory and its tickSpacing() matches", getAddress(pf) === R.RAMSES.FACTORY && Number(pts) === p0.tickSpacing);
  // Holbric's quote against an independent single-pool quote on the same pool.
  const single = [{ type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable", inputs: [{ name: "params", type: "tuple", components: [{ name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "tickSpacing", type: "int24" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }], outputs: [{ name: "amountOut", type: "uint256" }, { name: "sqrtPriceX96After", type: "uint160" }, { name: "initializedTicksCrossed", type: "uint32" }, { name: "gasEstimate", type: "uint256" }] }];
  const rq = JSON.parse(await call("quote_swap", { tokenIn: "WETH", tokenOut: "USDG", amount: "0.02", venue: "ramses" }));
  check(`quote_swap venue ramses: ${rq.route} = ${rq.tokenOut.amountOut} USDG`, rq.bestVenue === "Ramses V3" && /Ramses/.test(rq.route) && rq.compared.ramsesRoutes >= 1 && rq.compared.v3Routes === 0);
  {
    // Path encoding: Holbric's path through quoteExactInput must equal quoteExactInputSingle on the same pool at one block.
    const multi = [{ type: "function", name: "quoteExactInput", stateMutability: "nonpayable", inputs: [{ name: "path", type: "bytes" }, { name: "amountIn", type: "uint256" }], outputs: [{ name: "amountOut", type: "uint256" }, { name: "a", type: "uint160[]" }, { name: "b", type: "uint32[]" }, { name: "g", type: "uint256" }] }];
    const B = await c.getBlockNumber(), amt = 20000000000000000n, ts = p0.tickSpacing;
    const [{ result: s1 }, { result: m1 }] = await Promise.all([
      c.simulateContract({ address: R.RAMSES.QUOTER_V2, abi: single, functionName: "quoteExactInputSingle", args: [{ tokenIn: ADDR.WETH, tokenOut: ADDR.USDG, amountIn: amt, tickSpacing: ts, sqrtPriceLimitX96: 0n }], blockNumber: B }),
      c.simulateContract({ address: R.RAMSES.QUOTER_V2, abi: multi, functionName: "quoteExactInput", args: [R.encodeRamsesPath([ADDR.WETH, ADDR.USDG], [ts]), amt], blockNumber: B }),
    ]);
    check(`Holbric's Ramses path quotes exactly like quoteExactInputSingle at block ${B} (${s1[0]})`, s1[0] === m1[0] && s1[0] > 0n);
    const viaMcp = BigInt(rq.tokenOut.amountOutRaw), ref = s1[0] > viaMcp ? s1[0] : viaMcp, gap = Number(((ref - (s1[0] < viaMcp ? s1[0] : viaMcp)) * 1000000n) / ref) / 10000;
    check(`quote_swap's Ramses figure is within 0.5% of that reference a few blocks apart (${gap}%)`, rq.tickSpacings[0] !== ts || gap <= 0.5);
  }
  const bq = JSON.parse(await call("quote_swap", { tokenIn: "ETH", tokenOut: "USDG", amount: "0.02", venue: "native" }));
  check(`venue native compares Uniswap v3, v4 and Ramses V3 (${bq.compared.v3Routes} + ${bq.compared.v4Routes} + ${bq.compared.ramsesRoutes} routes, best ${bq.bestVenue})`, bq.compared.v3Routes > 0 && bq.compared.v4Routes > 0 && bq.compared.ramsesRoutes > 0);
  const rp = JSON.parse(await call("ramses_pools", { tokenA: "WETH", tokenB: "USDG" }));
  check(`ramses_pools lists WETH/USDG pools with fee, tick spacing and price (${rp.pools.length})`, rp.pools.some((p) => p.inRange && p.price && p.feePct > 0));
  check("Ramses path encoding is token + 3-byte tick spacing + token", R.encodeRamsesPath([ADDR.WETH, ADDR.USDG], [5]).toLowerCase() === ("0x" + ADDR.WETH.slice(2) + "000005" + ADDR.USDG.slice(2)).toLowerCase());
}
await client.close();
console.log(`\n${pass} passed, ${fail} failed. Nothing was signed or sent.`);
process.exit(fail ? 1 : 0);
