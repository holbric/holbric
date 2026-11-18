#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const pos = rest.filter((a) => !a.startsWith("--"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const HELP = `holbric ${pkg.version} - one MCP connection to Robinhood Chain mainnet projects (chain id 4663)

  holbric mcp                       Run the MCP server on stdio (your host starts this)
  holbric init [--import]           Create (or import) the encrypted wallet in ~/.holbric. Terminal only.
  holbric unlock | lock             Store or remove the passphrase file the server uses to sign
  holbric address                   Print the wallet address
  holbric connect <cursor|claude|codex|gemini|windsurf|vscode> [--global] [--print]
  holbric tools                     List every tool, grouped by project
  holbric limit <usd|off>           Set or clear the daily USD spend limit for swaps
  holbric aggregators <on|off>      Compare with KyberSwap (third-party API, on by default) or use only Holbric's own routing
  holbric bridges <on|off>          Relay bridge tools (third-party API, on by default); off sends nothing to Relay
  holbric export                    Show the private key in this terminal. Terminal only.
  holbric --version`;

function requireTTY(what) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`holbric ${what} must be run by you in an interactive terminal, not through an agent.`);
    process.exit(2);
  }
}

function ask(q, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(q);
    let buf = "";
    stdin.setRawMode?.(true); stdin.resume(); stdin.setEncoding("utf8");
    const onData = (ch) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") { stdin.setRawMode?.(false); stdin.pause(); stdin.off("data", onData); process.stdout.write("\n"); return resolve(buf); }
        if (c === "\u0003") { process.stdout.write("\n"); process.exit(130); }
        if (c === "\u007f" || c === "\b") { if (buf.length) { buf = buf.slice(0, -1); if (!hidden) process.stdout.write("\b \b"); } continue; }
        buf += c; if (!hidden) process.stdout.write(c);
      }
    };
    stdin.on("data", onData);
  });
}

async function newPassphrase() {
  const a = await ask("New passphrase (12+ characters): ", { hidden: true });
  if (a.length < 12) { console.error("Too short. Use at least 12 characters."); process.exit(1); }
  const b = await ask("Repeat passphrase: ", { hidden: true });
  if (a !== b) { console.error("Passphrases do not match."); process.exit(1); }
  return a;
}

async function main() {
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h" || flags.has("--help")) return console.log(HELP);
  if (cmd === "--version" || cmd === "-v" || cmd === "version") return console.log(pkg.version);

  if (cmd === "tools") {
    const { TOOLS } = await import("../src/server.js");
    const by = {}; for (const t of TOOLS) (by[t[1]] ||= []).push(t);
    for (const [p, ts] of Object.entries(by)) { console.log(`\n${p}`); for (const t of ts) console.log(`  ${t[0].padEnd(24)} ${t[3]}`); }
    return console.log(`\n${TOOLS.length} tools.`);
  }
  if (cmd === "mcp") { const { runServer } = await import("../src/server.js"); return runServer(); }

  const { keystoreExists, writeKeystore, walletAddress, decryptKey } = await import("../src/keystore.js");
  const { paths, loadConfig, saveConfig, ensureDir } = await import("../src/config.js");

  if (cmd === "init") {
    requireTTY("init");
    if (keystoreExists()) { console.error(`A wallet already exists at ${paths().keystore} (${walletAddress()}). Holbric will not overwrite it.`); process.exit(1); }
    let pk;
    if (flags.has("--import")) {
      pk = (await ask("Private key (0x..., hidden): ", { hidden: true })).trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) { console.error("That is not a 32-byte hex private key."); process.exit(1); }
    } else pk = generatePrivateKey();
    const pass = await newPassphrase();
    const address = writeKeystore(pk, pass);
    console.log(`\nWallet ${flags.has("--import") ? "imported" : "created"}: ${address}`);
    console.log(`Keystore: ${paths().keystore} (encrypted, scrypt + AES-256-GCM, file mode 600)`);
    const save = (await ask("\nLet the Holbric server sign after you say yes in chat? This stores the passphrase in ~/.holbric/passphrase (mode 600). [y/N] ")).trim().toLowerCase();
    if (save === "y" || save === "yes") { ensureDir(); writeFileSync(paths().passphrase, pass + "\n", { mode: 0o600 }); console.log("Signing unlocked. Run `holbric lock` to remove it."); }
    else console.log("Signing stays locked. Reads and quotes work. Run `holbric unlock` later, or set HOLBRIC_PASSPHRASE in your host config.");
    console.log("\nHolbric cannot recover a lost passphrase or key. Back up with `holbric export` in this terminal.");
    console.log(`Fund it with ETH for gas on Robinhood Chain (chain id 4663). Next: holbric connect cursor | claude | codex | gemini | windsurf | vscode`);
    return;
  }
  if (cmd === "unlock") {
    requireTTY("unlock");
    const pass = await ask("Passphrase: ", { hidden: true });
    decryptKey(pass);
    ensureDir(); writeFileSync(paths().passphrase, pass + "\n", { mode: 0o600 });
    return console.log(`Signing unlocked for ${walletAddress()}. Every swap still needs your yes in chat.`);
  }
  if (cmd === "lock") {
    if (existsSync(paths().passphrase)) unlinkSync(paths().passphrase);
    return console.log("Signing locked. The passphrase file was removed.");
  }
  if (cmd === "export") {
    requireTTY("export");
    const pass = await ask("Passphrase: ", { hidden: true });
    const pk = decryptKey(pass);
    console.log(`\nAddress: ${privateKeyToAccount(pk).address}\nPrivate key: ${pk}\nAnyone with this key controls the wallet. Do not paste it into a chat.`);
    return;
  }
  if (cmd === "address") {
    const a = walletAddress();
    if (!a) { console.error("No wallet yet. Run `holbric init`."); process.exit(1); }
    return console.log(a);
  }
  if (cmd === "limit") {
    const v = pos[0];
    const cfg = loadConfig();
    if (!v) return console.log(cfg.dailyLimitUsd == null ? "No daily limit set." : `Daily limit: $${cfg.dailyLimitUsd}`);
    if (v === "off") cfg.dailyLimitUsd = null;
    else if (/^\d+(\.\d+)?$/.test(v)) cfg.dailyLimitUsd = Number(v);
    else { console.error("Use a number of USD, e.g. `holbric limit 50`, or `holbric limit off`."); process.exit(1); }
    saveConfig(cfg);
    return console.log(cfg.dailyLimitUsd == null ? "Daily limit cleared." : `Daily limit set to $${cfg.dailyLimitUsd} per day (local date).`);
  }
  if (cmd === "aggregators") {
    const v = pos[0];
    const cfg = loadConfig();
    const env = /^(1|true|yes|on)$/i.test(process.env.HOLBRIC_NO_AGGREGATORS || "");
    const state = () => (cfg.aggregators === false || env ? "off" : "on");
    if (!v) return console.log(`KyberSwap aggregator: ${state()}${env ? " (HOLBRIC_NO_AGGREGATORS is set)" : ""}. When on, swap quotes send the token addresses and amount to aggregator-api.kyberswap.com, and prepare_swap sends the wallet address when KyberSwap's quote is ahead.`);
    if (v !== "on" && v !== "off") { console.error("Use `holbric aggregators on` or `holbric aggregators off`."); process.exit(1); }
    cfg.aggregators = v === "on";
    saveConfig(cfg);
    return console.log(`KyberSwap aggregator ${v}.${v === "on" && env ? " HOLBRIC_NO_AGGREGATORS is still set in this environment, which keeps it off." : ""}${v === "off" ? " Only Holbric's own Uniswap routing is used; nothing is sent to KyberSwap." : ""}`);
  }
  if (cmd === "bridges") {
    const v = pos[0];
    const cfg = loadConfig();
    const env = /^(1|true|yes|on)$/i.test(process.env.HOLBRIC_NO_BRIDGES || "");
    const state = () => (cfg.bridges === false || env ? "off" : "on");
    if (!v) return console.log(`Relay bridging: ${state()}${env ? " (HOLBRIC_NO_BRIDGES is set)" : ""}. When on, bridge_quote sends the chains, tokens and amount to api.relay.link, prepare_bridge also sends the wallet address and recipient, and bridge_status sends the id or hash you ask about.`);
    if (v !== "on" && v !== "off") { console.error("Use `holbric bridges on` or `holbric bridges off`."); process.exit(1); }
    cfg.bridges = v === "on";
    saveConfig(cfg);
    return console.log(`Relay bridging ${v}.${v === "on" && env ? " HOLBRIC_NO_BRIDGES is still set in this environment, which keeps it off." : ""}${v === "off" ? " The bridge tools refuse and nothing is sent to Relay." : ""}`);
  }
  if (cmd === "connect") {
    const { connect } = await import("../src/connect.js");
    return console.log(connect(pos[0], { global: flags.has("--global"), print: flags.has("--print") }));
  }
  console.error(`Unknown command "${cmd}".\n\n${HELP}`); process.exit(1);
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
