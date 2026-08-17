// A stand-in for the Iris API surface this harness uses, plus a PDF generator, so
// all three stages can be exercised without a token, a network, or a live
// deployment's queue. It is not a model of Iris — it is a fixture whose shapes match
// the endpoints and log events this harness reads, which is what the harness can
// actually get wrong.
//
// Its `max_pages` is deliberately tiny (3) so that splitting, the most intricate
// part of prepare, is exercised by a seven-page document rather than a 60-page one.

import { createServer } from "node:http";

// A minimal, valid, uncompressed multi-page PDF. Written by hand rather than shelled
// out to a generator so the test runs the same way on any machine — the point of the
// fixture is that `pdfinfo` reads a real page count and real page dimensions off it.
export function makePdf(pages, { widthPts = 612, heightPts = 792 } = {}) {
  const objs = [];
  const pageIds = [];
  // 1: catalog, 2: page tree, 3: font, then two objects per page.
  for (let i = 0; i < pages; i++) pageIds.push(4 + i * 2);
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`;
  objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  for (let i = 0; i < pages; i++) {
    const pageId = pageIds[i];
    const contentId = pageId + 1;
    objs[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPts} ${heightPts}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    const stream = `BT /F1 24 Tf 72 700 Td (Page ${i + 1} of ${pages}) Tj ET`;
    objs[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }

  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const xref = out.length;
  const count = objs.length; // object 0 is the free-list head
  out += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// A delivered document with a defect of each kind the local re-lint is configured to
// catch: a duplicate id on inert elements, on active ones, and on one an ARIA/`for`
// reference points at (the case axe reports as `incomplete`, which lint.mjs promotes).
export const OUTPUT_HTML = `<!DOCTYPE html><html><head><title>Fixture</title></head><body>
<h1>Fixture</h1><p>Some delivered content, long enough not to look like an empty document.</p>
<ul><li id="x">a</li><li id="x">b</li></ul>
<label for="q1">Name</label><input id="q1"><input id="q1">
<a id="dup" href="#x">one</a><a id="dup" href="#x">two</a>
<img src="fig.png">
</body></html>`;

const LIMITS = {
  pdf: { max_pages: 3 },
  upload: { max_files: 25, max_request_bytes: 134217728 },
  image: { max_bytes: 3932160, max_long_edge_px: 1568, max_dimension_px: 8000 },
  // High enough that the submit spacing does not dominate the test's runtime, while
  // still exercising the code path that derives spacing from the published limit.
  rate_limits: { general_per_minute: 240, auth_per_minute: 60, upload_per_minute: 600 },
};

const MODEL = "us.anthropic.claude-sonnet-4-6";
const call = (agent, capability, duration_ms, input_tokens, output_tokens) => ({
  ts: "2026-01-01T00:00:02.000Z",
  type: "model_call",
  agent,
  model: MODEL,
  provider: "bedrock",
  capability,
  duration_ms,
  ok: true,
  input_tokens,
  output_tokens,
});

const LOG_LINES = [
  { ts: "2026-01-01T00:00:00.000Z", type: "run_start", pages: 3 },
  { ts: "2026-01-01T00:00:01.000Z", type: "phase", phase: "extraction" },
  call("page", "vision", 4000, 5200, 1400),
  call("reader", "text", 2000, 3000, 500),
  { ts: "2026-01-01T00:00:04.000Z", type: "assembly", pages: 3, lint_ok: false, violations: 2 },
  { ts: "2026-01-01T00:00:05.000Z", type: "reader", iteration: 0, issues: 2 },
  { ts: "2026-01-01T00:00:06.000Z", type: "editor", iteration: 1 },
  { ts: "2026-01-01T00:00:07.000Z", type: "editor_links_dropped", iteration: 1, hrefs: ["#x"] },
  { ts: "2026-01-01T00:00:08.000Z", type: "reader", iteration: 1, issues: 0 },
  { ts: "2026-01-01T00:00:09.000Z", type: "run_complete", iterations: 1, unresolved: 0, mode: "initial" },
];
const FAIL_ERROR = "page 2: stream stalled (idle) after 60000ms";

const diagnostics = (id, failed) => ({
  session_id: id,
  status: failed ? "failed" : "ready_for_review",
  phase: "done",
  elapsed_ms: 9000,
  in_flight: null,
  in_flight_count: 0,
  phase_durations_ms: { extraction: 5000, assembly: 1000, review: 3000 },
  model_calls: { count: 2, failed: 0, total_ms: 6000, avg_ms: 3000, max_ms: 4000, concurrency_factor: 0.67 },
  tokens: { input: 8200, output: 1900, cache_read: 0, cache_write: 0, calls_reported: 2 },
  by_agent: {
    page: { count: 1, total_ms: 4000, max_ms: 4000, input_tokens: 5200, output_tokens: 1400 },
    reader: { count: 1, total_ms: 2000, max_ms: 2000, input_tokens: 3000, output_tokens: 500 },
  },
  slowest_calls: [],
  errors: failed ? [{ ts: null, type: "run_failed", message: FAIL_ERROR }] : [],
});

// `failNth` makes one submission end in `status: "failed"`, so the test covers the
// capture path that matters most: a run whose only account of itself is its log.
// `unauthorizedAfter` starts refusing submissions partway through, which is what an
// expiring GitHub user token looks like to a campaign that outlives it.
export function startStub({ pages = 7, failNth = 3, unauthorizedAfter = Infinity } = {}) {
  const pdf = makePdf(pages);
  const sessions = new Map();
  let submissions = 0;

  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://stub").pathname;
    const send = (code, body, type = "application/json") => {
      res.writeHead(code, { "content-type": type });
      res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };

    if (path === "/v1/limits") return send(200, LIMITS);
    // Two URLs, same bytes, so duplicate collapsing is exercised.
    if (path === "/a.pdf" || path === "/copy.pdf") return send(200, pdf, "application/pdf");
    // An HTML sign-in page served as application/pdf — why prepare checks magic bytes.
    if (path === "/signin") return send(200, "<html>please sign in</html>", "application/pdf");
    if (path === "/missing") return send(404, "not found", "text/plain");

    if (path === "/v1/sessions" && req.method === "POST") {
      for await (const chunk of req) void chunk; // drain the multipart body
      submissions += 1;
      if (submissions > unauthorizedAfter) {
        return send(401, { error: "unauthorized", message: "Bad credentials" });
      }
      const id = `sess-${submissions}`;
      sessions.set(id, { polls: 0, failed: submissions === failNth });
      return send(200, { session_id: id, status: "queued" });
    }

    const m = path.match(/^\/v1\/sessions\/([^/]+)(\/.*)?$/);
    if (m) {
      const s = sessions.get(m[1]);
      if (!s) return send(404, { error: "no such session" });
      switch (m[2] ?? "") {
        case "":
          // queued -> running -> terminal, so the queue-wait measurement has
          // something to measure.
          s.polls += 1;
          if (s.polls === 1) return send(200, { session_id: m[1], status: "queued", phase: "queued" });
          if (s.polls === 2) return send(200, { session_id: m[1], status: "running", phase: "extraction" });
          return send(200, {
            session_id: m[1],
            status: s.failed ? "failed" : "ready_for_review",
            phase: s.failed ? "extraction" : "done",
            iterations_completed: 1,
            ...(s.failed ? { error: FAIL_ERROR } : {}),
          });
        case "/logs":
          return send(200, LOG_LINES.map((e) => JSON.stringify(e)).join("\n"), "application/x-ndjson");
        case "/diagnostics":
          return send(200, diagnostics(m[1], s.failed));
        case "/output":
          return send(200, OUTPUT_HTML, "text/html");
        case "/close":
          return send(200, { ok: true });
      }
    }
    send(404, { error: `stub has no route for ${path}` });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}/v1`, origin: `http://127.0.0.1:${port}`, server });
    });
  });
}
