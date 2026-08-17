// Get a token for the deployment under test, via GitHub's device flow.
//
// Iris has no API keys and no anonymous mode: a GitHub token is required on every
// call, because the token is the identity that feedback from a session is filed
// under. The flow is three requests — begin, approve in a browser, poll — and doing
// it by hand with curl and jq is the fiddliest step in getting started, so it lives
// here instead.
//
// The token is printed and never written anywhere. Where it goes next is the
// operator's decision, and a credential this script silently dropped into a file
// would be one nobody remembered was there.

import { args, log, sleep } from "./util.mjs";

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

async function main() {
  const a = args();
  const base = (a.base ?? process.env.IRIS_BASE_URL ?? "https://iris.equalify.uic.edu/v1").replace(/\/$/, "");

  const begin = await post(`${base}/auth/github/device`);
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
    if (poll.status === 200 && poll.json?.access_token) {
      process.stderr.write("\n  Approved.\n\n");
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
