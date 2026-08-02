import path from "node:path";
import os from "node:os";

export const bridgeDir = path.join(os.homedir(), ".psyche", "bridge");
export const certPath = path.join(bridgeDir, "cert.pem");
export const keyPath = path.join(bridgeDir, "key.pem");
export const tokensPath = path.join(bridgeDir, "devices.json");
