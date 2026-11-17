// Wrap ETH into WETH and unwrap it back, on the WETH contract listed in docs.robinhood.com/chain/contracts.
import { parseAbi, parseUnits, encodeFunctionData, erc20Abi } from "viem";
import { publicClient, ADDR, fmt } from "./chain.js";
import { requireWallet, store } from "./actions.js";

const wethAbi = parseAbi(["function deposit() payable", "function withdraw(uint256 wad)"]);

function amountOf(amount) {
  if (!/^\d+(\.\d+)?$/.test(String(amount))) throw new Error("amount must be a positive decimal string, e.g. \"0.01\".");
  const v = parseUnits(String(amount), 18);
  if (v <= 0n) throw new Error("amount must be greater than zero.");
  return v;
}

export async function prepareWrap({ amount }) {
  const from = requireWallet();
  const v = amountOf(amount);
  const bal = await publicClient().getBalance({ address: from });
  if (bal <= v) throw new Error(`Not enough ETH: wallet holds ${fmt(bal, 18, 18)}, wrapping needs ${fmt(v, 18, 18)} plus the network fee. Nothing was prepared.`);
  const tx = { label: `wrap ${fmt(v, 18, 18)} ETH into WETH`, to: ADDR.WETH, value: v, data: encodeFunctionData({ abi: wethAbi, functionName: "deposit" }) };
  return store({ kind: "weth_wrap", from, txs: [tx], usd: 0, lines: [`Wrap ${fmt(v, 18, 18)} ETH into the same amount of WETH at ${ADDR.WETH} (deposit). 1 WETH always unwraps back to 1 ETH.`],
    valueLine: "The value stays in the wallet as WETH; only the network fee is paid." });
}

export async function prepareUnwrap({ amount }) {
  const from = requireWallet();
  const v = amountOf(amount);
  const bal = await publicClient().readContract({ address: ADDR.WETH, abi: erc20Abi, functionName: "balanceOf", args: [from] });
  if (bal < v) throw new Error(`Not enough WETH: wallet holds ${fmt(bal, 18, 18)}, unwrapping needs ${fmt(v, 18, 18)}. Nothing was prepared.`);
  const tx = { label: `unwrap ${fmt(v, 18, 18)} WETH into ETH`, to: ADDR.WETH, value: 0n, data: encodeFunctionData({ abi: wethAbi, functionName: "withdraw", args: [v] }) };
  return store({ kind: "weth_unwrap", from, txs: [tx], usd: 0, lines: [`Unwrap ${fmt(v, 18, 18)} WETH at ${ADDR.WETH} back into the same amount of ETH (withdraw).`],
    valueLine: "The value stays in the wallet as ETH; only the network fee is paid." });
}
