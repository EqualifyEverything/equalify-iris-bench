// Stage 3: turn a directory of captured runs into the three numbers the campaign
// exists to produce — how often Iris succeeds, how long it takes, what it costs —
// plus the failure inventory that says what to fix first.
//
// Two things about accuracy are worth stating up front, because they decide what
// this report can and cannot claim.
//
// There is no ground truth. Nobody has hand-authored the correct accessible HTML
// for 2000 PDFs, so "accuracy" here is not agreement with a reference. It is the
// conjunction of signals Iris's own pipeline produces and one independent check:
//
//   * The FINAL axe lint, re-run locally on the delivered HTML (see lint.mjs). This
//     is the only accuracy number in the report that Iris did not compute — the
//     deployment's own final lint goes to the aggregate `/v1/quality` tally and
//     never to a per-session endpoint.
//   * The review loop's own verdict: `iterations` used, and `unresolved` issues
//     remaining when the iteration cap was hit. Hitting the cap is the pipeline
//     saying, in its own words, that it could not finish fixing this document.
//   * Signals the loop can only report and not fix: links the copy editor dropped,
//     id collisions the assembler had to resolve, pages whose verify pass failed,
//     specialists that declined.
//   * Structure, from lint.mjs `shape()`. A clean lint on a nearly empty document
//     is a silent failure no rule catches.
//
// And the denominator is not the corpus. Documents the corpus never ran — 404s,
// HTML login walls served as PDFs, encrypted files — are prepare's business and
// live in prepared.jsonl; a success rate computed here is over documents that were
// actually submitted. Both numbers are printed, because a campaign that ran 1400 of
// 2000 URLs and reports 95% has told you something misleading.

import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAxe, shape, AXE_VERSION } from "./lint.mjs";
import { costOf, loadRates, normalizeModelId, provenance } from "./pricing.mjs";
import { args, errorText, latestAttempts, log, num, pct, readJsonl } from "./util.mjs";

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

// --- one run ---------------------------------------------------------------

async function analyze(dir, rates, opts) {
  const meta = readJson(join(dir, "meta.json"));
  if (!meta) return null;
  const status = readJson(join(dir, "status.json"));
  const diag = readJson(join(dir, "diagnostics.json"));
  const events = existsSync(join(dir, "log.jsonl")) ? readJsonl(join(dir, "log.jsonl")) : [];
  const htmlPath = join(dir, "output.html");
  const html = existsSync(htmlPath) ? readFileSync(htmlPath, "utf8") : null;

  const ev = (type) => events.filter((e) => e.type === type);
  const assembly = ev("assembly").at(-1) ?? null;
  const readers = ev("reader");
  const complete = ev("run_complete").at(-1) ?? null;
  const failed = ev("run_failed").at(-1) ?? null;
  const anchors = ev("assembly_anchors").at(-1) ?? null;

  const tokens = diag?.tokens ?? null;
  const models = new Set(events.filter((e) => e.type === "model_call" && e.model).map((e) => e.model));
  // One model per run in practice (all three capabilities point at the same id), so
  // the run's cost is priced against the one that did the most calls; a run that
  // genuinely mixed models is flagged rather than averaged.
  const modelCounts = {};
  for (const e of events) if (e.type === "model_call" && e.model) modelCounts[e.model] = (modelCounts[e.model] ?? 0) + 1;
  const primaryModel = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const cost = tokens ? costOf(tokens, primaryModel, rates) : { usd: null, priced: false, model: null };

  // The independent check. Skippable (--no-lint) because axe over a few thousand
  // documents is minutes of CPU, and the rest of the report does not depend on it.
  let finalLint = null;
  let structure = null;
  if (html) {
    structure = shape(html);
    if (!opts.noLint) {
      const r = await runAxe(html);
      finalLint = {
        ok: r.ok,
        error: r.error ?? null,
        violations: r.violations,
        // Total offending elements, not rules: one document with 40 unlabelled
        // inputs and one with a single missing lang are both "1 rule".
        nodes: r.violations.reduce((s, v) => s + v.nodes, 0),
      };
    }
  }

  const pages = assembly?.pages ?? meta.pages ?? null;
  const wall = meta.round_trip_ms ?? null;
  const serverMs = diag?.elapsed_ms ?? null;

  return {
    id: meta.id,
    url: meta.url,
    session_id: meta.session_id ?? null,
    outcome: meta.outcome,
    // Was this a whole document or a slice of an oversize one? A chunk's review
    // score is not comparable — the reviewer saw a document with no beginning — so
    // the summary reports both populations separately.
    is_chunk: Boolean(meta.parent_sha),
    page_from: meta.page_from ?? null,
    page_to: meta.page_to ?? null,
    risks: meta.risks ?? [],
    bytes: meta.bytes ?? null,
    pages,

    // --- time ---
    // Three clocks, because they answer different questions: wall is what a caller
    // experiences, server elapsed is what Iris spent once it had a slot, and queue
    // wait is the difference concurrency causes.
    wall_ms: wall,
    server_ms: serverMs,
    queue_wait_ms: meta.queue_wait_ms ?? null,
    ms_per_page: pages && wall ? Math.round(wall / pages) : null,
    phase_ms: diag?.phase_durations_ms ?? null,
    model_calls: diag?.model_calls?.count ?? null,
    model_calls_failed: diag?.model_calls?.failed ?? null,
    concurrency_factor: diag?.model_calls?.concurrency_factor ?? null,

    // --- cost ---
    tokens,
    // Lower than model_calls means these sums cover only part of the run, so the
    // cost below is a floor. Surfaced per document, not just in aggregate.
    tokens_partial: tokens ? tokens.calls_reported < (diag?.model_calls?.count ?? 0) : null,
    model: primaryModel,
    models: [...models],
    mixed_models: models.size > 1,
    usd: cost.usd,
    usd_per_page: cost.usd != null && pages ? cost.usd / pages : null,
    tokens_per_page: tokens && pages ? Math.round((tokens.input + tokens.output) / pages) : null,
    by_agent: diag?.by_agent ?? null,

    // --- accuracy ---
    final_lint: finalLint,
    // The pre-review lint, from the assembly event. The pair is the interesting
    // thing: pre-review violations that survive to final are what the review loop
    // failed to fix.
    assembly_lint_ok: assembly?.lint_ok ?? null,
    assembly_violations: assembly?.violations ?? null,
    assembly_lint_error: assembly?.lint_error ?? null,
    iterations: complete?.iterations ?? status?.iterations_completed ?? null,
    unresolved: complete?.unresolved ?? null,
    // The pipeline's own admission of defeat: the cap was reached with issues left.
    hit_iteration_cap: complete ? complete.unresolved > 0 : null,
    reader_issues: readers.map((r) => r.issues),
    links_dropped: ev("editor_links_dropped").reduce((s, e) => s + (e.hrefs?.length ?? 0), 0),
    id_collisions: anchors?.collisions?.length ?? 0,
    ambiguous_refs: anchors?.ambiguous?.length ?? 0,
    skipped_pages: anchors?.skipped_pages?.length ?? 0,
    pages_verify_failed: ev("page_verify_failed").length,
    links_unrecovered: ev("page_links_unrecovered").length,
    specialists_dispatched: ev("specialist_dispatched").length,
    specialists_declined: ev("specialist_declined").length,
    specialists_unresolved: ev("specialist_unresolved").length,
    reextracts: ev("reextract_start").length,
    structure,

    // --- what went wrong ---
    error: errorText(failed?.error ?? meta.error ?? status?.error) ?? null,
    errors: (diag?.errors ?? []).map((e) => e.message),
    // Every run that files one of these opens a GitHub issue on the upstream repo.
    // Counted so the campaign can see what it generated.
    agent_issues: ev("agent_issue").length,
  };
}

// --- aggregation -----------------------------------------------------------

// Errors are grouped by shape, not text: a provider message carrying a request id,
// a page number or a byte count is one class of failure, not two hundred.
function errorClass(msg) {
  if (!msg) return "unknown";
  return String(msg)
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    // Every digit run, not just whole words: the timeouts and byte counts that make
    // two identical failures look different are written `60000ms`, `3932160b`.
    .replace(/\d+/g, "<n>")
    .slice(0, 140);
}

const sum = (rows, f) => rows.reduce((s, r) => s + (f(r) ?? 0), 0);
const defined = (rows, f) => rows.map(f).filter((v) => v != null);

function summarize(rows, prepared, rates, opts) {
  const delivered = rows.filter((r) => r.outcome === "ready_for_review" || r.outcome === "closed");
  const walls = defined(delivered, (r) => r.wall_ms);
  const perPage = defined(delivered, (r) => r.ms_per_page);
  const usd = defined(delivered, (r) => r.usd);
  const linted = delivered.filter((r) => r.final_lint);
  const lintable = linted.filter((r) => !r.final_lint.error);

  const outcomes = {};
  for (const r of rows) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;

  // Which axe rules actually fire, ranked by how many documents they affect rather
  // than by node count — a rule that breaks 300 documents once matters more to fix
  // than one that fires 900 times inside a single table.
  const rules = {};
  for (const r of lintable) {
    for (const v of r.final_lint.violations) {
      const cur = (rules[v.id] ??= { rule: v.id, impact: v.impact, documents: 0, nodes: 0 });
      cur.documents += 1;
      cur.nodes += v.nodes;
    }
  }

  const errors = {};
  for (const r of rows) {
    if (r.outcome === "ready_for_review" || r.outcome === "closed") continue;
    const k = errorClass(r.error ?? r.errors[0]);
    const cur = (errors[k] ??= { error: k, count: 0, examples: [] });
    cur.count += 1;
    if (cur.examples.length < 3) cur.examples.push(r.id);
  }

  // Which agent spends the money, and which one spends the time. Iris reports these
  // per run; the campaign's question is which one to optimize first.
  const agents = {};
  for (const r of delivered) {
    for (const [name, a] of Object.entries(r.by_agent ?? {})) {
      const cur = (agents[name] ??= { agent: name, calls: 0, total_ms: 0, input_tokens: 0, output_tokens: 0 });
      cur.calls += a.count;
      cur.total_ms += a.total_ms;
      cur.input_tokens += a.input_tokens;
      cur.output_tokens += a.output_tokens;
    }
  }

  // URL-level accounting, which is not the same as document-level. One oversize PDF
  // becomes several runnable chunks, so counting prepared.jsonl rows would both
  // inflate the number of URLs and count a single URL's `ok` several times. Rows
  // with a `parent_sha` are chunk children and are excluded from the URL tallies.
  const preparedCounts = {};
  const urls = new Set();
  for (const p of prepared) {
    if (p.url) urls.add(p.url);
    if (p.parent_sha) continue;
    preparedCounts[p.klass ?? "unknown"] = (preparedCounts[p.klass ?? "unknown"] ?? 0) + 1;
  }
  // A URL counts as covered only if EVERY item it produced was delivered. A 40-page
  // PDF whose second chunk failed is not a document anyone received.
  const byUrl = new Map();
  for (const r of rows) {
    const cur = byUrl.get(r.url) ?? { total: 0, delivered: 0 };
    cur.total += 1;
    if (r.outcome === "ready_for_review" || r.outcome === "closed") cur.delivered += 1;
    byUrl.set(r.url, cur);
  }
  const urlsCovered = [...byUrl.values()].filter((u) => u.total > 0 && u.delivered === u.total).length;

  const pagesDelivered = sum(delivered, (r) => r.pages);
  const partial = delivered.filter((r) => r.tokens_partial).length;

  return {
    generated_at: new Date().toISOString(),
    axe_version: AXE_VERSION,
    lint_skipped: Boolean(opts.noLint),

    corpus: {
      // The honest denominator: URLs the CSV offered, what prepare made of them,
      // and how many of those were actually submitted.
      urls_prepared: urls.size || null,
      prepared_classes: Object.keys(preparedCounts).length ? preparedCounts : null,
      submitted: rows.length,
      urls_submitted: byUrl.size,
      urls_covered: urlsCovered,
      chunks: rows.filter((r) => r.is_chunk).length,
      pages_delivered: pagesDelivered,
    },

    outcomes,
    success_rate: rows.length ? delivered.length / rows.length : null,
    // The same question asked of every URL the CSV contained — the number a "can
    // Iris handle real-world PDFs" claim has to survive, since it charges the
    // harness for the 404s, sign-in walls and encrypted files too.
    end_to_end_rate: urls.size ? urlsCovered / urls.size : null,

    time: {
      // Percentiles, not means: the tail decides how long a campaign takes and it is
      // where the timeouts live.
      wall_ms: { p50: pct(walls, 50), p90: pct(walls, 90), p99: pct(walls, 99), max: pct(walls, 100) },
      ms_per_page: { p50: pct(perPage, 50), p90: pct(perPage, 90), max: pct(perPage, 100) },
      queue_wait_ms: { p50: pct(defined(rows, (r) => r.queue_wait_ms), 50), p90: pct(defined(rows, (r) => r.queue_wait_ms), 90) },
      total_hours: sum(rows, (r) => r.wall_ms) / 3_600_000,
      // >1 means model calls overlapped (extraction runs pages in parallel). Near 1
      // on multi-page documents means the concurrency is not being used.
      concurrency_factor_p50: pct(defined(delivered, (r) => r.concurrency_factor), 50),
    },

    cost: {
      tokens: {
        input: sum(delivered, (r) => r.tokens?.input),
        output: sum(delivered, (r) => r.tokens?.output),
        cache_read: sum(delivered, (r) => r.tokens?.cache_read),
        cache_write: sum(delivered, (r) => r.tokens?.cache_write),
      },
      tokens_per_page_p50: pct(defined(delivered, (r) => r.tokens_per_page), 50),
      usd_total: usd.length ? usd.reduce((a, b) => a + b, 0) : null,
      usd_per_document: { p50: pct(usd, 50), p90: pct(usd, 90), max: pct(usd, 100) },
      usd_per_page_p50: pct(defined(delivered, (r) => r.usd_per_page), 50),
      // Projected from the per-page median, which is the number to quote for "what
      // would 100,000 pages cost" — and the number to distrust if unpriced > 0.
      usd_per_1000_pages: pct(defined(delivered, (r) => r.usd_per_page), 50) * 1000 || null,
      unpriced_documents: delivered.filter((r) => r.usd == null).length,
      // Documents whose token sums cover only part of the run: their cost is a floor.
      partial_token_documents: partial,
      rates: provenance(new Set(delivered.flatMap((r) => r.models)), rates),
      caveat:
        "The deployment runs on Amazon Bedrock, which is partner-operated and billed by AWS at " +
        "AWS's own rates. Dollar figures here are estimates for comparing documents, not an invoice.",
    },

    accuracy: {
      // Documents delivered with zero final axe violations, by the deployment's own
      // rule configuration, re-checked locally.
      lint_clean: lintable.filter((r) => r.final_lint.ok).length,
      lint_checked: lintable.length,
      lint_clean_rate: lintable.length ? lintable.filter((r) => r.final_lint.ok).length / lintable.length : null,
      // A document axe could not examine is not a clean document.
      lint_errored: linted.filter((r) => r.final_lint.error).length,
      violation_nodes_p50: pct(defined(lintable, (r) => r.final_lint.nodes), 50),
      top_rules: Object.values(rules).sort((a, b) => b.documents - a.documents).slice(0, 20),

      // The review loop's self-assessment.
      iterations: {
        p50: pct(defined(delivered, (r) => r.iterations), 50),
        max: pct(defined(delivered, (r) => r.iterations), 100),
        // Cap reached with issues remaining: the pipeline could not finish the job.
        hit_cap: delivered.filter((r) => r.hit_iteration_cap).length,
        unresolved_total: sum(delivered, (r) => r.unresolved),
      },
      // Losses the loop reports but cannot repair.
      links_dropped: sum(rows, (r) => r.links_dropped),
      documents_losing_links: rows.filter((r) => r.links_dropped > 0).length,
      id_collisions: sum(rows, (r) => r.id_collisions),
      ambiguous_refs: sum(rows, (r) => r.ambiguous_refs),
      skipped_pages: sum(rows, (r) => r.skipped_pages),
      pages_verify_failed: sum(rows, (r) => r.pages_verify_failed),
      specialists: {
        dispatched: sum(rows, (r) => r.specialists_dispatched),
        declined: sum(rows, (r) => r.specialists_declined),
        unresolved: sum(rows, (r) => r.specialists_unresolved),
      },
      reextracts: sum(rows, (r) => r.reextracts),
      // Structural floors — a clean lint on an empty document.
      documents_without_headings: delivered.filter((r) => r.structure && r.structure.headings === 0).length,
      documents_under_200_chars: delivered.filter((r) => r.structure && r.structure.text_chars < 200).length,
      chars_per_page_p50: pct(
        defined(delivered, (r) => (r.structure && r.pages ? Math.round(r.structure.text_chars / r.pages) : null)),
        50,
      ),
    },

    failures: Object.values(errors).sort((a, b) => b.count - a.count).slice(0, 25),
    by_agent: Object.values(agents).sort((a, b) => b.total_ms - a.total_ms),
    agent_issues_filed: sum(rows, (r) => r.agent_issues),
  };
}

// --- output ----------------------------------------------------------------

const money = (v) => (v == null ? "n/a" : `$${v >= 1 ? v.toFixed(2) : v < 0.01 ? v.toFixed(5) : v.toFixed(4)}`);
const secs = (v) => (v == null ? "n/a" : `${(v / 1000).toFixed(1)}s`);
const rate = (v) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);

function print(s) {
  const l = log;
  l("=== equalify-iris-bench ===");
  l(`corpus: ${s.corpus.submitted} item(s) submitted from ${s.corpus.urls_submitted} of`,
    `${s.corpus.urls_prepared ?? "?"} prepared URL(s) — ${s.corpus.pages_delivered} page(s) delivered,`,
    `${s.corpus.chunks} item(s) were chunks of oversize PDFs`);
  l("");
  l("--- outcomes ---");
  for (const [k, v] of Object.entries(s.outcomes).sort((a, b) => b[1] - a[1])) l(`  ${k}: ${v}`);
  l(`  success rate (of items submitted): ${rate(s.success_rate)}`);
  l(`  end-to-end (URLs fully delivered, of every URL in the CSV):`,
    `${rate(s.end_to_end_rate)} — ${s.corpus.urls_covered}/${s.corpus.urls_prepared ?? "?"}`);
  l("");
  l("--- time ---");
  l(`  per document: p50 ${secs(s.time.wall_ms.p50)}  p90 ${secs(s.time.wall_ms.p90)}  max ${secs(s.time.wall_ms.max)}`);
  l(`  per page:     p50 ${secs(s.time.ms_per_page.p50)}  p90 ${secs(s.time.ms_per_page.p90)}`);
  l(`  queue wait:   p50 ${secs(s.time.queue_wait_ms.p50)}  p90 ${secs(s.time.queue_wait_ms.p90)}`);
  l(`  campaign wall clock: ${s.time.total_hours.toFixed(1)}h; call concurrency p50 ${s.time.concurrency_factor_p50 ?? "n/a"}x`);
  l("");
  l("--- cost (estimate; see caveat) ---");
  l(`  tokens: ${s.cost.tokens.input.toLocaleString()} in / ${s.cost.tokens.output.toLocaleString()} out`,
    `(cache ${s.cost.tokens.cache_read.toLocaleString()} read / ${s.cost.tokens.cache_write.toLocaleString()} write)`);
  l(`  per document: p50 ${money(s.cost.usd_per_document.p50)}  p90 ${money(s.cost.usd_per_document.p90)}`);
  l(`  per page: p50 ${money(s.cost.usd_per_page_p50)}  →  ${money(s.cost.usd_per_1000_pages)} per 1000 pages`);
  l(`  total: ${money(s.cost.usd_total)}  (median ${s.cost.tokens_per_page_p50 ?? "n/a"} tokens/page)`);
  if (s.cost.unpriced_documents) l(`  WARNING: ${s.cost.unpriced_documents} document(s) ran on an unpriced model — cost excludes them`);
  if (s.cost.partial_token_documents) l(`  WARNING: ${s.cost.partial_token_documents} document(s) reported tokens for only part of the run — cost is a floor`);
  l("");
  l("--- accuracy ---");
  if (s.lint_skipped) l("  (local re-lint skipped: --no-lint)");
  l(`  axe-clean: ${s.accuracy.lint_clean}/${s.accuracy.lint_checked} (${rate(s.accuracy.lint_clean_rate)}) [axe ${s.axe_version}]`);
  if (s.accuracy.lint_errored) l(`  axe could not examine ${s.accuracy.lint_errored} document(s) — not counted as clean`);
  l(`  review iterations: p50 ${s.accuracy.iterations.p50 ?? "n/a"}, max ${s.accuracy.iterations.max ?? "n/a"};`,
    `${s.accuracy.iterations.hit_cap} document(s) hit the cap with ${s.accuracy.iterations.unresolved_total} issue(s) unresolved`);
  l(`  links dropped by the editor: ${s.accuracy.links_dropped} across ${s.accuracy.documents_losing_links} document(s)`);
  l(`  id collisions ${s.accuracy.id_collisions}, ambiguous refs ${s.accuracy.ambiguous_refs}, pages left as written ${s.accuracy.skipped_pages}`);
  l(`  page verify failures ${s.accuracy.pages_verify_failed}, re-extractions ${s.accuracy.reextracts}`);
  l(`  specialists: ${s.accuracy.specialists.dispatched} dispatched, ${s.accuracy.specialists.declined} declined, ${s.accuracy.specialists.unresolved} unresolved`);
  l(`  suspiciously thin output: ${s.accuracy.documents_without_headings} with no headings, ${s.accuracy.documents_under_200_chars} under 200 chars`,
    `(median ${s.accuracy.chars_per_page_p50 ?? "n/a"} chars/page)`);
  if (s.accuracy.top_rules.length) {
    l("  top axe rules, by documents affected:");
    for (const r of s.accuracy.top_rules.slice(0, 10)) l(`    ${r.documents}× ${r.rule} [${r.impact ?? "?"}] (${r.nodes} nodes)`);
  }
  if (s.failures.length) {
    l("");
    l("--- failures ---");
    for (const f of s.failures.slice(0, 10)) l(`  ${f.count}× ${f.error}  e.g. ${f.examples[0]}`);
  }
  if (s.by_agent.length) {
    l("");
    l("--- where the time and money go ---");
    for (const a of s.by_agent) {
      l(`  ${a.agent}: ${a.calls} call(s), ${(a.total_ms / 1000).toFixed(0)}s,`,
        `${a.input_tokens.toLocaleString()} in / ${a.output_tokens.toLocaleString()} out`);
    }
  }
  if (s.agent_issues_filed) {
    l("");
    l(`NOTE: this campaign filed ${s.agent_issues_filed} agent-suggestion issue(s) upstream.`);
  }
}

// --- main ------------------------------------------------------------------

async function main() {
  const a = args();
  const runsDir = a.runs ?? "runs";
  const outDir = a.out ?? runsDir;
  const rates = loadRates(a.rates);
  const opts = { noLint: Boolean(a["no-lint"]) };

  if (!existsSync(runsDir)) {
    console.error(`no such directory: ${runsDir}`);
    process.exit(2);
  }
  const dirs = readdirSync(runsDir)
    .map((d) => join(runsDir, d))
    .filter((p) => statSync(p).isDirectory());
  if (!dirs.length) {
    console.error(`${runsDir} has no run directories — run src/run.mjs first`);
    process.exit(2);
  }

  const prepared = latestAttempts(readJsonl(a.prepared ?? "prepared.jsonl"));
  log(`analyzing ${dirs.length} run(s)${opts.noLint ? "" : ` with a local axe re-lint (axe-core ${AXE_VERSION})`}`);

  // Serial on purpose. axe in jsdom is CPU-bound, and the point of this stage is a
  // report, not throughput; a progress line every 100 is enough.
  const rows = [];
  for (const [i, dir] of dirs.entries()) {
    const row = await analyze(dir, rates, opts);
    if (row) rows.push(row);
    if ((i + 1) % 100 === 0) log(`  analyzed ${i + 1}/${dirs.length}`);
  }

  const resultsPath = join(outDir, "results.jsonl");
  writeFileSync(resultsPath, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  const s = summarize(rows, prepared, rates, opts);
  const summaryPath = join(outDir, "summary.json");
  writeFileSync(summaryPath, JSON.stringify(s, null, 2));

  print(s);
  log("");
  log(`wrote ${resultsPath} (one row per document) and ${summaryPath}`);
  // stdout is the summary and nothing else, so this can be piped into jq while the
  // narration above goes to stderr.
  process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
}

await main();
