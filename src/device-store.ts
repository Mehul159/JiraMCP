import { mkdir, readFile, rename, writeFile, open, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

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

export async function ensureStoreReady(dir: string) {
  await mkdir(dir, { recursive: true });
}

export async function loadStore(dir: string): Promise<DeviceFilePayload> {
  await ensureStoreReady(dir);
  const path = join(dir, "devices.json");
  try {
    const txt = await readFile(path, "utf8");
    const parsed = JSON.parse(txt) as DeviceFilePayload;
    if (!parsed.devices || typeof parsed.devices !== "object") {
      return { devices: {} };
    }
    return parsed;
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      return { devices: {} };
    }
    throw e;
  }
}

export async function saveStoreAtomic(dir: string, payload: DeviceFilePayload) {
  await ensureStoreReady(dir);
  const path = tokenFilename(dir);
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = JSON.stringify(payload, null, 2);
  await writeFile(tmp, fd, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function acquireLock(dir: string): Promise<() => Promise<void>> {
  await ensureStoreReady(dir);
  const lockPath = join(dir, "devices.json.lock");
  let retries = 0;
  while (retries < 50) {
    try {
      const file = await open(lockPath, "wx");
      await file.close();
      return async () => {
        try { await unlink(lockPath); } catch {}
      };
    } catch (e: any) {
      if (e.code === "EEXIST") {
        try {
          const stats = await stat(lockPath);
          if (Date.now() - stats.mtimeMs > 10000) {
            await unlink(lockPath);
            continue;
          }
        } catch (statErr) {}
        retries++;
        await delay(100);
      } else {
        throw e;
      }
    }
  }
  throw new Error("Could not acquire lock for devices.json");
}

export function generateDeviceToken(): string {
  return `jmcp_${randomBytes(32).toString("base64url")}`;
}

export async function registerDevice(
  dir: string,
  email: string,
  apiToken: string,
): Promise<string> {
  const release = await acquireLock(dir);
  try {
    const token = generateDeviceToken();
    const payload = await loadStore(dir);
    payload.devices[token] = {
      email: email.trim(),
      apiToken,
      createdAt: new Date().toISOString(),
    };
    await saveStoreAtomic(dir, payload);
    return token;
  } finally {
    await release();
  }
}

export async function getDeviceCredential(
  dir: string,
  token: string,
): Promise<StoredDeviceCredential | null> {
  if (!token) return null;
  const payload = await loadStore(dir);
  return payload.devices[token] ?? null;
}

export async function revokeDevice(dir: string, token: string): Promise<boolean> {
  const release = await acquireLock(dir);
  try {
    const payload = await loadStore(dir);
    if (!payload.devices[token]) return false;
    delete payload.devices[token];
    await saveStoreAtomic(dir, payload);
    return true;
  } finally {
    await release();
  }
}
