// Robinhood Chain mainnet constants. Sources: docs.robinhood.com/chain/connecting,
// docs.robinhood.com/chain/contracts, robinhoodchain.blockscout.com.
import { createPublicClient, defineChain, http, getAddress, isAddress, erc20Abi } from "viem";
import { loadConfig } from "./config.js";

export const CHAIN_ID = 4663;
export const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER = "https://robinhoodchain.blockscout.com";

export const ADDR = {
  USDG: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
  WETH: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  QUOTER_V2: getAddress("0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7"),
  SWAP_ROUTER_02: getAddress("0xcaf681a66d020601342297493863e78c959e5cb2"),
  // Uniswap v3 factory (docs). QuoterV2.factory() and SwapRouter02.factory() both return this address on chain.
  UNISWAP_V3_FACTORY: getAddress("0x1f7d7550b1b028f7571e69a784071f0205fd2efa"),
  // Pons V2 launch factory, exact match on Sourcify as PonsV2LaunchFactory.
  PONS_FACTORY: getAddress("0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e"),
  // Pons V2 fee escrow (Sourcify exact match: PonsV2FeeEscrow) and meme hook (PonsV2MemeHook). docs.ponsfamily.com/v2#contracts
  PONS_ESCROW: getAddress("0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e"),
  PONS_HOOK: getAddress("0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044"),
  // ERC-8004 registries (proxies; implementations exact match on Sourcify).
  ERC8004_IDENTITY: getAddress("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"),
  ERC8004_REPUTATION: getAddress("0x8004BAa17C55a88189AE136b182e5fdA19dE9b63"),
};
export const SOURCIFY = "https://sourcify.dev/server/v2/contract/4663";
export const GECKO = "https://api.geckoterminal.com/api/v2/networks/robinhood";
export const RH_ASSETS = "https://api.robinhood.com/rhj/assets";

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [DEFAULT_RPC] } },
  blockExplorers: { default: { name: "Blockscout", url: EXPLORER } },
});

let _client;
export function rpcUrl() {
  return process.env.HOLBRIC_RPC || loadConfig().rpc || DEFAULT_RPC;
}
export function publicClient() {
  if (!_client) _client = createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl(), { timeout: 20_000, retryCount: 2 }) });
  return _client;
}
export function transport() {
  return http(rpcUrl(), { timeout: 30_000, retryCount: 2 });
}

const KNOWN = {
  ETH: { symbol: "ETH", name: "Ether (native)", address: null, decimals: 18, native: true },
  USDG: { symbol: "USDG", name: "Global Dollar", address: ADDR.USDG, decimals: 6 },
  WETH: { symbol: "WETH", name: "Wrapped Ether", address: ADDR.WETH, decimals: 18 },
};
export const KNOWN_TOKENS = KNOWN;

/** Resolve "ETH" | "USDG" | "WETH" | 0x-address into token metadata, reading ERC-20 fields on-chain. */
export async function resolveToken(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("Token is required (ETH, USDG, WETH or a 0x contract address).");
  const key = input.trim().toUpperCase();
  if (KNOWN[key]) return { ...KNOWN[key] };
  if (!isAddress(input.trim())) throw new Error(`Unknown token "${input}". Use ETH, USDG, WETH or a 0x contract address on Robinhood Chain.`);
  const address = getAddress(input.trim());
  for (const t of Object.values(KNOWN)) if (t.address === address) return { ...t };
  const c = publicClient();
  const code = await c.getCode({ address });
  if (!code || code === "0x") throw new Error(`No contract at ${address} on Robinhood Chain mainnet.`);
  const [symbol, decimals, name] = await Promise.all([
    c.readContract({ address, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
    c.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    c.readContract({ address, abi: erc20Abi, functionName: "name" }).catch(() => ""),
  ]);
  return { symbol, name, address, decimals: Number(decimals), unverified: true };
}

/** The ERC-20 address used inside Uniswap for a token (native ETH routes as WETH). */
export const poolAddress = (t) => (t.native ? ADDR.WETH : t.address);

export const txLink = (h) => `${EXPLORER}/tx/${h}`;
export const addrLink = (a) => `${EXPLORER}/address/${a}`;

export const fmt = (v, d, max = 8) => {
  const neg = v < 0n; if (neg) v = -v;
  const base = 10n ** BigInt(d); const i = v / base; let f = (v % base).toString().padStart(d, "0").slice(0, max).replace(/0+$/, "");
  return (neg ? "-" : "") + i.toString() + (f ? "." + f : "");
};
export const localTime = (d) => d.toLocaleString("en-GB", { hour12: false, timeZoneName: "short" });
export async function getJson(url, ms = 15000) {
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "holbric-mcp" }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${new URL(url).host} returned HTTP ${r.status}`);
  return r.json();
}
