// Turning tokens into dollars — the one place in this repo that knows a rate.
//
// Iris itself deliberately never does this. `GET /v1/limits` does not name the
// model behind its numbers and `GET /v1/sessions/:id/diagnostics` reports token
// counts and not cost, because the model gets swapped and the price of a token
// depends on the provider, the region and the model at the moment the call was
// made — none of which a deployment can state durably. Cost therefore belongs to
// the analysis, at a known date, with its assumptions written down.
//
// Three rules follow from that, and all three matter more than the numbers:
//
//   1. Every rate carries a `checked` date and a `source`. A stale rate that looks
//      authoritative is worse than no rate.
//   2. An unrecognized model id costs `null`, not zero. It is counted and reported
//      as unpriced, so "we changed the model and the corpus suddenly looks free"
//      cannot happen quietly.
//   3. `--rates rates.json` overrides the table wholesale. The table below is a
//      convenience, not an authority; a real cost claim should be made against the
//      invoice or the provider's current price page.
//
// PARTNER CAVEAT: the live deployment runs on Amazon Bedrock (`providers.default:
// bedrock`), which is partner-operated. Bedrock bills through AWS at AWS's own
// rates for the region in use, which are not guaranteed to equal Anthropic's
// first-party rates. The Bedrock entries below inherit the first-party rate as a
// documented ESTIMATE, flagged as such in every report that uses them. Treat the
// resulting dollar figures as an order of magnitude for comparing documents
// against each other, and not as an amount owed.

import { readFileSync } from "node:fs";

// Cache multipliers, applied to the input rate. Present and correct even though
// Iris sends no `cache_control` blocks today (so these tokens are always 0), so
// that turning caching on does not silently mis-price the next campaign.
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25; // 5-minute TTL; a 1-hour write is 2x.

// $ per million tokens.
const TABLE = {
  "claude-sonnet-4-6": { input: 3, output: 15, source: "anthropic-first-party", checked: "2026-08-17" },
  "claude-sonnet-5": { input: 3, output: 15, source: "anthropic-first-party", checked: "2026-08-17" },
  "claude-opus-4-7": { input: 5, output: 25, source: "anthropic-first-party", checked: "2026-08-17" },
  "claude-opus-5": { input: 5, output: 25, source: "anthropic-first-party", checked: "2026-08-17" },
  "claude-haiku-4-5": { input: 1, output: 5, source: "anthropic-first-party", checked: "2026-08-17" },
};

// Bedrock ids carry a region-routing prefix (`us.`, `eu.`, `apac.`) and OpenRouter
// ids a vendor prefix (`anthropic/`); both may carry a `-v1:0`-style suffix. Strip
// them to reach the model, and keep the original in the report so a mis-strip is
// visible.
export function normalizeModelId(id) {
  if (!id) return null;
  return String(id)
    .replace(/^(us|eu|apac|us-gov)\./, "")
    .replace(/^anthropic[/.]/, "")
    .replace(/-v\d+:\d+$/, "")
    .replace(/:\d+$/, "");
}

export function loadRates(path) {
  if (!path) return { ...TABLE };
  const custom = JSON.parse(readFileSync(path, "utf8"));
  // Merged, not replaced, so a rates file can correct one model without having to
  // restate the rest.
  return { ...TABLE, ...custom };
}

// Cost of one usage record, or null when the model is not priced. `usage` uses the
// diagnostics vocabulary: `input` excludes cached tokens, which is why the four
// counts are added rather than one of them being a subset of another.
export function costOf(usage, modelId, rates = TABLE) {
  const key = normalizeModelId(modelId);
  const rate = key ? rates[key] : null;
  if (!rate) return { usd: null, model: key, priced: false, rate: null };
  const m = 1e-6;
  const usd =
    (usage.input ?? 0) * rate.input * m +
    (usage.output ?? 0) * rate.output * m +
    (usage.cache_read ?? 0) * rate.input * CACHE_READ_MULTIPLIER * m +
    (usage.cache_write ?? 0) * rate.input * CACHE_WRITE_MULTIPLIER * m;
  return { usd, model: key, priced: true, rate };
}

// Which of the rates actually got used, for the report's provenance block. A cost
// figure that does not say what it assumed is not a measurement.
export function provenance(usedModels, rates = TABLE) {
  return [...usedModels].sort().map((id) => {
    const key = normalizeModelId(id);
    const rate = rates[key];
    return {
      model_id: id,
      normalized: key,
      priced: Boolean(rate),
      input_per_mtok: rate?.input ?? null,
      output_per_mtok: rate?.output ?? null,
      source: rate?.source ?? null,
      checked: rate?.checked ?? null,
      // The deployment runs on Bedrock; see the partner caveat at the top.
      estimate_only: Boolean(rate) && /^(us|eu|apac|us-gov)\./.test(String(id)),
    };
  });
}
