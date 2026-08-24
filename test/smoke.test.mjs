// End-to-end exercise of prepare -> run -> report against the stub in stub.mjs.
//
// What it is for: this harness will run unattended for days and its output is used to
// make decisions about Iris. The failure mode to protect against is not a crash — it
// is a report that looks plausible and counts the wrong things. So the assertions are
// mostly about arithmetic and provenance: that an oversize PDF becomes the right
// chunks, that a URL is only "covered" when every chunk of it came back, that a failed
// run's tokens are still counted, and that an unpriced model produces no dollars.
//
// The local axe re-lint is checked separately, in lint.test.mjs, against the
// deployment's own linter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startStub } from "./stub.mjs";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const run = (script, args, env, cwd) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [join(SRC, script), ...args],
      { cwd, env: { ...process.env, ...env }, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }),
    );
  });

const jsonl = (p) =>
  readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test("prepare, run and report over a stub deployment", async (t) => {
  const { base, origin, server } = await startStub({ pages: 7, failNth: 3 });
  t.after(() => server.close());
  const dir = mkdtempSync(join(tmpdir(), "equalify-iris-bench-"));
  const env = { IRIS_BASE_URL: base, IRIS_TOKEN: "stub-token" };

  writeFileSync(
    join(dir, "urls.csv"),
    [
      "title,pdf_url,agency",
      `Seven pages,${origin}/a.pdf,Test`,
      `Same bytes behind another URL,${origin}/copy.pdf,Test`,
      `A sign-in wall served as application/pdf,${origin}/signin,Test`,
      `Gone,${origin}/missing,Test`,
      `A repeated row,${origin}/a.pdf,Test`,
      "",
    ].join("\n"),
  );

  // --- prepare ---
  const prep = await run("prepare.mjs", ["--csv", "urls.csv", "--concurrency", "2"], env, dir);
  assert.equal(prep.code, 0, prep.stderr);
  // The column is chosen by name and reported, because silently picking the wrong one
  // would produce a perfectly plausible run over the wrong 2000 things.
  assert.match(prep.stderr, /reading URLs from column 1 \("pdf_url"\)/);
  assert.match(prep.stderr, /1 duplicate URL\(s\) collapsed/);

  const prepared = jsonl(join(dir, "prepared.jsonl"));
  const klass = (k) => prepared.filter((r) => r.klass === k);
  assert.equal(klass("not_pdf").length, 1, "an HTML page served as application/pdf is caught by magic bytes");
  assert.equal(klass("download_failed").length, 1, "a 404 is a class, not an exception");
  assert.equal(klass("duplicate").length, 1, "byte-identical files behind two URLs run once");
  assert.equal(klass("oversize_pages").length, 1);

  // 7 pages against a cap of 3 is 3+3+1, and every page is accounted for exactly once.
  const corpus = jsonl(join(dir, "corpus.jsonl"));
  assert.equal(corpus.length, 3);
  assert.deepEqual(
    corpus.map((r) => [r.page_from, r.page_to]),
    [
      [1, 3],
      [4, 6],
      [7, 7],
    ],
  );
  assert.equal(
    corpus.reduce((s, r) => s + r.pages, 0),
    7,
    "no page is dropped or double-counted by the split",
  );
  assert.equal(klass("oversize_pages")[0].chunks_dropped, 0);
  for (const c of corpus) assert.ok(existsSync(c.path), `${c.path} was written`);

  // Idempotent: a second pass re-fetches nothing.
  const again = await run("prepare.mjs", ["--csv", "urls.csv"], env, dir);
  assert.match(again.stderr, /4 already prepared; 0 to fetch/);

  // --- run ---
  const ran = await run("run.mjs", ["--poll-ms", "50"], env, dir);
  assert.equal(ran.code, 0, ran.stderr);
  const ledger = jsonl(join(dir, "runs", "ledger.jsonl"));
  assert.equal(ledger.length, 3);
  assert.equal(ledger.filter((r) => r.outcome === "ready_for_review").length, 2);
  assert.equal(ledger.filter((r) => r.outcome === "failed").length, 1);

  // The failed run keeps its log and diagnostics — the only account of why it failed,
  // and the record of what it spent getting there — but has no delivered output.
  const failedId = ledger.find((r) => r.outcome === "failed").id;
  const failedDir = join(dir, "runs", failedId);
  assert.ok(existsSync(join(failedDir, "log.jsonl")));
  assert.ok(existsSync(join(failedDir, "diagnostics.json")));
  assert.ok(!existsSync(join(failedDir, "output.html")));

  // Resumable: nothing in the ledger is submitted twice.
  const resumed = await run("run.mjs", ["--poll-ms", "50"], env, dir);
  assert.match(resumed.stderr, /skipping 3 already in the ledger/);
  assert.match(resumed.stderr, /running 0 of 3/);

  // --- report ---
  const rep = await run("report.mjs", [], env, dir);
  assert.equal(rep.code, 0, rep.stderr);
  const s = JSON.parse(rep.stdout);

  assert.equal(s.corpus.urls_prepared, 4);
  assert.equal(s.corpus.submitted, 3);
  assert.equal(s.corpus.chunks, 3);
  assert.equal(s.corpus.pages_delivered, 6, "only the two delivered chunks' pages count");
  // Two of three items succeeded, but they were chunks of the SAME document and its
  // third chunk failed — so no URL was fully delivered. A report that called this 67%
  // end-to-end would be overstating what a caller received.
  assert.equal(Math.round(s.success_rate * 1000) / 1000, 0.667);
  assert.equal(s.corpus.urls_covered, 0);
  assert.equal(s.end_to_end_rate, 0);

  // Cost: ALL THREE runs' tokens, including the one that delivered nothing. A failed
  // run has already paid for every page it extracted — on the first real bench, 73% of
  // the bill was runs like this one — so a total drawn from delivered runs alone is the
  // flattering number rather than the budget.
  assert.equal(s.cost.tokens.input, 24600, "3 x 8200: the failed run's spend is in the total");
  assert.equal(s.cost.tokens_delivered.input, 16400, "and separable, for comparing documents");
  assert.equal(s.cost.tokens.output, 5700);
  assert.ok(s.cost.usd_on_failures > 0, "and named, so the waste is visible rather than absorbed");
  assert.ok(
    s.cost.usd_per_delivered_page > s.cost.usd_per_page_p50,
    "what a page cost is above what a page costs when nothing goes wrong",
  );
  assert.equal(s.cost.unpriced_documents, 0);
  assert.equal(s.cost.rates.length, 1);
  assert.equal(s.cost.rates[0].normalized, "claude-sonnet-4-6");
  assert.equal(s.cost.rates[0].estimate_only, true, "a Bedrock model id is an estimate, not an invoice");
  assert.ok(s.cost.rates[0].checked, "a rate without a date is not a measurement");
  assert.ok(s.cost.usd_total > 0 && s.cost.usd_total < 1);

  // Accuracy: the fixture document carries defects of every duplicate-id kind, so a
  // clean verdict here would mean the ported lint config had drifted.
  assert.equal(s.accuracy.lint_checked, 2);
  assert.equal(s.accuracy.lint_clean, 0);
  const rules = s.accuracy.top_rules.map((r) => r.rule);
  for (const id of ["duplicate-id", "duplicate-id-active", "duplicate-id-aria", "image-alt"]) {
    assert.ok(rules.includes(id), `${id} is reported (config parity with the deployment)`);
  }
  assert.equal(s.accuracy.links_dropped, 3, "a link the editor dropped is counted on failed runs too");

  // Failures are grouped by shape, so one stalled-stream class does not become two
  // hundred distinct errors once page numbers and timeouts are masked.
  assert.equal(s.failures.length, 1);
  assert.equal(s.failures[0].error, "page <n>: stream stalled (idle) after <n>ms");

  // Per-document rows are the thing to query afterwards.
  const rows = jsonl(join(dir, "runs", "results.jsonl"));
  assert.equal(rows.length, 3);
  const failedRow = rows.find((r) => r.outcome === "failed");
  assert.equal(failedRow.tokens.input, 8200, "a failed run's spend is recorded, not discarded");
  assert.equal(failedRow.is_chunk, true);
  assert.match(failedRow.error, /stream stalled/);
});

test("a refused token stops the campaign instead of consuming it", async (t) => {
  // The multi-day hazard: a GitHub user token can expire mid-run. Without this, every
  // remaining item would be submitted, refused, and ledgered as a failure in about a
  // minute — and recovering would mean re-running the whole corpus.
  const { base, origin, server } = await startStub({ pages: 7, unauthorizedAfter: 1 });
  t.after(() => server.close());
  const dir = mkdtempSync(join(tmpdir(), "equalify-iris-bench-auth-"));
  const env = { IRIS_BASE_URL: base, IRIS_TOKEN: "expired-token" };

  writeFileSync(join(dir, "urls.csv"), `pdf_url\n${origin}/a.pdf\n`);
  assert.equal((await run("prepare.mjs", ["--csv", "urls.csv"], env, dir)).code, 0);
  assert.equal(jsonl(join(dir, "corpus.jsonl")).length, 3, "three chunks, of which only one is accepted");

  const ran = await run("run.mjs", ["--poll-ms", "50", "--concurrency", "1"], env, dir);
  assert.equal(ran.code, 1, "a refused token is a non-zero exit, not a quiet finish");
  assert.match(ran.stderr, /STOPPED: http_401/);
  assert.match(ran.stderr, /not attempted and are not in the ledger/);
  assert.match(ran.stderr, /login\.mjs/, "says how to recover");

  // Only the item that actually ran is ledgered, so a fresh token resumes at the
  // exact point the old one stopped being accepted.
  assert.deepEqual(
    jsonl(join(dir, "runs", "ledger.jsonl")).map((r) => r.outcome),
    ["ready_for_review"],
  );
});

test("a slow host is not a failed host, and a hung one is retryable", async (t) => {
  // Measured on the first real four-URL bench: a flat 120s download deadline dropped
  // three of the four, all of them working PDFs on slow government hosts. So progress
  // — however slow — must never be a failure, silence must be, and the difference has
  // to survive into the corpus as a class you can retry.
  const { base, origin, server } = await startStub({ pages: 7 });
  t.after(() => server.close());
  const dir = mkdtempSync(join(tmpdir(), "equalify-iris-bench-slow-"));
  const env = { IRIS_BASE_URL: base, IRIS_TOKEN: "stub-token" };

  writeFileSync(
    join(dir, "urls.csv"),
    ["pdf_url", `${origin}/dribble.pdf`, `${origin}/stall.pdf`, `${origin}/flaky.pdf`, ""].join("\n"),
  );

  // A 1s stall budget with a 60s total: the dribbled file takes ~1.25s in five 250ms
  // steps, so it only survives if the clock is re-armed per chunk rather than run once.
  const first = await run(
    "prepare.mjs",
    ["--csv", "urls.csv", "--stall-sec", "1", "--total-sec", "60", "--concurrency", "3"],
    env,
    dir,
  );
  assert.equal(first.code, 0, first.stderr);
  // findLast, not find: prepared.jsonl keeps every attempt, and the latest is the verdict.
  const klassOf = (u) =>
    jsonl(join(dir, "prepared.jsonl")).findLast((r) => r.url.endsWith(u) && !r.parent_sha)?.klass;
  assert.equal(klassOf("/dribble.pdf"), "ok", "slow but progressing is a document, not a failure");
  assert.equal(klassOf("/stall.pdf"), "download_stalled");
  assert.equal(klassOf("/flaky.pdf"), "download_stalled");
  assert.match(first.stderr, /ran out of download time/);

  // Without --retry a fetch failure is sticky, and says how to un-stick it.
  const second = await run("prepare.mjs", ["--csv", "urls.csv"], env, dir);
  assert.match(second.stderr, /2 previously failed on the fetch or the split, or lost/);
  assert.match(second.stderr, /0 to fetch/);

  // With it, only the fetch failures are re-attempted — the settled `ok` is not
  // re-downloaded — and the host that works the second time becomes a document.
  const third = await run("prepare.mjs", ["--csv", "urls.csv", "--retry", "--stall-sec", "1"], env, dir);
  assert.match(third.stderr, /2 to fetch/);
  assert.equal(klassOf("/flaky.pdf"), "ok");
  assert.equal(klassOf("/stall.pdf"), "download_stalled", "still hung, still recorded");

  // The retried URL is counted once, not once per attempt: prepared.jsonl keeps both
  // attempts, so a tally over raw rows would report 4 outcomes for 3 URLs.
  const rows = jsonl(join(dir, "prepared.jsonl")).filter((r) => !r.parent_sha);
  assert.equal(rows.length, 5, "three first attempts plus two retries are all on disk");
  const summary = third.stderr.slice(third.stderr.indexOf("--- corpus ---"));
  assert.match(summary, /ok: 2/);
  assert.match(summary, /download_stalled: 1/);
  assert.doesNotMatch(summary, /download_stalled: 2/);
  assert.equal(jsonl(join(dir, "corpus.jsonl")).filter((r) => r.url.endsWith("/flaky.pdf")).length, 1);
});

test("a chunk too big to send is caught here, not by a 413", async (t) => {
  // Real, and expensive: splitting the 1004-page Texas appropriations act with
  // pdfseparate+pdfunite produced 477 MB chunks from a 34 MB source, because poppler
  // copies the whole shared resource set into every slice. Each was uploaded and
  // refused with a 413. A chunk's size is not a function of its page count, so it has
  // to be measured — and measured here, where it costs a stat call.
  // 1500 sits between poppler's 3-page slices (1921 and 2283 bytes) and its 1-page one
  // (1023), so two of three chunks are unsendable and one is not — the shape the real
  // Texas act took, in miniature.
  const { base, origin, server } = await startStub({ pages: 7, maxRequestBytes: 1500 });
  t.after(() => server.close());
  const dir = mkdtempSync(join(tmpdir(), "equalify-iris-bench-big-"));
  const env = { IRIS_BASE_URL: base, IRIS_TOKEN: "stub-token" };
  writeFileSync(join(dir, "urls.csv"), `pdf_url\n${origin}/a.pdf\n`);

  // Forced to poppler, because poppler is the splitter that produces unsendable chunks
  // and leaks scratch space — on a machine with qpdf installed, the default would test
  // neither. It is the fixture for both, so both are asserted below.
  const prep = await run("prepare.mjs", ["--csv", "urls.csv", "--splitter", "poppler"], env, dir);
  assert.equal(prep.code, 0, prep.stderr);

  // Per chunk, not per document: the two 3-page slices exceed the cap and the trailing
  // 1-page slice does not, so one of the three is still runnable. A guard that judged
  // the whole document would have thrown that page away too.
  const rows = jsonl(join(dir, "prepared.jsonl"));
  const big = rows.filter((r) => r.klass === "chunk_too_large");
  assert.equal(big.length, 2);
  assert.ok(big[0].bytes > 1500, "the measured size is kept, not just the verdict");
  assert.match(big[0].error, /max_request_bytes/);
  assert.match(big[0].error, /\d+ bytes >/, "the sizes are readable, not rounded to '0.0 MB'");
  assert.equal(big[0].split_with, "poppler", "--splitter was honoured, so the advice below is the right advice");
  assert.match(big[0].error, /install qpdf/, "says the fix, since the splitter is the cause");
  assert.deepEqual(
    big.map((r) => [r.page_from, r.page_to]),
    [
      [1, 3],
      [4, 6],
    ],
    "and exactly which pages are missing as a result",
  );

  // A chunk that can never be sent is not kept. The four real ones were 477 MB each,
  // and its measured size — the part worth having — is in the record above.
  for (const r of big) assert.ok(!existsSync(join(dir, "cache", "chunks", `${r.id}.pdf`)), `${r.id} was removed`);

  // Nor is the scratch space poppler splits into: one file per page, per chunk, per
  // document. Left behind, four documents cost 3.3 GB in .tmp dirs alone.
  assert.deepEqual(
    readdirSync(join(dir, "cache", "chunks")).filter((f) => f.startsWith(".tmp-")),
    [],
    "the splitter's scratch directories are cleaned up",
  );

  // Not runnable, and not silently absent either: the parent counts them and the
  // summary says so, because a corpus quietly missing a document reads as coverage.
  const corpus = jsonl(join(dir, "corpus.jsonl"));
  assert.deepEqual(corpus.map((r) => r.page_from), [7]);
  assert.equal(rows.find((r) => r.klass === "oversize_pages").chunks_too_large, 2);
  assert.match(prep.stderr, /NOT runnable: 2 chunk\(s\) came out over max_request_bytes/);

  // Retryable, because the fix is on this side: installing qpdf changes the outcome
  // for a document that was never at fault.
  const again = await run("prepare.mjs", ["--csv", "urls.csv"], env, dir);
  assert.match(again.stderr, /1 previously failed on the fetch or the split, or lost/);
  assert.match(again.stderr, /re-splits from scratch/);
});

test("a prepared file that is gone is not a corpus entry", async (t) => {
  // The cache is gigabytes and gets pruned — deliberately, when a splitter's output
  // turns out to be unsendable, and eventually just for space. prepared.jsonl says `ok`
  // either way, so without this the corpus lists paths nothing can open and the run
  // stage discovers it one failed item at a time.
  const { base, origin, server } = await startStub({ pages: 7 });
  t.after(() => server.close());
  const dir = mkdtempSync(join(tmpdir(), "equalify-iris-bench-gone-"));
  const env = { IRIS_BASE_URL: base, IRIS_TOKEN: "stub-token" };
  writeFileSync(join(dir, "urls.csv"), `pdf_url\n${origin}/a.pdf\n`);

  assert.equal((await run("prepare.mjs", ["--csv", "urls.csv"], env, dir)).code, 0);
  assert.equal(jsonl(join(dir, "corpus.jsonl")).length, 3);

  rmSync(jsonl(join(dir, "corpus.jsonl"))[1].path);
  const after = await run("prepare.mjs", ["--csv", "urls.csv"], env, dir);
  assert.equal(jsonl(join(dir, "corpus.jsonl")).length, 2, "the missing chunk is not offered to the run stage");
  assert.match(after.stderr, /1 prepared file\(s\) are no longer on disk, from 1 URL\(s\)/);
  assert.match(after.stderr, /--retry to fetch and split them again/);

  // And --retry actually does it, even though the URL's own outcome was never a failure.
  const retried = await run("prepare.mjs", ["--csv", "urls.csv", "--retry"], env, dir);
  assert.match(retried.stderr, /1 to fetch/);
  assert.equal(jsonl(join(dir, "corpus.jsonl")).length, 3, "and all three pages are runnable again");
  assert.doesNotMatch(retried.stderr, /no longer on disk/);
});

test("a structured error survives into text", async () => {
  const { errorText } = await import("../src/util.mjs");
  // Iris returns {code, message, details}. Interpolated directly it becomes
  // "[object Object]" — which is what a real 413 printed, hiding a message that named
  // the declared size, the cap and the fix. It would also have collapsed every
  // distinct structured failure into one bogus class in the report.
  assert.equal(
    errorText({ code: "upload_too_large", message: "Upload too large: 455.4 MB", details: { max_bytes: 1 } }),
    "upload_too_large: Upload too large: 455.4 MB",
  );
  assert.equal(errorText("already a string"), "already a string");
  assert.equal(errorText(null), null);
  assert.equal(errorText({ weird: true }), '{"weird":true}', "no shape is rendered as [object Object]");
});

test("an unpriced model yields no dollars and says so", async () => {
  const { costOf } = await import("../src/pricing.mjs");
  const tokens = { input: 1000, output: 1000, cache_read: 0, cache_write: 0 };
  const unknown = costOf(tokens, "us.anthropic.claude-whatever-9");
  assert.equal(unknown.usd, null, "an unknown model costs null, never zero");
  assert.equal(unknown.priced, false);

  // The four counts bill at four rates; cache reads at a tenth of input, cache writes
  // at 1.25x. Iris sends no cache_control today, so this exists to stay correct when
  // it does.
  const all = costOf({ input: 1e6, output: 1e6, cache_read: 1e6, cache_write: 1e6 }, "claude-sonnet-4-6");
  assert.equal(all.usd, 3 + 15 + 0.3 + 3.75);
});
