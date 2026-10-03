import { arch, freemem, hostname, platform, release, totalmem, uptime } from "node:os";
import { cpu, currentLoad, fsSize, mem, osInfo, time } from "systeminformation";

const cacheTtlMs = 15_000;

export interface ServerStatus {
  state: "healthy" | "warning" | "critical" | "unknown";
  sampledAt: string;
  hostname: string;
  platform: string;
  distro: string;
  release: string;
  arch: string;
  nodeVersion: string;
  hostUptimeSeconds: number;
  serviceUptimeSeconds: number;
  cpu: { usagePercent: number; cores: number; model: string };
  memory: { totalBytes: number; usedBytes: number; usagePercent: number };
  disk: { totalBytes: number; usedBytes: number; usagePercent: number; mount: string };
}

let cached: { expiresAt: number; value: ServerStatus } | null = null;
let pending: Promise<ServerStatus> | null = null;

function percent(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round(Math.min(100, Math.max(0, used / total * 100)) * 10) / 10;
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function resourceState(cpuPercent: number, memoryPercent: number, diskPercent: number): ServerStatus["state"] {
  if (memoryPercent >= 97 || diskPercent >= 95) return "critical";
  if (cpuPercent >= 90 || memoryPercent >= 90 || diskPercent >= 85) return "warning";
  return "healthy";
}

async function collectServerStatus(): Promise<ServerStatus> {
  try {
    const [os, cpuInfo, load, memory, disks] = await Promise.all([
      osInfo(),
      cpu(),
      currentLoad(),
      mem(),
      fsSize(),
    ]);
    const currentDirectory = normalizedPath(process.cwd());
    const disk = disks
      .filter((item) => item.size > 0)
      .sort((left, right) => normalizedPath(right.mount).length - normalizedPath(left.mount).length)
      .find((item) => {
        const mount = normalizedPath(item.mount || item.fs);
        return currentDirectory === mount || currentDirectory.startsWith(`${mount}/`);
      }) ?? disks.find((item) => item.size > 0);
    const memoryUsed = memory.used;
    const memoryPercent = percent(memoryUsed, memory.total);
    const diskPercent = disk ? percent(disk.used, disk.size) : 0;
    const cpuPercent = Math.round(Math.min(100, Math.max(0, load.currentLoad)) * 10) / 10;
    return {
      state: resourceState(cpuPercent, memoryPercent, diskPercent),
      sampledAt: new Date().toISOString(),
      hostname: os.hostname || hostname(),
      platform: os.platform || platform(),
      distro: os.distro || os.codename || os.platform || platform(),
      release: os.release || release(),
      arch: os.arch || arch(),
      nodeVersion: process.version,
      hostUptimeSeconds: Math.max(0, Math.round(time().uptime)),
      serviceUptimeSeconds: Math.max(0, Math.round(process.uptime())),
      cpu: {
        usagePercent: cpuPercent,
        cores: cpuInfo.cores,
        model: [cpuInfo.manufacturer, cpuInfo.brand].filter(Boolean).join(" "),
      },
      memory: {
        totalBytes: memory.total,
        usedBytes: memoryUsed,
        usagePercent: memoryPercent,
      },
      disk: {
        totalBytes: disk?.size ?? 0,
        usedBytes: disk?.used ?? 0,
        usagePercent: diskPercent,
        mount: disk?.mount || disk?.fs || "-",
      },
    };
  } catch {
    const total = totalmem();
    const used = total - freemem();
    return {
      state: "unknown",
      sampledAt: new Date().toISOString(),
      hostname: hostname(),
      platform: platform(),
      distro: platform(),
      release: release(),
      arch: arch(),
      nodeVersion: process.version,
      hostUptimeSeconds: Math.max(0, Math.round(uptime())),
      serviceUptimeSeconds: Math.max(0, Math.round(process.uptime())),
      cpu: { usagePercent: 0, cores: 0, model: "" },
      memory: { totalBytes: total, usedBytes: used, usagePercent: percent(used, total) },
      disk: { totalBytes: 0, usedBytes: 0, usagePercent: 0, mount: "-" },
    };
  }
}

export async function getServerStatus(): Promise<ServerStatus> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (pending) return pending;
  pending = collectServerStatus().then((value) => {
    cached = { value, expiresAt: Date.now() + cacheTtlMs };
    return value;
  }).finally(() => {
    pending = null;
  });
  return pending;
}
