// A local axe re-lint of each delivered document.
//
// This exists because of a gap in what a session reports. Iris lints during the
// review loop and again after it, but only the DURING-loop results reach
// `log.jsonl` (as `lint` events). The FINAL post-review lint — the one that
// describes the document actually handed back — is written to the deployment's
// `run_signals` table and surfaces only in aggregate, through `GET /v1/quality`.
// There is no per-document endpoint for it. So the only way to say "this document
// came back with two duplicate ids" is to re-run axe on the delivered HTML here.
//
// The configuration below is a deliberate port of the deployment's
// `src/pipeline/lint.ts`, not an independent opinion about what to check. If it
// drifts, this harness stops measuring Iris and starts measuring a different
// linter — so the four decisions that make Iris's config unusual are reproduced
// exactly, and each is annotated with why Iris made it:
//
//   * The WCAG tag filter, verbatim.
//   * `color-contrast` off — the output is content-only with no styling, and
//     contrast cannot be assessed without rendering.
//   * `duplicate-id` and `duplicate-id-active` ON BY NAME. The tag filter excludes
//     them (WCAG 2.2 dropped 4.1.1, so axe tags them obsolete), but a duplicate id
//     is the specific defect that arises from assembling a document out of
//     independently extracted pages. Both halves are needed: axe splits duplicate
//     ids across three rules by what the element is, and each skips the others'
//     elements.
//   * `duplicate-id-aria`'s `incomplete` results promoted to violations — that rule
//     is `reviewOnFail`, so its findings never appear under `violations`, and it is
//     the one that catches the case with the clearest harm (two `<input id="q1">`
//     under one `<label for="q1">`).
//
// Version fidelity matters as much as configuration: which rule claims which
// element is an axe internal that a version bump can move. package.json pins
// axe-core and jsdom to the same versions the deployment resolves.

import { JSDOM, VirtualConsole } from "jsdom";
import axe from "axe-core";

export const AXE_VERSION = axe.version;

export async function runAxe(html) {
  let dom;
  try {
    const virtualConsole = new VirtualConsole();
    dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
  } catch (e) {
    return { ok: false, violations: [], error: `document failed to parse: ${e.message}` };
  }

  try {
    const { window } = dom;
    window.eval(axe.source);
    const results = await window.axe.run(window.document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: {
        "color-contrast": { enabled: false },
        "duplicate-id": { enabled: true },
        "duplicate-id-active": { enabled: true },
      },
    });
    const promoted = results.incomplete.filter((v) => v.id === "duplicate-id-aria");
    const violations = [...results.violations, ...promoted].map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      nodes: v.nodes.length,
    }));
    return { ok: violations.length === 0, violations };
  } catch (e) {
    // Iris degrades to a pass here rather than failing a run. The harness keeps the
    // same verdict but records the error, because at corpus scale "axe could not
    // run" and "the document is clean" must not be summarized as the same thing.
    return { ok: true, violations: [], error: `axe-core could not run in this environment: ${e.message}` };
  } finally {
    try {
      dom.window.close();
    } catch {
      // Deliberately empty, for the reason the deployment gives: close() recurses,
      // a deep document overflows the stack in here, and a throw from finally would
      // replace the result the try block already decided on.
    }
  }
}

// Structural counts, for the shape of what came back rather than its conformance.
// A document that lints clean because it is nearly empty is a failure mode axe
// cannot see, and "extraction quietly dropped half the pages" is exactly the kind
// of regression a 2000-document corpus is worth running to find.
export function shape(html) {
  const count = (re) => (html.match(re) ?? []).length;
  return {
    bytes: Buffer.byteLength(html),
    // Text length after tags, as a floor on how much content survived.
    text_chars: html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim().length,
    headings: count(/<h[1-6][\s>]/gi),
    h1: count(/<h1[\s>]/gi),
    tables: count(/<table[\s>]/gi),
    lists: count(/<[uo]l[\s>]/gi),
    images: count(/<img[\s>]/gi),
    // An <img> with no alt attribute at all is an axe violation; alt="" is a valid
    // decorative marker. Counted separately because a page of scanned figures
    // marked decorative is a judgement call worth seeing, not a rule failure.
    images_alt_empty: count(/<img[^>]*\salt=(""|'')/gi),
    links: count(/<a[\s>]/gi),
    // Iris namespaces each page's ids; a surviving fragment link that resolves
    // nowhere is a broken cross-reference the assembler did not catch.
    anchors: count(/href="#/gi),
    lang: /<html[^>]*\slang=/i.test(html),
    title: /<title>\s*\S/i.test(html),
  };
}
