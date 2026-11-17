// Encrypted local keystore: scrypt key derivation + AES-256-GCM. The key never leaves this computer.
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { paths, ensureDir } from "./config.js";

const KDF = { N: 2 ** 17, r: 8, p: 1, dkLen: 32 };
const derive = (pass, salt, k = KDF) => scryptSync(pass.normalize("NFKC"), salt, k.dkLen, { N: k.N, r: k.r, p: k.p, maxmem: 512 * 1024 * 1024 });

export function keystoreExists() { return existsSync(paths().keystore); }

export function writeKeystore(privateKey, passphrase) {
  const account = privateKeyToAccount(privateKey);
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = derive(passphrase, salt);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(privateKey.slice(2), "hex")), c.final()]);
  const data = {
    version: 1,
    address: account.address,
    chainId: 4663,
    kdf: { name: "scrypt", ...KDF, salt: salt.toString("hex") },
    cipher: { name: "aes-256-gcm", iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex") },
    ciphertext: ct.toString("hex"),
    createdAt: new Date().toISOString(),
  };
  ensureDir();
  writeFileSync(paths().keystore, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return account.address;
}

export function readKeystore() {
  if (!keystoreExists()) return null;
  return JSON.parse(readFileSync(paths().keystore, "utf8"));
}

export function walletAddress() {
  const ks = readKeystore();
  return ks ? ks.address : null;
}

export function decryptKey(passphrase) {
  const ks = readKeystore();
  if (!ks) throw new Error("No Holbric wallet yet. Run `holbric init` in your own terminal.");
  const key = derive(passphrase, Buffer.from(ks.kdf.salt, "hex"), ks.kdf);
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ks.cipher.iv, "hex"));
  d.setAuthTag(Buffer.from(ks.cipher.tag, "hex"));
  let pk;
  try { pk = Buffer.concat([d.update(Buffer.from(ks.ciphertext, "hex")), d.final()]); }
  catch { throw new Error("Wrong passphrase for the Holbric keystore."); }
  return "0x" + pk.toString("hex");
}

/** Passphrase for signing inside the MCP server: HOLBRIC_PASSPHRASE env, or the 0600 passphrase file written by `holbric init`. */
export function signingPassphrase() {
  if (process.env.HOLBRIC_PASSPHRASE) return process.env.HOLBRIC_PASSPHRASE;
  if (existsSync(paths().passphrase)) return readFileSync(paths().passphrase, "utf8").replace(/\r?\n$/, "");
  throw new Error("Signing is locked. Either run `holbric unlock` in your terminal to store the passphrase file, or set HOLBRIC_PASSPHRASE in your host's MCP config.");
}

export function loadAccount() {
  return privateKeyToAccount(decryptKey(signingPassphrase()));
}
