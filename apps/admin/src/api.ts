export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers,
  });
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new ApiError(payload.error ?? "请求失败", response.status);
  return payload as T;
}

export function post<T>(path: string, data?: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: data === undefined ? undefined : JSON.stringify(data) });
}

export function formatCredits(value: string | number): string {
  return Number(value).toLocaleString("zh-CN");
}

export function formatMoney(cents: string | number, currency = "CNY"): string {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency }).format(Number(cents) / 100);
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
