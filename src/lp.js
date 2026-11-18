// Uniswap v4 liquidity positions on Robinhood Chain mainnet, through the verified PositionManager.
//
// PositionManager 0x58daec3116aae6D93017bAAea7749052E8a04fA7 is an exact match on Sourcify as
// src/PositionManager.sol:PositionManager. On chain, poolManager(), permit2() and WETH9() return the
// same PoolManager, Permit2 and WETH Holbric already pins. The create2 deploy (tx 0x228c18ada6cb46b4fbcc18f4ec1519953415393e256fa8349aafbd5a2db037c8,
// block 9073) encodes those same constructor arguments, and Uniswap's "Robinhood Chain: 4663" deployment
// table lists this address. Positions are ERC-721s ("Uniswap v4 Positions NFT"); the contract is not
// enumerable, so a wallet's token ids are recovered from its Transfer logs, starting at that deploy block.
//
// Reads never sign. Every write is prepared only and simulated on mainnet; nothing is signed here.
import {
  encodeAbiParameters, encodeFunctionData, encodePacked, erc20Abi, getAddress, isAddress, pad, parseAbi,
  parseAbiItem, parseUnits, toHex,
} from "viem";
import { ADDR, CHAIN_ID, publicClient, resolveToken, fmt, addrLink, EXPLORER } from "./chain.js";
import { currencyOf, makeKey, poolId, poolState, priceFromSqrt, isAllowedHook, isPonsKey, candidateKeys, NATIVE, permit2Abi } from "./v4.js";
import { walletAddress } from "./keystore.js";
import { requireWallet, store, slippage, checkLimit, approveTx } from "./actions.js";
import { usdValue } from "./swap.js";
import {
  getSqrtPriceAtTick, getLiquidityForAmounts, getAmountsForLiquidity, feesFromGrowth,
  unpackPositionInfo, inRange, nearestUsableTick, minUsableTick, maxUsableTick, requireUint128,
} from "./lpmath.js";

export const POSITION_MANAGER = ADDR.V4_POSITION_MANAGER;
export const PM_FROM_BLOCK = 9073n; // create2 deploy, receipt checked on chain
const LOG_SPAN = 10_000_000n; // public RPC cap for address-filtered getLogs
const MULTICALL3 = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11");
const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const ZERO = "0x0000000000000000000000000000000000000000";
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed id)");
const FEE_TO_SPACING = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

const INCREASE_LIQUIDITY = 0x00, DECREASE_LIQUIDITY = 0x01, MINT_POSITION = 0x02, BURN_POSITION = 0x03;
const SETTLE_PAIR = 0x0d, TAKE_PAIR = 0x11, SWEEP = 0x14;

const pmAbi = [
  { type: "function", name: "modifyLiquidities", stateMutability: "payable",
    inputs: [{ name: "unlockData", type: "bytes" }, { name: "deadline", type: "uint256" }], outputs: [] },
  { type: "function", name: "getPoolAndPositionInfo", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "poolKey", type: "tuple", components: [
        { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
        { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
      ] },
      { name: "info", type: "uint256" },
    ] },
  { type: "function", name: "getPositionLiquidity", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "liquidity", type: "uint128" }] },
  { type: "function", name: "ownerOf", stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }], outputs: [{ name: "owner", type: "address" }] },
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nextTokenId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];
const svPosAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)",
  "function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)",
]);

const POOL_KEY_T = { type: "tuple", components: [
  { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
] };
const pct = (fee) => `${Number(fee) / 10000}%`;
const deadlineIn = (min) => BigInt(Math.floor(Date.now() / 1000) + min * 60);
const saltOf = (tokenId) => pad(toHex(BigInt(tokenId)), { size: 32 });
const hookKind = (hooks) => {
  const h = getAddress(hooks);
  if (h === NATIVE) return "hookless";
  if (h === ADDR.PONS_HOOK) return "Pons V2 hook";
  return `unknown hook ${h}`;
};

async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = { ok: true, value: await fn(items[k], k) }; } catch (e) { out[k] = { ok: false, error: e }; } }
  }));
  return out;
}

function parseDec(amount, decimals, label) {
  if (amount == null || amount === "") return 0n;
  if (!/^\d+(\.\d+)?$/.test(String(amount).trim())) throw new Error(`${label} must be a positive decimal string, e.g. "5" or "0.25".`);
  const v = parseUnits(String(amount).trim(), decimals);
  if (v < 0n) throw new Error(`${label} must not be negative.`);
  return v;
}

async function resolveCurrency(cur) {
  if (cur == null) throw new Error("A currency is required.");
  if (typeof cur === "string" && (cur.trim() === "" || /^0x0{40}$/i.test(cur.trim()) || cur.trim().toUpperCase() === "ETH")) return resolveToken("ETH");
  return resolveToken(cur);
}

function requireAddress(label, value, { optional = false } = {}) {
  if (value == null || value === "") {
    if (optional) return null;
    throw new Error(`${label} is required.`);
  }
  if (!isAddress(value)) throw new Error(`${label} is not an address: ${value}`);
  return getAddress(value);
}

function parseTokenId(tokenId) {
  if (tokenId == null || tokenId === "") throw new Error("tokenId is required.");
  const s = String(tokenId).trim();
  if (!/^\d+$/.test(s)) throw new Error("tokenId must be a whole number (the Uniswap v4 Positions NFT id).");
  return BigInt(s);
}

/** Who we are listing positions for: an explicit address, or the Holbric wallet. */
function whoOf(address) {
  if (address) {
    if (!isAddress(address)) throw new Error(`Not an address: ${address}`);
    return getAddress(address);
  }
  const w = walletAddress();
  if (!w) throw new Error("No address given and no Holbric wallet yet.");
  return w;
}

async function getLogsRetry(args, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await publicClient().getLogs(args); }
    catch (e) {
      last = e;
      const msg = String(e?.details || e?.shortMessage || e?.message || e);
      if (!/too many requests|429|rate|timeout|timed out|ECONNRESET|503|502/i.test(msg) || i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1) * (i + 1)));
    }
  }
  throw last;
}

/** Transfer logs for one wallet, from the PositionManager deploy block to `toBlock`, in 10M-block chunks. */
async function positionTransfers(owner, toBlock) {
  const jobs = [];
  for (let f = PM_FROM_BLOCK; f <= toBlock; f += LOG_SPAN) {
    const t = f + LOG_SPAN - 1n > toBlock ? toBlock : f + LOG_SPAN - 1n;
    jobs.push({ f, t, dir: "to" }, { f, t, dir: "from" });
  }
  const res = await mapLimit(jobs, 3, (j) => getLogsRetry({
    address: POSITION_MANAGER, event: TRANSFER, args: j.dir === "to" ? { to: owner } : { from: owner },
    fromBlock: j.f, toBlock: j.t,
  }));
  const failed = res.filter((r) => !r.ok).length;
  const logs = res.flatMap((r) => (r.ok ? r.value : [])).sort((a, b) => {
    const d = a.blockNumber - b.blockNumber;
    return d === 0n ? a.logIndex - b.logIndex : Number(d);
  });
  return { logs, requests: jobs.length, failedRequests: failed, fromBlock: PM_FROM_BLOCK, toBlock };
}

function idsFromTransfers(logs, owner) {
  const held = new Set();
  for (const l of logs) {
    const id = l.args.id;
    if (getAddress(l.args.to) === owner) held.add(id);
    if (getAddress(l.args.from) === owner) held.delete(id);
  }
  return [...held].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function multi(contracts, blockNumber) {
  if (!contracts.length) return [];
  const run = (list, batchSize) => publicClient().multicall({ contracts: list, blockNumber, allowFailure: true, multicallAddress: MULTICALL3, batchSize })
    .catch((e) => list.map(() => ({ status: "failure", error: e })));
  const out = await run(contracts, 16_384);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const idx = out.map((r, i) => (r.status === "success" ? -1 : i)).filter((i) => i >= 0);
    if (!idx.length) break;
    await new Promise((r) => setTimeout(r, 400 * attempt));
    const again = await run(idx.map((i) => contracts[i]), 4_096);
    idx.forEach((i, k) => { out[i] = again[k]; });
  }
  return out;
}

const metaCache = new Map();
async function currencyMeta(address) {
  const key = getAddress(address);
  if (metaCache.has(key)) return metaCache.get(key);
  const t = await resolveCurrency(key);
  metaCache.set(key, t);
  return t;
}

function hookNote(hooks) {
  const h = getAddress(hooks);
  if (h === NATIVE) return null;
  if (h === ADDR.PONS_HOOK) return "This pool uses the Pons V2 hook. Holbric will not mint a new position here; an existing position can still be read, and a remove or collect is prepared only if the hook allows it (the mainnet simulation is the check).";
  return `This pool uses hook ${h}, which Holbric does not treat as a known hook. It will not mint a new position here. An existing position can still be read; a change is prepared only if the hook allows it.`;
}

/** Load one or more token ids at a single block: pool key, ticks, liquidity, amounts, uncollected fees, in-range. */
export async function loadPositions(tokenIds, blockNumber) {
  if (!tokenIds.length) return [];
  const c = publicClient();
  const block = blockNumber ?? await c.getBlockNumber();
  const infoCalls = tokenIds.flatMap((id) => ([
    { address: POSITION_MANAGER, abi: pmAbi, functionName: "getPoolAndPositionInfo", args: [id] },
    { address: POSITION_MANAGER, abi: pmAbi, functionName: "getPositionLiquidity", args: [id] },
    { address: POSITION_MANAGER, abi: pmAbi, functionName: "ownerOf", args: [id] },
  ]));
  const infos = await multi(infoCalls, block);
  const rows = tokenIds.map((id, i) => {
    const pk = infos[i * 3], liq = infos[i * 3 + 1], own = infos[i * 3 + 2];
    if (pk.status !== "success" || own.status !== "success") {
      return { tokenId: id.toString(), error: "not a current Uniswap v4 Positions NFT (burned or never minted)" };
    }
    const [poolKey, packed] = pk.result;
    const ticks = unpackPositionInfo(packed);
    const liquidity = liq.status === "success" ? liq.result : 0n;
    return {
      tokenId: id, poolKey: { currency0: getAddress(poolKey.currency0), currency1: getAddress(poolKey.currency1), fee: Number(poolKey.fee), tickSpacing: Number(poolKey.tickSpacing), hooks: getAddress(poolKey.hooks) },
      tickLower: ticks.tickLower, tickUpper: ticks.tickUpper, hasSubscriber: ticks.hasSubscriber,
      liquidity, owner: getAddress(own.result), poolId: poolId(poolKey),
    };
  });
  const live = rows.filter((r) => !r.error);
  const uniquePools = [...new Map(live.map((r) => [r.poolId, r.poolKey])).entries()];
  const slotCalls = uniquePools.map(([id]) => ({ address: ADDR.V4_STATE_VIEW, abi: svPosAbi, functionName: "getSlot0", args: [id] }));
  const slots = await multi(slotCalls, block);
  const slotBy = new Map();
  uniquePools.forEach(([id], i) => { if (slots[i].status === "success") slotBy.set(id, slots[i].result); });

  const feeCalls = live.map((r) => ({ address: ADDR.V4_STATE_VIEW, abi: svPosAbi, functionName: "getFeeGrowthInside", args: [r.poolId, r.tickLower, r.tickUpper] }));
  const posCalls = live.map((r) => ({ address: ADDR.V4_STATE_VIEW, abi: svPosAbi, functionName: "getPositionInfo", args: [r.poolId, POSITION_MANAGER, r.tickLower, r.tickUpper, saltOf(r.tokenId)] }));
  const [feeRes, posRes] = await Promise.all([multi(feeCalls, block), multi(posCalls, block)]);

  const currencies = [...new Set(live.flatMap((r) => [r.poolKey.currency0, r.poolKey.currency1]))];
  await Promise.all(currencies.map(currencyMeta));

  return rows.map((r) => {
    if (r.error) return r;
    const i = live.indexOf(r);
    const slot = slotBy.get(r.poolId);
    if (!slot) return { ...viewBase(r), error: "could not read pool state from StateView at this block" };
    const [sqrtPriceX96, tick, protocolFee, lpFee] = slot;
    const t0 = metaCache.get(r.poolKey.currency0), t1 = metaCache.get(r.poolKey.currency1);
    const sqrtA = getSqrtPriceAtTick(r.tickLower), sqrtB = getSqrtPriceAtTick(r.tickUpper);
    const principal = getAmountsForLiquidity(sqrtPriceX96, sqrtA, sqrtB, r.liquidity);
    let fees0 = 0n, fees1 = 0n, feeOk = false;
    if (feeRes[i].status === "success" && posRes[i].status === "success") {
      const [g0, g1] = feeRes[i].result;
      const [, last0, last1] = posRes[i].result;
      fees0 = feesFromGrowth(r.liquidity, g0, last0);
      fees1 = feesFromGrowth(r.liquidity, g1, last1);
      feeOk = true;
    }
    const inside = inRange(Number(tick), r.tickLower, r.tickUpper);
    const price = priceFromSqrt(sqrtPriceX96, t0.decimals, t1.decimals);
    const hook = hookKind(r.poolKey.hooks);
    return {
      tokenId: r.tokenId.toString(),
      owner: r.owner,
      explorer: `${EXPLORER}/token/${POSITION_MANAGER}/instance/${r.tokenId}`,
      poolId: r.poolId,
      poolKey: r.poolKey,
      hook,
      fee: pct(r.poolKey.fee),
      tickSpacing: r.poolKey.tickSpacing,
      tickLower: r.tickLower,
      tickUpper: r.tickUpper,
      currentTick: Number(tick),
      inRange: inside,
      rangeStatus: inside ? "in range" : (Number(tick) < r.tickLower ? "below range (only currency0)" : "above range (only currency1)"),
      liquidity: r.liquidity.toString(),
      token0: tokenView(t0, r.poolKey.currency0),
      token1: tokenView(t1, r.poolKey.currency1),
      principal: {
        token0: fmt(principal.amount0, t0.decimals, 18),
        token1: fmt(principal.amount1, t1.decimals, 18),
        token0Raw: principal.amount0.toString(),
        token1Raw: principal.amount1.toString(),
      },
      uncollectedFees: feeOk ? {
        token0: fmt(fees0, t0.decimals, 18),
        token1: fmt(fees1, t1.decimals, 18),
        token0Raw: fees0.toString(),
        token1Raw: fees1.toString(),
      } : { error: "could not read fee growth from StateView at this block" },
      ifWithdrawnNow: feeOk ? {
        token0: fmt(principal.amount0 + fees0, t0.decimals, 18),
        token1: fmt(principal.amount1 + fees1, t1.decimals, 18),
      } : undefined,
      lpFee: pct(lpFee),
      protocolFee: Number(protocolFee),
      price: `1 ${sym(t0)} = ${price.toPrecision(8)} ${sym(t1)}`,
      hasSubscriber: r.hasSubscriber,
      hookNote: hookNote(r.poolKey.hooks),
      _raw: { ...r, sqrtPriceX96, tick: Number(tick), principal, fees0, fees1, t0, t1 },
    };
  });
}

function viewBase(r) {
  return { tokenId: r.tokenId.toString(), owner: r.owner, poolId: r.poolId, poolKey: r.poolKey, tickLower: r.tickLower, tickUpper: r.tickUpper, liquidity: r.liquidity.toString() };
}
function sym(t) { return t.native ? "ETH" : t.symbol; }
function tokenView(t, currency) {
  return { symbol: sym(t), currency: t.native ? "native ETH (0x0)" : currency, decimals: t.decimals, name: t.name };
}
function publicPosition(p) {
  if (!p) return p;
  const { _raw, ...rest } = p;
  return rest;
}

/**
 * lp_positions: a wallet's Uniswap v4 Positions NFTs, with range, in-range status, principal and uncollected fees.
 * Pass tokenId / tokenIds to skip the Transfer-log scan. Default 40 positions, max 100, then use offset.
 */
export async function lpPositions({ address, tokenId, tokenIds, offset = 0, limit = 40 } = {}) {
  const lim = Number(limit), off = Number(offset);
  if (!Number.isInteger(lim) || lim < 1 || lim > 100) throw new Error("limit must be an integer from 1 to 100.");
  if (!Number.isInteger(off) || off < 0) throw new Error("offset must be a non-negative integer.");
  const c = publicClient();
  const block = await c.getBlockNumber();
  let ids, owner = null, discovery = null;

  const explicit = [];
  if (tokenId != null && tokenId !== "") explicit.push(parseTokenId(tokenId));
  if (Array.isArray(tokenIds)) explicit.push(...tokenIds.map(parseTokenId));
  const uniqueExplicit = [...new Set(explicit.map((x) => x.toString()))].map(BigInt);

  if (uniqueExplicit.length) {
    ids = uniqueExplicit;
    if (address) owner = whoOf(address);
  } else {
    owner = whoOf(address);
    const [balance, xf] = await Promise.all([
      c.readContract({ address: POSITION_MANAGER, abi: pmAbi, functionName: "balanceOf", args: [owner], blockNumber: block }),
      positionTransfers(owner, block),
    ]);
    ids = idsFromTransfers(xf.logs, owner);
    discovery = {
      method: "Uniswap v4 Positions NFT Transfer logs on the PositionManager, from its deploy block 9073 (create2, tx 0x228c18ada6cb46b4fbcc18f4ec1519953415393e256fa8349aafbd5a2db037c8) to this block. The contract is not ERC-721 enumerable.",
      fromBlock: xf.fromBlock.toString(), toBlock: xf.toBlock.toString(), requests: xf.requests, failedRequests: xf.failedRequests,
      balanceOf: balance.toString(),
      recovered: ids.length,
      ...(xf.failedRequests ? { warning: "Some log requests failed, so this list may be incomplete. Pass tokenId if you know it." } : {}),
      ...(balance > 0n && ids.length !== Number(balance) && !xf.failedRequests ? { warning: `balanceOf is ${balance} but Transfer logs recovered ${ids.length} token ids. Pass tokenId if a position is missing.` } : {}),
    };
  }

  const page = ids.slice(off, off + lim);
  const loaded = await loadPositions(page, block);
  if (owner) for (const p of loaded) if (!p.error && p.owner !== owner) p.note = `Currently owned by ${p.owner}, not ${owner}.`;
  return {
    chainId: CHAIN_ID, block: block.toString(),
    positionManager: POSITION_MANAGER, stateView: ADDR.V4_STATE_VIEW, poolManager: ADDR.V4_POOL_MANAGER,
    address: owner, nft: { name: "Uniswap v4 Positions NFT", symbol: "UNI-V4-POSM", explorer: addrLink(POSITION_MANAGER) },
    total: ids.length, offset: off, limit: lim, returned: loaded.length,
    more: off + loaded.length < ids.length,
    ...(off + loaded.length < ids.length ? { nextOffset: off + loaded.length } : {}),
    positions: loaded.map(publicPosition),
    ...(discovery ? { discovery } : { method: "token id supplied by the caller; no Transfer-log scan" }),
    methodNote: "Principal amounts are the tokens currently in the position (no fees). Uncollected fees are computed from StateView fee growth the way Position.update does. In-range means the pool tick is in [tickLower, tickUpper). Nothing is signed.",
  };
}

async function pickPool({ tokenA, tokenB, fee, tickSpacing, hooks, poolKey }) {
  if (poolKey) {
    for (const f of ["currency0", "currency1"]) if (!isAddress(poolKey[f] || "")) throw new Error(`poolKey.${f} must be a 0x address (native ETH is 0x0000000000000000000000000000000000000000).`);
    if (poolKey.hooks && !isAddress(poolKey.hooks)) throw new Error("poolKey.hooks must be a 0x address.");
    if (poolKey.tickSpacing == null) throw new Error("poolKey.tickSpacing is required.");
    const key = makeKey(poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks || NATIVE);
    const st = await poolState(key);
    return { key, state: st, t0: await resolveCurrency(key.currency0), t1: await resolveCurrency(key.currency1), picked: "explicit pool key" };
  }
  if (tokenA == null || tokenB == null) throw new Error("Give tokenA and tokenB, or an existing tokenId, or a poolKey.");
  const [a, b] = await Promise.all([resolveToken(tokenA), resolveToken(tokenB)]);
  const ca = currencyOf(a), cb = currencyOf(b);
  if (ca === cb) throw new Error("tokenA and tokenB are the same currency.");
  let key, picked;
  if (fee != null) {
    const ts = tickSpacing != null ? Number(tickSpacing) : FEE_TO_SPACING[Number(fee)];
    if (ts == null) throw new Error(`fee ${fee} is not a standard Uniswap fee (100, 500, 3000, 10000). Pass tickSpacing too, or use a poolKey.`);
    key = makeKey(ca, cb, fee, ts, hooks || NATIVE);
    picked = hooks ? "fee, tickSpacing and hooks you gave" : `hookless ${pct(fee)} key`;
  } else {
    if (hooks) throw new Error("hooks was set without a fee or poolKey.");
    const cands = (await candidateKeys(ca, cb)).filter((c) => getAddress(c.key.hooks) === NATIVE);
    const states = await Promise.all(cands.map((c) => poolState(c.key)));
    const live = cands.map((c, i) => ({ ...c, state: states[i] })).filter((c) => c.state.initialized && c.state.liquidity > 0n)
      .sort((p, q) => (q.state.liquidity > p.state.liquidity ? 1 : -1));
    if (!live.length) throw new Error(`No live hookless Uniswap v4 pool for ${a.symbol}/${b.symbol} at the standard fee keys (0.01%, 0.05%, 0.3%, 1%). Pass a fee or a poolKey. Holbric does not mint into hooked pools.`);
    key = live[0].key;
    picked = live.length === 1 ? `the only live hookless pool (${pct(key.fee)})` : `the most liquid live hookless pool (${pct(key.fee)}; ${live.length} live hookless pools compared)`;
  }
  const st = await poolState(key);
  const t0 = ca === key.currency0 ? a : b, t1 = ca === key.currency1 ? a : b;
  return { key, state: st, t0, t1, picked };
}

function resolveTicks({ tickLower, tickUpper, fullRange, tickSpacing, currentTick }) {
  const ts = Number(tickSpacing);
  if (fullRange) {
    return { tickLower: minUsableTick(ts), tickUpper: maxUsableTick(ts), source: "full range for this tick spacing", snapped: false };
  }
  if (tickLower == null || tickUpper == null) {
    throw new Error("Give tickLower and tickUpper, or set fullRange: true. Ticks are snapped to the pool's tick spacing.");
  }
  const rawLo = Number(tickLower), rawHi = Number(tickUpper);
  if (!Number.isInteger(rawLo) || !Number.isInteger(rawHi)) throw new Error("tickLower and tickUpper must be integers.");
  const lo = nearestUsableTick(rawLo, ts), hi = nearestUsableTick(rawHi, ts);
  if (lo >= hi) throw new Error(`tickLower must be below tickUpper after snapping to tick spacing ${ts} (got ${lo} and ${hi}).`);
  const snapped = lo !== rawLo || hi !== rawHi;
  return { tickLower: lo, tickUpper: hi, source: snapped ? `snapped from ${rawLo} / ${rawHi} to tick spacing ${ts}` : "as given, already aligned", snapped };
}

function amountsForAdd({ state, tickLower, tickUpper, amount0, amount1, t0, t1 }) {
  if (!state.initialized) throw new Error(`This v4 pool is not initialized (no price yet). Holbric does not initialize pools; adding liquidity needs a live pool.`);
  if (amount0 === 0n && amount1 === 0n) throw new Error("Give amountA and/or amountB greater than zero.");
  const sqrtA = getSqrtPriceAtTick(tickLower), sqrtB = getSqrtPriceAtTick(tickUpper);
  const liquidity = requireUint128(getLiquidityForAmounts(state.sqrtPriceX96, sqrtA, sqrtB, amount0, amount1), "liquidity");
  if (liquidity === 0n) {
    const inside = inRange(state.tick, tickLower, tickUpper);
    const hint = !inside && state.tick < tickLower ? `The current tick ${state.tick} is below this range, so only ${sym(t0)} is used. Give a ${sym(t0)} amount.`
      : !inside ? `The current tick ${state.tick} is above this range, so only ${sym(t1)} is used. Give a ${sym(t1)} amount.`
      : "Those amounts produce zero liquidity at the current price.";
    throw new Error(`Liquidity would be zero. ${hint}`);
  }
  const used = getAmountsForLiquidity(state.sqrtPriceX96, sqrtA, sqrtB, liquidity);
  return { liquidity, used, leftover0: amount0 > used.amount0 ? amount0 - used.amount0 : 0n, leftover1: amount1 > used.amount1 ? amount1 - used.amount1 : 0n };
}

function applyMaxSlip(amount, slip) { return (amount * BigInt(10000 + slip)) / 10000n; }
function applyMinSlip(amount, slip) { return (amount * BigInt(10000 - slip)) / 10000n; }

function encodeActions(actions, params) {
  const packed = encodePacked(actions.map(() => "uint8"), actions);
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [packed, params]);
}
function mintParams(key, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner = MSG_SENDER) {
  return encodeAbiParameters(
    [POOL_KEY_T, { type: "int24" }, { type: "int24" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "address" }, { type: "bytes" }],
    [key, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner, "0x"]);
}
function modifyParams(tokenId, liquidity, amount0, amount1) {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
    [tokenId, liquidity, amount0, amount1, "0x"]);
}
function burnParams(tokenId, amount0Min, amount1Min) {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
    [tokenId, amount0Min, amount1Min, "0x"]);
}
function pairParams(c0, c1) { return encodeAbiParameters([{ type: "address" }, { type: "address" }], [c0, c1]); }
function takePairParams(c0, c1, to = MSG_SENDER) { return encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [c0, c1, to]); }
function sweepParams(cur, to = MSG_SENDER) { return encodeAbiParameters([{ type: "address" }, { type: "address" }], [cur, to]); }
function modifyCall(unlockData, deadline) {
  return encodeFunctionData({ abi: pmAbi, functionName: "modifyLiquidities", args: [unlockData, deadline] });
}

async function permit2Txs(c, from, token, amount, lines) {
  const txs = [];
  if (!amount || token.native) return txs;
  const allowance = await c.readContract({ address: token.address, abi: erc20Abi, functionName: "allowance", args: [from, ADDR.PERMIT2] });
  if (allowance < amount) {
    txs.push(approveTx(token.address, ADDR.PERMIT2, amount, token.symbol, token.decimals));
    lines.push(`Approve exactly ${fmt(amount, token.decimals, 18)} ${token.symbol} for Permit2 ${ADDR.PERMIT2}, which the Uniswap v4 PositionManager uses to pull tokens (current allowance ${fmt(allowance, token.decimals, 18)}). Not unlimited.`);
  }
  const [p2amount, p2exp] = await c.readContract({ address: ADDR.PERMIT2, abi: permit2Abi, functionName: "allowance", args: [from, token.address, POSITION_MANAGER] });
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (p2amount < amount || BigInt(p2exp) < now + 15n * 60n) {
    const exp = now + 30n * 60n;
    txs.push({ label: `Permit2: allow PositionManager to pull exactly ${fmt(amount, token.decimals, 18)} ${token.symbol}, expires in 30 minutes`, to: ADDR.PERMIT2, value: 0n,
      data: encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [token.address, POSITION_MANAGER, amount, Number(exp)] }) });
    lines.push(`Permit2: let Uniswap v4 PositionManager ${POSITION_MANAGER} pull exactly ${fmt(amount, token.decimals, 18)} ${token.symbol}, expiring 30 minutes from now. Not unlimited.`);
  }
  return txs;
}

async function planAdd(args) {
  const slip = slippage(args.slippageBps);
  let key, state, t0, t1, picked, tokenId = null, tickLower, tickUpper, tickSource, existing = null;
  if (args.tokenId != null && args.tokenId !== "") {
    tokenId = parseTokenId(args.tokenId);
    const [row] = await loadPositions([tokenId]);
    if (row.error) throw new Error(`tokenId ${tokenId} is not a current Uniswap v4 Positions NFT.`);
    existing = row;
    key = row.poolKey;
    state = { sqrtPriceX96: row._raw.sqrtPriceX96, tick: row._raw.tick, initialized: true, liquidity: 0n, id: row.poolId };
    t0 = row._raw.t0; t1 = row._raw.t1;
    tickLower = row.tickLower; tickUpper = row.tickUpper;
    tickSource = `existing position ${tokenId}'s range`;
    picked = `existing position ${tokenId}`;
  } else {
    const pickedPool = await pickPool(args);
    key = pickedPool.key; state = pickedPool.state; t0 = pickedPool.t0; t1 = pickedPool.t1; picked = pickedPool.picked;
    if (!isAllowedHook(key.hooks) || isPonsKey(key)) {
      throw new Error(`Holbric only mints Uniswap v4 liquidity on hookless pools. This pool uses ${hookKind(key.hooks)}. To change an existing position, pass its tokenId.`);
    }
    const ticks = resolveTicks({ ...args, tickSpacing: key.tickSpacing, currentTick: state.tick });
    tickLower = ticks.tickLower; tickUpper = ticks.tickUpper; tickSource = ticks.source;
  }
  // Map amountA/amountB onto currency0/currency1.
  const amountA = args.amountA ?? args.amount0, amountB = args.amountB ?? args.amount1;
  let amount0, amount1;
  if (existing) {
    amount0 = parseDec(amountA, t0.decimals, "amountA");
    amount1 = parseDec(amountB, t1.decimals, "amountB");
  } else {
    const a = args.tokenA ? await resolveToken(args.tokenA) : null;
    const b = args.tokenB ? await resolveToken(args.tokenB) : null;
    const ca = a ? currencyOf(a) : null, cb = b ? currencyOf(b) : null;
    const amtA = a ? parseDec(amountA, a.decimals, "amountA") : 0n;
    const amtB = b ? parseDec(amountB, b.decimals, "amountB") : 0n;
    amount0 = 0n; amount1 = 0n;
    if (ca === key.currency0) amount0 += amtA; else if (ca === key.currency1) amount1 += amtA;
    if (cb === key.currency0) amount0 += amtB; else if (cb === key.currency1) amount1 += amtB;
    if (ca && ca !== key.currency0 && ca !== key.currency1) throw new Error(`${a.symbol} is not in this pool.`);
    if (cb && cb !== key.currency0 && cb !== key.currency1) throw new Error(`${b.symbol} is not in this pool.`);
  }
  const add = amountsForAdd({ state, tickLower, tickUpper, amount0, amount1, t0, t1 });
  const amount0Max = requireUint128(applyMaxSlip(add.used.amount0, slip), "amount0Max");
  const amount1Max = requireUint128(applyMaxSlip(add.used.amount1, slip), "amount1Max");
  return { slip, key, state, t0, t1, picked, tokenId, existing, tickLower, tickUpper, tickSource, add, amount0Max, amount1Max, amount0, amount1 };
}

function addView(p, block) {
  return {
    chainId: CHAIN_ID, block: block.toString(),
    positionManager: POSITION_MANAGER, poolManager: ADDR.V4_POOL_MANAGER, permit2: ADDR.PERMIT2,
    action: p.tokenId ? `increase position ${p.tokenId}` : "mint a new position",
    ...(p.tokenId ? { tokenId: p.tokenId.toString() } : {}),
    poolId: poolId(p.key), poolKey: p.key, hook: hookKind(p.key.hooks), fee: pct(p.key.fee),
    picked: p.picked, tickLower: p.tickLower, tickUpper: p.tickUpper, ticks: p.tickSource,
    currentTick: p.state.tick, inRange: inRange(p.state.tick, p.tickLower, p.tickUpper),
    token0: tokenView(p.t0, p.key.currency0), token1: tokenView(p.t1, p.key.currency1),
    liquidity: p.add.liquidity.toString(),
    uses: { token0: fmt(p.add.used.amount0, p.t0.decimals, 18), token1: fmt(p.add.used.amount1, p.t1.decimals, 18), token0Raw: p.add.used.amount0.toString(), token1Raw: p.add.used.amount1.toString() },
    leftover: { token0: fmt(p.add.leftover0, p.t0.decimals, 18), token1: fmt(p.add.leftover1, p.t1.decimals, 18) },
    maxIn: { token0: fmt(p.amount0Max, p.t0.decimals, 18), token1: fmt(p.amount1Max, p.t1.decimals, 18), slippageBps: p.slip, note: "PositionManager slippage is on the principal only. Max in is the used amount plus the slippage limit." },
    price: `1 ${sym(p.t0)} = ${priceFromSqrt(p.state.sqrtPriceX96, p.t0.decimals, p.t1.decimals).toPrecision(8)} ${sym(p.t1)}`,
    note: "Quote only. prepare_add_liquidity builds the transaction and simulates it on mainnet; nothing is signed.",
  };
}

export async function quoteAddLiquidity(args) {
  const p = await planAdd(args);
  const block = await publicClient().getBlockNumber();
  return addView(p, block);
}

export async function prepareAddLiquidity(args) {
  const from = requireWallet();
  const p = await planAdd(args);
  if (p.existing && p.existing.owner !== from) throw new Error(`Position ${p.tokenId} is owned by ${p.existing.owner}, not this wallet (${from}). Nothing was prepared.`);
  const c = publicClient();
  const lines = [];
  const txs = [
    ...(await permit2Txs(c, from, p.t0, p.amount0Max, lines)),
    ...(await permit2Txs(c, from, p.t1, p.amount1Max, lines)),
  ];
  const hasNative = p.key.currency0 === NATIVE || p.key.currency1 === NATIVE;
  const value = p.key.currency0 === NATIVE ? p.amount0Max : p.key.currency1 === NATIVE ? p.amount1Max : 0n;
  const actions = p.tokenId
    ? [INCREASE_LIQUIDITY, SETTLE_PAIR, ...(hasNative ? [SWEEP] : [])]
    : [MINT_POSITION, SETTLE_PAIR, ...(hasNative ? [SWEEP] : [])];
  const params = p.tokenId
    ? [modifyParams(p.tokenId, p.add.liquidity, p.amount0Max, p.amount1Max), pairParams(p.key.currency0, p.key.currency1), ...(hasNative ? [sweepParams(NATIVE)] : [])]
    : [mintParams(p.key, p.tickLower, p.tickUpper, p.add.liquidity, p.amount0Max, p.amount1Max), pairParams(p.key.currency0, p.key.currency1), ...(hasNative ? [sweepParams(NATIVE)] : [])];
  const deadline = deadlineIn(15);
  const label = p.tokenId
    ? `increase Uniswap v4 position ${p.tokenId} by liquidity ${p.add.liquidity} (up to ${fmt(p.amount0Max, p.t0.decimals, 18)} ${sym(p.t0)} and ${fmt(p.amount1Max, p.t1.decimals, 18)} ${sym(p.t1)})`
    : `mint Uniswap v4 position on ${sym(p.t0)}/${sym(p.t1)} ${pct(p.key.fee)}, ticks ${p.tickLower} to ${p.tickUpper}, liquidity ${p.add.liquidity}`;
  txs.push({ label, to: POSITION_MANAGER, value, data: modifyCall(encodeActions(actions, params), deadline) });

  if (!p.t0.native) {
    const bal = await c.readContract({ address: p.t0.address, abi: erc20Abi, functionName: "balanceOf", args: [from] });
    if (bal < p.add.used.amount0) throw new Error(`Not enough ${sym(p.t0)}: wallet holds ${fmt(bal, p.t0.decimals, 18)}, adding needs ${fmt(p.add.used.amount0, p.t0.decimals, 18)}. Nothing was prepared.`);
  }
  if (!p.t1.native) {
    const bal = await c.readContract({ address: p.t1.address, abi: erc20Abi, functionName: "balanceOf", args: [from] });
    if (bal < p.add.used.amount1) throw new Error(`Not enough ${sym(p.t1)}: wallet holds ${fmt(bal, p.t1.decimals, 18)}, adding needs ${fmt(p.add.used.amount1, p.t1.decimals, 18)}. Nothing was prepared.`);
  }
  const ethBal = await c.getBalance({ address: from });
  if (value > 0n && ethBal <= value) throw new Error(`Not enough ETH: wallet holds ${fmt(ethBal, 18, 18)}, adding needs ${fmt(value, 18, 18)} plus the network fee. Nothing was prepared.`);

  const usdParts = await Promise.all([
    p.add.used.amount0 ? usdValue(p.t0, p.add.used.amount0).catch(() => null) : 0,
    p.add.used.amount1 ? usdValue(p.t1, p.add.used.amount1).catch(() => null) : 0,
  ]);
  const usd = usdParts.some((x) => x == null) ? null : usdParts[0] + usdParts[1];
  checkLimit(usd);

  const leftover = (p.add.leftover0 > 0n || p.add.leftover1 > 0n)
    ? ` Leftover not deposited: ${p.add.leftover0 > 0n ? fmt(p.add.leftover0, p.t0.decimals, 18) + " " + sym(p.t0) : ""}${p.add.leftover0 > 0n && p.add.leftover1 > 0n ? " and " : ""}${p.add.leftover1 > 0n ? fmt(p.add.leftover1, p.t1.decimals, 18) + " " + sym(p.t1) : ""}.`
    : "";
  const ethSweep = hasNative ? " Any leftover native ETH is swept back to this wallet." : "";
  lines.push(p.tokenId
    ? `Add liquidity to Uniswap v4 position ${p.tokenId} (ticks ${p.tickLower} to ${p.tickUpper} on ${sym(p.t0)}/${sym(p.t1)} ${pct(p.key.fee)}, ${p.existing.rangeStatus}). Deposit up to ${fmt(p.amount0Max, p.t0.decimals, 18)} ${sym(p.t0)} and ${fmt(p.amount1Max, p.t1.decimals, 18)} ${sym(p.t1)} (expected ${fmt(p.add.used.amount0, p.t0.decimals, 18)} ${sym(p.t0)} and ${fmt(p.add.used.amount1, p.t1.decimals, 18)} ${sym(p.t1)}; slippage limit ${(p.slip / 100).toFixed(2)}%). The NFT stays in this wallet.`
    : `Mint a new Uniswap v4 liquidity position as an NFT at PositionManager ${POSITION_MANAGER}, owned by this wallet. Pool: ${sym(p.t0)}/${sym(p.t1)} ${pct(p.key.fee)} (${p.picked}), hookless, ticks ${p.tickLower} to ${p.tickUpper} (${p.tickSource}), currently ${inRange(p.state.tick, p.tickLower, p.tickUpper) ? "in range" : "out of range"}. Deposit up to ${fmt(p.amount0Max, p.t0.decimals, 18)} ${sym(p.t0)} and ${fmt(p.amount1Max, p.t1.decimals, 18)} ${sym(p.t1)} (expected ${fmt(p.add.used.amount0, p.t0.decimals, 18)} ${sym(p.t0)} and ${fmt(p.add.used.amount1, p.t1.decimals, 18)} ${sym(p.t1)}; slippage limit ${(p.slip / 100).toFixed(2)}%). Deadline 15 minutes.`);
  lines.push(`Pool id ${poolId(p.key)}. Liquidity to add: ${p.add.liquidity}.${leftover}${ethSweep} No Holbric fee.`);

  const block = await c.getBlockNumber();
  return store({
    kind: p.tokenId ? "v4_increase_liquidity" : "v4_mint_position", from, txs, lines, usd, slippageBps: p.slip,
    extra: { quote: addView(p, block) },
    valueLine: usd != null ? `Approximate value deposited: $${usd.toFixed(2)}.` : "Approximate USD value of the deposit: not available.",
  });
}

async function planRemove({ tokenId, liquidity, percent, slippageBps, collectOnly = false }) {
  const id = parseTokenId(tokenId);
  const slip = slippage(slippageBps);
  const [row] = await loadPositions([id]);
  if (row.error) throw new Error(`tokenId ${id} is not a current Uniswap v4 Positions NFT.`);
  const liqAll = row._raw.liquidity;
  let liqUse, mode, burn = false;
  if (collectOnly) {
    if (liqAll === 0n) throw new Error(`Position ${id} has zero liquidity, so fees cannot be collected (Uniswap v4 rejects a zero-liquidity poke). To burn the empty NFT, use prepare_remove_liquidity.`);
    const f0 = row._raw.fees0, f1 = row._raw.fees1;
    if (f0 === 0n && f1 === 0n) throw new Error(`Position ${id} has no uncollected fees at this block.`);
    liqUse = 0n; mode = "collect fees";
  } else if (liquidity != null && liquidity !== "") {
    if (!/^\d+$/.test(String(liquidity).trim())) throw new Error("liquidity must be a whole number (the liquidity units to remove).");
    liqUse = BigInt(String(liquidity).trim());
    if (liqUse <= 0n) throw new Error("liquidity to remove must be greater than zero. To collect fees only, use quote_collect_lp_fees / prepare_collect_lp_fees.");
    if (liqUse > liqAll) throw new Error(`Position ${id} has liquidity ${liqAll}, which is less than ${liqUse}.`);
    mode = "remove liquidity";
    burn = liqUse === liqAll;
  } else if (percent != null) {
    const p = Number(percent);
    if (!Number.isFinite(p) || p <= 0 || p > 100) throw new Error("percent must be greater than 0 and at most 100.");
    liqUse = p === 100 ? liqAll : (liqAll * BigInt(Math.floor(p * 1000))) / 100000n;
    if (liqUse === 0n) throw new Error(`percent ${p} of liquidity ${liqAll} rounds down to zero.`);
    mode = `remove ${p}% of liquidity`;
    burn = liqUse === liqAll;
  } else {
    if (liqAll === 0n) { liqUse = 0n; mode = "burn empty position"; burn = true; }
    else { liqUse = liqAll; mode = "remove all liquidity and burn the NFT"; burn = true; }
  }
  const share = liqAll === 0n ? { amount0: 0n, amount1: 0n } : getAmountsForLiquidity(row._raw.sqrtPriceX96, getSqrtPriceAtTick(row.tickLower), getSqrtPriceAtTick(row.tickUpper), liqUse);
  const fees0 = collectOnly || liqUse > 0n || burn ? row._raw.fees0 : 0n;
  const fees1 = collectOnly || liqUse > 0n || burn ? row._raw.fees1 : 0n;
  // Slippage mins apply to principal only (PositionManager SlippageCheck.validateMinOut). Fees are extra.
  const amount0Min = requireUint128(applyMinSlip(share.amount0, slip), "amount0Min");
  const amount1Min = requireUint128(applyMinSlip(share.amount1, slip), "amount1Min");
  return { id, slip, row, liqUse, liqAll, mode, burn, collectOnly, share, fees0, fees1, amount0Min, amount1Min };
}

function removeView(p, block) {
  const { row } = p, t0 = row._raw.t0, t1 = row._raw.t1;
  return {
    chainId: CHAIN_ID, block: block.toString(),
    positionManager: POSITION_MANAGER, tokenId: p.id.toString(), owner: row.owner,
    action: p.mode, burnNft: p.burn,
    poolId: row.poolId, poolKey: row.poolKey, hook: hookKind(row.poolKey.hooks),
    tickLower: row.tickLower, tickUpper: row.tickUpper, currentTick: row.currentTick, inRange: row.inRange, rangeStatus: row.rangeStatus,
    token0: tokenView(t0, row.poolKey.currency0), token1: tokenView(t1, row.poolKey.currency1),
    liquidityNow: p.liqAll.toString(), liquidityToRemove: p.liqUse.toString(),
    principalOut: { token0: fmt(p.share.amount0, t0.decimals, 18), token1: fmt(p.share.amount1, t1.decimals, 18), token0Raw: p.share.amount0.toString(), token1Raw: p.share.amount1.toString() },
    uncollectedFees: { token0: fmt(p.fees0, t0.decimals, 18), token1: fmt(p.fees1, t1.decimals, 18), token0Raw: p.fees0.toString(), token1Raw: p.fees1.toString() },
    expectedTotal: { token0: fmt(p.share.amount0 + p.fees0, t0.decimals, 18), token1: fmt(p.share.amount1 + p.fees1, t1.decimals, 18) },
    minOut: p.collectOnly
      ? { token0: "0", token1: "0", note: "Collect uses decrease liquidity 0. PositionManager's slippage check is on the principal, which is zero, so the minimums are zero. Fees still come out through TAKE_PAIR." }
      : { token0: fmt(p.amount0Min, t0.decimals, 18), token1: fmt(p.amount1Min, t1.decimals, 18), slippageBps: p.slip, note: "Minimums apply to the principal only, not the fees, matching PositionManager.SlippageCheck." },
    hookNote: hookNote(row.poolKey.hooks),
    note: "Quote only. prepare_remove_liquidity / prepare_collect_lp_fees build the transaction and simulate it on mainnet; nothing is signed.",
  };
}

export async function quoteRemoveLiquidity(args) {
  const p = await planRemove({ ...args, collectOnly: false });
  const block = await publicClient().getBlockNumber();
  return removeView(p, block);
}

export async function quoteCollectLpFees(args) {
  const p = await planRemove({ ...args, collectOnly: true });
  const block = await publicClient().getBlockNumber();
  return removeView(p, block);
}

async function prepareRemoveOrCollect(args, collectOnly) {
  const from = requireWallet();
  const p = await planRemove({ ...args, collectOnly });
  if (p.row.owner !== from) throw new Error(`Position ${p.id} is owned by ${p.row.owner}, not this wallet (${from}). Nothing was prepared.`);
  const t0 = p.row._raw.t0, t1 = p.row._raw.t1;
  const key = p.row.poolKey;
  const amount0Min = collectOnly ? 0n : p.amount0Min;
  const amount1Min = collectOnly ? 0n : p.amount1Min;
  const actions = p.burn ? [BURN_POSITION, TAKE_PAIR] : [DECREASE_LIQUIDITY, TAKE_PAIR];
  const params = p.burn
    ? [burnParams(p.id, amount0Min, amount1Min), takePairParams(key.currency0, key.currency1)]
    : [modifyParams(p.id, p.liqUse, amount0Min, amount1Min), takePairParams(key.currency0, key.currency1)];
  const deadline = deadlineIn(15);
  const label = collectOnly
    ? `collect Uniswap v4 fees on position ${p.id} (expected ${fmt(p.fees0, t0.decimals, 18)} ${sym(t0)} and ${fmt(p.fees1, t1.decimals, 18)} ${sym(t1)})`
    : p.burn
      ? `remove all liquidity from Uniswap v4 position ${p.id} and burn the NFT (expected ${fmt(p.share.amount0 + p.fees0, t0.decimals, 18)} ${sym(t0)} and ${fmt(p.share.amount1 + p.fees1, t1.decimals, 18)} ${sym(t1)})`
      : `remove liquidity ${p.liqUse} from Uniswap v4 position ${p.id} (expected ${fmt(p.share.amount0 + p.fees0, t0.decimals, 18)} ${sym(t0)} and ${fmt(p.share.amount1 + p.fees1, t1.decimals, 18)} ${sym(t1)})`;
  const tx = { label, to: POSITION_MANAGER, value: 0n, data: modifyCall(encodeActions(actions, params), deadline) };
  const lines = [];
  if (collectOnly) {
    lines.push(`Collect uncollected fees from Uniswap v4 position ${p.id} (ticks ${p.row.tickLower} to ${p.row.tickUpper} on ${sym(t0)}/${sym(t1)} ${pct(key.fee)}, ${p.row.rangeStatus}) at PositionManager ${POSITION_MANAGER}. This is a decrease of 0 liquidity, which credits fees. Expected ${fmt(p.fees0, t0.decimals, 18)} ${sym(t0)} and ${fmt(p.fees1, t1.decimals, 18)} ${sym(t1)}, paid to this wallet. The NFT and its liquidity stay in the wallet. Deadline 15 minutes.`);
  } else if (p.burn) {
    lines.push(`Remove all remaining liquidity from Uniswap v4 position ${p.id} and burn the NFT at PositionManager ${POSITION_MANAGER}. Pool: ${sym(t0)}/${sym(t1)} ${pct(key.fee)}, ticks ${p.row.tickLower} to ${p.row.tickUpper}, ${p.row.rangeStatus}. Expected principal ${fmt(p.share.amount0, t0.decimals, 18)} ${sym(t0)} and ${fmt(p.share.amount1, t1.decimals, 18)} ${sym(t1)}, plus uncollected fees ${fmt(p.fees0, t0.decimals, 18)} ${sym(t0)} and ${fmt(p.fees1, t1.decimals, 18)} ${sym(t1)}, paid to this wallet. Minimum principal (slippage limit ${(p.slip / 100).toFixed(2)}%): ${fmt(amount0Min, t0.decimals, 18)} ${sym(t0)} and ${fmt(amount1Min, t1.decimals, 18)} ${sym(t1)}. Deadline 15 minutes.`);
  } else {
    lines.push(`Remove liquidity ${p.liqUse} of ${p.liqAll} from Uniswap v4 position ${p.id} at PositionManager ${POSITION_MANAGER}. The NFT stays in this wallet with the remaining liquidity. Pool: ${sym(t0)}/${sym(t1)} ${pct(key.fee)}, ticks ${p.row.tickLower} to ${p.row.tickUpper}, ${p.row.rangeStatus}. Expected principal ${fmt(p.share.amount0, t0.decimals, 18)} ${sym(t0)} and ${fmt(p.share.amount1, t1.decimals, 18)} ${sym(t1)}, plus uncollected fees ${fmt(p.fees0, t0.decimals, 18)} ${sym(t0)} and ${fmt(p.fees1, t1.decimals, 18)} ${sym(t1)}, paid to this wallet. Minimum principal (slippage limit ${(p.slip / 100).toFixed(2)}%): ${fmt(amount0Min, t0.decimals, 18)} ${sym(t0)} and ${fmt(amount1Min, t1.decimals, 18)} ${sym(t1)}. Deadline 15 minutes.`);
  }
  if (p.row.hookNote) lines.push(p.row.hookNote);
  const block = await publicClient().getBlockNumber();
  // No minReceive check: some tokens on this chain do not emit a Transfer log, so eth_simulateV1 cannot
  // trace what the wallet receives. PositionManager already enforces the principal minimums on chain.
  return store({
    kind: collectOnly ? "v4_collect_lp_fees" : (p.burn ? "v4_burn_position" : "v4_decrease_liquidity"),
    from, txs: [tx], lines, usd: 0, slippageBps: p.slip,
    extra: { quote: removeView(p, block) },
    valueLine: "Tokens return to this wallet; only the network fee is paid.",
  });
}

export const prepareRemoveLiquidity = (args) => prepareRemoveOrCollect(args, false);
export const prepareCollectLpFees = (args) => prepareRemoveOrCollect(args, true);
