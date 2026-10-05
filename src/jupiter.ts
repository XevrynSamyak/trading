/** Minimal client for Jupiter's swap API (quote + swap-instructions). */

export interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: RouteStep[];
  /** Slot of the market state the quote was computed from (if Jupiter sends it). */
  contextSlot?: number;
  [key: string]: unknown;
}

export interface RouteStep {
  swapInfo: {
    label?: string;
    /** The pool (AMM) account this hop trades through. */
    ammKey?: string;
    inputMint?: string;
    outputMint?: string;
    inAmount?: string;
    outAmount?: string;
    feeAmount?: string;
    feeMint?: string;
  };
  /** Share of the leg routed through this step (split routes). */
  percent?: number;
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

/** Headers for Jupiter requests: the API key goes in `x-api-key` (never in the URL or logs). */
export function jupiterHeaders(apiKey: string | undefined, extra: Record<string, string> = {}): Record<string, string> {
  return apiKey ? { ...extra, "x-api-key": apiKey } : extra;
}

export class JupiterClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly apiKey?: string,
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
    const res = await this.fetchFn(`${this.baseUrl}/quote?${qs}`, { headers: jupiterHeaders(this.apiKey) });
    if (!res.ok) throw new Error(`Jupiter quote ${res.status}: ${await res.text()}`);
    return (await res.json()) as QuoteResponse;
  }

  async swapInstructions(quote: QuoteResponse, userPublicKey: string): Promise<SwapInstructionsResponse> {
    const res = await this.fetchFn(`${this.baseUrl}/swap-instructions`, {
      method: "POST",
      headers: jupiterHeaders(this.apiKey, { "Content-Type": "application/json" }),
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
