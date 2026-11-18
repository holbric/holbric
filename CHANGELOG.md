# Changelog

Dates below are calendar dates in Asia/Jakarta. This is the public record of Holbric releases and on-chain events that have already happened. Nothing here is a promise about the future.

## 0.9.0 — 18 November 2026

42 tools across 9 projects on Robinhood Chain mainnet (chain id 4663). Holbric now reads Uniswap v4 liquidity positions and quotes and prepares adding, removing and collecting fees. Everything is prepared only and simulated on mainnet; nothing is signed.

- **PositionManager, verified first.** Uniswap v4 PositionManager `0x58daec3116aae6D93017bAAea7749052E8a04fA7` is an exact match on Sourcify as `src/PositionManager.sol:PositionManager`. On chain, `poolManager()`, `permit2()` and `WETH9()` return the PoolManager, Permit2 and WETH Holbric already pins. The create2 deploy at block 9073 (tx `0x228c18ada6cb46b4fbcc18f4ec1519953415393e256fa8349aafbd5a2db037c8`) encodes those same constructor arguments. Uniswap's "Robinhood Chain: 4663" deployment table lists this address. Positions are ERC-721s (`Uniswap v4 Positions NFT`, `UNI-V4-POSM`). The contract is not enumerable.
- **New `lp_positions`.** A wallet's Positions NFTs at one block: pool key, ticks, in-range status, liquidity, principal amounts and uncollected fees. Token ids come from Transfer logs from block 9073, or from `tokenId` / `tokenIds` you pass. Fees are computed from StateView fee growth the way `Position.update` does. Example at block 117113242: address `0x9701fb0aDe1E269c8f64Ec0C7b3cfADB31A13A52` held token ids 1 and 2 (`balanceOf` was 2, and the log scan recovered both, 24 requests, none failed). Position 1 was a hookless WETH/SMK4 0.3% full-range position (ticks -887220 to 887220), in range, liquidity 50000000000000, principal 0.000004553157887631 WETH and 0.000549069472594207 SMK4, uncollected fees 0.000062861960571016 WETH and 0.004924161159437917 SMK4.
- **New `quote_add_liquidity` and `prepare_add_liquidity`.** Mint a new NFT or increase an existing one. New mints are hookless only; if you do not name a fee, Holbric uses the most liquid live hookless standard-key pool for the pair. Ticks are given or `fullRange: true` (usable range for the tick spacing). Approvals are the exact maximum (used amount plus the slippage limit, default 0.5%) to Permit2, then an exact 30-minute Permit2 allowance for the PositionManager. Native ETH goes in as value; leftover ETH is swept back. Holbric does not initialize a new pool. Example at block 117113242: 0.01 ETH and 20 USDG, full range, used the most liquid hookless ETH/USDG pool (0.05%, pool id `0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982`), ticks -887270 to 887270, in range, expected 0.009999999999993797 ETH and 18.04885 USDG.
- **New `quote_remove_liquidity` and `prepare_remove_liquidity`.** Remove some or all liquidity. Omitting the amount removes all of it and burns the NFT. Tokens paid out are the principal plus uncollected fees. The PositionManager's slippage check is on the principal only; Holbric's minimums follow that.
- **New `quote_collect_lp_fees` and `prepare_collect_lp_fees`.** Collect fees with a decrease of 0 liquidity; the NFT stays. A zero-liquidity position cannot be poked. At block 117113448, a mainnet simulation of collecting position 1's fees (from the holder above, nothing signed) paid exactly the quoted amounts: 0.000062861960571016 WETH and 0.004924161159437917 SMK4. A simulation of burning position 2 paid its quoted WETH principal plus fees to the wei.
- **What is refused.** Minting into a hooked pool, including a graduated Pons V2 pool. An existing hooked position can still be read, and a remove or collect is prepared only if the hook allows it (the simulation is the check). Adding or removing on a v3 NonfungiblePositionManager is not in this release: swaps already use Uniswap v3, but that position manager is a different NFT contract and was not already in Holbric's verified address set.
- **Tests.** 311 checks pass: 182 live and 129 write simulations. All 280 earlier checks still pass. Live tests read the two Positions NFTs above (log scan matching `balanceOf` and `ownerOf(1)`), quote an ETH/USDG mint, quote a collect and a full remove, and refuse a Pons mint and the write tools on an empty wallet. Write simulations prepare and re-check a full-range ETH/USDG mint (native ETH in, exact USDG Permit2 allowance), a full-range WETH/USDG mint (exact Permit2 for both tokens, a different pool from the native ETH pool), a tight-range ETH/USDG mint around the current tick, and the refusals of a Pons mint and of collect/remove on an NFT this wallet does not own. Collect and burn of the public holder's positions are simulated from that address and checked against the quote to the wei. Nothing is signed.

Tool count per project: Wallet 9, Uniswap 12, Robinhood Stock Tokens 2, Pons V2 7, ERC-8004 3, KyberSwap 1, Morpho 3, Relay 3, GeckoTerminal 2.

Install from the [v0.9.0 release](https://github.com/holbric/holbric/releases/tag/v0.9.0). The package is not on the npm registry yet.

## 0.8.0 — 18 November 2026

35 tools across 9 projects on Robinhood Chain mainnet (chain id 4663). Holbric now bridges through Relay: quotes in both directions, a checked and simulated deposit for bridging out, and status for any Relay request.

- **Relay, verified first.** Relay's `/chains` lists Robinhood Chain (4663, protocol id `robinhood`) with ETH and USDG bridgeable and the RelayDepository `0x4cD00E387622C35bDDB9b4c962C136462338BC31`. That contract has code on chain and is an exact match on Sourcify as `RelayDepository`. Holbric pins it and refuses if `/chains` ever names another depository. Chains on the other side: Ethereum, Base, Arbitrum One, OP Mainnet and Unichain. ETH bridges to ETH; USDG bridges to USDG on Ethereum and to USDC elsewhere.
- **New `bridge_quote`.** Works in both directions. Returns Relay's expected output, guaranteed minimum (your slippage limit, default 0.5%), fee breakdown, total cost and time estimate, with the Robinhood Chain block. Labelled as Relay's figures. Example at block 117071566: 0.1 ETH from Robinhood Chain to Base, expected 0.099868739236507417 ETH, at least 0.09936939554032488 ETH, relayer fee 0.000131260763492583 ETH, Relay's estimate 1 second. At block 117071571, 100 USDG to Ethereum: expected 99.936242 USDG, at least 99.436561 USDG.
- **Relay's order is checked, not trusted.** Holbric follows Relay's input-validation guide. It recomputes the order id from the order data (EIP-712 `hashStruct`, the same types as Relay's settlement SDK; matched the SDK and Relay on 10 live quotes during development). Then it checks the order:
  - it pays exactly the token and amount asked, on Robinhood Chain;
  - one output, to the recipient, in the token asked, on the chain asked;
  - the guaranteed minimum is within the slippage limit;
  - no destination calls and no fees to anyone;
  - refunds on Robinhood Chain pay the wallet;
  - the deadline is ahead.
- **New `prepare_bridge`, out of Robinhood Chain only.** It builds an exact USDG approval when needed, then `depositNative` or `depositErc20` on the RelayDepository. Holbric encodes the deposit itself, with the wallet as depositor and the verified order id. It refuses if Relay's calldata differs by one byte, or if Relay asks for any other target or step. The recipient is the wallet's own address unless the user names another one; the summary then says NOT this wallet. The deposit is simulated on mainnet and must show exactly the deposit amount leaving to the depository, nothing else. `execute_prepared` re-simulates, and also refuses when Relay's order deadline is near.
- **What is not simulated.** The delivery on the other chain is done afterwards by Relay's solver. If it does not fill, Relay refunds to the wallet on Robinhood Chain, less refund gas. Holbric always sets `refundTo`.
- **Bridging in is quote-only.** Bridging into Robinhood Chain starts with a transaction on the other chain. Holbric only reads and simulates Robinhood Chain, so it does not build that transaction, and `bridge_quote` says so.
- **New `bridge_status`.** Takes a request id or a transaction hash. Returns Relay's status, the deposit and fill transactions with explorer links, amounts, and failure or refund reasons. For a deposit on Robinhood Chain it also reads the receipt and decodes the RelayDepository event: sender, depositor, amount and order id.
- **Privacy and opt-out.** Relay is a third-party API:
  - `bridge_quote` sends the chains, tokens and amount, and quotes for a placeholder address, not your wallet;
  - `prepare_bridge` sends the wallet address (sender and refund address) and the recipient;
  - `bridge_status` sends the id or hash you ask about.

  To turn it off, set `HOLBRIC_NO_BRIDGES=1` or run `holbric bridges off`; the bridge tools then refuse and nothing is sent. `chain_status` shows the setting.
- **No fees.** Relay's fees are inside its quote and shown. No Holbric fee, no app fee, no referrer.
- **Fix.** `portfolio` now values Pons V2 tokens on a curve paired with a token other than ETH, such as a Robinhood Stock Token. The curve quote goes into the pair token, then Holbric's own quote takes that into USDG. Before, such a token showed no price.
- **Tests.** 280 checks, all passing: 166 live and 114 write simulations. All 213 earlier checks still pass. New live checks (40):
  - the depository's code and Sourcify match, and Relay's `/chains` entry;
  - quotes out to Base, Ethereum and Arbitrum One, and in from Base;
  - refusals for unsupported chains and tokens;
  - `bridge_status` on the latest finished Relay request out of Robinhood Chain, by hash and by id, against the on-chain deposit event;
  - the local order id against Relay's;
  - ten tampered orders, each refused;
  - no wallet address in quotes, both opt-outs, and the API being down.

  New write simulations (27):
  - deposits of ETH to Base, USDG to Ethereum, USDG to Arbitrum One, and ETH to a named recipient on OP Mainnet;
  - six tampered Relay answers, each refused: wrong target, wrong depositor, wrong recipient, an app fee, an unlimited approval, another depository in `/chains`;
  - `execute_prepared` refusing at the order deadline.

  Nothing is signed.

Tool count per project: Wallet 9, Uniswap 5, Robinhood Stock Tokens 2, Pons V2 7, ERC-8004 3, KyberSwap 1, Morpho 3, Relay 3, GeckoTerminal 2.

## 0.7.0 — 18 November 2026

32 tools across 8 projects on Robinhood Chain mainnet (chain id 4663). Holbric now reads Morpho lending and values a whole wallet. Everything new in this release is read-only: no new write tools.

- **Morpho, read on chain.** Morpho Blue `0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010`, AdaptiveCurveIrm `0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1` and VaultV2Factory `0x0FBad98595b0186dA120E41f77C102beb49f803c` come from Morpho's own address registry ([morpho-org/sdks](https://github.com/morpho-org/sdks/blob/main/packages/morpho-ts/src/addresses.ts), `RobinhoodMainnet = 4663`). Each has code on chain and is verified on Sourcify for chain 4663. Markets are found from Morpho Blue's `CreateMarket` events (540 at release), vaults from the factory's `CreateVaultV2` events (122). Every figure is read at one block, with interest accrued to the block time the way Morpho Blue does it.
- **New `morpho_markets`.** Loan and collateral token (with addresses, and whether each is USDG, WETH, cbBTC, an official Robinhood Stock Token or a Pons V2 launch), LLTV, oracle and its price, IRM, supply, borrow, liquidity, utilization, and supply and borrow APY computed from the IRM's `borrowRateView`. By default only markets listed in Morpho's app are shown; that flag is the one thing taken from Morpho's API (`api.morpho.org`). If the API is down, Holbric says so and shows only markets whose tokens are all in its own lists. At block 117041747 the largest listed market lent 358,514,434 USDG against USDe at 88.9% utilization, supply APY 3.945%, borrow APY 4.437%.
- **New `morpho_position`.** Any address's positions across every market: supplied, borrowed, collateral, health factor, LTV, oracle price, liquidation price and the drop to it, plus Morpho Vault V2 shares and what they are worth. On chain only; no API. Example at block 117041727: a Safe (`0x498752D5fa0600CBd613074C151Abe15B3FeC7CB`) borrowed 380,528.014123 USDG against 4,662.439341 NVDA in the NVDA/USDG market `0x8b16891f…c3e` (LLTV 62.5%). The oracle had NVDA at 159.94919 USDG, health factor 1.2249, liquidation at 130.58504 USDG, 18.36% lower.
- **New `morpho_vaults`.** Vault V2 vaults from the factory (each confirmed with `isVaultV2`), asset, total assets at the block, owner, curator and fees. The APY shown is Morpho's API figure, labelled as such: the public RPC keeps no historical state, so Holbric cannot measure share-price growth itself. The registry lists no MetaMorpho (vault V1) factory for this chain.
- **New `portfolio`.** What an address holds at one block: ETH, WETH, USDG, cbBTC, all official Robinhood Stock Tokens (203 at release), tokens that reached it in the last 24 hours (Transfer logs, up to 72 hours), tokens you name, and its Morpho positions and vault shares, with debt counted as negative. Prices are Holbric's own Uniswap v3/v4 quotes into USDG for a small amount; Pons V2 tokens still on their curve are quoted on the curve. Next to the total it gives a sell-everything-now total from full-size quotes, so thin pools show up. No price feed or aggregator API is asked. Tokens outside Holbric's lists are listed but not valued unless you name them.
- **No PnL, on purpose.** An honest PnL needs the price of every token at every past transfer. The public RPC keeps no historical state, so past blocks cannot be quoted, and Holbric will not guess a cost basis. `portfolio` says this in every answer.
- **Fix.** `pons_quote` on a bonding curve failed when no Holbric wallet existed yet: its probe address was not checksummed. It works now, and a live check covers it.
- **Partial reads are refused.** Morpho reads go through Multicall3 at one block. Failed batches are retried twice. If any market or position read still fails, the tool says so instead of returning a partial list.
- **Tests.** 213 checks, all passing: 126 live and 87 write simulations. All 169 earlier checks still pass. New live checks (44):
  - the three Morpho addresses have code and are verified on Sourcify under their contract names;
  - logged market params hash to the market id and match `idToMarketParams` on chain;
  - listed markets, the unlisted switch and the token filter;
  - the on-chain supply APY is within 10% of Morpho's API figure;
  - the Safe's health factor matches a recomputation from raw `position`, `market` and oracle reads;
  - vault shares match `convertToAssets`, and every vault returned passes `isVaultV2`;
  - `portfolio` totals add up, debt is negative, a Pons token on its curve is valued on the curve, and the empty test wallet is $0;
  - `portfolio` contacts no host other than the RPC and Robinhood's token list;
  - with Morpho's API down, `morpho_markets` still answers from chain.

  Nothing is signed.

Tool count per project: Wallet 9, Uniswap 5, Robinhood Stock Tokens 2, Pons V2 7, ERC-8004 3, KyberSwap 1, Morpho 3, GeckoTerminal 2.

Install from the [v0.7.0 release](https://github.com/holbric/holbric/releases/tag/v0.7.0). The package is not on the npm registry yet.

## 0.6.0 — 18 November 2026

28 tools across 7 projects on Robinhood Chain mainnet (chain id 4663). Every swap quote now gets a second opinion from the KyberSwap aggregator. Holbric only takes it after simulating it on mainnet.

- **KyberSwap next to Holbric's own routing.** With `venue: "best"` (the default), `quote_swap`, `find_route` and `prepare_swap` ask the KyberSwap Aggregator API (`aggregator-api.kyberswap.com/robinhood`) for the same swap. They also quote Holbric's own Uniswap v3 and v4 routes. KyberSwap's figure is not trusted on its own. Holbric builds KyberSwap's transaction for a throwaway address, gives that address the input by state override, and simulates the router call with `eth_simulateV1`. KyberSwap wins only if that simulated output beats Holbric's best route. New venues: `"native"` (v3 and v4 only, nothing sent to KyberSwap) and `"kyber"` (KyberSwap only).
- **New `compare_quotes`.** Holbric's best route and KyberSwap's route side by side at one block, with the block time. It shows KyberSwap's API figure, its simulated figure, and which one wins by how much. Example at block 117012359, selling 0.05 AMZN for ETH: Holbric 0.007140204331445412 ETH (AMZN → USDG → ETH on Uniswap v4), KyberSwap 0.007158546347770614 ETH simulated (AMZN → SPY → WETH). KyberSwap was ahead by 0.2568%. At block 117012644, buying AMZN with 0.01 ETH, KyberSwap's API said 0.069772216299223904 AMZN, but its route simulated to 0.06957178323476682. Holbric's own route gave 0.069627588112801698, so Holbric kept it.
- **Swaps through KyberSwap.** `prepare_swap` builds a KyberSwap transaction for the wallet only when KyberSwap's quote is ahead. Holbric decodes the calldata and refuses it unless:
  - the router is MetaAggregationRouterV2 `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` and the executor is `0x8F10B468b06c6FD214B65F87778827F7D113f996` (both from KyberSwap's docs; the router is an exact match on Sourcify for chain 4663);
  - the tokens and amount match the request, and the output goes to the wallet;
  - the minimum output is at least the KyberSwap output minus the slippage limit;
  - no fee receivers, permit or extra fee are set.

  The approval is for the exact input amount, to that router. The transaction is simulated from the wallet. It must deliver its minimum output, take no more than the input amount, and still beat the native route. Otherwise Holbric prepares the native route and says why.
- **Minimum output checked before signing.** Every swap, native or KyberSwap, now checks in the pre-sign simulation that the wallet receives at least the minimum output. `execute_prepared` checks it again before signing.
- **Fallback and opt-out.** If KyberSwap is unreachable, rate limited, or returns something that fails these checks, Holbric uses its own route. `venue: "kyber"` refuses instead. Set `HOLBRIC_NO_AGGREGATORS=1` or run `holbric aggregators off` to send nothing to KyberSwap. `chain_status` shows the setting.
- **Privacy.** KyberSwap is a third-party API. A quote sends it the token addresses and the amount. `prepare_swap` also sends the wallet address, but only when KyberSwap's quote is ahead.
- **No fees.** No Holbric fee. Holbric sends no fee or referral parameters to KyberSwap and refuses KyberSwap routes or calldata that carry one.
- **Tests.** 169 checks, all passing: 82 live and 87 write simulations. All 122 earlier checks still pass. Six live route-shape checks and two v4 write simulations now pin `venue: "native"`, because KyberSwap can win those swaps with a different route. New live checks:
  - the router and executor have code on chain, and the router is an exact match on Sourcify;
  - `compare_quotes` picks the larger simulated output;
  - `quote_swap` and `find_route` report KyberSwap next to the native route;
  - the opt-out sends nothing to KyberSwap;
  - an unreachable API falls back to the native route;
  - calldata that pays another address is refused, and so is a route that carries a fee.

  New write simulations prepare and re-check KyberSwap swaps with native ETH in, USDG in (exact approval to the KyberSwap router, native ETH out) and AMZN in. They also check the fallback, the opt-out, and that `execute_prepared` refuses when the output falls below the minimum. Nothing is signed.

Tool count per project: Wallet 8, Uniswap 5, Robinhood Stock Tokens 2, Pons V2 7, ERC-8004 3, KyberSwap 1, GeckoTerminal 2.

Install from the [v0.6.0 release](https://github.com/holbric/holbric/releases/tag/v0.6.0). The package is not on the npm registry yet.

## 0.5.0 — 18 November 2026

27 tools across 6 projects on Robinhood Chain mainnet (chain id 4663). Uniswap v4 sits next to v3, and Holbric now trades graduated Pons tokens on their v4 pools.

- **v3 and v4 compared.** `quote_swap`, `find_route` and `prepare_swap` now quote Uniswap v4 routes next to v3 routes and take the better output (`venue: "best"` by default, or `"v3"` / `"v4"`). v4 pools are read by key from StateView `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` and quoted with V4Quoter `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94`: hookless pools at the four standard keys, direct or 2 hops through native ETH, USDG and cbBTC. A route stays on one version.
- **Graduated Pons tokens.** Once a launch leaves its bonding curve, `pons_token` reads the price from its v4 pool, and `pons_quote` and `prepare_pons_trade` trade on that pool. The pool key comes from the Pons factory record (pair token, pool fee, tick spacing) with the Pons V2 hook `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044`, and the hook must list the pool as registered. Other routes can reach these pools too, for example USDG → ETH → ORBIT.
- **New `v4_pools` and `quote_v4`.** Pool ids, keys, liquidity, price, tick and fees for a pair, and v4-only quotes, including on a pool key you name.
- **Swaps on v4.** Through Universal Router 2.1.2 `0x204FAca1764B154221e35c0d20aBb3c525710498` with one `V4_SWAP` command (`SWAP_EXACT_IN_SINGLE` or `SWAP_EXACT_IN`, `SETTLE_ALL`, `TAKE_ALL`). Native ETH goes in as value and comes out as ETH. A token input is pulled through Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` with an exact ERC-20 approval and an exact allowance that expires after 30 minutes. Pools with unknown hooks are refused. The same minimum output, mainnet simulation and `execute_prepared` re-check apply.
- **Tests.** Live tests check the derived Pons pool key against the PoolManager's own `Initialize` event, read v4 pools, and quote v4 routes and the graduated ORBIT pool. The write simulations prepare and re-check v4 swaps with native ETH in, Permit2 input, native ETH out, a 2-hop v4 route into a Pons pool, graduated Pons buys and sells, and the refusal of a worse result and of an unknown hook. Three v3 multi-hop simulations now pin `venue: "v3"`, because v4 can win those routes. Nothing is signed.

Tool count per project: Wallet 8, Uniswap 5, Robinhood Stock Tokens 2, Pons V2 7, ERC-8004 3, GeckoTerminal 2.

Install from the [v0.5.0 release](https://github.com/holbric/holbric/releases/tag/v0.5.0). The package is not on the npm registry yet.

## 0.4.0 — 18 November 2026

25 tools across 6 projects on Robinhood Chain mainnet (chain id 4663). Uniswap v3 swaps now find their own route, including 2-hop routes.

- **Multi-hop routing.** `quote_swap` and `prepare_swap` read pools from the Uniswap v3 factory `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`: the direct pair at all four fee tiers, plus 2-hop routes through WETH, USDG and cbBTC. Each path is quoted with QuoterV2 `quoteExactInput` and the best output wins. Tokens with no direct pool against your input, such as several Robinhood Stock Tokens, can now be quoted and swapped (ETH → USDG → AMZN, USDG → WETH → BMNR).
- **New `find_route`.** Lists every route that was compared, with pool addresses, gas estimates and how far each is from the best.
- **Swaps.** 2-hop routes go through SwapRouter02 `exactInput` inside `multicall`, with the same exact-amount approvals, slippage-based minimum output, pre-sign simulation and `execute_prepared` re-check as direct swaps. The summary now shows the route, the pools and the next best routes.
- **Simulation.** Balance overrides now also find tokens that keep balances in OpenZeppelin's ERC-7201 storage namespace, which the Robinhood Stock Tokens use. This lets the test suite simulate stock token sells.
- **Tests.** Live tests check the factory has no direct pool for the multi-hop cases, then quote them. The write simulations prepare and re-check ETH → AMZN, USDG → BMNR (with an exact approval) and AMZN → ETH (with the WETH unwrap). Nothing is signed.

Tool count per project: Wallet 8, Uniswap v3 3, Robinhood Stock Tokens 2, Pons V2 7, ERC-8004 3, GeckoTerminal 2.

Install from the [v0.4.0 release](https://github.com/holbric/holbric/releases/tag/v0.4.0). The package is not on the npm registry yet.

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
