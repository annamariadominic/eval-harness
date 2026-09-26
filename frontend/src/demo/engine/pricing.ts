/** Port of `app/pricing.py`: per-model token prices; unknown models yield no cost. */

export type ModelPrice = {
  provider: string;
  model: string;
  input_per_mtok: number;
  output_per_mtok: number;
};

const TOKENS_PER_UNIT = 1_000_000;

export class PricingTable {
  private readonly prices: Map<string, ModelPrice>;

  constructor(prices: ModelPrice[]) {
    this.prices = new Map(prices.map((p) => [`${p.provider}\u0000${p.model}`, p]));
  }

  static fromJson(data: { models?: ModelPrice[] }): PricingTable {
    return new PricingTable(
      (data.models ?? []).map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        input_per_mtok: Number(entry.input_per_mtok),
        output_per_mtok: Number(entry.output_per_mtok),
      })),
    );
  }

  lookup(provider: string, model: string): ModelPrice | null {
    return this.prices.get(`${provider}\u0000${model}`) ?? null;
  }

  estimate(
    provider: string,
    model: string,
    inputTokens: number | null,
    outputTokens: number | null,
  ): number | null {
    const price = this.lookup(provider, model);
    if (price === null || (inputTokens === null && outputTokens === null)) return null;
    const cost =
      (inputTokens ?? 0) * price.input_per_mtok + (outputTokens ?? 0) * price.output_per_mtok;
    return cost / TOKENS_PER_UNIT;
  }
}
