// Finds ERC-20 balance/allowance storage slots so quotes can be simulated with eth_call state overrides.
// Nothing is written on-chain; overrides exist only inside the simulated call.
import { keccak256, encodeAbiParameters, pad, toHex, erc20Abi } from "viem";
import { publicClient } from "./chain.js";

const cache = new Map();
const mapKey = (addr, slot) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [addr, BigInt(slot)]));
const nestedKey = (owner, spender, slot) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, mapKey(owner, slot)]));
const PROBE = 123456789123456789n;
// OpenZeppelin v5 upgradeable ERC20 keeps balances in the ERC-7201 namespace "openzeppelin.storage.ERC20" (allowances at +1).
const OZ_ERC20_NS = BigInt("0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00");
const BAL_SLOTS = [...Array.from({ length: 64 }, (_, i) => BigInt(i)), OZ_ERC20_NS];

export async function findSlots(token, holder) {
  const k = token.toLowerCase();
  if (cache.has(k)) return cache.get(k);
  const c = publicClient();
  let bal = null;
  for (const s of BAL_SLOTS) {
    if (bal != null) break;
    const v = await c.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder],
      stateOverride: [{ address: token, stateDiff: [{ slot: mapKey(holder, s), value: pad(toHex(PROBE)) }] }] }).catch(() => null);
    if (v === PROBE) bal = s;
  }
  if (bal == null) { cache.set(k, null); return null; }
  const spender = "0x000000000000000000000000000000000000bEEF";
  let allow = null;
  for (const s of [bal + 1n, ...Array.from({ length: 64 }, (_, i) => BigInt(i))]) {
    const v = await c.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [holder, spender],
      stateOverride: [{ address: token, stateDiff: [{ slot: nestedKey(holder, spender, s), value: pad(toHex(PROBE)) }] }] }).catch(() => null);
    if (v === PROBE) { allow = s; break; }
  }
  const out = allow == null ? null : { bal, allow };
  cache.set(k, out);
  return out;
}

/** State override giving `holder` `amount` of `token` and an allowance of `amount` for `spender`. */
export async function tokenOverride(token, holder, spender, amount) {
  const s = await findSlots(token, holder);
  if (!s) return null;
  return { address: token, stateDiff: [
    { slot: mapKey(holder, s.bal), value: pad(toHex(amount)) },
    { slot: nestedKey(holder, spender, s.allow), value: pad(toHex(amount)) },
  ] };
}
