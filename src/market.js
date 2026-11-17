// GeckoTerminal public API (third-party market data for Robinhood Chain). Read-only.
import { isAddress, getAddress } from "viem";
import { GECKO, getJson } from "./chain.js";

const num = (x) => (x == null ? null : Number(x));
const pool = (p, inc) => {
  const a = p.attributes, dexId = p.relationships?.dex?.data?.id;
  return { name: a.name, address: a.address, dex: inc?.[dexId] || dexId, priceUsd: num(a.base_token_price_usd), reserveUsd: num(a.reserve_in_usd),
    volume24hUsd: num(a.volume_usd?.h24), change24hPct: num(a.price_change_percentage?.h24), createdAt: a.pool_created_at };
};

export async function marketToken({ token }) {
  if (!isAddress(token || "")) throw new Error("token must be a 0x address.");
  const t = getAddress(token).toLowerCase();
  const j = await getJson(`${GECKO}/tokens/${t}?include=top_pools`);
  const a = j.data.attributes;
  return { source: `${GECKO}/tokens/${t}`, fetchedAt: new Date().toISOString(), name: a.name, symbol: a.symbol, priceUsd: num(a.price_usd),
    fdvUsd: num(a.fdv_usd), marketCapUsd: num(a.market_cap_usd), volume24hUsd: num(a.volume_usd?.h24), totalReserveUsd: num(a.total_reserve_in_usd),
    topPools: (j.included || []).filter((x) => x.type === "pool").slice(0, 5).map((p) => pool(p)),
    note: "Third-party data from GeckoTerminal. It can lag the chain." };
}

export async function marketTrending({ limit = 10 } = {}) {
  const j = await getJson(`${GECKO}/trending_pools?include=dex`);
  const inc = Object.fromEntries((j.included || []).map((x) => [x.id, x.attributes?.name]));
  return { source: `${GECKO}/trending_pools`, fetchedAt: new Date().toISOString(), pools: (j.data || []).slice(0, limit).map((p) => pool(p, inc)),
    note: "Third-party data from GeckoTerminal. Trending is not a recommendation." };
}
