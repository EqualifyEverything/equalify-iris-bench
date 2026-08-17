// What the deployment under test accepts, read from the deployment itself.
//
// Nothing in this repo hardcodes a page cap, an image ceiling or a rate limit.
// Those numbers move with the model and provider Iris is configured with — that
// is the whole reason `GET /v1/limits` exists and deliberately does not name the
// model behind them — so a harness that baked them in would silently prefilter
// the corpus against last month's deployment and report the difference as a
// change in Iris.

import { log } from "./util.mjs";

export async function fetchLimits(base) {
  const url = `${base.replace(/\/$/, "")}/limits`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}; cannot prepare a corpus without the deployment's limits`);
  const limits = await res.json();

  // Read through the shapes rather than assuming one: `max_pages` is published at
  // the top level and again under `pdf`, and `rate_limits` is null on a
  // deployment that does not limit in the app (which means "not limiting", not
  // "unknown" — so treat it as unbounded rather than falling back to a guess).
  const maxPages = limits.pdf?.max_pages ?? limits.max_pages;
  if (!maxPages) throw new Error(`${url} published no page cap; refusing to guess one`);

  const resolved = {
    maxPages,
    maxFiles: limits.upload?.max_files ?? 1,
    maxRequestBytes: limits.upload?.max_request_bytes ?? null,
    imageMaxBytes: limits.image?.max_bytes ?? null,
    maxDimensionPx: limits.image?.max_dimension_px ?? null,
    maxLongEdgePx: limits.image?.max_long_edge_px ?? null,
    uploadPerMinute: limits.rate_limits?.upload_per_minute ?? null,
    generalPerMinute: limits.rate_limits?.general_per_minute ?? null,
    raw: limits,
  };
  log(
    `limits: max_pages=${resolved.maxPages}`,
    `image_max_bytes=${resolved.imageMaxBytes}`,
    `max_dimension_px=${resolved.maxDimensionPx}`,
    `upload_per_minute=${resolved.uploadPerMinute ?? "unlimited"}`,
  );
  return resolved;
}

// The DPI Iris rasterizes PDF pages at. NOT published by /v1/limits — it is
// internal (src/util/pdf.ts `DPI`), so this is the one number here that can go
// stale without the deployment saying so. It is used only to predict which pages
// will render too large for the vision model, and that prediction is recorded as
// a risk flag rather than an exclusion: a wrong guess must not silently drop
// documents from the corpus.
export const RASTER_DPI = 150;

// A page's rendered pixel size, from its physical size in PostScript points.
export const pxFromPts = (pts) => Math.round((pts / 72) * RASTER_DPI);
