import { erc20Abi, isAddress, getAddress } from "viem";
import { publicClient, SOURCIFY, ADDR, addrLink, fmt, getJson } from "./chain.js";
import { findStock } from "./stocks.js";
import ponsAbi from "./abi/pons-factory.json" with { type: "json" };

export async function sourcify(address) {
  try {
    const r = await getJson(`${SOURCIFY}/${address}?fields=compilation`, 10000);
    return { match: r.match || null, contractName: r.compilation?.name || null, source: `${SOURCIFY}/${address}` };
  } catch { return { match: null, contractName: null, source: `${SOURCIFY}/${address}` }; }
}

export async function tokenInfo({ token }) {
  if (!isAddress(token || "")) throw new Error("token must be a 0x contract address on Robinhood Chain.");
  const address = getAddress(token);
  const c = publicClient();
  const code = await c.getCode({ address });
  if (!code || code === "0x") throw new Error(`No contract at ${address} on Robinhood Chain mainnet.`);
  const rd = (fn, args = []) => c.readContract({ address, abi: erc20Abi, functionName: fn, args }).catch(() => null);
  const [name, symbol, decimals, supply, dead] = await Promise.all([rd("name"), rd("symbol"), rd("decimals"), rd("totalSupply"), rd("balanceOf", ["0x000000000000000000000000000000000000dEaD"])]);
  const [verify, stock, pons] = await Promise.all([
    sourcify(address), findStock(address).catch(() => null),
    c.readContract({ address: ADDR.PONS_FACTORY, abi: ponsAbi, functionName: "getLaunchedToken", args: [address] }).catch(() => null),
  ]);
  const d = decimals == null ? null : Number(decimals);
  return {
    address, explorer: addrLink(address), bytecodeBytes: (code.length - 2) / 2,
    erc20: { name, symbol, decimals: d, totalSupply: supply != null && d != null ? fmt(supply, d, 6) : null, deadAddressBalance: dead != null && d != null ? fmt(dead, d, 6) : null },
    sourcify: verify,
    robinhoodStockToken: stock ? { symbol: stock.symbol, name: stock.name, multiplier: stock.multiplier } : false,
    ponsV2: pons && pons.exists ? { curve: pons.curve, deployer: pons.deployer, phase: Number(pons.phase), pairToken: /^0x0{40}$/i.test(pons.pairToken) ? "native ETH" : pons.pairToken } : false,
  };
}
