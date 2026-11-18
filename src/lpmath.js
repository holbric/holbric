// Uniswap v4 liquidity math, ported from the PositionManager's Sourcify-verified sources on Robinhood Chain
// (PositionManager 0x58daec3116aae6D93017bAAea7749052E8a04fA7, exact match as src/PositionManager.sol:PositionManager):
//   TickMath.getSqrtPriceAtTick          lib/v4-core/src/libraries/TickMath.sol
//   LiquidityAmounts.getLiquidityForAmount{0,1} / getLiquidityForAmounts
//                                        src/libraries/LiquidityAmounts.sol
//   getAmountsForLiquidity               the inverse formulas used by Uniswap v3/v4 (not in this deployment's
//                                        LiquidityAmounts.sol, which only has the forward functions)
//   Position.update fee growth           lib/v4-core/src/libraries/Position.sol (unchecked uint256 subtraction)
//   PositionInfo packing                 src/libraries/PositionInfoLibrary.sol
// Nothing here touches the chain.

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
export const Q96 = 1n << 96n;
export const Q128 = 1n << 128n;
const U256 = 1n << 256n;
const MAX_U128 = (1n << 128n) - 1n;

const TICK_MUL = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

/** sqrt(1.0001^tick) * 2^96 as a Q64.96, identical to TickMath.getSqrtPriceAtTick. */
export function getSqrtPriceAtTick(tick) {
  const t = Number(tick);
  if (!Number.isInteger(t) || t < MIN_TICK || t > MAX_TICK) {
    throw new Error(`tick ${tick} is outside Uniswap v4's allowed range (${MIN_TICK} to ${MAX_TICK}).`);
  }
  const absTick = t < 0 ? -t : t;
  let price = (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : (1n << 128n);
  for (const [bit, m] of TICK_MUL) if (absTick & bit) price = (price * m) >> 128n;
  if (t > 0) price = (U256 - 1n) / price;
  return (price + 0xffffffffn) >> 32n;
}

export const mulDiv = (a, b, denom) => {
  if (denom === 0n) throw new Error("division by zero");
  return (a * b) / denom;
};

export function minUsableTick(tickSpacing) {
  const s = Number(tickSpacing);
  if (!Number.isInteger(s) || s < 1 || s > 32767) throw new Error("tickSpacing must be an integer from 1 to 32767.");
  return Math.trunc(MIN_TICK / s) * s;
}
export function maxUsableTick(tickSpacing) {
  const s = Number(tickSpacing);
  if (!Number.isInteger(s) || s < 1 || s > 32767) throw new Error("tickSpacing must be an integer from 1 to 32767.");
  return Math.trunc(MAX_TICK / s) * s;
}

/** Snap a tick to the nearest usable tick for this spacing, clamped to the usable range. */
export function nearestUsableTick(tick, tickSpacing) {
  const s = Number(tickSpacing);
  if (!Number.isInteger(s) || s < 1 || s > 32767) throw new Error("tickSpacing must be an integer from 1 to 32767.");
  const t = Number(tick);
  if (!Number.isInteger(t)) throw new Error("tick must be an integer.");
  const lo = minUsableTick(s), hi = maxUsableTick(s);
  const rounded = Math.round(t / s) * s;
  if (rounded < lo) return lo;
  if (rounded > hi) return hi;
  return rounded;
}

function sortSqrt(a, b) { return a > b ? [b, a] : [a, b]; }

export function getLiquidityForAmount0(sqrtA, sqrtB, amount0) {
  const [a, b] = sortSqrt(sqrtA, sqrtB);
  if (b === a) return 0n;
  const intermediate = mulDiv(a, b, Q96);
  return mulDiv(amount0, intermediate, b - a);
}
export function getLiquidityForAmount1(sqrtA, sqrtB, amount1) {
  const [a, b] = sortSqrt(sqrtA, sqrtB);
  if (b === a) return 0n;
  return mulDiv(amount1, Q96, b - a);
}

/** Maximum liquidity for the given token amounts at the current price, same as LiquidityAmounts.getLiquidityForAmounts. */
export function getLiquidityForAmounts(sqrtPrice, sqrtA, sqrtB, amount0, amount1) {
  const [a, b] = sortSqrt(sqrtA, sqrtB);
  if (sqrtPrice <= a) return getLiquidityForAmount0(a, b, amount0);
  if (sqrtPrice < b) {
    const l0 = getLiquidityForAmount0(sqrtPrice, b, amount0);
    const l1 = getLiquidityForAmount1(a, sqrtPrice, amount1);
    return l0 < l1 ? l0 : l1;
  }
  return getLiquidityForAmount1(a, b, amount1);
}

export function getAmount0ForLiquidity(sqrtA, sqrtB, liquidity) {
  const [a, b] = sortSqrt(sqrtA, sqrtB);
  if (b === a || liquidity === 0n) return 0n;
  return mulDiv(liquidity << 96n, b - a, b) / a;
}
export function getAmount1ForLiquidity(sqrtA, sqrtB, liquidity) {
  const [a, b] = sortSqrt(sqrtA, sqrtB);
  if (b === a || liquidity === 0n) return 0n;
  return mulDiv(liquidity, b - a, Q96);
}

/** Token amounts (principal only, no fees) for a liquidity position at the current price. */
export function getAmountsForLiquidity(sqrtPrice, sqrtA, sqrtB, liquidity) {
  const [a, b] = sortSqrt(sqrtA, sqrtB);
  if (sqrtPrice <= a) return { amount0: getAmount0ForLiquidity(a, b, liquidity), amount1: 0n };
  if (sqrtPrice < b) return { amount0: getAmount0ForLiquidity(sqrtPrice, b, liquidity), amount1: getAmount1ForLiquidity(a, sqrtPrice, liquidity) };
  return { amount0: 0n, amount1: getAmount1ForLiquidity(a, b, liquidity) };
}

/** Uncollected fees from fee-growth counters. Subtraction wraps at 2^256, as Position.update does. */
export function feesFromGrowth(liquidity, growthNow, growthLast) {
  const delta = (growthNow - growthLast + U256) % U256;
  return mulDiv(delta, liquidity, Q128);
}

/** Unpack PositionManager.positionInfo: 200 bits poolId | 24 bits tickUpper | 24 bits tickLower | 8 bits hasSubscriber. */
export function unpackPositionInfo(info) {
  const v = BigInt(info);
  const sign24 = (u) => { const n = Number(u); return n >= 0x800000 ? n - 0x1000000 : n; };
  return {
    hasSubscriber: (v & 0xffn) !== 0n,
    tickLower: sign24((v >> 8n) & 0xffffffn),
    tickUpper: sign24((v >> 32n) & 0xffffffn),
  };
}

/** In-range is [tickLower, tickUpper): same convention as Uniswap v3/v4. */
export const inRange = (tick, tickLower, tickUpper) => tick >= tickLower && tick < tickUpper;

export function requireUint128(v, label) {
  if (v < 0n) throw new Error(`${label} is negative.`);
  if (v > MAX_U128) throw new Error(`${label} does not fit in uint128.`);
  return v;
}
