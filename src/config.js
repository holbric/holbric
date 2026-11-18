import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";

export const HOME = () => process.env.HOLBRIC_HOME || join(homedir(), ".holbric");
export const paths = () => ({
  dir: HOME(),
  keystore: join(HOME(), "keystore.json"),
  passphrase: join(HOME(), "passphrase"),
  config: join(HOME(), "config.json"),
  spend: join(HOME(), "spend.json"),
});

export function ensureDir() {
  mkdirSync(HOME(), { recursive: true, mode: 0o700 });
  try { chmodSync(HOME(), 0o700); } catch {}
}

const DEFAULTS = { rpc: null, dailyLimitUsd: null, slippageBps: 50, aggregators: true };

export function loadConfig() {
  const p = paths().config;
  if (!existsSync(p)) return { ...DEFAULTS };
  try { return { ...DEFAULTS, ...JSON.parse(readFileSync(p, "utf8")) }; } catch { return { ...DEFAULTS }; }
}
export function saveConfig(cfg) {
  ensureDir();
  writeFileSync(paths().config, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function spentToday() {
  const p = paths().spend;
  if (!existsSync(p)) return 0;
  try { const s = JSON.parse(readFileSync(p, "utf8")); return s.date === today() ? Number(s.usd) || 0 : 0; } catch { return 0; }
}
export function recordSpend(usd) {
  ensureDir();
  const usdNow = spentToday() + usd;
  writeFileSync(paths().spend, JSON.stringify({ date: today(), usd: usdNow }, null, 2) + "\n", { mode: 0o600 });
  return usdNow;
}
