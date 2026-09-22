/**
 * Verify that the single-page UI's inline script only references elements that
 * actually exist, and that every `<label for>` points at a real control.
 *
 * Why this exists
 *   `public/index.html` is one hand-written file with no build step and no
 *   component layer, so a renamed id or a mistyped `getElementById` produces a
 *   `null` dereference at runtime and a dead panel, with nothing in the toolchain
 *   to catch it: the Worker bundles, `tsc` sees no TypeScript, and the asset is
 *   served verbatim. Watching for that class of mistake by hand does not scale, so
 *   the check is mechanical.
 *
 * Scope
 *   Static analysis only. It does not evaluate the script, so a reference built by
 *   string concatenation is reported as absent rather than resolved; the script
 *   currently uses literal ids throughout, which is what makes the check exact.
 *
 * Run with: node scripts/check-dom.mjs
 */

import { readFileSync } from 'node:fs';

const HTML_PATH = 'public/index.html';

const html = readFileSync(HTML_PATH, 'utf8');

/** The page has one script block; take the longest match defensively. */
const scriptBlocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].sort((a, b) => b[1].length - a[1].length);
if (!scriptBlocks.length) {
	console.error(`FAIL: no inline <script> block found in ${HTML_PATH}.`);
	process.exit(1);
}
const script = scriptBlocks[0][1];

const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
const referenced = new Set([...script.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map(match => match[1]));
const labelTargets = [...html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map(match => match[1]);

const missingElements = [...referenced].filter(id => !ids.has(id)).sort();
const missingLabelTargets = labelTargets.filter(id => !ids.has(id)).sort();

console.log(`${HTML_PATH}`);
console.log(`  ids in document        : ${ids.size}`);
console.log(`  getElementById targets : ${referenced.size}`);
console.log(`  label for targets      : ${labelTargets.length}`);

let failed = false;

if (missingElements.length) {
	console.error(`  FAIL missing elements  : ${missingElements.join(', ')}`);
	failed = true;
} else {
	console.log('  missing elements       : none');
}

if (missingLabelTargets.length) {
	console.error(`  FAIL missing labels    : ${missingLabelTargets.join(', ')}`);
	failed = true;
} else {
	console.log('  missing label targets  : none');
}

if (failed) {
	console.error('\nEvery referenced id must exist in the document.');
	process.exit(1);
}
console.log('\nAll DOM references resolve.');
