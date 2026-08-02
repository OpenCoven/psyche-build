import fs from "node:fs/promises";
import crypto from "node:crypto";
import selfsigned from "selfsigned";
import { bridgeDir, certPath, keyPath } from "./paths.js";

export interface TLSMaterial {
  cert: string;        // PEM
  key: string;         // PEM
  fingerprint: string; // colon-separated uppercase hex of SHA-256
}

/** Returns existing TLS material, creating fresh self-signed if absent. */
export async function loadOrCreateTLS(): Promise<TLSMaterial> {
  await fs.mkdir(bridgeDir, { recursive: true, mode: 0o700 });
  try {
    const cert = await fs.readFile(certPath, "utf8");
    const key = await fs.readFile(keyPath, "utf8");
    return { cert, key, fingerprint: fingerprintFromPEM(cert) };
  } catch {
    return generateAndStore();
  }
}

async function generateAndStore(): Promise<TLSMaterial> {
  const attrs = [{ name: "commonName", value: "psyche" }];
  const opts = {
    keySize: 2048,
    days: 3650,
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 7, ip: "127.0.0.1" },
        ],
      },
    ],
  };
  const pems = selfsigned.generate(attrs, opts);
  await fs.writeFile(certPath, pems.cert, { mode: 0o600 });
  await fs.writeFile(keyPath, pems.private, { mode: 0o600 });
  return { cert: pems.cert, key: pems.private, fingerprint: fingerprintFromPEM(pems.cert) };
}

function fingerprintFromPEM(pem: string): string {
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
  const digest = crypto.createHash("sha256").update(der).digest("hex").toUpperCase();
  return digest.match(/.{2}/g)!.join(":");
}
