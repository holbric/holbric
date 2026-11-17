// Finds ERC-20 balance/allowance storage slots so quotes can be simulated with eth_call state overrides.
// Nothing is written on-chain; overrides exist only inside the simulated call.
import { keccak256, encodeAbiParameters, pad, toHex, erc20Abi } from "viem";
import { publicClient } from "./chain.js";

const cache = new Map();
const mapKey = (addr, slot) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [addr, BigInt(slot)]));
const nestedKey = (owner, spender, slot) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, mapKey(owner, slot)]));
const PROBE = 123456789123456789n;

export async function findSlots(token, holder) {
  const k = token.toLowerCase();
  if (cache.has(k)) return cache.get(k);
  const c = publicClient();
  let bal = null;
  for (let s = 0; s < 30 && bal == null; s++) {
    const v = await c.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder],
      stateOverride: [{ address: token, stateDiff: [{ slot: mapKey(holder, s), value: pad(toHex(PROBE)) }] }] }).catch(() => null);
    if (v === PROBE) bal = s;
  }
  if (bal == null) { cache.set(k, null); return null; }
  const spender = "0x000000000000000000000000000000000000bEEF";
  let allow = null;
  for (const s of [bal + 1, ...Array.from({ length: 30 }, (_, i) => i)]) {
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
