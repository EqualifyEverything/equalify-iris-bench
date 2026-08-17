// Stage 2: submit the corpus to a live Iris deployment and capture everything each
// run produced.
//
// The pacing is the design. A deployment admits `max_concurrent_runs` sessions at a
// time (2 by default) and a conversation takes minutes, so the throughput ceiling
// is concurrency, not the rate limiter — and the default here matches the server so
// the harness cannot be the reason the numbers look bad. Overflow is not an error:
// Iris queues it and reports `status: "queued"`, which is measured (`queue_wait_ms`)
// rather than avoided.
//
// Everything is captured for FAILED runs too. A 2000-document corpus's most useful
// artifacts are the ones from documents that went wrong, and the run log and
// diagnostics are the only record of why.
//
// Resumable: a terminal outcome per item is appended to ledger.jsonl and skipped on
// the next pass. At 50-100 hours of wall clock this is not optional.

import { basename, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { fetchLimits } from "./limits.mjs";
import { appendJsonl, args, ensureDir, log, num, pool, readJsonl, sleep } from "./util.mjs";

const TERMINAL = new Set(["ready_for_review", "closed", "failed"]);

// Retry only what retrying can fix. A 400 is a verdict about the file (too many
// pages, a page that rendered too large) and is recorded as a result, not an error.
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

class Client {
  constructor(base, token) {
    this.base = base.replace(/\/$/, "");
    this.token = token;
    // Submissions are spaced to stay inside `upload_per_minute`, computed from the
    // deployment's own published limit rather than a number chosen here. Set by
    // configure() below.
    this.minSubmitGapMs = 0;
    this.lastSubmitAt = 0;
  }

  configure(limits) {
    this.minSubmitGapMs = limits.uploadPerMinute ? Math.ceil(60_000 / limits.uploadPerMinute) : 0;
  }

  async request(method, path, { body, raw = false, timeoutMs = 120_000 } = {}) {
    let last;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res;
      try {
        res = await fetch(`${this.base}${path}`, {
          method,
          headers: { authorization: `Bearer ${this.token}` },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        last = { status: 0, error: `${e.name}: ${e.message}` };
        if (attempt === MAX_ATTEMPTS) return last;
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      if (RETRY_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
        // Honour Retry-After when the server offers one — the upload gate does.
        const after = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** (attempt - 1);
        log(`  ${res.status} on ${method} ${path}; waiting ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      const text = await res.text();
      if (raw) return { status: res.status, text };
      try {
        return { status: res.status, json: JSON.parse(text), text };
      } catch {
        return { status: res.status, text };
      }
    }
    return last;
  }

  // Serialized against the published upload rate. Called from several lanes, so the
  // gap is enforced on a shared timestamp.
  async submit(path) {
    const wait = this.minSubmitGapMs - (Date.now() - this.lastSubmitAt);
    if (wait > 0) await sleep(wait);
    this.lastSubmitAt = Date.now();
    const buf = readFileSync(path);
    const form = new FormData();
    form.append("images", new File([buf], basename(path), { type: "application/pdf" }));
    return this.request("POST", "/sessions", { body: form, timeoutMs: 300_000 });
  }
}

async function runOne(client, doc, opts) {
  const dir = ensureDir(join(opts.out, doc.id));
  const meta = {
    id: doc.id,
    url: doc.url,
    sha256: doc.sha256,
    parent_sha: doc.parent_sha ?? null,
    page_from: doc.page_from ?? null,
    page_to: doc.page_to ?? null,
    pages: doc.pages ?? null,
    bytes: doc.bytes ?? null,
    risks: doc.risks ?? [],
    base: client.base,
    submitted_at: null,
    // Client-side wall clock, which is not the same as the server's `elapsed_ms`:
    // that one excludes the wait for a concurrency slot.
    round_trip_ms: null,
    queue_wait_ms: null,
    polls: 0,
    outcome: null,
    http_status: null,
    error: null,
    session_id: null,
  };

  const started = Date.now();
  meta.submitted_at = new Date(started).toISOString();
  const create = await client.submit(doc.path);
  meta.http_status = create.status;
  if (create.status !== 200 && create.status !== 201) {
    // The interesting failures live here: a 400 naming the page cap or a page that
    // rendered too large is a measurement, so the body is kept verbatim.
    meta.outcome = create.status === 0 ? "submit_error" : `http_${create.status}`;
    meta.error = create.json?.error ?? create.error ?? create.text?.slice(0, 500) ?? null;
    meta.round_trip_ms = Date.now() - started;
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    return meta;
  }

  const sid = create.json?.session_id;
  meta.session_id = sid;
  if (!sid) {
    meta.outcome = "no_session_id";
    meta.error = create.text?.slice(0, 500) ?? null;
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    return meta;
  }

  let status = null;
  let leftQueue = false;
  for (;;) {
    await sleep(opts.pollMs);
    const s = await client.request("GET", `/sessions/${sid}`);
    meta.polls++;
    if (s.json?.status) {
      status = s.json;
      if (!leftQueue && status.status !== "queued") {
        leftQueue = true;
        meta.queue_wait_ms = Date.now() - started;
      }
      if (TERMINAL.has(status.status)) break;
    }
    if (Date.now() - started > opts.timeoutMs) {
      meta.outcome = "client_timeout";
      break;
    }
  }
  meta.round_trip_ms = Date.now() - started;
  if (status) writeFileSync(join(dir, "status.json"), JSON.stringify(status, null, 2));
  meta.outcome ??= status?.status ?? "unknown";

  // Captured whatever happened — a failed run's log is the only account of why it
  // failed, and its diagnostics still carry the tokens it spent getting there.
  const logs = await client.request("GET", `/sessions/${sid}/logs`, { raw: true });
  if (logs.status === 200) writeFileSync(join(dir, "log.jsonl"), logs.text);
  const diag = await client.request("GET", `/sessions/${sid}/diagnostics`, { raw: true });
  if (diag.status === 200) writeFileSync(join(dir, "diagnostics.json"), diag.text);
  if (meta.outcome === "ready_for_review" || meta.outcome === "closed") {
    const html = await client.request("GET", `/sessions/${sid}/output`, { raw: true });
    if (html.status === 200) writeFileSync(join(dir, "output.html"), html.text);
    else meta.error = `output ${html.status}: ${html.text?.slice(0, 200)}`;
  }

  // Closing finalizes the session, which also captures regression fixtures and
  // prunes working files server-side. Opt-in: on a corpus run that is 2000 fixture
  // captures against a deployment that has done seventeen documents, and that is a
  // decision to make deliberately rather than as a side effect of measuring.
  if (opts.close && (meta.outcome === "ready_for_review")) {
    const closed = await client.request("POST", `/sessions/${sid}/close`);
    meta.closed = closed.status;
  }

  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  return meta;
}

async function main() {
  const a = args();
  const base = process.env.IRIS_BASE_URL ?? "https://iris.equalify.uic.edu/v1";
  const token = process.env.IRIS_TOKEN;
  if (!token) {
    console.error("IRIS_TOKEN is not set (a GitHub token — see `iris login` or docs/API.md §1).");
    process.exit(2);
  }
  const corpusPath = a.corpus ?? "corpus.jsonl";
  const out = ensureDir(a.out ?? "runs");
  const opts = {
    out,
    // Matches the server's default `max_concurrent_runs`. Raising it past what the
    // deployment admits does not go faster — it just moves the wait into Iris's
    // queue and inflates queue_wait_ms.
    concurrency: num(a.concurrency, 2),
    pollMs: num(a["poll-ms"], 5000),
    // Above the provider's own 15-minute total backstop, so the harness never gives
    // up on a run Iris is still working on.
    timeoutMs: num(a["timeout-ms"], 45 * 60_000),
    close: Boolean(a.close),
  };

  const corpus = readJsonl(corpusPath).filter((r) => r.klass === "ok");
  if (!corpus.length) {
    console.error(`no runnable items in ${corpusPath} — run prepare.mjs first`);
    process.exit(2);
  }
  const ledgerPath = join(out, "ledger.jsonl");
  const done = new Set(a.redo ? [] : readJsonl(ledgerPath).map((r) => r.id));
  let todo = corpus.filter((d) => !done.has(d.id));
  // Staging is what makes this safe: 25 items answers "how long does a document
  // actually take and what does it cost" before committing to days of wall clock.
  if (a.limit) todo = todo.slice(0, num(a.limit, todo.length));

  const limits = await fetchLimits(base);
  const client = new Client(base, token);
  client.configure(limits);
  log(
    `running ${todo.length} of ${corpus.length} item(s) against ${base}`,
    `— concurrency ${opts.concurrency}, submissions spaced ${client.minSubmitGapMs}ms`,
  );
  if (done.size) log(`skipping ${done.size} already in the ledger (--redo to re-run)`);

  const counts = {};
  let n = 0;
  await pool(todo, opts.concurrency, async (doc) => {
    let meta;
    try {
      meta = await runOne(client, doc, opts);
    } catch (e) {
      meta = { id: doc.id, url: doc.url, outcome: "harness_error", error: `${e.name}: ${e.message}` };
    }
    appendJsonl(ledgerPath, {
      id: meta.id,
      session_id: meta.session_id ?? null,
      outcome: meta.outcome,
      round_trip_ms: meta.round_trip_ms ?? null,
      at: new Date().toISOString(),
    });
    counts[meta.outcome] = (counts[meta.outcome] ?? 0) + 1;
    n++;
    // Ids are content hashes, and every chunk of one oversize PDF shares its
    // parent's prefix — so the page range is what makes the line identify a run.
    const label = meta.page_from ? `${meta.id.slice(0, 8)}#p${meta.page_from}-${meta.page_to}` : meta.id.slice(0, 12);
    log(
      `[${n}/${todo.length}] ${label} ${meta.outcome}` +
        `${meta.round_trip_ms ? ` in ${Math.round(meta.round_trip_ms / 1000)}s` : ""}` +
        `${meta.error ? ` — ${String(meta.error).slice(0, 120)}` : ""}`,
    );
  });

  log("--- outcomes ---");
  for (const [k, v] of Object.entries(counts).sort((x, y) => y[1] - x[1])) log(`  ${k}: ${v}`);
  log(`artifacts in ${out}/ — next: node src/report.mjs --runs ${out}`);
}

await main();
