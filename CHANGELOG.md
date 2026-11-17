# Changelog

Dates below are calendar dates in Asia/Jakarta. This is the public record of Holbric releases and on-chain events that have already happened. Nothing here is a promise about the future.

## 0.3.0 — 18 November 2026

24 tools across 6 projects on Robinhood Chain mainnet (chain id 4663). Five new tools, and every write is now simulated before you sign it.

- **Simulation before signing.** Every `prepare_*` tool now simulates all of its steps, in order, with `eth_simulateV1` and `traceTransfers: true` on mainnet. The summary lists the expected change to each token in the wallet, every approval being set, and the estimated network fee. If a step would revert, nothing is prepared.
- **Re-check inside `execute_prepared`.** Right before signing, Holbric simulates again and refuses, with the reason, if a step now reverts, if ETH or tokens would leave the wallet to an address that wasn't in the preview or in a larger amount, if a new approval appears, or if the output fell by more than the slippage limit.
- **Pons creator fees.** New `pons_creator_fees` shows the fee escrow balance and the fees still unswept on the curve or hook as separate numbers, with the creator's estimated share. As the Pons docs note, the escrow alone can understate what a creator is owed. New `prepare_pons_sweep` (only when the contract allows the creator to sweep) and `prepare_pons_claim` (ETH or ERC-20 ledger) go through the same prepare, confirm and execute flow.
- **WETH.** New `prepare_wrap_eth` and `prepare_unwrap_weth` on WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`.
- **Tests.** `npm test` now runs the live MCP suite and the write simulations, including the refusal paths. Nothing is signed.
- Balance storage-slot lookup for simulations now also finds tokens whose balances sit in later storage slots, such as WETH.

Tool count per project: Wallet 8, Uniswap v3 2, Robinhood Stock Tokens 2, Pons V2 7, ERC-8004 3, GeckoTerminal 2.

Install from the [v0.3.0 release](https://github.com/holbric/holbric/releases/tag/v0.3.0). The package is not on the npm registry yet.

## 18 November 2026

- 5,000,000 HOLBRIC (0.5% of the 1,000,000,000 supply) was sent to the public Holbric fomo account `0x8f4c85fb8423314f7537f3dacd4e6970b198ea0a`. Transaction: [0x1c3ac44913036ba0ab812192724bfabca1e79ef82f06ea808b9f632c35f33e0e](https://robinhoodchain.blockscout.com/tx/0x1c3ac44913036ba0ab812192724bfabca1e79ef82f06ea808b9f632c35f33e0e).

## 0.2.0 — 17 November 2026

First public release of the Holbric MCP server. 19 tools across 6 projects on Robinhood Chain mainnet (chain id 4663):

- Wallet (6): `wallet_address`, `chain_status`, `get_balances`, `token_info`, `prepare_send`, `execute_prepared`
- Uniswap v3 (2): `quote_swap`, `prepare_swap`
- Robinhood Stock Tokens (2): `stock_tokens`, `stock_quote`
- Pons V2 (4): `pons_token`, `pons_recent_launches`, `pons_quote`, `prepare_pons_trade`
- ERC-8004 (3): `agent_identity`, `agent_reputation`, `prepare_register_agent`
- GeckoTerminal (2): `market_token`, `market_trending`

Install from the release tarball at [holbric.com/dl/holbric-0.2.0.tgz](https://holbric.com/dl/holbric-0.2.0.tgz). The package is not on the npm registry yet.

The same day:

- [holbric.com](https://holbric.com) went live.
- $HOLBRIC launched on Pons V2. Contract `0xE8D6AE09757769968d17eab44998A03E196217e7`, 18 decimals, total supply 1,000,000,000. Launch transaction: [0xd2fab0c31d23479800798e20838d487e0fead8412edc518fa885a6f3080ebaa9](https://robinhoodchain.blockscout.com/tx/0xd2fab0c31d23479800798e20838d487e0fead8412edc518fa885a6f3080ebaa9).
- 10,851,197.87 HOLBRIC (1.0851% of supply) was sent to the dead address `0x000000000000000000000000000000000000dEaD`. Transaction: [0x414093ea8e5e3ffba441e9a4420210c63af0763f25cec72efdcc5387f24586c7](https://robinhoodchain.blockscout.com/tx/0x414093ea8e5e3ffba441e9a4420210c63af0763f25cec72efdcc5387f24586c7).
