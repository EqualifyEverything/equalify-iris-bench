# iris-bench

A benchmark harness for [Iris](https://github.com/EqualifyEverything/equalify-iris). Give it a
CSV of PDF URLs; it tells you how often Iris succeeds, how long it takes, and what it costs
per page — and leaves behind the per-document artifacts needed to work out why the failures
failed.

It lives outside `equalify-iris` on purpose. This is a client of the public API, it has
dependencies and gigabytes of cached PDFs that the service should not carry, and it needs to
be pointable at any deployment — including the live one — without a release.

## Why these three numbers

- **Success rate** — how much of an unfiltered real-world corpus Iris can actually process.
  Reported twice: over documents *submitted*, and over every URL the CSV contained. The
  second number is lower and is the one an outside claim has to survive, because 404s,
  login walls served as `200 application/pdf`, and encrypted files are part of the world.
- **Time** — as percentiles, per document and per page. The tail is what decides how long a
  campaign takes and it is where the timeouts live; the mean hides it. Three clocks are
  captured separately: caller wall time, the server's own `elapsed_ms`, and the queue wait
  between them, which is the cost of concurrency rather than of the document.
- **Cost** — from the token counts Iris reports per session, multiplied by a rate table that
  carries a date and a source. Iris deliberately reports tokens and never dollars: the price
  of a token depends on the provider, region and model, all of which are deployment config.
  So cost is computed here, at a stated date, under stated assumptions.

## Accuracy, and what "accuracy" can mean here

There is no ground truth. Nobody has hand-authored the correct accessible HTML for 2000
PDFs, so this harness does not measure agreement with a reference. It measures the
conjunction of Iris's own pipeline signals with one independent check:

| Signal | Source | What a bad value means |
| --- | --- | --- |
| Final axe violations | **re-linted locally** by `src/lint.mjs` | the delivered document has accessibility defects |
| `iterations`, `unresolved` | `run_complete` | the review loop hit its cap and gave up with issues open |
| `editor_links_dropped` | run log | the copy editor deleted links; unrecoverable and invisible downstream |
| `assembly_anchors` | run log | id collisions, ambiguous cross-references, pages left as written |
| `page_verify_failed`, `specialist_declined` | run log | per-page extraction problems the pipeline reported but did not fix |
| headings / chars-per-page | `shape()` in `src/lint.mjs` | a clean lint on a nearly empty document — the failure no rule catches |

The local re-lint exists because of a real gap: Iris lints during the review loop (visible in
`log.jsonl`) and again after it, but the **final** lint — the one describing the document
actually handed back — is written to the deployment's aggregate quality tally and has no
per-session endpoint. `src/lint.mjs` is therefore a deliberate rule-for-rule port of the
deployment's `src/pipeline/lint.ts`, and `package.json` pins `axe-core` and `jsdom` to exact
versions rather than ranges, because which axe rule claims which element is an internal that a
version bump can move. **If Iris's lint config or axe version changes, update `src/lint.mjs`
in the same breath** — otherwise this stops measuring Iris and starts measuring a different
linter.

## Requirements

- Node 22+ (24 recommended — the same runtime Iris uses).
- `poppler-utils` for `pdfinfo` (required): `brew install poppler` / `apt install poppler-utils`.
- `qpdf` (strongly recommended): `brew install qpdf` / `apt install qpdf`. Without it, PDFs
  over the deployment's page cap cannot be split, which drops long documents from the corpus
  and biases every result toward short ones. `pdfseparate` + `pdfunite` are used as a fallback.
- A GitHub token the target deployment accepts. Iris has no API keys and no anonymous mode —
  the token is the identity that a session's feedback is filed under. `src/login.mjs` runs the
  device flow for you.

## Getting started

```sh
git clone https://github.com/EqualifyEverything/iris-bench && cd iris-bench
npm install
npm test                        # proves the harness works: no token, no network, no deployment
```

```sh
cp .env.example .env            # then set IRIS_BASE_URL if not the UIC deployment
node src/login.mjs              # opens a code to approve in the browser; prints a token
                                # paste it into .env as IRIS_TOKEN
```

Start with a handful of URLs, not the whole list. Ten is enough to prove the loop end to end
and to learn what a document costs:

```sh
printf 'pdf_url\nhttps://example.org/a.pdf\nhttps://example.org/b.pdf\n' > small.csv
node --env-file=.env src/prepare.mjs --csv small.csv
node --env-file=.env src/run.mjs
node src/report.mjs
```

The report's `usd_per_page` and `ms_per_page` from that first handful are what size everything
after it: multiply by the corpus's page count for the bill, and by `pages ÷ 2` for the wall
clock at the deployment's current concurrency.

## Usage

Any column of URLs works — the column is chosen by name and the choice is logged rather
than assumed. See `example.csv` for the shape.

```sh
# 1. Download, inspect, classify, split. Idempotent and resumable.
node --env-file=.env src/prepare.mjs --csv urls.csv

# 2. A 25-document pilot first. Always.
node --env-file=.env src/run.mjs --limit 25

# 3. Read the pilot before spending days of wall clock.
node src/report.mjs

# 4. Then the rest, in stages.
node --env-file=.env src/run.mjs --limit 200
node --env-file=.env src/run.mjs
```

Tokens are GitHub user tokens and can expire before a multi-day campaign finishes. A refused
token **stops** the run rather than failing the rest of the corpus against it, and nothing is
written to the ledger for the items it never attempted — so `node src/login.mjs` and the same
`run.mjs` command resume from exactly where the old token stopped being accepted.

### Stage 1 — `prepare.mjs`

Iris does not fetch URLs (`POST /v1/sessions` is multipart only), so every file is downloaded
client-side, then screened before anything is submitted. A URL that turns out to be an HTML
error page costs one download here; discovering it during the run costs a session, a
concurrency slot, and a place in the failure statistics.

Each URL lands in `prepared.jsonl` with a class: `ok`, `duplicate`, `download_failed`,
`too_large_bytes`, `not_pdf`, `pdfinfo_failed`, `encrypted`, `oversize_pages`, `prepare_error`.
PDFs are detected by the `%PDF-` magic bytes, not by `content-type` — servers hand out PDFs as
`application/octet-stream` and sign-in pages as `application/pdf`, and only one of those is
visible from a header. The runnable subset is rewritten to `corpus.jsonl` on every pass.

Documents over the deployment's `max_pages` are split into cap-sized chunks rather than
dropped, and labelled (`parent_sha`, `page_from`, `page_to`) so the report can keep them in a
separate population — a chunk's review score isn't comparable to a whole document's, because
the reviewer saw a document with no beginning. At most `--max-chunks` (default 4) chunks come
from any one PDF; the dropped tail is recorded and printed, because a bound that doesn't
announce itself reads as "we covered everything".

| Flag | Default | |
| --- | --- | --- |
| `--csv` | *(required)* | any column of URLs; the chosen column is logged, not assumed |
| `--concurrency` | 8 | parallel downloads |
| `--max-download-mb` | 200 | disk guard; larger files are recorded as skipped |
| `--max-chunks` | 4 | cap-sized chunks per oversize PDF |
| `--limit` | | prepare only the first N new URLs |

Nothing here hardcodes a page cap or an image ceiling — they come from `GET /v1/limits` at run
time, which is the whole reason that endpoint exists. The one exception is the rasterization
DPI behind `predicted_max_edge_px`, which Iris does not publish; it only ever produces a
**risk flag**, never an exclusion, so a stale guess costs a failed run rather than a missing
document.

### Stage 2 — `run.mjs`

Submits, polls to a terminal state, and captures `status.json`, `log.jsonl`,
`diagnostics.json` and `output.html` per document — **including for failed runs**, whose logs
are the only account of why they failed and whose diagnostics still carry the tokens they
spent getting there. A terminal outcome per item is appended to `runs/ledger.jsonl`, so an
interrupted campaign resumes where it stopped.

Throughput is bounded by the deployment's `max_concurrent_runs` (2 by default), not by the
rate limiter — a conversation takes minutes. `--concurrency` defaults to 2 to match, so the
harness cannot be the reason the numbers look bad; going higher doesn't run faster, it just
moves the wait into Iris's queue and shows up as `queue_wait_ms`. Submissions are additionally
spaced to stay inside the published `upload_per_minute`, and `429`s honour `Retry-After`.
A `400` is not retried: it's a verdict about the file, and it's recorded as a result.

| Flag | Default | |
| --- | --- | --- |
| `--limit` | | run only the first N unrun items — how staging is done |
| `--concurrency` | 2 | match the deployment's `max_concurrent_runs` |
| `--poll-ms` | 5000 | status poll interval |
| `--timeout-ms` | 2700000 | client give-up, deliberately above the provider's own 15-minute backstop |
| `--close` | off | `POST /sessions/:id/close` on success — see below |
| `--redo` | off | ignore the ledger and re-run everything |

`--close` is off by default and should stay off for a large campaign. Closing a session
finalizes it and captures regression fixtures server-side; on 2000 documents that is 2000
fixture captures against a deployment that has processed seventeen documents in its life. That
should be a deliberate decision, not a side effect of measuring.

### Stage 3 — `report.mjs`

Writes `results.jsonl` (one row per document, the thing to query) and `summary.json`, prints a
human summary to stderr and the JSON summary to stdout, so it can be piped into `jq` while
it narrates.

| Flag | Default | |
| --- | --- | --- |
| `--runs` | `runs` | artifact directory |
| `--rates` | | JSON overrides for the `$/MTok` table, merged over the built-in one |
| `--no-lint` | off | skip the local axe re-lint (minutes of CPU at corpus scale) |
| `--prepared` | `prepared.jsonl` | for the end-to-end denominator |

Failure messages are grouped by shape, with request ids and numbers masked, so a provider
error carrying a page number is one class of failure rather than two hundred. Every cost figure
names the rate that produced it, its source and the date it was checked; an unrecognized model
costs `null`, is excluded, and is counted loudly — "we swapped the model and the corpus
suddenly looks free" should not be able to happen quietly.

## Tests

`npm test` runs all three stages against a stub of the Iris API (`test/stub.mjs`), over a
hand-written multi-page PDF fixture — no token, no network, no queue. It asserts the things a
long unattended campaign can get quietly wrong: that a 7-page PDF against a cap of 3 becomes
3+3+1 with no page dropped or double-counted, that a URL counts as covered only when *every*
chunk of it came back, that a failed run's tokens are still counted, that an unpriced model
yields `null` rather than `$0`, and that failure messages collapse by shape.

`test/lint.test.mjs` additionally runs **both** linters — this repo's port and the
deployment's own `src/pipeline/lint.ts` — over the same fixtures and requires identical
verdicts. That comparison needs an `equalify-iris` checkout; it looks for one at `../equalify-iris`
and honours `IRIS_REPO=/path/to/equalify-iris`. Without one it falls back to asserting the
specific rule ids the config is supposed to produce, and says it skipped the comparison.

## Cost figures are estimates

The live deployment runs on Amazon Bedrock, which is partner-operated and billed through AWS
at AWS's rates for the region in use. The built-in table carries Anthropic's first-party rates
as a documented stand-in and flags every Bedrock-prefixed model id as `estimate_only`. Treat
the dollars as an order of magnitude for comparing documents against each other, and settle
real numbers against the invoice — or pass `--rates` once you have them.

## Before a large campaign

- **Raise `max_concurrent_runs`** on the target deployment if you want the corpus finished this
  week. At the default of 2 and a few minutes per document, 2000 documents is days.
- **Decide what to do about agent-suggestion issues.** A completed run can file GitHub issues
  upstream; across a corpus that is a lot of issues. The report counts what was filed
  (`agent_issues_filed`) but cannot un-file it.
- **Run 25 first, and read the report.** Per-page cost and per-page latency from the pilot are
  what tell you whether the full corpus is an afternoon or a fortnight, and how much it costs.
