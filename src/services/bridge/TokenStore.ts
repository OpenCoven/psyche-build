import fs from "node:fs/promises";
import { tokensPath, bridgeDir } from "./paths.js";
import { randomBytes } from "node:crypto";
import { atomicWriteFile } from "../../utils/atomicWrite.js";

export interface DeviceRecord {
  token: string;
  clientId: string;
  clientName: string;
  pairedAt: string;
  lastSeenAt: string;
}

interface TokensFile {
  version: 1;
  devices: DeviceRecord[];
}

export class TokenStore {
  private cache: TokensFile | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  async load(): Promise<TokensFile> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await fs.readFile(tokensPath, "utf8"));
    } catch (err: any) {
      if (err.code !== "ENOENT" && !(err instanceof SyntaxError)) throw err;
      this.cache = { version: 1, devices: [] };
    }
    return this.cache!;
  }

  async list(): Promise<DeviceRecord[]> {
    return (await this.load()).devices.slice();
  }

  async issue(clientId: string, clientName: string): Promise<DeviceRecord> {
    return this.mutate((file) => {
      const rec: DeviceRecord = {
        token: randomBytes(32).toString("hex"),
        clientId,
        clientName,
        pairedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      };
      file.devices.push(rec);
      return { result: rec, dirty: true };
    });
  }

  async revoke(token: string): Promise<boolean> {
    return this.mutate((file) => {
      const before = file.devices.length;
      file.devices = file.devices.filter(d => d.token !== token);
      return { result: file.devices.length !== before, dirty: file.devices.length !== before };
    });
  }

  async touch(token: string): Promise<void> {
    await this.mutate((file) => {
      const rec = file.devices.find(d => d.token === token);
      if (!rec) return { result: undefined, dirty: false };
      rec.lastSeenAt = new Date().toISOString();
      return { result: undefined, dirty: true };
    });
  }

  async validate(token: string): Promise<DeviceRecord | null> {
    const file = await this.load();
    return file.devices.find(d => d.token === token) ?? null;
  }

  private async mutate<T>(
    fn: (file: TokensFile) => { result: T; dirty: boolean } | Promise<{ result: T; dirty: boolean }>
  ): Promise<T> {
    let result: T;
    const next = this.mutationQueue.then(async () => {
      const file = await this.load();
      const mutation = await fn(file);
      result = mutation.result;
      if (mutation.dirty) await this.write(file);
    });
    this.mutationQueue = next.catch(() => {});
    await next;
    return result!;
  }

  private async write(file: TokensFile) {
    await fs.mkdir(bridgeDir, { recursive: true, mode: 0o700 });
    // Synced temp-plus-rename: a full disk keeps the previous device list and
    // removes the partial temporary file, which would otherwise hold tokens.
    await atomicWriteFile(tokensPath, JSON.stringify(file, null, 2), { mode: 0o600 });
    this.cache = file;
  }
}
