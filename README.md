# Holbric

Holbric gives your AI agent one MCP connection to several projects on **Robinhood Chain mainnet** (chain id 4663). It works with Claude Code, Cursor, Codex, Gemini CLI, Windsurf, VS Code, or any MCP host that runs a local command.

Version 0.10.0 covers 9 projects with 48 tools. Every integration below was tested live against mainnet, and every write is simulated on mainnet before you are asked to sign it. Not released yet, on this branch after 0.10.0: `spend_history` and `holbric history` (see [Spend history](#spend-history-not-released-yet)), and Ramses V3 in swap routing plus `ramses_pools` (see [Ramses V3](#ramses-v3-not-released-yet)). Together they make 10 projects with 50 tools.

| Project | What your agent can do | Tools |
| --- | --- | --- |
| Wallet (Robinhood Chain) | Show its address and balances, value any address's holdings and Morpho positions at one block, look up any token, send ETH or ERC-20s, wrap and unwrap WETH | `wallet_address`, `chain_status`, `get_balances`, `portfolio`, `token_info`, `prepare_send`, `prepare_wrap_eth`, `prepare_unwrap_weth`, `execute_prepared` |
| Uniswap v3 and v4 | Find the best route across v3 and v4 (direct pools, or 2 hops through WETH, ETH, USDG or cbBTC), quote it, and swap; list v4 pools for a pair and quote on v4 alone; read Uniswap v4 liquidity positions and quote or prepare adding, removing and collecting fees | `quote_swap`, `find_route`, `prepare_swap`, `v4_pools`, `quote_v4`, `lp_positions`, `quote_add_liquidity`, `prepare_add_liquidity`, `quote_remove_liquidity`, `prepare_remove_liquidity`, `quote_collect_lp_fees`, `prepare_collect_lp_fees` |
| Robinhood Stock Tokens | Search the official stock token and ETF list (the one behind docs.robinhood.com/chain/contracts) and quote their Uniswap pools | `stock_tokens`, `stock_quote` |
| Pons V2 | Read a launch, list recent launches, quote and trade on the bonding curve or, after graduation, on the launch's Uniswap v4 pool, read creator fees (escrow and unswept, kept apart), sweep and claim them | `pons_token`, `pons_recent_launches`, `pons_quote`, `prepare_pons_trade`, `pons_creator_fees`, `prepare_pons_sweep`, `prepare_pons_claim` |
| ERC-8004 | Look up agent identities and reputation, register an agent, give feedback to an agent and revoke it | `agent_identity`, `agent_reputation`, `prepare_register_agent`, `prepare_agent_feedback`, `prepare_revoke_feedback` |
| KyberSwap aggregator | Holbric's own route against KyberSwap's for the same swap, side by side at one block. KyberSwap's output only counts after its router call is simulated on mainnet. `quote_swap`, `find_route` and `prepare_swap` use it too | `compare_quotes` |
| Relay bridge | Quote ETH and stablecoin bridges between Robinhood Chain and Ethereum, Base, Arbitrum One, OP Mainnet or Unichain (both directions), bridge out of Robinhood Chain with a checked and simulated deposit, and follow a bridge by request id or hash | `bridge_quote`, `prepare_bridge`, `bridge_status` |
| Morpho | Read lending markets (rates, utilization, liquidity, oracle price), any address's positions with health factor and liquidation price, and Vault V2 vaults; supply, borrow (with collateral in the same action), repay and withdraw on Morpho Blue | `morpho_markets`, `morpho_position`, `morpho_vaults`, `prepare_morpho_supply`, `prepare_morpho_borrow`, `prepare_morpho_repay`, `prepare_morpho_withdraw` |
| GeckoTerminal | Third-party prices, liquidity, and trending pools | `market_token`, `market_trending` |
| Sourcify | Check whether a contract's source is verified, inside `token_info` | (part of `token_info`) |

Tool count per project: Wallet 9, Uniswap 12, Robinhood Stock Tokens 2, Pons V2 7, ERC-8004 5, KyberSwap 1, Morpho 7, Relay 3, GeckoTerminal 2. Signing for any write goes through `execute_prepared`.

Site: [holbric.com](https://holbric.com) · X: [@holbriconrh](https://x.com/holbriconrh) · Source: [github.com/holbric/holbric](https://github.com/holbric/holbric)

## $HOLBRIC

The Holbric token is on Robinhood Chain mainnet. You don't need it to use any Holbric tool.

| Item | Value |
| --- | --- |
| Name / symbol | Holbric / HOLBRIC |
| Decimals / supply | 18 / 1,000,000,000 |
| Contract | `0xE8D6AE09757769968d17eab44998A03E196217e7` |
| Pons V2 bonding curve (ETH pair) | `0x4eF8D0d0210BbF85C3e4C93921C9F87d075618B6` |
| Launch | Pons V2, 17 November 2026 |
| Explorer | [Blockscout](https://robinhoodchain.blockscout.com/token/0xE8D6AE09757769968d17eab44998A03E196217e7) |

## How a write works

1. A `prepare_*` tool checks your balance, allowance, and daily limit, then simulates every step on mainnet with `eth_simulateV1` (`traceTransfers: true`, all steps in order). The summary shows the expected change to each token in your wallet, every approval being set, and the estimated network fee. If the simulation reverts, nothing is prepared. The `prepareId` expires after 5 minutes.
2. Your agent shows you the summary and asks for a yes or no.
3. Only after you say yes does it call `execute_prepared` with `{ prepareId, confirm: true }`. Holbric simulates again first and refuses to sign if a step now reverts, if ETH or tokens would leave the wallet to an address that wasn't in the preview or in a larger amount, if a new approval appears, or if what you receive fell by more than the slippage limit. Otherwise the key is decrypted inside the local process, the transactions are signed and sent, and receipts come back.

Holbric is built around three rules:

- **Approvals are exact.** When a token approval is needed, it is for the exact amount of that action, never unlimited.
- **No Holbric fee.** You pay the network fee in ETH. Pool and curve fees are already counted in every quote. Holbric sends no fee or referral parameters to KyberSwap or Relay, and refuses a KyberSwap route or a Relay order that carries a fee.
- **The key stays on your computer.** It is stored in `~/.holbric/keystore.json`, encrypted with scrypt and AES-256-GCM. No tool returns the key or the passphrase.

## Install

Node.js 22.12.0 or newer is required.

```sh
npm install -g holbric
# or from the GitHub release tarball
npm install -g https://github.com/holbric/holbric/releases/download/v0.10.0/holbric-0.10.0.tgz
# or from this repository
git clone https://github.com/holbric/holbric.git
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
holbric aggregators off # use only Holbric's own routing; nothing is sent to KyberSwap (`on` turns it back)
holbric bridges off     # turn off the Relay bridge tools; nothing is sent to Relay (`on` turns them back)
holbric history --csv --out=history.csv   # actions this wallet signed through Holbric (not released yet)
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
| Uniswap v3 factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` (`factory()` on QuoterV2 and SwapRouter02 returns this address) |
| Uniswap v3 QuoterV2 / SwapRouter02 | `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` / `0xCaf681a66D020601342297493863E78C959E5cb2` |
| Uniswap v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` (exact match on Sourcify: PoolManager) |
| Uniswap v4 V4Quoter / StateView | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` / `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` (exact matches; `poolManager()` returns the PoolManager) |
| Uniswap v4 PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` (exact match on Sourcify: PositionManager). On chain, `poolManager()`, `permit2()` and `WETH9()` return the PoolManager, Permit2 and WETH above. Deployed by create2 at block 9073 (tx `0x228c18ada6cb46b4fbcc18f4ec1519953415393e256fa8349aafbd5a2db037c8`), with those same constructor arguments. Listed on Uniswap's Robinhood Chain: 4663 deployment table |
| Uniswap Universal Router 2.1.2 | `0x204FAca1764B154221e35c0d20aBb3c525710498` (exact match; constructor arguments name this PoolManager, Permit2, WETH and the v3 factory) |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` (exact match on Sourcify: Permit2; `PositionManager.permit2()` returns this address) |
| cbBTC (route middle hop) | `0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4` (exact match on Sourcify, `name()` Coinbase Wrapped BTC) |
| Pons V2 launch factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` (exact match on Sourcify: PonsV2LaunchFactory) |
| Pons V2 fee escrow | `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` (exact match on Sourcify: PonsV2FeeEscrow) |
| Pons V2 meme hook | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` (exact match on Sourcify: PonsV2MemeHook) |
| ERC-8004 identity / reputation | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` / `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| Stock token list | `https://api.robinhood.com/rhj/assets` (the source of the table on docs.robinhood.com/chain/contracts) |
| KyberSwap MetaAggregationRouterV2 | `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` (docs.kyberswap.com, Contracts & Addresses, Robinhood (ChainID: 4663); exact match on Sourcify: MetaAggregationRouterV2). The only router Holbric accepts from KyberSwap |
| KyberSwap AggregationExecutorProxy | `0x8F10B468b06c6FD214B65F87778827F7D113f996` (same docs page). The only executor Holbric accepts in KyberSwap calldata |
| KyberSwap API | `https://aggregator-api.kyberswap.com/robinhood/api/v1` (`/routes`, `/route/build`), third party |
| RelayDepository | `0x4cD00E387622C35bDDB9b4c962C136462338BC31` (Relay's `/chains`, `protocol.v2.depository` for chain 4663; exact match on Sourcify: RelayDepository). The only contract Holbric deposits into for a bridge |
| Relay API | `https://api.relay.link` (`/chains`, `/quote/v2`, `/requests/v3` with `RELAY_API_KEY`, `/intents/status/v3`), third party |
| Morpho Blue | `0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010` (Morpho's address registry, `RobinhoodMainnet = 4663`; verified on Sourcify: Morpho) |
| Morpho AdaptiveCurveIrm / VaultV2Factory | `0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1` / `0x0FBad98595b0186dA120E41f77C102beb49f803c` (same registry; verified on Sourcify) |
| Morpho API | `https://api.morpho.org/graphql`, third party: only the market listing flag and vault APY. No address is sent |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` (batched reads at one block) |
| Market data | `https://api.geckoterminal.com/api/v2/networks/robinhood` |
| Verification | `https://sourcify.dev/server/v2/contract/4663/<address>` |

Uniswap v4 addresses are from the "Robinhood Chain: 4663" table on [docs.uniswap.org/contracts/v4/deployments](https://docs.uniswap.org/contracts/v4/deployments).

### Uniswap routing (v3 and v4)

`quote_swap`, `find_route` and `prepare_swap` share one router. By default it searches both versions (`venue: "best"`); `venue: "v3"` or `"v4"` limits it. A route stays on one version.

1. Pools are read from the Uniswap v3 factory with `getPool` for the direct pair at every fee tier (0.01%, 0.05%, 0.3%, 1%) and for each leg through WETH, USDG and cbBTC. Pools with zero in-range liquidity are skipped, and at most 3 pools per leg are tried.
2. Every candidate path is quoted with `QuoterV2.quoteExactInput` on the encoded path (token, fee, token, fee, token). The highest output wins; on a tie the shorter route wins.
3. `prepare_swap` sends a direct route through SwapRouter02 `exactInputSingle` and a 2-hop route through `exactInput`, inside `multicall` with a 15-minute deadline. The minimum output comes from the slippage limit (default 0.5%), approvals are for the exact input amount, and native ETH is wrapped in and unwrapped out by the router.
4. The summary shows the route (tokens and fee tiers), the pool addresses, and the next best routes it was compared with. The usual simulation and the re-check inside `execute_prepared` apply.

Uniswap v4:

1. v4 has no `getPool`: a pool is its key (currency0, currency1, fee, tickSpacing, hooks) and its id is `keccak256(abi.encode(key))`. Holbric checks the four hookless standard keys (0.01%/1, 0.05%/10, 0.3%/60, 1%/200) and, when one side is a graduated Pons V2 launch paired with the other, the key from the Pons factory record (`pairToken`, `poolFee`, `tickSpacing`) with the Pons V2 hook. The hook must list that pool id as registered. Pools with any other hook, or non-standard fees, are not used.
2. In-range liquidity comes from `StateView.getLiquidity`. Routes are direct or 2 hops through native ETH, USDG and cbBTC. Each path is quoted with `V4Quoter.quoteExactInputSingle` or `quoteExactInput`, which runs the swap, hooks included.
3. `prepare_swap` sends a v4 route through Universal Router 2.1.2 `execute` with one `V4_SWAP` command: `SWAP_EXACT_IN_SINGLE` or `SWAP_EXACT_IN`, then `SETTLE_ALL` and `TAKE_ALL` with the minimum output. Native ETH goes in as value and comes out as ETH. A token input needs an exact ERC-20 approval to Permit2 and an exact Permit2 allowance for the router that expires after 30 minutes; both are added only when missing.
4. On v4, native ETH (`0x0`) and WETH are different currencies. ETH routes use native pools, WETH routes use WETH pools.

The best output across v3 and v4 wins; on a tie the shorter route wins. `v4_pools` lists the v4 pools Holbric can see for a pair (id, key, liquidity, price, tick, fees) and `quote_v4` quotes on v4 alone, optionally on one pool key you give it.

### Uniswap v4 liquidity positions

Positions are ERC-721s minted by the PositionManager (`Uniswap v4 Positions NFT`, symbol `UNI-V4-POSM`). The contract is not enumerable, so `lp_positions` finds a wallet's token ids from its Transfer logs, starting at the PositionManager's deploy block (9073), in 10-million-block chunks. You can also pass `tokenId` or `tokenIds`. Each position is then read at one block from the PositionManager and StateView: pool key, ticks, in-range status, liquidity, principal token amounts, and uncollected fees. Fees are computed from fee-growth counters the way `Position.update` does in the verified v4 core source. In-range means the pool tick is in `[tickLower, tickUpper)`.

`quote_add_liquidity` and `prepare_add_liquidity` mint a new NFT or increase an existing one (`tokenId`). For a new mint, Holbric only uses hookless pools (the most liquid live standard-key pool for the pair, or a fee / pool key you give). Give `tickLower` and `tickUpper` (snapped to the pool's tick spacing) or `fullRange: true`. The liquidity and the tokens actually used come from the same `LiquidityAmounts` formulas as the PositionManager. Leftover of the less-limiting token is not deposited. Approvals are the exact maximum (used amount plus the slippage limit, default 0.5%) to Permit2, then an exact 30-minute Permit2 allowance for the PositionManager. Native ETH goes in as `msg.value`; leftover ETH is swept back to the wallet. Holbric does not initialize a new pool.

`quote_remove_liquidity` and `prepare_remove_liquidity` take a `tokenId`. Omit `liquidity` and `percent` to remove all liquidity and burn the NFT. A partial remove keeps the NFT. Tokens paid out are the principal plus uncollected fees. The PositionManager's slippage check is on the principal only; the minimums Holbric sets follow that.

`quote_collect_lp_fees` and `prepare_collect_lp_fees` collect fees with a decrease of 0 liquidity, leaving the NFT and its liquidity in place. A position with zero liquidity cannot be poked; burn it with `prepare_remove_liquidity` instead.

New mints on hooked pools, including graduated Pons pools, are refused. An existing hooked position can still be read, and a remove or collect is prepared only if the hook allows it (the mainnet simulation is the check).

The usual simulation and the re-check inside `execute_prepared` apply. Nothing is signed by the quote or prepare tools.


Robinhood Stock Tokens are never used as a middle hop. A stock token with no direct pool against your input can still be reached: for example ETH to AMZN goes ETH → USDG → AMZN, because the factory has no live WETH/AMZN pool.

Pons quotes come from an `eth_call` simulation of the curve's own `buy` / `sell` functions, with temporary balance overrides. Nothing is signed during a quote. Once a token has graduated, `pons_token` reads its price from the v4 pool, and `pons_quote` and `prepare_pons_trade` use that pool through V4Quoter and the Universal Router. The Pons hook takes its fee and the creator tax from each swap's output; both are inside the quoted amount.

### KyberSwap next to Holbric's own routing

KyberSwap runs an aggregator on Robinhood Chain (chain slug `robinhood` in its API). It reaches liquidity Holbric does not route through itself, such as other DEXs, hooked v4 pools and market-maker pools. Holbric uses it as a second opinion and never trusts its number on its own.

- **Quotes.** With `venue: "best"` (the default), `quote_swap`, `find_route` and `compare_quotes` ask KyberSwap's `/routes` for the same swap. Holbric then asks `/route/build` for a transaction from a throwaway address, gives that address the input by state override, and runs the router call with `eth_simulateV1` on mainnet. KyberSwap only wins if that **simulated** output is higher than Holbric's best Uniswap v3 or v4 route. Both figures are shown, with the block. KyberSwap's API figure and its simulated figure can differ. In our runs, routes through market-maker pools simulated about 0.3% below the API figure.
- **Swaps.** `prepare_swap` (`venue: "best"`) builds a KyberSwap transaction for your wallet only when KyberSwap's quote is ahead. Holbric decodes the calldata and refuses it unless:
  - the router is MetaAggregationRouterV2 `0x6131…37b5` and the executor is `0x8F10…f996`;
  - source token, destination token and amount match your request, and the output goes to your wallet;
  - the minimum output is at least the KyberSwap output minus your slippage limit;
  - no fee receivers and no permit are set, and no extra fee is attached.
  
  The approval is for the exact input amount, to that router. The transaction is then simulated from your wallet. If it reverts, if it delivers less than its minimum output, if it takes more than the input amount, or if it no longer beats the native route, Holbric prepares the native route and says why in the summary. The minimum-output check runs again inside `execute_prepared` before signing, for every swap, native or KyberSwap.
- **Venues.** `"best"` uses Holbric's routing and KyberSwap. `"native"` uses Uniswap v3 and v4 only and sends nothing to KyberSwap. `"kyber"` uses KyberSwap only. `"v3"` and `"v4"` work as before.
- **Failure.** If the API is down, rate limited or answers wrongly, quotes and `prepare_swap` fall back to the native route. `venue: "kyber"` refuses instead.
- **Privacy.** KyberSwap is a third-party API. A quote sends the two token addresses and the amount. `prepare_swap` also sends your wallet address as sender and recipient, but only when KyberSwap's quote is ahead. To turn it off, set `HOLBRIC_NO_AGGREGATORS=1` in the MCP server's environment, or run `holbric aggregators off`. `chain_status` shows whether it is on.
- **No fees.** Holbric sends no fee or referral fields to KyberSwap. KyberSwap's request header and `source` field say `holbric`.

### Relay bridge

Relay (relay.link) runs a bridge with Robinhood Chain (chain id 4663) as a supported chain. Its `/chains` answer lists ETH and USDG as bridgeable there. Holbric covers Ethereum, Base, Arbitrum One, OP Mainnet and Unichain on the other side, with ETH to ETH, and USDG to USDG (Ethereum) or USDC (the others).

- **Quotes, both directions.** `bridge_quote` returns Relay's expected output, its guaranteed minimum (your slippage limit, default 0.5%), its fee breakdown, its total cost and its time estimate, with the Robinhood Chain block at the time of the quote. These are Relay's figures, labelled as third-party. Example at block 117071566: 0.1 ETH from Robinhood Chain to Base, expected 0.099868739236507417 ETH, at least 0.09936939554032488 ETH, Relay's relayer fee 0.000131260763492583 ETH, estimate 1 second.
- **The order is checked, not trusted.** Relay's quotes carry a protocol order. Holbric follows Relay's own input-validation guide. It recomputes the order id from the order data (EIP-712, the same types as Relay's settlement SDK; checked against the SDK during development). Then it checks the order:
  - it pays exactly the token and amount asked, on Robinhood Chain;
  - one output, to the recipient, in the token asked, on the chain asked;
  - the guaranteed minimum is within the slippage limit;
  - no destination calls and no fees to anyone;
  - every refund on Robinhood Chain pays the wallet;
  - the deadline is ahead.
- **Bridging out: `prepare_bridge`.** Only the Robinhood Chain side is built: an exact USDG approval when needed, then `depositNative` or `depositErc20` on the RelayDepository above. That address must also be the depository Relay's `/chains` lists for chain 4663, or nothing is prepared. Holbric encodes the deposit itself (your wallet as depositor, the verified order id) and refuses if Relay's calldata differs by a byte, or if Relay asks for any other transaction or target. The recipient is your own wallet address unless you name another one, and the summary says so in capitals. The deposit is simulated on mainnet; the simulation must show exactly the deposit amount leaving to the depository and nothing else. `execute_prepared` re-simulates and also refuses when Relay's order deadline is near.
- **What the simulation cannot show.** The delivery on the other chain is done later by Relay's solver, so it is not part of the simulation. If it does not happen, Relay refunds: on Robinhood Chain to your wallet (Holbric always sets `refundTo`), less the refund gas.
- **Bridging in is quote-only.** Bridging into Robinhood Chain starts with a transaction on the other chain. Holbric only reads and simulates Robinhood Chain, so it does not build or sign that transaction. `bridge_quote` says so; use Relay's app or your wallet there.
- **Status.** `bridge_status` takes a request id or a transaction hash and returns Relay's status, the deposit and fill transactions with explorer links, amounts, and any failure or refund reason. For a deposit on Robinhood Chain it also reads the receipt and decodes the RelayDepository event (sender, depositor, amount, order id). Relay's request lookup (`GET /requests/v3`) needs a Relay API key: create one in the [Relay Dashboard](https://dashboard.relay.link) and set it as `RELAY_API_KEY` in the MCP server's environment. Holbric sends it as `x-api-key`, only to api.relay.link, and only when it is set. Without a key, a request id is still followed through Relay's `GET /intents/status/v3` (status and transaction hashes, no amounts), and a Robinhood Chain deposit hash is read on chain; looking up Relay's request from a bare hash needs the key.
- **Privacy.** Relay is a third-party API. `bridge_quote` sends the chains, the tokens and the amount, and asks for a placeholder address, not your wallet. `prepare_bridge` sends your wallet address (sender and refund address) and the recipient. `bridge_status` sends the id or hash you ask about. To turn Relay off, set `HOLBRIC_NO_BRIDGES=1` in the MCP server's environment or run `holbric bridges off`; the bridge tools then refuse and nothing is sent. `chain_status` shows the setting. `HOLBRIC_NO_AGGREGATORS` only covers KyberSwap.
- **No fees.** Relay's own fees are inside its quote and shown. Holbric adds none and sends no app fee or referrer.

### Morpho

Addresses come from Morpho's own registry, [`packages/morpho-ts/src/addresses.ts`](https://github.com/morpho-org/sdks/blob/main/packages/morpho-ts/src/addresses.ts) in morpho-org/sdks. Morpho Blue, the AdaptiveCurveIrm and the VaultV2Factory each have code on chain and are verified on Sourcify. The registry lists no MetaMorpho (vault V1) factory for chain 4663; vaults here are Morpho Vault V2.

- **Discovery from events.** Markets come from Morpho Blue's `CreateMarket` logs and vaults from the factory's `CreateVaultV2` logs, scanned from the registry's deployment blocks in 10M-block ranges and cached.
- **One block.** Every figure is read at one block through Multicall3: `market`, `position`, the market's oracle `price()` and the IRM's `borrowRateView`. Interest since the market's last update is added as Morpho Blue does it (Taylor compounding, fee shares). Borrow APY = e^(rate x 1 year) - 1; supply APY = borrow APY x utilization x (1 - fee).
- **Health factor** = collateral x oracle price x LLTV / debt. Below 1 a position can be liquidated. The liquidation price is the oracle price at which the health factor reaches 1.
- **Morpho's API** is used only for whether Morpho's app lists a market (`morpho_markets` shows listed markets by default) and for vault APY. Both are labelled. If it is down, `morpho_markets` shows only markets whose tokens are all WETH, USDG, cbBTC or official stock tokens, and `morpho_vaults` shows no APY.
- **Partial reads are refused.** Failed batches are retried twice at the same block. If a read still fails, the tool says so rather than return a partial list.

**Writes (0.10.0).** `prepare_morpho_supply`, `prepare_morpho_borrow`, `prepare_morpho_repay` and `prepare_morpho_withdraw` call Morpho Blue directly (`supply`, `supplyCollateral` then `borrow`, `repay`, `withdraw` / `withdrawCollateral`, with signatures from its verified source). There is no bundler, no callback data and no authorization: every call acts for your wallet and pays your wallet. Each one is simulated on mainnet and re-simulated by `execute_prepared`.

- **Listed markets only.** Supply and borrow are refused on markets Morpho's app does not list, unless you explicitly pass `allowUnlisted: true`; the summary then carries a warning. If Morpho's API is down, only markets whose tokens are all WETH, USDG, cbBTC or official stock tokens are allowed. Repay and withdraw work on any market you are already in.
- **Health margin.** A borrow, or a collateral withdrawal while in debt, is refused if the health factor afterwards would be under 1.10 at the market oracle (Morpho itself stops at 1.00). The check is read again right before signing. The summary shows the health factor after, the liquidation price and how far it is from the oracle price now.
- **Exact approvals.** Supply, collateral and partial repay approve exactly the amount. A full repay (`all: true`) repays by shares so no interest dust is left: it approves the debt plus at most 15 minutes of interest, then sets the allowance back to 0 in the same action. Interest accrues between prepare and signing, so the re-check lets that payment grow by up to 0.05%; the approval still caps it.
- **Liquidity.** A borrow or a supply withdrawal larger than the market's free liquidity is refused before simulation, and the liquidity is shown.

### Portfolio

`portfolio` checks ETH, WETH, USDG, cbBTC, every official Robinhood Stock Token, the tokens you name, and tokens that reached the address in the last 24 hours (Transfer logs, up to 72; the public RPC allows 30,000 blocks per log request without an address). It adds the address's Morpho positions and Vault V2 shares, with debt as negative.

Prices are Holbric's own best Uniswap v3/v4 quote into USDG for a small amount (1 token, or about $100 worth when 1 token is worth more). ETH and WETH use a 1 ETH quote. Pons V2 tokens still on their curve are quoted on the curve. A second, full-size quote gives the sell-everything-now value, so a thin pool shows up as a gap between the two totals. No price feed or aggregator API is asked. Tokens outside Holbric's lists are listed, not valued, unless you name them.

There is no PnL. An honest one needs the price of every token at every past transfer. The public RPC keeps no historical state, and Holbric will not guess a cost basis.

### ERC-8004 feedback

`prepare_agent_feedback` calls `giveFeedback` on the reputation registry `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` (a proxy; implementation `0x16e0FA7f7C56B9a767E34B192B51f921BE31dA34`, exact match on Sourcify as ReputationRegistryUpgradeable; its `getIdentityRegistry()` is the identity registry Holbric uses). The value is a decimal such as `5`, `4.5` or `-1` (up to 18 decimals, at most 1e38 in absolute value), with optional tags, an endpoint, an https or ipfs feedbackURI and a 32-byte hash. The registry refuses feedback from an agent's owner or operators; Holbric checks `isAuthorizedOrOwner` first and says so. Feedback is public, permanent and tied to your wallet. `prepare_revoke_feedback` marks one of your entries as revoked: it stays on chain, and summaries stop counting it.

### Ramses V3 (not released yet)

Ramses V3 is a concentrated-liquidity DEX on Robinhood Chain built like Uniswap v3, with pools keyed by tick spacing instead of a fee tier. Holbric uses only the contracts Ramses publishes for Robinhood ([ramses.xyz/docs/contract-addresses](https://ramses.xyz/docs/contract-addresses), "Robinhood" -> "V3 AMM"), each verified on Sourcify and checked on chain on every test run:

| Contract | Address |
| --- | --- |
| RamsesV3Factory | `0xE0c4ceb92d08CA985bB70fe0a22fEb121A9854A8` |
| RamsesV3PoolDeployer | `0x4b37359BF291AbE8453692DB58d515a8b013Dca9` (the factory's `ramsesV3PoolDeployer()`, and `deployer()` on the router and quoter) |
| SwapRouter | `0xFCBBe2Af83F94e7E2a9C35a535B3A04719aFD2Ae` (`WETH9()` is Holbric's WETH) |
| QuoterV2 | `0x4730e03EB4a58A5e20244062D5f9A99bCf5770a6` (`WETH9()` is Holbric's WETH) |

- **Routing.** `quote_swap`, `find_route` and `prepare_swap` read Ramses pools from the factory at every enabled tick spacing (1, 5, 10, 50, 100, 200, 500), direct or 2 hops through WETH, USDG and cbBTC, and quote each path with the Ramses QuoterV2. Venue `best` and `native` compare them with Uniswap v3 and v4 (and `best` with KyberSwap); `ramses` limits the search to Ramses.
- **Fees can change.** Each Ramses pool's fee is set by Ramses governance and can differ from the tick spacing's starting fee, so Holbric reads it from the pool at the quote's block. The quote and the simulation are what count.
- **Swaps.** An exact approval to the Ramses SwapRouter when needed, then `exactInputSingle` or `exactInput` (deadline 15 minutes). Native ETH goes in as value; for native ETH out the router keeps the WETH and `unwrapWETH9` pays the wallet, in one `multicall`. Simulated on mainnet and re-checked by `execute_prepared` like every other swap.
- **`ramses_pools`** lists a pair's Ramses pools: address, tick spacing, current fee, in-range liquidity, tick and price at one block.

### Spend history (not released yet)

Every action `execute_prepared` signs and sends is added to a local file, `~/.holbric/history.jsonl` (one JSON object per line, readable only by you). It is written once a transaction is sent, also when a step reverts or the run stops part way, so a sent transaction is never missing from it. Each entry has the time and local date, the action kind, the prepareId, the result (`confirmed`, `reverted` or `incomplete`), each step's hash and block, how many steps were not sent, Holbric's USD estimate and the network fee.

- **The USD figure is an estimate.** `usdEstimate` is the value Holbric estimated when the action was prepared (its own Uniswap quote into USDG), the same figure the daily limit uses. It is not a price at the time of the transaction and not a realised value. Actions that could not be valued have none, and the totals count them.
- **The network fee is read from the receipts.** `gasUsed x effectiveGasPrice` for each transaction. On Robinhood Chain `gasUsed` already includes the parent-chain data cost (`gasUsedForL1`), so this is the whole fee.
- **What is not in it.** Actions signed before this record existed, and anything signed with the same key outside Holbric. Holbric does not rebuild history from the chain.
- **Export.** `spend_history` returns the entries with explorer links and totals (actions, confirmed, USD estimate, network fee, count per kind), filtered by `from` / `to` (local calendar days, `YYYY-MM-DD`), `kind` and `limit`, as JSON or CSV. `holbric history [--csv] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--out=FILE]` does the same in your terminal. Neither reads the network or sends anything.

### Pons creator fees

Per the [Pons V2 docs](https://docs.ponsfamily.com/v2), a trade does not credit the fee escrow directly. Fees accrue on the launch's curve before graduation, or on the hook after it, until a sweep moves them, so the escrow balance alone can understate what a creator is owed. `pons_creator_fees` reports the escrow balance (`balanceOf` for ETH, `balanceOfToken` for ERC-20s) and the unswept fees (`quoteFeeBalance` / `creatorTaxBalance` on the curve, or `pendingFees` / `pendingCreatorTax` on the hook) separately, plus the creator's estimated share using the contract's own split.

`prepare_pons_sweep` calls `sweepFees(minBuybackTokensOut)` on the curve or `sweepPoolFees(poolId, minConversionQuoteOut, minBuybackTokensOut)` on the hook. It is only offered when the contract lets this wallet do it: the wallet must be the creator fee recipient, and no buyback or launch-token conversion may be pending (those need the Pons sweep operator). `prepare_pons_claim` calls `claim()` or `claimToken(token)` on the escrow. The curve signatures are taken from `PonsV2BondingCurve.sol` in the Sourcify exact match of the Pons V2 launch deployer `0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42`; the escrow and hook ABIs come from their own exact matches.

## Tests

```sh
npm test                           # both suites below. Never signs.
node test/live.mjs                 # live, over MCP stdio: read tools, multi-hop and v4 routes, a graduated Pons pool, the HOLBRIC creator-fee readout,
                                   # KyberSwap comparisons, the opt-out, the fallback and the calldata checks, Morpho markets, positions and vaults,
                                   # the ERC-8004 and Morpho contracts on Sourcify
                                   # checked against raw reads, portfolio totals, prepare refusals, Relay quotes, order checks, bridge status and the opt-out,
                                   # and spend_history over MCP (a real public receipt's fee, CSV, filters, no network call)
node test/simulate-writes.mjs      # builds every prepare_* action (multi-hop, v4 and KyberSwap swaps, Relay deposits, Morpho supply and borrow, ERC-8004 feedback) with a throwaway wallet,
                                   # simulates it on mainnet; Morpho repay and withdraw are simulated from real public positions;
                                   # re-checks it like execute_prepared, and checks the refusal paths; builds the history entry execute_prepared would write. Never signs.
```

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) and [holbric.com/changelog](https://holbric.com/changelog/).

## Licence

MIT. Holbric is independent software. It is not affiliated with Robinhood, Uniswap, KyberSwap, Morpho, Relay, Pons, GeckoTerminal or Sourcify, and nothing here is financial advice.
