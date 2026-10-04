import { describe, expect, it } from "vitest";
import { JitoClient } from "../src/jito.js";

describe("JitoClient", () => {
  it("sends revert-protected transactions as JSON-RPC", async () => {
    let seen: { url: string; body: any } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "sigABC" }));
    }) as unknown as typeof fetch;
    const sig = await new JitoClient("https://jito.example/api/v1", fetchFn).sendTransaction("AAAA");
    expect(sig).toBe("sigABC");
    expect(seen!.url).toBe("https://jito.example/api/v1/transactions?bundleOnly=true");
    expect(seen!.body).toMatchObject({ method: "sendTransaction", params: ["AAAA", { encoding: "base64" }] });
  });

  it("surfaces Jito errors", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "rate limited" } }))) as unknown as typeof fetch;
    await expect(new JitoClient("https://x", fetchFn).getTipAccounts()).rejects.toThrow(/rate limited/);
  });
});
