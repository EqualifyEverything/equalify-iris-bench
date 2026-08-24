// Shared plumbing. Deliberately dependency-free — Node 24 has everything this
// needs, and a harness that measures another service should not be the thing
// that breaks in a lockfile update.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Progress goes to stderr so stdout stays a clean data stream (a report can be
// piped into jq while the run is still narrating itself).
export function log(...parts) {
  process.stderr.write(`[${new Date().toISOString()}] ${parts.join(" ")}\n`);
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

// A malformed line is skipped rather than fatal: these files are append-only logs
// that a killed run can leave half-written, and losing the last line is better
// than refusing to resume.
export function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip
    }
  }
  return out;
}

export function appendJsonl(path, obj) {
  appendFileSync(path, `${JSON.stringify(obj)}\n`);
}

// prepared.jsonl is append-only, so a URL re-attempted with `--retry` has more than one
// attempt in it. Only the most recent one counts: otherwise a URL that failed the fetch
// once and succeeded on retry is tallied as both a failure and a success, and appears
// twice in the corpus. Keyed on `prepared_at` because every record one attempt writes —
// the URL-level outcome and each of its chunk children — shares that single timestamp.
export function latestAttempts(records) {
  const newest = new Map();
  for (const r of records) {
    const at = r.prepared_at ?? "";
    if (at > (newest.get(r.url) ?? "")) newest.set(r.url, at);
  }
  return records.filter((r) => (r.prepared_at ?? "") === newest.get(r.url));
}

// Never rejects: a non-zero exit is data, not an exception. Callers branch on
// `code` because "this PDF is broken" is an expected outcome at corpus scale.
export function exec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? (err ? 1 : 0), stdout: stdout ?? "", stderr: stderr ?? String(err ?? "") });
    });
  });
}

export async function hasCommand(cmd) {
  const { code } = await exec("sh", ["-c", `command -v ${cmd}`]);
  return code === 0;
}

// Bounded-concurrency map that preserves input order in its output. Workers pull
// from a shared cursor rather than being pre-partitioned, so one slow item does
// not idle a lane — which matters here, where item cost varies by 100x.
export async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await worker(items[i], i);
      }
    }),
  );
  return out;
}

// --flag value / --flag=value / --bool. Unknown flags are returned rather than
// rejected so each script can decide what it accepts.
export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (argv[i + 1] != null && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

export const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Percentile over an unsorted array of numbers. Used for the latency summary,
// where the mean is the least interesting number: the tail is what decides how
// long a 2000-document campaign actually takes.
export function pct(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
