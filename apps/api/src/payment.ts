import { createHash, timingSafeEqual } from "node:crypto";

export interface EpayConfig {
  gatewayUrl: string;
  merchantId: string;
  merchantKey: string;
  paymentType: "alipay" | "wxpay";
}

export interface EpayOrder {
  orderNo: string;
  amountCents: number;
  name: string;
}

function normalizedParameters(input: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(input)
    .filter(([key, value]) => key !== "sign" && key !== "sign_type" && value !== undefined && value !== null && String(value) !== "")
    .map(([key, value]) => [key, String(value)] as [string, string])
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
}

export function signEpay(input: Record<string, unknown>, merchantKey: string): string {
  const canonical = normalizedParameters(input).map(([key, value]) => `${key}=${value}`).join("&");
  return createHash("md5").update(`${canonical}${merchantKey}`, "utf8").digest("hex");
}

export function verifyEpaySignature(input: Record<string, unknown>, merchantKey: string): boolean {
  const received = String(input.sign ?? "").toLowerCase();
  const expected = signEpay(input, merchantKey);
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

export function parseMoneyToCents(value: unknown): number | null {
  const text = String(value ?? "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const amount = Math.round(Number(text) * 100);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}

export function buildEpayCheckoutUrl(
  config: EpayConfig,
  order: EpayOrder,
  urls: { notifyUrl: string; returnUrl: string },
): string {
  const url = new URL(config.gatewayUrl);
  const path = url.pathname.replace(/\/+$/, "");
  if (!/\.php$/i.test(path)) url.pathname = `${path}/submit.php`;
  const parameters: Record<string, string> = {
    pid: config.merchantId,
    type: config.paymentType,
    out_trade_no: order.orderNo,
    notify_url: urls.notifyUrl,
    return_url: urls.returnUrl,
    name: order.name,
    money: (order.amountCents / 100).toFixed(2),
    sign_type: "MD5",
  };
  parameters.sign = signEpay(parameters, config.merchantKey);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.toString();
}
