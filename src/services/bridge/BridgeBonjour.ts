import { Bonjour } from "bonjour-service";
import {
  LEGACY_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./wireProtocol.js";

/**
 * Publishes the running daemon as `_psyche._tcp.local.` so iOS clients on
 * the same LAN find it via Bonjour. TXT record carries protocol version
 * + serverId so iOS can dedupe and reject mismatched protocol versions
 * before connecting.
 *
 * Failures are non-fatal — networks may be offline, services may be
 * blocked. Caller should swallow exceptions from publish().
 */
export class BridgeBonjour {
  private bj: Bonjour | null = null;
  private service: any = null;

  publish(opts: { name: string; port: number; serverId: string }): void {
    this.bj = new Bonjour();
    this.service = this.bj.publish({
      name: opts.name,
      type: "psyche",
      port: opts.port,
      protocol: "tcp",
      txt: {
        proto: String(LEGACY_PROTOCOL_VERSION),
        versions: SUPPORTED_PROTOCOL_VERSIONS.join(","),
        serverId: opts.serverId,
      },
    });
  }

  async stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.service || !this.bj) return resolve();
      this.service.stop(() => {
        this.bj?.destroy();
        this.bj = null;
        this.service = null;
        resolve();
      });
    });
  }
}
