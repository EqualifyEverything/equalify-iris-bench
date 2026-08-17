// Parity between this repo's local re-lint and the deployment's own linter.
//
// `src/lint.mjs` is a port of equalify-iris `src/pipeline/lint.ts`, and a port that
// drifts stops measuring Iris. The check that matters is not "does axe run" — it is
// "does it reach the same verdict as the code Iris ships", including the four
// non-obvious decisions in that config: the WCAG tag filter, contrast disabled,
// `duplicate-id` and `duplicate-id-active` enabled by name against the tag filter,
// and `duplicate-id-aria`'s `incomplete` results promoted to violations.
//
// When equalify-iris is checked out alongside this repo, the test runs BOTH linters
// over the same fixtures and compares. When it is not, it falls back to asserting the
// specific rule ids that config is supposed to produce — which is the property that
// would break on drift, just without the second opinion. Point IRIS_REPO at the
// checkout to get the stronger version.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runAxe, shape } from "../src/lint.mjs";

const irisRepo = process.env.IRIS_REPO ?? join(process.cwd(), "..", "equalify-iris");
const irisLint = join(irisRepo, "src", "pipeline", "lint.ts");

// One document per interesting case. The duplicate-id family is split across three axe
// rules by what the element IS, and each rule deliberately skips the others' elements —
// so a single fixture with one kind of duplicate would pass while the config was wrong
// for the other two.
const FIXTURES = {
  "inert duplicate ids": `<!DOCTYPE html><html lang="en"><head><title>t</title></head><body>
    <h1>h</h1><ul><li id="x">a</li><li id="x">b</li></ul></body></html>`,
  "active duplicate ids": `<!DOCTYPE html><html lang="en"><head><title>t</title></head><body>
    <h1>h</h1><a id="d" href="#x">one</a><a id="d" href="#x">two</a></body></html>`,
  "referenced duplicate ids": `<!DOCTYPE html><html lang="en"><head><title>t</title></head><body>
    <h1>h</h1><label for="q">Name</label><input id="q"><input id="q"></body></html>`,
  "an image with no alt": `<!DOCTYPE html><html lang="en"><head><title>t</title></head><body>
    <h1>h</h1><img src="a.png"></body></html>`,
  "no lang attribute": `<!DOCTYPE html><html><head><title>t</title></head><body><h1>h</h1></body></html>`,
  "clean": `<!DOCTYPE html><html lang="en"><head><title>t</title></head><body>
    <h1>h</h1><p>text</p><img src="a.png" alt="a figure"></body></html>`,
  // Unstyled content-only output is what Iris produces, so contrast is out of scope and
  // disabled. This fixture would fail the rule if it were enabled.
  "low contrast, which is out of scope": `<!DOCTYPE html><html lang="en"><head><title>t</title></head>
    <body style="background:#fff"><h1 style="color:#eee">h</h1></body></html>`,
};

const ids = (r) => r.violations.map((v) => v.id).sort();

test("the ported config produces the rule ids the deployment's config is for", async () => {
  const got = {};
  for (const [name, html] of Object.entries(FIXTURES)) got[name] = ids(await runAxe(html));

  assert.deepEqual(got["inert duplicate ids"], ["duplicate-id"]);
  assert.deepEqual(got["active duplicate ids"], ["duplicate-id-active"]);
  // `reviewOnFail`, so axe reports it under `incomplete`; lint.mjs promotes it. Without
  // that promotion this comes back clean, which was the case with the clearest user
  // harm — two inputs under one label.
  assert.deepEqual(got["referenced duplicate ids"], ["duplicate-id-aria"]);
  assert.deepEqual(got["an image with no alt"], ["image-alt"]);
  assert.deepEqual(got["no lang attribute"], ["html-has-lang"]);
  assert.deepEqual(got["clean"], []);
  assert.deepEqual(got["low contrast, which is out of scope"], [], "color-contrast stays disabled");
});

test("both linters agree, when equalify-iris is checked out alongside", async (t) => {
  if (!existsSync(irisLint)) {
    t.skip(`no equalify-iris checkout at ${irisRepo} (set IRIS_REPO to compare against it)`);
    return;
  }
  // Requires a Node with TypeScript type stripping (24+), which is what Iris runs on.
  let deployment;
  try {
    deployment = await import(irisLint);
  } catch (e) {
    t.skip(`could not load the deployment's linter: ${e.message}`);
    return;
  }
  for (const [name, html] of Object.entries(FIXTURES)) {
    const mine = await runAxe(html);
    const theirs = await deployment.runAxe(html);
    assert.deepEqual(ids(mine), ids(theirs), `${name}: local re-lint matches the deployment`);
    assert.equal(mine.ok, theirs.ok, `${name}: same verdict`);
  }
});

test("shape() sees the failure axe cannot: a clean but empty document", () => {
  const empty = shape(`<!DOCTYPE html><html lang="en"><head><title>t</title></head><body></body></html>`);
  assert.equal(empty.headings, 0);
  assert.ok(empty.text_chars < 200);

  const real = shape(FIXTURES["clean"]);
  assert.equal(real.h1, 1);
  assert.equal(real.images, 1);
  assert.equal(real.images_alt_empty, 0, 'alt="a figure" is not a decorative marker');
  assert.equal(real.lang, true);
  assert.equal(real.title, true);
});
