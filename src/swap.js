import { parseUnits, formatUnits, erc20Abi, encodeFunctionData, getAddress, isAddress, decodeEventLog } from "viem";
import { ADDR, publicClient, resolveToken, poolAddress, CHAIN_ID, fmt, localTime } from "./chain.js";
import { walletAddress } from "./keystore.js";
import { requireWallet, slippage, checkLimit, approveTx, store } from "./actions.js";

export const FEE_TIERS = [100, 500, 3000, 10000];
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002"; // SwapRouter02 constant

const quoterAbi = [{
  type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
  inputs: [{ name: "params", type: "tuple", components: [
    { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "amountIn", type: "uint256" },
    { name: "fee", type: "uint24" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }],
  outputs: [{ name: "amountOut", type: "uint256" }, { name: "sqrtPriceX96After", type: "uint160" },
    { name: "initializedTicksCrossed", type: "uint32" }, { name: "gasEstimate", type: "uint256" }],
}];
const routerAbi = [
  { type: "function", name: "exactInputSingle", stateMutability: "payable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "fee", type: "uint24" },
      { name: "recipient", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" }] }],
    outputs: [{ name: "amountOut", type: "uint256" }] },
  { type: "function", name: "unwrapWETH9", stateMutability: "payable",
    inputs: [{ name: "amountMinimum", type: "uint256" }, { name: "recipient", type: "address" }], outputs: [] },
  { type: "function", name: "multicall", stateMutability: "payable",
    inputs: [{ name: "deadline", type: "uint256" }, { name: "data", type: "bytes[]" }], outputs: [{ name: "results", type: "bytes[]" }] },
  { type: "function", name: "WETH9", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];


async function quoteTier(tIn, tOut, amountIn, fee) {
  const { result } = await publicClient().simulateContract({
    address: ADDR.QUOTER_V2, abi: quoterAbi, functionName: "quoteExactInputSingle",
    args: [{ tokenIn: poolAddress(tIn), tokenOut: poolAddress(tOut), amountIn, fee, sqrtPriceLimitX96: 0n }],
  });
  return { fee, amountOut: result[0], gasEstimate: result[3], ticksCrossed: Number(result[2]) };
}

export async function quote({ tokenIn, tokenOut, amount }) {
  const [tIn, tOut] = await Promise.all([resolveToken(tokenIn), resolveToken(tokenOut)]);
  if (poolAddress(tIn) === poolAddress(tOut)) throw new Error("tokenIn and tokenOut are the same asset (ETH and WETH share one pool side). Use a wrap, not a swap.");
  if (!/^\d+(\.\d+)?$/.test(String(amount))) throw new Error("amount must be a positive decimal string, e.g. \"5\" or \"0.25\".");
  const amountIn = parseUnits(String(amount), tIn.decimals);
  if (amountIn <= 0n) throw new Error("amount must be greater than zero.");
  const tries = await Promise.allSettled(FEE_TIERS.map((f) => quoteTier(tIn, tOut, amountIn, f)));
  const ok = tries.filter((t) => t.status === "fulfilled" && t.value.amountOut > 0n).map((t) => t.value);
  if (!ok.length) throw new Error(`No Uniswap v3 pool on Robinhood Chain quoted ${tIn.symbol} -> ${tOut.symbol} at any fee tier (${FEE_TIERS.join(", ")}).`);
  ok.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
  const best = ok[0];
  const block = await publicClient().getBlockNumber();
  const priceOutPerIn = Number(formatUnits(best.amountOut, tOut.decimals)) / Number(amount);
  return {
    tIn, tOut, amountIn, best, all: ok, block,
    view: {
      chainId: CHAIN_ID, block: block.toString(), quotedAt: new Date().toISOString(), quotedAtLocal: localTime(new Date()),
      venue: "Uniswap v3 QuoterV2 " + ADDR.QUOTER_V2,
      tokenIn: { symbol: tIn.symbol, address: tIn.address ?? "native", amount: fmt(amountIn, tIn.decimals, 18) },
      tokenOut: { symbol: tOut.symbol, address: tOut.address ?? "native", amountOut: fmt(best.amountOut, tOut.decimals, 18), amountOutRaw: best.amountOut.toString() },
      feeTier: `${best.fee / 10000}%`, price: `1 ${tIn.symbol} = ${priceOutPerIn.toPrecision(8)} ${tOut.symbol}`,
      gasEstimate: best.gasEstimate.toString(),
      otherTiers: ok.slice(1).map((q) => ({ feeTier: `${q.fee / 10000}%`, amountOut: fmt(q.amountOut, tOut.decimals, 18) })),
      ...(tIn.unverified || tOut.unverified ? { warning: "One token is not in Holbric's verified list (ETH, USDG, WETH). Check the contract on the explorer." } : {}),
    },
  };
}

/** USD value of an input amount: USDG is 1:1, everything else is quoted into USDG. */
export async function usdValue(tIn, amountIn) {
  if (tIn.address === ADDR.USDG) return Number(formatUnits(amountIn, 6));
  if (amountIn === 0n) return 0;
  const q = await quote({ tokenIn: tIn.native ? "ETH" : tIn.address, tokenOut: "USDG", amount: formatUnits(amountIn, tIn.decimals) });
  return Number(formatUnits(q.best.amountOut, 6));
}

export async function prepareSwap({ tokenIn, tokenOut, amount, slippageBps }) {
  const from = requireWallet();
  const slip = slippage(slippageBps);
  const q = await quote({ tokenIn, tokenOut, amount });
  const c = publicClient();
  const { tIn, tOut, amountIn, best } = q;
  const minOut = (best.amountOut * BigInt(10000 - slip)) / 10000n;
  const balance = tIn.native ? await c.getBalance({ address: from }) : await c.readContract({ address: tIn.address, abi: erc20Abi, functionName: "balanceOf", args: [from] });
  if (balance < amountIn) throw new Error(`Not enough ${tIn.symbol}: wallet ${from} holds ${fmt(balance, tIn.decimals, 18)}, swap needs ${fmt(amountIn, tIn.decimals, 18)}. Nothing was prepared.`);
  const usd = await usdValue(tIn, amountIn).catch(() => null);
  checkLimit(usd);
  const txs = [], lines = [];
  if (!tIn.native) {
    const allowance = await c.readContract({ address: tIn.address, abi: erc20Abi, functionName: "allowance", args: [from, ADDR.SWAP_ROUTER_02] });
    if (allowance < amountIn) {
      txs.push(approveTx(tIn.address, ADDR.SWAP_ROUTER_02, amountIn, tIn.symbol, tIn.decimals));
      lines.push(`Approve exactly ${fmt(amountIn, tIn.decimals, 18)} ${tIn.symbol} for Uniswap SwapRouter02 ${ADDR.SWAP_ROUTER_02} (current allowance ${fmt(allowance, tIn.decimals, 18)}). Not unlimited.`);
    }
  }
  const unwrap = tOut.native;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 15 * 60);
  const calls = [encodeFunctionData({ abi: routerAbi, functionName: "exactInputSingle", args: [{
    tokenIn: poolAddress(tIn), tokenOut: poolAddress(tOut), fee: best.fee, recipient: unwrap ? ADDRESS_THIS : from,
    amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] })];
  if (unwrap) calls.push(encodeFunctionData({ abi: routerAbi, functionName: "unwrapWETH9", args: [minOut, from] }));
  txs.push({ label: `swap ${fmt(amountIn, tIn.decimals, 18)} ${tIn.symbol} -> ${tOut.symbol} on Uniswap v3`, to: ADDR.SWAP_ROUTER_02,
    data: encodeFunctionData({ abi: routerAbi, functionName: "multicall", args: [deadline, calls] }), value: tIn.native ? amountIn : 0n });
  lines.push(`Swap ${fmt(amountIn, tIn.decimals, 18)} ${tIn.symbol} for at least ${fmt(minOut, tOut.decimals)} ${tOut.symbol} (expected ${fmt(best.amountOut, tOut.decimals)}) on Uniswap v3, fee tier ${best.fee / 10000}%. Slippage limit ${(slip / 100).toFixed(2)}%, deadline 15 minutes from now.`);
  const onReceipt = async (r) => {
    if (unwrap) return {};
    for (const log of r.logs) {
      if (getAddress(log.address) !== getAddress(poolAddress(tOut))) continue;
      try { const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
        if (ev.eventName === "Transfer" && getAddress(ev.args.to) === getAddress(from)) return { received: `${fmt(ev.args.value, tOut.decimals, 18)} ${tOut.symbol}` }; } catch {}
    }
    return {};
  };
  return store({ kind: "uniswap_swap", from, txs, lines, usd, onReceipt, slippageBps: slip, extra: { quote: q.view } });
}

export async function balances({ address, tokens = [] }) {
  const who = address || walletAddress();
  if (!who) throw new Error("No address given and no Holbric wallet yet.");
  if (!isAddress(who)) throw new Error(`Not an address: ${who}`);
  const c = publicClient();
  const list = [await resolveToken("USDG"), await resolveToken("WETH"), ...(await Promise.all(tokens.map(resolveToken)))];
  const [eth, block, ...erc] = await Promise.all([
    c.getBalance({ address: who }), c.getBlockNumber(),
    ...list.map((t) => c.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [who] })),
  ]);
  return {
    address: getAddress(who), chainId: CHAIN_ID, block: block.toString(), readAt: new Date().toISOString(),
    balances: [{ symbol: "ETH", type: "native", amount: fmt(eth, 18, 18), raw: eth.toString() },
      ...list.map((t, i) => ({ symbol: t.symbol, contract: t.address, amount: fmt(erc[i], t.decimals, 18), raw: erc[i].toString(), decimals: t.decimals }))],
  };
}

export async function routerWeth() {
  return publicClient().readContract({ address: ADDR.SWAP_ROUTER_02, abi: routerAbi, functionName: "WETH9" });
}
