// Stage 1: turn a CSV of PDF URLs into a corpus Iris can actually be asked to run.
//
// Iris does not fetch URLs — `POST /v1/sessions` is multipart only — so the URLs
// are client-side input and every file has to be downloaded here. Two things then
// have to happen before any of it is uploaded:
//
//   * Page cap. A PDF over the deployment's `max_pages` is rejected with a 400.
//     An unfiltered real-world corpus skews long, so dropping those would bias
//     the whole accuracy baseline toward short documents — they are split into
//     cap-sized chunks instead, and labelled, because a chunk's review score is
//     not comparable to a whole document's (the reviewer sees a document with no
//     beginning).
//   * Everything that is not a PDF. At corpus scale a meaningful share of any URL
//     list is 404s, login walls, HTML error pages served as 200, and encrypted
//     files. Finding that out here costs a download; finding it out during the run
//     costs a session, a queue slot and a place in the failure statistics.
//
// Idempotent and resumable: every URL's outcome is appended to prepared.jsonl and
// skipped on a later pass, and downloads are content-addressed in cache/.

import { join, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fetchLimits, pxFromPts, RASTER_DPI } from "./limits.mjs";
import {
  appendJsonl,
  args,
  ensureDir,
  exec,
  hasCommand,
  latestAttempts,
  log,
  num,
  pool,
  readJsonl,
  sha256,
} from "./util.mjs";

const UA = "equalify-iris-bench/0.1 (+https://github.com/EqualifyEverything/equalify-iris-bench)";

// A ceiling on the download itself, not on what Iris accepts. Its purpose is to
// stop one pathological 400 MB scan from filling the disk; anything over it is
// recorded as skipped rather than quietly ignored.
const DEFAULT_MAX_DOWNLOAD_MB = 200;

// How many cap-sized chunks one oversize PDF may contribute. A 600-page document
// would otherwise become 24 sessions and dominate the corpus on its own. The
// dropped tail is recorded on the parent and logged in the summary — a bound that
// does not announce itself reads as "we covered everything".
const DEFAULT_MAX_CHUNKS = 4;

// Two separate clocks, because "slow" and "hung" are different failures and one
// deadline cannot tell them apart. A flat deadline set short enough to notice a hung
// connection also discards every large PDF on a slow host — and government document
// servers, which are most of what a corpus like this points at, are exactly that:
// 35 MB at 40 KB/s is a fifteen-minute download that is working perfectly. Measured
// against these four URLs, a 120s flat deadline dropped three of them, and the corpus
// that survived would have been silently biased toward small files on fast hosts.
//
// So: STALL is the real failure detector — no bytes at all for this long. TOTAL is
// only a backstop against a server that dribbles forever.
const DEFAULT_STALL_SEC = 45;
const DEFAULT_TOTAL_SEC = 30 * 60;

// --- CSV -------------------------------------------------------------------

// RFC 4180 enough for real exports: quoted fields, embedded commas and newlines,
// doubled quotes.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (c !== "\r") field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const isUrl = (s) => /^https?:\/\//i.test((s ?? "").trim());

// Which column holds the URLs, and whether row 0 is a header. Logged rather than
// assumed: a harness that silently picked the wrong column would produce a
// perfectly plausible run over the wrong 2000 things.
function pickUrls(rows) {
  if (!rows.length) return { urls: [], column: null };
  const header = rows[0];
  let column;
  let body;
  if (header.some(isUrl)) {
    column = header.findIndex(isUrl);
    body = rows;
    log(`csv: no header row detected; reading URLs from column ${column}`);
  } else {
    const named = header.findIndex((h) => /url|link|href|pdf|document/i.test(h));
    column = named === -1 ? 0 : named;
    body = rows.slice(1);
    log(`csv: header row detected; reading URLs from column ${column} ("${header[column]}")`);
  }
  const urls = [];
  const seen = new Set();
  let dupes = 0;
  for (const r of body) {
    const u = (r[column] ?? "").trim();
    if (!isUrl(u)) continue;
    if (seen.has(u)) {
      dupes++;
      continue;
    }
    seen.add(u);
    urls.push(u);
  }
  if (dupes) log(`csv: ${dupes} duplicate URL(s) collapsed`);
  return { urls, column };
}

// --- download + inspect ----------------------------------------------------

// A TLS chain that Node rejects and a browser accepts. Real: www.hr.uic.edu serves an
// incomplete chain, and browsers paper over it by fetching the missing intermediate
// while Node does not. Worth its own class rather than hiding inside download_failed,
// because the fix is a trust-store flag (see --use-system-ca in the README) rather than
// anything wrong with the URL.
const TLS_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
]);

function downloadError(e, { stalled, expired, stallSec, totalSec, got }) {
  if (stalled) {
    return { klass: "download_stalled", error: `no bytes for ${stallSec}s after ${got} byte(s)`, bytes: got };
  }
  if (expired) {
    return { klass: "download_timeout", error: `still downloading after ${totalSec}s (${got} byte(s))`, bytes: got };
  }
  const code = e?.cause?.code ?? e?.code;
  const cause = e?.cause?.message ?? e?.message;
  if (TLS_CODES.has(code) || /certificate/i.test(cause ?? "")) {
    return { klass: "tls_failed", error: `${code ?? "tls"}: ${cause}`.slice(0, 300) };
  }
  return { klass: "download_failed", error: `${e.name}: ${e.message}${cause && cause !== e.message ? ` (${cause})` : ""}`.slice(0, 300) };
}

async function download(url, maxBytes, { stallSec = DEFAULT_STALL_SEC, totalSec = DEFAULT_TOTAL_SEC } = {}) {
  const ctl = new AbortController();
  let stalled = false;
  let expired = false;
  let got = 0;
  let stallTimer;
  // Re-armed on every chunk, so progress — however slow — is never a failure.
  const arm = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      ctl.abort();
    }, stallSec * 1000);
  };
  const totalTimer = setTimeout(() => {
    expired = true;
    ctl.abort();
  }, totalSec * 1000);
  const stop = () => {
    clearTimeout(stallTimer);
    clearTimeout(totalTimer);
  };
  const failed = (e) => downloadError(e, { stalled, expired, stallSec, totalSec, got });

  let res;
  try {
    arm();
    res = await fetch(url, {
      redirect: "follow",
      signal: ctl.signal,
      headers: { "user-agent": UA, accept: "application/pdf,*/*" },
    });
  } catch (e) {
    stop();
    return failed(e);
  }
  if (!res.ok) {
    stop();
    return { klass: "download_failed", error: `http_${res.status}`, http_status: res.status };
  }

  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared && declared > maxBytes) {
    stop();
    return { klass: "too_large_bytes", error: `content-length ${declared} > ${maxBytes}`, bytes: declared };
  }

  // Streamed rather than buffered whole, so a file that lies about its content-length
  // is stopped at the cap instead of after it has been held in memory.
  const parts = [];
  let buf;
  try {
    for await (const chunk of res.body) {
      arm();
      got += chunk.length;
      if (got > maxBytes) {
        stop();
        return { klass: "too_large_bytes", error: `over ${maxBytes} bytes (undeclared)`, bytes: got };
      }
      parts.push(Buffer.from(chunk));
    }
    buf = Buffer.concat(parts);
  } catch (e) {
    return failed(e);
  } finally {
    stop();
  }
  // Magic bytes, not content-type. A great many servers hand out PDFs as
  // application/octet-stream, and a great many hand out an HTML "sign in" page as
  // application/pdf — only one of those two errors is detectable from the header.
  if (!buf.subarray(0, 1024).includes("%PDF-")) {
    return {
      klass: "not_pdf",
      error: `no %PDF- header (content-type: ${res.headers.get("content-type") ?? "none"})`,
      bytes: buf.length,
      final_url: res.url,
    };
  }
  return { buf, bytes: buf.length, final_url: res.url, content_type: res.headers.get("content-type") };
}

function field(text, key) {
  const m = text.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

async function inspect(path, maxPages) {
  const info = await exec("pdfinfo", [path]);
  if (info.code !== 0) {
    return { klass: "pdfinfo_failed", error: info.stderr.trim().slice(0, 300) };
  }
  const pages = Number(field(info.stdout, "Pages"));
  if (!Number.isInteger(pages) || pages < 1) {
    return { klass: "pdfinfo_failed", error: `unreadable page count: ${field(info.stdout, "Pages")}` };
  }
  const encrypted = /^yes/i.test(field(info.stdout, "Encrypted") ?? "no");

  // Per-page physical sizes, for the pages that would actually be rasterized.
  // Iris measures each RENDERED page against the vision model's per-image byte
  // cap and its hard dimension ceiling, so a physically huge page (an ARCH-D
  // drawing) fails a 400 that no property of the file itself predicts.
  const sizes = await exec("pdfinfo", ["-f", "1", "-l", String(Math.min(pages, maxPages)), path]);
  let maxEdgePts = 0;
  for (const m of sizes.stdout.matchAll(/^Page\s+\d+ size:\s+([\d.]+) x ([\d.]+) pts/gm)) {
    maxEdgePts = Math.max(maxEdgePts, Number(m[1]), Number(m[2]));
  }
  return {
    pages,
    encrypted,
    max_edge_pts: maxEdgePts || null,
    predicted_max_edge_px: maxEdgePts ? pxFromPts(maxEdgePts) : null,
    pdf_version: field(info.stdout, "PDF version"),
    tagged: /^yes/i.test(field(info.stdout, "Tagged") ?? "no"),
  };
}

// --- splitting -------------------------------------------------------------

// qpdf if it is here, poppler otherwise. Both are ordinary installs and either
// will do; what matters is not silently declining to split, since that would
// re-introduce the long-document bias splitting exists to remove.
async function splitter() {
  if (await hasCommand("qpdf")) return "qpdf";
  if ((await hasCommand("pdfseparate")) && (await hasCommand("pdfunite"))) return "poppler";
  return null;
}

async function splitRange(tool, src, from, to, dest, tmpDir) {
  if (tool === "qpdf") {
    const r = await exec("qpdf", [src, "--pages", src, `${from}-${to}`, "--", dest]);
    // qpdf exits 3 on warnings while still writing a valid file, which is common
    // in real-world PDFs and must not read as a failure.
    return r.code === 0 || (r.code === 3 && existsSync(dest)) ? null : r.stderr.trim().slice(0, 300);
  }
  const sep = await exec("pdfseparate", ["-f", String(from), "-l", String(to), src, join(tmpDir, "p-%d.pdf")]);
  if (sep.code !== 0) return sep.stderr.trim().slice(0, 300);
  const parts = [];
  for (let p = from; p <= to; p++) {
    const f = join(tmpDir, `p-${p}.pdf`);
    if (existsSync(f)) parts.push(f);
  }
  if (!parts.length) return "pdfseparate produced no pages";
  const uni = await exec("pdfunite", [...parts, dest]);
  return uni.code === 0 ? null : uni.stderr.trim().slice(0, 300);
}

// --- accounting ------------------------------------------------------------

// Classes that say something about the fetch rather than about the document. Each is
// recoverable by changing a setting — a longer stall budget, a wider trust store, a
// working network — so `--retry` re-attempts exactly these and leaves settled verdicts
// (not_pdf, encrypted, duplicate, too_large_bytes, ok) alone.
const RETRYABLE = new Set(["download_failed", "download_stalled", "download_timeout", "tls_failed", "prepare_error"]);

// --- main ------------------------------------------------------------------

async function main() {
  const a = args();
  if (!a.csv) {
    console.error(
      "usage: node src/prepare.mjs --csv urls.csv [--out .] [--concurrency 8]\n" +
        `                           [--max-download-mb ${DEFAULT_MAX_DOWNLOAD_MB}] [--max-chunks ${DEFAULT_MAX_CHUNKS}] [--limit N]\n` +
        `                           [--stall-sec ${DEFAULT_STALL_SEC}] [--total-sec ${DEFAULT_TOTAL_SEC}] [--retry]`,
    );
    process.exit(2);
  }
  const base = process.env.IRIS_BASE_URL ?? "https://iris.equalify.uic.edu/v1";
  // Absolute, so the `path` recorded for every corpus item resolves from wherever the
  // run stage is later invoked. corpus.jsonl is machine-local by nature (it points at
  // gigabytes of cached PDFs), so there is nothing to gain from relative paths and a
  // resumed run started from the wrong directory to lose.
  const out = ensureDir(resolve(a.out ?? "."));
  const cache = ensureDir(join(out, "cache"));
  const chunkDir = ensureDir(join(cache, "chunks"));
  const preparedPath = join(out, "prepared.jsonl");
  const corpusPath = join(out, "corpus.jsonl");
  const maxBytes = num(a["max-download-mb"], DEFAULT_MAX_DOWNLOAD_MB) * 1024 * 1024;
  const maxChunks = num(a["max-chunks"], DEFAULT_MAX_CHUNKS);
  const concurrency = num(a.concurrency, 8);
  const timeouts = {
    stallSec: num(a["stall-sec"], DEFAULT_STALL_SEC),
    totalSec: num(a["total-sec"], DEFAULT_TOTAL_SEC),
  };

  if (!(await hasCommand("pdfinfo"))) {
    console.error("pdfinfo not found. Install poppler-utils (brew install poppler / apt install poppler-utils).");
    process.exit(2);
  }
  const limits = await fetchLimits(base);
  const tool = await splitter();
  if (!tool) {
    log("WARNING: neither qpdf nor pdfseparate+pdfunite found — oversize PDFs will be recorded, not split.");
    log("         That drops long documents from the corpus and biases it toward short ones. Install qpdf.");
  }

  const { urls } = pickUrls(parseCsv(readFileSync(a.csv, "utf8")));
  const previous = latestAttempts(readJsonl(preparedPath));
  // The URL-level outcome of each past attempt — chunk children carry their parent's
  // URL, so they are not it.
  const done = new Map(previous.filter((r) => !r.parent_sha).map((r) => [r.url, r]));
  const retryable = urls.filter((u) => RETRYABLE.has(done.get(u)?.klass));
  let todo = urls.filter((u) => !done.has(u) || (a.retry && RETRYABLE.has(done.get(u).klass)));
  if (a.limit) todo = todo.slice(0, num(a.limit, todo.length));
  log(`csv: ${urls.length} unique URL(s); ${done.size} already prepared; ${todo.length} to fetch`);
  if (retryable.length && !a.retry) {
    log(`  ${retryable.length} previously failed on the fetch, not on the document — --retry re-attempts those`);
  }

  // sha256 -> url, so the same file behind two URLs is downloaded twice (cheap,
  // and unavoidable without fetching) but run once.
  const bySha = new Map();
  for (const r of previous) if (r.sha256 && !r.duplicate_of && !todo.includes(r.url)) bySha.set(r.sha256, r.url);

  let n = 0;
  await pool(todo, concurrency, async (url) => {
    const record = { url, prepared_at: new Date().toISOString() };
    try {
      const dl = await download(url, maxBytes, timeouts);
      if (dl.klass) {
        appendJsonl(preparedPath, { ...record, ...dl });
        return;
      }
      const sha = sha256(dl.buf);
      record.sha256 = sha;
      record.bytes = dl.bytes;
      record.final_url = dl.final_url;
      record.content_type = dl.content_type;

      const existing = bySha.get(sha);
      if (existing && existing !== url) {
        // Byte-identical to something already in the corpus: keep the record so the
        // URL is accounted for, but do not run it twice.
        appendJsonl(preparedPath, { ...record, klass: "duplicate", duplicate_of: existing });
        return;
      }
      bySha.set(sha, url);

      const path = join(cache, `${sha}.pdf`);
      if (!existsSync(path)) writeFileSync(path, dl.buf);

      const info = await inspect(path, limits.maxPages);
      Object.assign(record, info);
      if (info.klass) {
        appendJsonl(preparedPath, record);
        return;
      }
      if (info.encrypted) {
        appendJsonl(preparedPath, { ...record, klass: "encrypted" });
        return;
      }

      // A page that will rasterize past the model's hard dimension ceiling is a
      // predicted 400. Flagged, never excluded: the DPI behind the prediction is
      // Iris-internal and unpublished, so this can be wrong, and being wrong must
      // cost a failed run rather than a missing document.
      const risks = [];
      if (limits.maxDimensionPx && info.predicted_max_edge_px > limits.maxDimensionPx) {
        risks.push(`predicted ${info.predicted_max_edge_px}px long edge at ${RASTER_DPI}dpi > max_dimension_px`);
      }

      if (info.pages <= limits.maxPages) {
        appendJsonl(preparedPath, { ...record, klass: "ok", id: sha, path, risks });
        return;
      }

      // Oversize: split into cap-sized chunks.
      if (!tool) {
        appendJsonl(preparedPath, { ...record, klass: "oversize_pages", risks, chunks: 0, chunks_dropped: null });
        return;
      }
      const wanted = Math.ceil(info.pages / limits.maxPages);
      const made = [];
      let failure = null;
      for (let c = 0; c < Math.min(wanted, maxChunks); c++) {
        const from = c * limits.maxPages + 1;
        const to = Math.min(info.pages, from + limits.maxPages - 1);
        const id = `${sha}-p${from}-${to}`;
        const dest = join(chunkDir, `${id}.pdf`);
        const tmp = ensureDir(join(chunkDir, `.tmp-${id}`));
        const err = existsSync(dest) ? null : await splitRange(tool, path, from, to, dest, tmp);
        if (err) {
          failure = err;
          break;
        }
        made.push({ id, from, to, path: dest, pages: to - from + 1 });
      }
      appendJsonl(preparedPath, {
        ...record,
        klass: "oversize_pages",
        risks,
        split_with: tool,
        chunks: made.length,
        chunks_dropped: Math.max(0, wanted - made.length),
        split_error: failure,
      });
      for (const c of made) {
        appendJsonl(preparedPath, {
          url,
          prepared_at: record.prepared_at,
          klass: "ok",
          id: c.id,
          path: c.path,
          sha256: sha,
          parent_sha: sha,
          parent_pages: info.pages,
          page_from: c.from,
          page_to: c.to,
          pages: c.pages,
          bytes: null,
          risks,
        });
      }
    } catch (e) {
      appendJsonl(preparedPath, { ...record, klass: "prepare_error", error: `${e.name}: ${e.message}` });
    } finally {
      if (++n % 25 === 0) log(`prepared ${n}/${todo.length}`);
    }
  });

  // corpus.jsonl is the runnable subset, rewritten from scratch each pass so it is
  // a deterministic function of prepared.jsonl rather than an append-only history.
  const all = latestAttempts(readJsonl(preparedPath));
  const runnable = all.filter((r) => r.klass === "ok");
  runnable.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)); // stable staging order
  writeFileSync(corpusPath, runnable.map((r) => JSON.stringify(r)).join("\n") + (runnable.length ? "\n" : ""));

  const counts = {};
  for (const r of all) counts[r.klass ?? "unknown"] = (counts[r.klass ?? "unknown"] ?? 0) + 1;
  const chunked = runnable.filter((r) => r.parent_sha).length;
  const droppedChunks = all.reduce((s, r) => s + (r.chunks_dropped ?? 0), 0);
  const atRisk = runnable.filter((r) => r.risks?.length).length;
  const pages = runnable.reduce((s, r) => s + (r.pages ?? 0), 0);

  log("--- corpus ---");
  for (const [k, v] of Object.entries(counts).sort((x, y) => y[1] - x[1])) log(`  ${k}: ${v}`);
  log(`  runnable: ${runnable.length} session(s), ${pages} page(s) — ${chunked} of them chunks of oversize PDFs`);
  if (droppedChunks) log(`  NOT covered: ${droppedChunks} chunk(s) past --max-chunks=${maxChunks}`);
  if (atRisk) log(`  ${atRisk} runnable item(s) carry a predicted-rejection risk flag (see .risks)`);
  // These three are recoverable by re-running with different settings, and a corpus
  // that lost documents to a trust store or a slow host is not the corpus that was
  // asked for — so they are called out rather than left to be read off a class tally.
  if (counts.tls_failed) {
    log(`  ${counts.tls_failed} URL(s) failed TLS verification — hosts serving an incomplete chain.`);
    log("     Retry those with: node --use-system-ca src/prepare.mjs ... (widens trust to the OS store)");
  }
  if (counts.download_stalled || counts.download_timeout) {
    log(
      `  ${(counts.download_stalled ?? 0) + (counts.download_timeout ?? 0)} URL(s) ran out of download time` +
        ` (--stall-sec ${timeouts.stallSec}, --total-sec ${timeouts.totalSec}) — raise either and re-run to retry them.`,
    );
  }
  log(`wrote ${corpusPath}`);
}

await main();
