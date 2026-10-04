import type { FetchFn } from "./jupiter.js";

/**
 * Jito block engine. Transactions sent with bundleOnly=true are "revert
 * protected": if the arbitrage would fail, it is simply not included in a
 * block, so a failed attempt costs nothing. The tip is only paid when it lands.
 */
export class JitoClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private async rpc<T>(path: string, method: string, params: unknown[]): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Jito ${method} ${res.status}: ${text.slice(0, 160)}`);
    const body = JSON.parse(text) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(`Jito ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
    if (body.result === undefined) throw new Error(`Jito ${method}: empty response`);
    return body.result;
  }

  getTipAccounts(): Promise<string[]> {
    return this.rpc<string[]>("/getTipAccounts", "getTipAccounts", []);
  }

  /** Sends a signed transaction (base64) as a revert-protected single-transaction bundle. */
  sendTransaction(base64Tx: string): Promise<string> {
    return this.rpc<string>("/transactions?bundleOnly=true", "sendTransaction", [base64Tx, { encoding: "base64" }]);
  }
}
