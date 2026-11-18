// Spend history: a local, append-only record of every action Holbric signed and sent through execute_prepared.
// One JSON object per line in ~/.holbric/history.jsonl (mode 600). Nothing here is sent anywhere.
// What it can and cannot say:
//   - Only actions signed by Holbric from the version that added this file are recorded. Earlier actions, and anything
//     signed outside Holbric with the same key, are not in it.
//   - usdEstimate is the USD value Holbric estimated when the action was prepared (its own Uniswap quote into USDG),
//     the same figure the daily limit uses. It is not a price at the time of the transaction and not a realised value.
//   - networkFeeEth is read from each receipt: gasUsed x effectiveGasPrice. On Robinhood Chain gasUsed already includes
//     the parent-chain data cost (gasUsedForL1), so this is the whole fee the wallet paid.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { formatEther } from "viem";
import { paths, ensureDir } from "./config.js";
import { CHAIN_ID, txLink } from "./chain.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Build one history entry from a prepared action, the execute_prepared output and the receipts. Pure; used by tests. */
export function historyEntry(p, out, receipts, now = new Date()) {
  const fee = receipts.reduce((a, r) => a + BigInt(r.gasUsed ?? 0n) * BigInt(r.effectiveGasPrice ?? 0n), 0n);
  const sent = out.transactions.length, planned = p.txs.length;
  return {
    v: 1,
    time: now.toISOString(),
    date: localDay(now),
    chainId: CHAIN_ID,
    wallet: p.from,
    kind: p.kind,
    prepareId: p.id,
    result: out.result?.startsWith("Confirmed") ? "confirmed" : out.transactions.some((t) => t.status === "reverted") ? "reverted" : "incomplete",
    steps: out.transactions.map((t) => ({ step: t.step, hash: t.hash, status: t.status, block: t.block })),
    notSent: planned - sent,
    usdEstimate: p.usd == null ? null : +p.usd.toFixed(2),
    networkFeeWei: fee.toString(),
    networkFeeEth: formatEther(fee),
  };
}

/** Append one entry. Never throws: a failed history write must not hide a transaction that was already sent. */
export function appendHistory(entry) {
  try {
    ensureDir();
    appendFileSync(paths().history, JSON.stringify(entry) + "\n", { mode: 0o600 });
    return true;
  } catch { return false; }
}

/** Every readable entry, oldest first. Lines that do not parse are counted, not dropped silently. */
export function readHistory() {
  const p = paths().history;
  if (!existsSync(p)) return { entries: [], unreadable: 0 };
  const entries = []; let unreadable = 0;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && e.time && e.kind) entries.push(e); else unreadable++; } catch { unreadable++; }
  }
  return { entries, unreadable };
}

const CSV_COLS = ["time", "date", "kind", "result", "usdEstimate", "networkFeeEth", "txHashes", "blocks", "wallet", "prepareId"];
const csvCell = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function toCsv(entries) {
  const rows = entries.map((e) => ({ ...e, txHashes: e.steps.map((s) => s.hash).join(" "), blocks: e.steps.map((s) => s.block).join(" ") }));
  return [CSV_COLS.join(","), ...rows.map((r) => CSV_COLS.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}

/** Filter and summarise. from/to are local calendar days (YYYY-MM-DD, inclusive). */
export function spendHistory({ from, to, kind, format = "json", limit } = {}) {
  for (const [k, v] of [["from", from], ["to", to]]) if (v != null && !DAY.test(v)) throw new Error(`${k} must be a date written as YYYY-MM-DD.`);
  if (from && to && from > to) throw new Error("from is after to.");
  if (!["json", "csv"].includes(format)) throw new Error('format must be "json" or "csv".');
  const { entries: all, unreadable } = readHistory();
  let entries = all.filter((e) => (!from || e.date >= from) && (!to || e.date <= to) && (!kind || e.kind === kind));
  const matching = entries.length;
  if (limit != null) entries = entries.slice(-limit);
  const totals = {
    actions: entries.length,
    confirmed: entries.filter((e) => e.result === "confirmed").length,
    usdEstimate: +entries.reduce((a, e) => a + (e.usdEstimate ?? 0), 0).toFixed(2),
    actionsWithoutUsdEstimate: entries.filter((e) => e.usdEstimate == null).length,
    networkFeeEth: formatEther(entries.reduce((a, e) => a + BigInt(e.networkFeeWei ?? "0"), 0n)),
    byKind: Object.fromEntries([...new Set(entries.map((e) => e.kind))].map((k) => [k, entries.filter((e) => e.kind === k).length])),
  };
  const notes = [
    `Local record in ${paths().history}. Nothing was read from or sent to the network.`,
    "Only actions signed through execute_prepared since Holbric started keeping this record are listed. Earlier actions, and anything signed outside Holbric, are not.",
    "usdEstimate is Holbric's estimate when the action was prepared (the figure the daily limit uses), not a price at the time of the transaction. networkFeeEth is read from the receipts.",
  ];
  if (unreadable) notes.push(`${unreadable} line(s) in the file could not be read and are left out.`);
  if (matching > entries.length) notes.push(`Showing the latest ${entries.length} of ${matching} matching actions.`);
  const base = { file: paths().history, filter: { from: from ?? null, to: to ?? null, kind: kind ?? null }, totals, notes };
  if (format === "csv") return { ...base, csv: toCsv(entries) };
  return { ...base, entries: entries.map((e) => ({ ...e, steps: e.steps.map((s) => ({ ...s, explorer: txLink(s.hash) })) })) };
}
