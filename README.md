# Holbric

Holbric gives your AI agent one MCP connection to several projects on **Robinhood Chain mainnet** (chain id 4663). It works with Claude Code, Cursor, Codex, Gemini CLI, Windsurf, VS Code, or any MCP host that runs a local command.

Version 0.2.0 covers 6 projects with 19 tools. Every integration below was tested live against mainnet.

| Project | What your agent can do | Tools |
| --- | --- | --- |
| Wallet (Robinhood Chain) | Show its address and balances, look up any token, send ETH or ERC-20s | `wallet_address`, `chain_status`, `get_balances`, `token_info`, `prepare_send` |
| Uniswap v3 | Quote and swap across the 0.01 / 0.05 / 0.3 / 1% pools | `quote_swap`, `prepare_swap` |
| Robinhood Stock Tokens | Search the official stock token and ETF list (the one behind docs.robinhood.com/chain/contracts) and quote their Uniswap pools | `stock_tokens`, `stock_quote` |
| Pons V2 | Read a launch, list recent launches, quote and trade on the bonding curve | `pons_token`, `pons_recent_launches`, `pons_quote`, `prepare_pons_trade` |
| ERC-8004 | Look up agent identities and reputation, register an agent | `agent_identity`, `agent_reputation`, `prepare_register_agent` |
| GeckoTerminal | Third-party prices, liquidity, and trending pools | `market_token`, `market_trending` |
| Sourcify | Check whether a contract's source is verified, inside `token_info` | (part of `token_info`) |

Signing for any write goes through `execute_prepared`.

Site: [holbric.com](https://holbric.com) · X: [@holbriconrh](https://x.com/holbriconrh) · Source: [github.com/GITHUB_USER/holbric](https://github.com/GITHUB_USER/holbric)

## $HOLBRIC

The Holbric token is on Robinhood Chain mainnet. You don't need it to use any Holbric tool.

| Item | Value |
| --- | --- |
| Name / symbol | Holbric / HOLBRIC |
| Decimals / supply | 18 / 1,000,000,000 |
| Contract | `0xE8D6AE09757769968d17eab44998A03E196217e7` |
| Pool | HOLBRIC / WETH · `0x4eF8D0d0210BbF85C3e4C93921C9F87d075618B6` |
| Launch | Pons V2, 17 November 2026 |
| Explorer | [Blockscout](https://robinhoodchain.blockscout.com/token/0xE8D6AE09757769968d17eab44998A03E196217e7) |

## How a write works

1. A `prepare_*` tool checks your balance, allowance, and daily limit. It returns a plain summary and a `prepareId` that expires after 5 minutes.
2. Your agent shows you the summary and asks for a yes or no.
3. Only after you say yes does it call `execute_prepared` with `{ prepareId, confirm: true }`. The key is decrypted inside the local process, the transactions are signed and sent, and receipts come back.

Holbric is built around three rules:

- **Approvals are exact.** When a token approval is needed, it is for the exact amount of that action, never unlimited.
- **No Holbric fee.** You pay the network fee in ETH. Pool and curve fees are already counted in every quote.
- **The key stays on your computer.** It is stored in `~/.holbric/keystore.json`, encrypted with scrypt and AES-256-GCM. No tool returns the key or the passphrase.

## Install

Node.js 22.12.0 or newer is required. Holbric is not on the npm registry yet, so install it from the release tarball or from this repository:

```sh
npm install -g https://holbric.com/dl/holbric-0.2.0.tgz
# or
git clone https://github.com/GITHUB_USER/holbric.git
cd holbric && npm install && npm install -g .
holbric --version
holbric tools          # every tool, grouped by project
```

## Wallet (run in your own terminal)

```sh
holbric init            # new wallet
holbric init --import   # or import a private key (hidden prompt)
holbric address
holbric unlock | lock   # store or remove the passphrase file the server signs with
holbric limit 50        # optional daily USD limit; `holbric limit off` removes it
holbric export          # show the key so you can back it up
```

`init`, `unlock` and `export` refuse to run unless they are in an interactive terminal, so an agent can't run them.

## Connect your agent

| Host | Command | What it writes |
| --- | --- | --- |
| Claude Code | `holbric connect claude` | `claude mcp add --scope user …`, or `~/.claude.json` if the CLI isn't on your PATH |
| Cursor | `holbric connect cursor [--global]` | `.cursor/mcp.json` (or `~/.cursor/mcp.json` with `--global`) |
| Codex | `holbric connect codex` | `[mcp_servers.holbric]` in `~/.codex/config.toml` |
| Gemini CLI | `holbric connect gemini` | `~/.gemini/settings.json` |
| Windsurf | `holbric connect windsurf` | `~/.codeium/windsurf/mcp_config.json` |
| VS Code | `holbric connect vscode` | `.vscode/mcp.json` |

If one of these files already exists, Holbric saves a backup next to it as `<file>.holbric-backup`. Add `--print` to see the config without writing it.

## Sources and addresses (chain 4663)

| Item | Value |
| --- | --- |
| RPC | `https://rpc.mainnet.chain.robinhood.com` (public and rate limited; set `rpc` in `~/.holbric/config.json` or `HOLBRIC_RPC` to use another) |
| USDG / WETH | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` / `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Uniswap v3 QuoterV2 / SwapRouter02 | `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` / `0xCaf681a66D020601342297493863E78C959E5cb2` |
| Pons V2 launch factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` (exact match on Sourcify: PonsV2LaunchFactory) |
| ERC-8004 identity / reputation | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` / `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| Stock token list | `https://api.robinhood.com/rhj/assets` (the source of the table on docs.robinhood.com/chain/contracts) |
| Market data | `https://api.geckoterminal.com/api/v2/networks/robinhood` |
| Verification | `https://sourcify.dev/server/v2/contract/4663/<address>` |

Pons quotes come from an `eth_call` simulation of the curve's own `buy` / `sell` functions, with temporary balance overrides. Nothing is signed during a quote. Tokens that have graduated from their curve are not traded yet.

## Tests

```sh
npm test                           # live, over MCP stdio: read tools plus prepare refusals. Never signs.
node test/simulate-writes.mjs      # builds every prepare_* action and replays it with eth_call. Never signs.
```

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) and [holbric.com/changelog](https://holbric.com/changelog/).

## Licence

MIT. Holbric is independent software. It is not affiliated with Robinhood, Uniswap, Pons, GeckoTerminal or Sourcify, and nothing here is financial advice.
