import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";import { randomBytes } from "node:crypto";

export type StoredDeviceCredential = {
  email: string;
  apiToken: string;
  createdAt: string;
};

export type DeviceFilePayload = {
  devices: Record<string, StoredDeviceCredential>;
};

function tokenFilename(dir: string) {
  return join(dir, "devices.json");
}

export function deviceStoreDir(): string {
  const raw = process.env.MCP_DATA_DIR?.trim() || join(process.cwd(), "data");
  return raw;
}

export function ensureStoreReady(dir: string) {
  mkdirSync(dir, { recursive: true });
}

export function loadStore(dir: string): DeviceFilePayload {
  ensureStoreReady(dir);
  const path = join(dir, "devices.json");
  try {
    const txt = readFileSync(path, "utf8");
    const parsed = JSON.parse(txt) as DeviceFilePayload;
    if (!parsed.devices || typeof parsed.devices !== "object") {
      return { devices: {} };
    }
    return parsed;
  } catch {
    return { devices: {} };
  }
}

export function saveStoreAtomic(dir: string, payload: DeviceFilePayload) {
  ensureStoreReady(dir);
  const path = tokenFilename(dir);
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = JSON.stringify(payload, null, 2);
  writeFileSync(tmp, fd, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

/** Prefix lets ops grep logs without confusing tokens with other secrets. */
export function generateDeviceToken(): string {
  return `jmcp_${randomBytes(32).toString("base64url")}`;
}

export function registerDevice(
  dir: string,
  email: string,
  apiToken: string,
): string {
  const token = generateDeviceToken();
  const payload = loadStore(dir);
  payload.devices[token] = {
    email: email.trim(),
    apiToken,
    createdAt: new Date().toISOString(),
  };
  saveStoreAtomic(dir, payload);
  return token;
}

export function getDeviceCredential(
  dir: string,
  token: string,
): StoredDeviceCredential | null {
  if (!token) return null;
  const payload = loadStore(dir);
  return payload.devices[token] ?? null;
}

export function revokeDevice(dir: string, token: string): boolean {
  const payload = loadStore(dir);
  if (!payload.devices[token]) return false;
  delete payload.devices[token];
  saveStoreAtomic(dir, payload);
  return true;
}
