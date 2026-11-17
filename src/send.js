import { parseUnits, erc20Abi, encodeFunctionData, isAddress, getAddress } from "viem";
import { publicClient, resolveToken, fmt, addrLink } from "./chain.js";
import { requireWallet, checkLimit, store } from "./actions.js";
import { usdValue } from "./swap.js";

export async function prepareSend({ to, token, amount }) {
  const from = requireWallet();
  if (!isAddress(to || "")) throw new Error(`"${to}" is not a valid 0x address.`);
  const dest = getAddress(to);
  if (/^0x0{40}$/i.test(dest)) throw new Error("Refusing to send to the zero address.");
  if (!/^\d+(\.\d+)?$/.test(String(amount))) throw new Error("amount must be a positive decimal string, e.g. \"1.5\".");
  const t = await resolveToken(token || "ETH");
  const value = parseUnits(String(amount), t.decimals);
  if (value <= 0n) throw new Error("amount must be greater than zero.");
  const c = publicClient();
  const bal = t.native ? await c.getBalance({ address: from }) : await c.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [from] });
  if (bal < value) throw new Error(`Not enough ${t.symbol}: wallet holds ${fmt(bal, t.decimals, 18)}, send needs ${fmt(value, t.decimals, 18)}. Nothing was prepared.`);
  if (t.address && getAddress(t.address) === dest) throw new Error("The recipient is the token contract itself. Tokens sent there are usually lost. Nothing was prepared.");
  const code = await c.getCode({ address: dest });
  const isContract = !!code && code !== "0x";
  const usd = await usdValue(t, value).catch(() => null);
  checkLimit(usd);
  const tx = t.native
    ? { label: `send ${fmt(value, 18, 18)} ETH to ${dest}`, to: dest, value, data: "0x" }
    : { label: `transfer ${fmt(value, t.decimals, 18)} ${t.symbol} to ${dest}`, to: t.address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [dest, value] }) };
  const lines = [`Send ${fmt(value, t.decimals, 18)} ${t.symbol}${t.address ? ` (contract ${t.address})` : " (native)"} to ${dest}.`];
  if (/^0x0{36}dead$/i.test(dest)) lines.push("The recipient is the dead address: this is a burn and cannot be undone.");
  if (isContract) lines.push(`The recipient ${dest} is a contract, not a personal wallet. Make sure it can receive ${t.symbol}.`);
  if (t.unverified) lines.push("This token is not in Holbric's known list. Check the contract address with the user.");
  return store({ kind: "send", from, txs: [tx], lines, usd, extra: { recipient: { address: dest, isContract, explorer: addrLink(dest) } } });
}
