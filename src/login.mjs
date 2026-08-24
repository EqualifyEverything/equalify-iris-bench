// Get a token for the deployment under test, via GitHub's device flow.
//
// Iris has no API keys and no anonymous mode: a GitHub token is required on every
// call, because the token is the identity that feedback from a session is filed
// under. The flow is three requests — begin, approve in a browser, poll — and doing
// it by hand with curl and jq is the fiddliest step in getting started, so it lives
// here instead.
//
// The token is printed and never written anywhere unless `--write-env` says so
// explicitly. Where it goes next is the operator's decision, and a credential this
// script silently dropped into a file would be one nobody remembered was there.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { args, log, sleep } from "./util.mjs";

// Transport failures come back as data, because this runs for up to fifteen minutes
// against a network that only has to hiccup once. A single connect timeout used to
// take the whole flow down with an uncaught rejection, which meant re-approving a
// fresh code for no reason.
async function post(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return { error: `${e.name}: ${e.cause?.code ?? e.message}` };
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

// Replace IRIS_TOKEN in place if it is already there, so an existing .env keeps its
// other settings and does not accumulate stale credentials.
function writeEnv(path, token) {
  const line = `IRIS_TOKEN=${token}`;
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const next = /^IRIS_TOKEN=.*$/m.test(existing)
    ? existing.replace(/^IRIS_TOKEN=.*$/m, line)
    : `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${line}\n`;
  writeFileSync(path, next, { mode: 0o600 });
}

async function main() {
  const a = args();
  const base = (a.base ?? process.env.IRIS_BASE_URL ?? "https://iris.equalify.uic.edu/v1").replace(/\/$/, "");

  let begin;
  for (let attempt = 1; attempt <= 3; attempt++) {
    begin = await post(`${base}/auth/github/device`);
    if (!begin.error) break;
    log(`starting the device flow failed (${begin.error}) — attempt ${attempt} of 3`);
    if (attempt < 3) await sleep(3000);
  }
  if (begin.error) {
    console.error(`POST ${base}/auth/github/device: ${begin.error}`);
    process.exit(1);
  }
  if (begin.status !== 200 || !begin.json?.device_code) {
    console.error(`POST ${base}/auth/github/device -> ${begin.status}: ${begin.text.slice(0, 300)}`);
    process.exit(1);
  }
  const { device_code, user_code, verification_uri, expires_in } = begin.json;

  // stderr, so `IRIS_TOKEN=$(node src/login.mjs)` works — the token is the only
  // thing on stdout.
  process.stderr.write(
    `\n  Open ${verification_uri}\n  and enter the code:  ${user_code}\n\n` +
      `  Waiting for approval (expires in ${Math.round((expires_in ?? 900) / 60)} min)...\n`,
  );

  // GitHub's own interval, honoured rather than guessed, and widened on `slow_down`
  // — polling too fast is what causes that error in the first place.
  let interval = (begin.json.interval ?? 5) * 1000;
  const deadline = Date.now() + (expires_in ?? 900) * 1000;
  for (;;) {
    await sleep(interval);
    if (Date.now() > deadline) {
      console.error("the device code expired before it was approved; run this again");
      process.exit(1);
    }
    const poll = await post(`${base}/auth/github/device/poll`, { device_code });
    // A failed poll is not a failed approval. Keep going until the code expires —
    // the operator is standing at a browser, and losing their approval to one dropped
    // packet means starting over for nothing.
    if (poll.error) {
      log(`poll failed (${poll.error}) — still waiting, the code is valid until it expires`);
      continue;
    }
    if (poll.status === 200 && poll.json?.access_token) {
      process.stderr.write("\n  Approved.\n\n");
      if (a["write-env"]) {
        const path = a["write-env"] === true ? ".env" : a["write-env"];
        writeEnv(path, poll.json.access_token);
        process.stderr.write(`  Wrote IRIS_TOKEN to ${path} (mode 600). Run with --env-file=${path}\n\n`);
        return;
      }
      // Say what to do with it, once, on stderr — then the token alone on stdout.
      process.stderr.write(`  Put this in .env as IRIS_TOKEN, then run with --env-file=.env\n\n`);
      process.stdout.write(`${poll.json.access_token}\n`);
      return;
    }
    if (poll.status === 202) {
      if (poll.json?.error === "slow_down") interval += 5000;
      continue;
    }
    console.error(`poll -> ${poll.status}: ${poll.text.slice(0, 300)}`);
    process.exit(1);
  }
}

await main();
