// Pons V2 creator fees: what the escrow holds, what is still unswept on the curve or hook, and prepare tools
// to sweep and claim. Sources: docs.ponsfamily.com/v2 (Claiming fees, Fees reach the escrow only after a sweep).
// Escrow and hook ABIs come from their Sourcify exact matches. The curve's function signatures come from
// PonsV2BondingCurve.sol inside the exact-match Sourcify record of the Pons V2 launch deployer
// 0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42 (each curve is deployed from that source).
import { parseAbi, encodeFunctionData, encodeAbiParameters, keccak256, isAddress, getAddress, erc20Abi } from "viem";
import { publicClient, ADDR, fmt, addrLink, resolveToken } from "./chain.js";
import { walletAddress } from "./keystore.js";
import { requireWallet, store } from "./actions.js";
import { launched, pairMeta } from "./pons.js";
import { quote as uniQuote } from "./swap.js";
import hookAbi from "./abi/pons-meme-hook.json" with { type: "json" };

const ZERO = "0x0000000000000000000000000000000000000000";
const curveAbi = parseAbi([
  "function token() view returns (address)",
  "function deployer() view returns (address)",
  "function feePolicy() view returns (address)",
  "function feeEscrow() view returns (address)",
  "function graduated() view returns (bool)",
  "function quoteFeeBalance() view returns (uint256)",
  "function creatorTaxBalance() view returns (uint256)",
  "function buybackQuoteBalance() view returns (uint256)",
  "function protocolFeeShareBps() view returns (uint16)",
  "function sweepFees(uint256 minBuybackTokensOut)",
]);
const policyAbi = parseAbi(["function feeSweepOperator() view returns (address)"]);
const escrowAbi = parseAbi([
  "function balanceOf(address recipient) view returns (uint256)",
  "function balanceOfToken(address recipient, address token) view returns (uint256)",
  "function claim() returns (uint256)",
  "function claimToken(address token) returns (uint256)",
]);
const CAVEAT = "Pons docs: a trade does not credit the escrow directly. Fees accrue on the launch's curve (before graduation) or on the hook (after) until a sweep moves them, so the escrow balance alone can understate what a creator is owed.";

async function resolveLaunch({ token, curve }) {
  if (token) return launched(token);
  if (!isAddress(curve || "")) throw new Error("Give token (the launch token address) or curve (its Pons V2 bonding curve address).");
  const t = await publicClient().readContract({ address: getAddress(curve), abi: curveAbi, functionName: "token" })
    .catch(() => { throw new Error(`${getAddress(curve)} is not a Pons V2 bonding curve.`); });
  const r = await launched(t);
  if (getAddress(r.L.curve) !== getAddress(curve)) throw new Error(`The factory lists ${r.L.curve} as the curve for ${t}, not ${getAddress(curve)}.`);
  return r;
}

const poolIdOf = (L) => {
  const [c0, c1] = L.pairToken.toLowerCase() < L.token.toLowerCase() ? [L.pairToken, L.token] : [L.token, L.pairToken];
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [c0, c1, L.poolFee, L.tickSpacing, ADDR.PONS_HOOK]));
};

/** Everything about a launch's creator fees, read live. Internal shape keeps bigints for the prepare tools. */
async function analyze({ token, curve, recipient }) {
  const { t, L } = await resolveLaunch({ token, curve });
  const c = publicClient();
  const pair = await pairMeta(L);
  const quoteAddr = pair.native ? ZERO : pair.address;
  const rc = (fn, args = []) => c.readContract({ address: L.curve, abi: curveAbi, functionName: fn, args });
  const [graduatedFlag, symbol, block] = await Promise.all([rc("graduated"), c.readContract({ address: t, abi: erc20Abi, functionName: "symbol" }), c.getBlockNumber()]);
  const graduated = graduatedFlag || Number(L.phase) !== 0;
  let escrow = ADDR.PONS_ESCROW, u;
  if (!graduated) {
    const [fee, tax, buyback, protoBps, sweeper, policy, esc] = await Promise.all([rc("quoteFeeBalance"), rc("creatorTaxBalance"), rc("buybackQuoteBalance"),
      rc("protocolFeeShareBps"), rc("deployer"), rc("feePolicy"), rc("feeEscrow")]);
    const operator = await c.readContract({ address: policy, abi: policyAbi, functionName: "feeSweepOperator" }).catch(() => null);
    escrow = getAddress(esc);
    const bucket = fee - (fee * BigInt(protoBps)) / 10000n;
    const bb = buyback < bucket ? buyback : bucket;
    u = { where: "curve", holder: L.curve, fee, tax, buyback, protoBps: Number(protoBps), creatorShare: bucket - bb + tax, sweeper: getAddress(sweeper), operator,
      memecoinPending: 0n, needsOperator: buyback !== 0n };
  } else {
    const poolId = poolIdOf(L);
    const rh = (fn, args) => c.readContract({ address: ADDR.PONS_HOOK, abi: hookAbi, functionName: fn, args });
    const [info, fee, tax, buyback, memFee, memTax, operator] = await Promise.all([rh("launches", [poolId]), rh("pendingFees", [poolId, quoteAddr]),
      rh("pendingCreatorTax", [poolId, quoteAddr]), rh("pendingBuyback", [poolId, quoteAddr]), rh("pendingFees", [poolId, t]), rh("pendingCreatorTax", [poolId, t]), rh("feeSweepOperator", [])]);
    const [registered, , , , creator, , , , protoBps] = info;
    if (!registered) throw new Error(`The Pons hook ${ADDR.PONS_HOOK} has no pool registered for ${t} (pool id ${poolId}). It may belong to another Pons stack.`);
    const bucket = fee - (fee * BigInt(protoBps)) / 10000n;
    const bb = buyback < bucket ? buyback : bucket;
    u = { where: "hook", holder: ADDR.PONS_HOOK, poolId, fee, tax, buyback, protoBps: Number(protoBps), creatorShare: bucket - bb + tax, sweeper: getAddress(creator), operator,
      memecoinPending: memFee + memTax, needsOperator: memFee + memTax !== 0n || buyback !== 0n };
  }
  const who = getAddress(recipient || L.creatorFeeRecipient);
  const [escrowQuote, escrowToken] = await Promise.all([
    pair.native ? c.readContract({ address: escrow, abi: escrowAbi, functionName: "balanceOf", args: [who] })
      : c.readContract({ address: escrow, abi: escrowAbi, functionName: "balanceOfToken", args: [who, quoteAddr] }),
    c.readContract({ address: escrow, abi: escrowAbi, functionName: "balanceOfToken", args: [who, t] }),
  ]);
  let usdPerQuote = null;
  try {
    if (pair.native) usdPerQuote = Number((await uniQuote({ tokenIn: "WETH", tokenOut: "USDG", amount: "1" })).view.tokenOut.amountOut);
    else if (pair.address === ADDR.USDG) usdPerQuote = 1;
  } catch {}
  return { t, L, symbol, pair, quoteAddr, graduated, escrow, who, escrowQuote, escrowToken, u, usdPerQuote, block };
}

export async function ponsCreatorFees({ token, curve, recipient }) {
  if (recipient && !isAddress(recipient)) throw new Error(`recipient "${recipient}" is not a 0x address.`);
  const a = await analyze({ token, curve, recipient });
  const { pair, u } = a, d = pair.decimals, Q = pair.symbol;
  const usd = (v) => (a.usdPerQuote != null ? +(Number(fmt(v, d, d)) * a.usdPerQuote).toFixed(2) : null);
  const total = a.escrowQuote + u.creatorShare;
  return {
    token: a.t, symbol: a.symbol, curve: a.L.curve, phase: a.graduated ? "graduated (fees accrue on the Uniswap v4 hook)" : "bonding curve (fees accrue on the curve)",
    recipient: a.who, currentCreatorFeeRecipient: a.L.creatorFeeRecipient, block: a.block.toString(), readAt: new Date().toISOString(),
    escrow: {
      contract: a.escrow, claimable: `${fmt(a.escrowQuote, d, 10)} ${Q}`, claimableRaw: a.escrowQuote.toString(), claimableUsdApprox: usd(a.escrowQuote),
      ...(a.escrowToken ? { claimableLaunchToken: `${fmt(a.escrowToken, 18, 6)} ${a.symbol}` } : {}),
      note: `This is the recipient's whole ${Q} balance in the escrow, across every Pons V2 launch that pays them in ${Q}, not only this one. Claim it with prepare_pons_claim.`,
    },
    unswept: {
      heldBy: u.holder, ...(u.poolId ? { poolId: u.poolId } : {}),
      tradingFeePending: `${fmt(u.fee, d, 10)} ${Q}`, creatorTaxPending: `${fmt(u.tax, d, 10)} ${Q}`, buybackEarmark: `${fmt(u.buyback, d, 10)} ${Q}`,
      ...(u.memecoinPending ? { launchTokenFeesPending: `${fmt(u.memecoinPending, 18, 6)} ${a.symbol} (converted by the operator at sweep time)` } : {}),
      protocolShareBps: u.protoBps,
      estimatedCreatorShare: `${fmt(u.creatorShare, d, 10)} ${Q}`, estimatedCreatorShareUsdApprox: usd(u.creatorShare),
      howEstimated: "Same split as the contract's sweep: trading fee minus the protocol share minus any buyback earmark, plus the full creator tax.",
    },
    estimatedTotalOwed: `${fmt(total, d, 10)} ${Q}`, estimatedTotalOwedUsdApprox: usd(total),
    sweep: {
      callableBy: [u.sweeper, ...(u.operator ? [`${u.operator} (Pons sweep operator)`] : [])],
      creatorCanSweepNow: !u.needsOperator && u.fee + u.tax > 0n,
      why: u.fee + u.tax === 0n ? "Nothing is pending right now." : u.needsOperator ? "A buyback or launch-token conversion is pending, so only the Pons sweep operator can sweep (InternalSwapRequiresOperator)." : "Pending fees need no internal swap, so the creator fee recipient can sweep them with prepare_pons_sweep.",
    },
    caveat: CAVEAT,
    usdNote: a.usdPerQuote != null ? "USD values use the Uniswap v3 WETH/USDG pool price on Robinhood Chain." : "No USD price for the pair token.",
    explorer: addrLink(a.escrow),
  };
}

export async function preparePonsSweep({ token, curve }) {
  const from = requireWallet();
  const a = await analyze({ token, curve, recipient: undefined });
  const { u, pair } = a, d = pair.decimals, Q = pair.symbol;
  if (u.fee + u.tax === 0n) throw new Error(`No fees are pending on the ${u.where} for ${a.symbol}, so there is nothing to sweep. Nothing was prepared.`);
  if (getAddress(from) !== u.sweeper) throw new Error(`Only the creator fee recipient ${u.sweeper} (or the Pons sweep operator) can sweep ${a.symbol}'s fees. This wallet is ${from}. Nothing was prepared.`);
  if (u.needsOperator) throw new Error("A buyback or launch-token conversion is pending, which the contract only lets the Pons sweep operator execute (InternalSwapRequiresOperator). Nothing was prepared.");
  const tx = u.where === "curve"
    ? { label: `sweep ${a.symbol} curve fees into the Pons escrow`, to: a.L.curve, value: 0n, data: encodeFunctionData({ abi: curveAbi, functionName: "sweepFees", args: [0n] }) }
    : { label: `sweep ${a.symbol} pool fees into the Pons escrow`, to: ADDR.PONS_HOOK, value: 0n, data: encodeFunctionData({ abi: hookAbi, functionName: "sweepPoolFees", args: [u.poolId, 0n, 0n] }) };
  const lines = [
    `Sweep the fees pending on ${a.symbol}'s ${u.where === "curve" ? `bonding curve ${a.L.curve} (sweepFees)` : `Uniswap v4 pool on the Pons hook ${ADDR.PONS_HOOK} (sweepPoolFees)`}: ${fmt(u.fee, d, 10)} ${Q} trading fee and ${fmt(u.tax, d, 10)} ${Q} creator tax.`,
    `About ${fmt(u.creatorShare, d, 10)} ${Q} is credited to ${u.sweeper} in the Pons fee escrow ${a.escrow}; the protocol share (${u.protoBps / 100}%) goes to Pons. Nothing arrives in the wallet yet: claim it afterwards with prepare_pons_claim.`,
  ];
  return store({ kind: "pons_sweep", from, txs: [tx], lines, usd: 0, valueLine: "No tokens leave the wallet; only the network fee is paid.", extra: { creatorFees: await ponsCreatorFees({ token: a.t, recipient: u.sweeper }) } });
}

export async function preparePonsClaim({ asset = "ETH" } = {}) {
  const from = requireWallet();
  const c = publicClient();
  const native = String(asset).trim().toUpperCase() === "ETH";
  const t = native ? null : await resolveToken(asset);
  if (t && t.native) throw new Error("Use asset ETH for the native ledger.");
  const bal = native ? await c.readContract({ address: ADDR.PONS_ESCROW, abi: escrowAbi, functionName: "balanceOf", args: [from] })
    : await c.readContract({ address: ADDR.PONS_ESCROW, abi: escrowAbi, functionName: "balanceOfToken", args: [from, t.address] });
  const sym = native ? "ETH" : t.symbol, d = native ? 18 : t.decimals;
  if (bal === 0n) throw new Error(`This wallet has no ${sym} to claim in the Pons fee escrow ${ADDR.PONS_ESCROW}. Fees may still be unswept on the curve or hook: check pons_creator_fees. Nothing was prepared.`);
  const tx = native
    ? { label: `claim ${fmt(bal, 18, 10)} ETH from the Pons fee escrow`, to: ADDR.PONS_ESCROW, value: 0n, data: encodeFunctionData({ abi: escrowAbi, functionName: "claim" }) }
    : { label: `claim ${fmt(bal, d, 10)} ${sym} from the Pons fee escrow`, to: ADDR.PONS_ESCROW, value: 0n, data: encodeFunctionData({ abi: escrowAbi, functionName: "claimToken", args: [t.address] }) };
  const lines = [`Claim the full ${fmt(bal, d, 10)} ${sym} this wallet has in the Pons V2 fee escrow ${ADDR.PONS_ESCROW} (${native ? "claim()" : `claimToken(${t.address})`}). It is paid to this wallet.`];
  return store({ kind: "pons_claim", from, txs: [tx], lines, usd: 0, valueLine: `No tokens leave the wallet; it receives ${fmt(bal, d, 10)} ${sym}. Only the network fee is paid.` });
}
