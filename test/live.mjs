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
check(`tool count is 24 (got ${tools.tools.length})`, tools.tools.length === 24);
const HOLBRIC = "0xE8D6AE09757769968d17eab44998A03E196217e7";
await call("wallet_address");
await call("chain_status");
await call("get_balances", { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" });
await call("token_info", { token: HOLBRIC });
await call("token_info", { token: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" });
await call("quote_swap", { tokenIn: "USDG", tokenOut: "WETH", amount: "5" });
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
await call("prepare_send", { to: "0x000000000000000000000000000000000000dEaD", token: "ETH", amount: "0.001" }, EMPTY);
await call("prepare_wrap_eth", { amount: "0.001" }, EMPTY);
await call("prepare_unwrap_weth", { amount: "0.001" }, EMPTY);
await call("prepare_pons_trade", { token: HOLBRIC, side: "buy", amount: "0.001" }, EMPTY);
await call("prepare_pons_claim", { asset: "ETH" }, EMPTY);
await call("prepare_pons_sweep", { token: HOLBRIC }, EMPTY);
await call("prepare_register_agent", { agentURI: "https://holbric.com/agent.json" }, EMPTY);
await call("execute_prepared", { prepareId: "hp_doesnotexist", confirm: true }, /Unknown or expired prepareId/);
await client.close();
console.log(`\n${pass} passed, ${fail} failed. Nothing was signed or sent.`);
process.exit(fail ? 1 : 0);
