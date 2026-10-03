/** Minimal client for Jupiter's swap API (quote + swap-instructions). */

export interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: { swapInfo: { label?: string } }[];
  [key: string]: unknown;
}

export interface RawInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string; // base64
}

export interface SwapInstructionsResponse {
  computeBudgetInstructions: RawInstruction[];
  setupInstructions: RawInstruction[];
  swapInstruction: RawInstruction;
  cleanupInstruction?: RawInstruction | null;
  addressLookupTableAddresses: string[];
}

export type FetchFn = typeof fetch;

export class JupiterClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async quote(params: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
    maxAccounts?: number;
  }): Promise<QuoteResponse> {
    const qs = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount.toString(),
      slippageBps: String(params.slippageBps),
      restrictIntermediateTokens: "true",
    });
    // Keeps each leg small enough that both legs fit in one transaction.
    if (params.maxAccounts) qs.set("maxAccounts", String(params.maxAccounts));
    const res = await this.fetchFn(`${this.baseUrl}/quote?${qs}`);
    if (!res.ok) throw new Error(`Jupiter quote ${res.status}: ${await res.text()}`);
    return (await res.json()) as QuoteResponse;
  }

  async swapInstructions(quote: QuoteResponse, userPublicKey: string): Promise<SwapInstructionsResponse> {
    const res = await this.fetchFn(`${this.baseUrl}/swap-instructions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey,
        // Keep wSOL as a token account so leg 2 can spend leg 1's output.
        wrapAndUnwrapSol: false,
        dynamicComputeUnitLimit: false,
      }),
    });
    if (!res.ok) throw new Error(`Jupiter swap-instructions ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as SwapInstructionsResponse & { error?: string };
    if (body.error) throw new Error(`Jupiter swap-instructions: ${body.error}`);
    return body;
  }
}
