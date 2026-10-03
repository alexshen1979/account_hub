export interface AccountHubClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

export interface WalletBalance {
  id: string;
  available: number | string;
  frozen: number | string;
  updated_at: string;
}

export interface UsageReservation {
  id: string;
  status: "reserved" | "captured" | "released";
  balance?: WalletBalance;
  idempotent?: boolean;
}

export interface ExchangedIdentity {
  user: {
    id: string;
    email: string;
    displayName: string;
    systemRole: "admin" | "user";
  };
  wallet: { available: number; frozen: number };
}

export class AccountHubError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

export class AccountHubClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: AccountHubClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async getWallet(userId: string): Promise<WalletBalance> {
    return this.request(`/api/sdk/v1/users/${encodeURIComponent(userId)}/wallet`);
  }

  async exchangeAuthorizationCode(code: string, redirectUri: string): Promise<ExchangedIdentity> {
    return this.request("/api/sdk/v1/auth/exchange", {
      method: "POST",
      body: JSON.stringify({ code, redirectUri }),
    });
  }

  async reserveUsage(input: {
    userId: string;
    amount: number;
    idempotencyKey: string;
    externalReference?: string;
  }): Promise<UsageReservation> {
    return this.request("/api/sdk/v1/usage/reservations", { method: "POST", body: JSON.stringify(input) });
  }

  async captureUsage(reservationId: string): Promise<UsageReservation> {
    return this.request(`/api/sdk/v1/usage/reservations/${encodeURIComponent(reservationId)}/capture`, { method: "POST" });
  }

  async releaseUsage(reservationId: string): Promise<UsageReservation> {
    return this.request(`/api/sdk/v1/usage/reservations/${encodeURIComponent(reservationId)}/release`, { method: "POST" });
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    if (init?.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
    const payload = await response.json() as T & { error?: string };
    if (!response.ok) throw new AccountHubError(payload.error ?? "Account Hub request failed", response.status);
    return payload;
  }
}
