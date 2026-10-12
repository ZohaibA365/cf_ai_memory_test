// Workers AI prices, copied from
// https://developers.cloudflare.com/workers-ai/platform/pricing/ on
// 2026-10-12. Neurons are what Cloudflare bills: $0.011 per 1,000 beyond the
// free 10,000 per day. Prices change; re-check before quoting costs.

export const PRICING_DATE = "2026-10-12";
export const USD_PER_1000_NEURONS = 0.011;

export interface ModelPrice {
  inputNeuronsPerM: number;
  outputNeuronsPerM: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "@cf/qwen/qwen3-30b-a3b-fp8": { inputNeuronsPerM: 4_625, outputNeuronsPerM: 30_475 },
  "@cf/openai/gpt-oss-20b": { inputNeuronsPerM: 18_182, outputNeuronsPerM: 27_273 },
  "@cf/meta/llama-4-scout-17b-16e-instruct": { inputNeuronsPerM: 24_545, outputNeuronsPerM: 77_273 },
  "@cf/openai/gpt-oss-120b": { inputNeuronsPerM: 31_818, outputNeuronsPerM: 68_182 },
  "@cf/mistralai/mistral-small-3.1-24b-instruct": { inputNeuronsPerM: 31_876, outputNeuronsPerM: 50_488 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { inputNeuronsPerM: 26_668, outputNeuronsPerM: 204_805 }
};

export function neurons(model: string, inputTokens: number, outputTokens: number): number {
  const price = MODEL_PRICES[model];
  if (!price) throw new Error(`No price recorded for ${model}`);
  return (
    (inputTokens * price.inputNeuronsPerM + outputTokens * price.outputNeuronsPerM) / 1e6
  );
}

export function neuronsToUsd(n: number): number {
  return (n / 1000) * USD_PER_1000_NEURONS;
}
