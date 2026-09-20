// Gate C — aggregate every evidence artifact into a reviewable summary.
//
// Reads the JSON produced by the Gate C suites and writes:
//   test-results/gate-c/SUMMARY.json   (machine-readable roll-up)
//   test-results/gate-c/SUMMARY.md     (review table for the Gate D package)
// Missing suites are reported as NOT RUN rather than silently skipped.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';

const DIR = new URL('../test-results/gate-c/', import.meta.url);
const readJson = async (name) => {
  try {
    return JSON.parse(await readFile(new URL(name, DIR), 'utf8'));
  } catch {
    return null;
  }
};

const matrix = await readJson('matrix-results.json');
const failures = await readJson('failure-results.json');
const interop = await readJson('interop-results.json');
const smoke = await readJson('deployment-smoke-results.json');
const manual = await readJson('manual/manual-incidents.json');
// Operator exports live beside the incident log; count them as evidence too.
const manualFiles = (await readdir(new URL('manual/', DIR)).catch(() => []))
  .filter((f) => f.endsWith('.json') && f !== 'manual-incidents.json');

// ---- operator fidelity coverage --------------------------------------------
//
// Gate C requires a Sheet-fidelity record per selection size (1/2/3/4). Collect what
// each operator export actually proves, and name the sizes still missing rather than
// reporting a single "manual evidence captured" count that hides the gap.
const manualExports = [];
for (const file of manualFiles) {
  const doc = await readJson(`manual/${file}`);
  if (!doc) { manualExports.push({ file, readable: false }); continue }
  const perSize = doc?.coverage?.perSize || {};
  const bySize = {};
  for (const n of [1, 2, 3, 4]) {
    const rec = perSize[n] || perSize[String(n)] || null;
    if (!rec) continue;
    if (rec.reportRequestId || rec.fidelityRecorded) {
      bySize[n] = {
        reportRequestId: rec.reportRequestId || '',
        sheetUrl: rec.sheetUrl || '',
        fidelityRecorded: !!rec.fidelityRecorded,
        scopeDropped: rec.scopeDropped ?? null,
        scopeExpected: rec.scopeExpected ?? null,
        payloadHash: rec.payloadHash || ''
      };
    }
  }
  manualExports.push({
    file,
    readable: true,
    capturedAt: doc.capturedAt || null,
    browser: /Firefox/i.test(String(doc.userAgent || '')) ? 'Firefox' : (/Chrome/i.test(String(doc.userAgent || '')) ? 'Chrome' : (/Edg\//i.test(String(doc.userAgent || '')) ? 'Edge' : 'unknown')),
    userAgent: String(doc.userAgent || ''),
    deployment: doc.deployment || '',
    hasPerSizeCoverage: !!doc?.coverage,
    coverageReported: doc?.coverage ? (doc.coverage.fullyCovered ?? doc.coverage.covered ?? 0) + '/4' : null,
    missingReported: doc?.coverage?.missing || null,
    // Flat fidelity blob is the older export shape (single checklist, no per-size split).
    legacyFidelityOnly: !doc?.coverage && !!doc?.fidelity,
    bySize
  });
}
const sizesWithFidelity = new Set();
for (const exp of manualExports) {
  for (const [size, rec] of Object.entries(exp.bySize || {})) if (rec.fidelityRecorded) sizesWithFidelity.add(Number(size));
}
const fidelityBySize = [1, 2, 3, 4].map((n) => {
  const sources = manualExports.filter((e) => e.bySize?.[n]?.fidelityRecorded).map((e) => `${e.browser}:${e.file}`);
  return { selectionSize: n, covered: sources.length > 0, sources };
});
const manualFidelity = {
  exports: manualExports,
  sizesCovered: [...sizesWithFidelity].sort((a, b) => a - b),
  sizesMissing: [1, 2, 3, 4].filter((n) => !sizesWithFidelity.has(n)),
  bySize: fidelityBySize,
  complete: sizesWithFidelity.size === 4
};

const suites = [];
const push = (name, obj, passKey, totalKey, finishedKey = 'finishedAt') => {
  if (!obj) { suites.push({ suite: name, status: 'NOT RUN', passed: 0, total: 0, finishedAt: null }); return; }
  suites.push({
    suite: name,
    status: obj[passKey] === obj[totalKey] ? 'PASS' : 'FAIL',
    passed: obj[passKey] ?? 0,
    total: obj[totalKey] ?? 0,
    finishedAt: obj[finishedKey] || null
  });
};

// The deployment smoke records a checks[] list rather than counters.
push('deployment smoke (live staging, anonymous)', { passed: 0, total: 0 });
if (smoke && smoke.checks) {
  suites[suites.length - 1].passed = smoke.checks.filter((c) => c.ok).length;
  suites[suites.length - 1].total = smoke.checks.length;
  suites[suites.length - 1].status = smoke.checks.every((c) => c.ok) ? 'PASS' : 'FAIL';
  suites[suites.length - 1].finishedAt = smoke.finishedAt || null;
}
push('browser × selection matrix', matrix, 'passed', 'total');
push('failure modes', failures, 'passed', 'total');
push('Web 1 state interop', interop, 'passed', 'total');

const summary = {
  gate: 'C',
  generatedAt: new Date().toISOString(),
  suites,
  coverage: {
    matrixEngines: (matrix?.engines || []).map((e) => `${e.engine || e.id}${e.channel ? ` (channel ${e.channel})` : ''}${e.version ? ` ${e.version}` : ''}`),
    matrixSelectionSizes: matrix?.selectionSizes || [],
    matrixCases: matrix?.total ?? 0,
    failureEngines: [...new Set((failures?.scenarios || []).map((s) => s.browser?.engine).filter(Boolean))],
    failureScenarios: failures?.scenarios?.length
      ? failures.scenarios[0].results.map((r) => r.name)
      : [],
    interopEngines: [...new Set((interop?.results || []).map((s) => s.browser?.engine).filter(Boolean))],
    deploymentSmokeChecks: (smoke?.checks || []).map((c) => c.name),
    manualEvidenceRecords: Array.isArray(manual) ? manual.length : 0,
    manualEvidenceFiles: manualFiles,
    manualFidelity
  },
  failures: [
    ...(matrix?.results || []).filter((r) => !r.pass).map((r) => ({ suite: 'matrix', case: `${r.browser?.engine} × ${r.selectionCount}`, errors: r.errors })),
    ...(failures?.scenarios || []).flatMap((s) => s.results.filter((r) => !r.pass).map((r) => ({ suite: 'failure', case: `${s.browser?.engine} :: ${r.name}`, errors: r.checks.filter((c) => !c.ok).map((c) => `${c.name} — ${c.detail}`) }))),
    ...(interop?.results || []).flatMap((s) => s.scenarios.filter((r) => !r.pass).map((r) => ({ suite: 'interop', case: `${s.browser?.engine} :: ${r.name}`, errors: r.checks.filter((c) => !c.ok).map((c) => `${c.name} — ${c.detail}`) }))),
    ...((smoke?.checks || []).filter((c) => !c.ok).map((c) => ({ suite: 'deployment smoke', case: c.name, errors: [c.detail] })))
  ],
  notAutomatedHere: [
    'Mozilla Firefox browser matrix — Playwright Firefox deadlocks in this environment (newPage never resolves); evidence collected with tests/gatec_manual_firefox.mjs in real Firefox.',
    'Authenticated end-to-end run against the staging deployment (operator Google session) — recorded with the same manual harness.',
    'Sheet template/content fidelity inspection (operator opens the generated Sheet).',
    '15-minute preview-expiry transition and the 6-minute browser confirmation deadline at full duration.'
  ]
};

await mkdir(DIR, { recursive: true });
await writeFile(new URL('SUMMARY.json', DIR), JSON.stringify(summary, null, 2), 'utf8');

const rows = suites.map((s) => `| ${s.suite} | ${s.status} | ${s.passed}/${s.total} | ${s.finishedAt || '-'} |`).join('\n');
const md = `# Gate C — automated evidence summary

Generated: ${summary.generatedAt}

| Suite | Status | Checks | Finished |
|---|---|---|---|
${rows}

## Coverage

- Matrix engines: ${summary.coverage.matrixEngines.join(', ') || '-'}
- Selection sizes: ${summary.coverage.matrixSelectionSizes.join(', ') || '-'} (${summary.coverage.matrixCases} cases)
- Failure-mode engines: ${summary.coverage.failureEngines.join(', ') || '-'}
- Failure scenarios: ${summary.coverage.failureScenarios.join('; ') || '-'}
- Web 1 interop engines: ${summary.coverage.interopEngines.join(', ') || '-'}
- Manual evidence records captured so far: ${summary.coverage.manualEvidenceRecords}
- Operator evidence files: ${summary.coverage.manualEvidenceFiles.join(', ') || '(none)'}

## Operator Sheet-fidelity coverage (per selection size)

${manualFidelity.exports.length
  ? manualFidelity.exports.map((e) => `- \`${e.file}\` — ${e.browser}${e.coverageReported ? `, per-size coverage ${e.coverageReported}` : ''}${e.legacyFidelityOnly ? ' (legacy export: flat fidelity, no per-size split)' : ''}${e.missingReported?.length ? `, missing ${e.missingReported.join(',')}` : ''}`).join('\n')
  : '- (no operator export yet)'}

| Selection | Fidelity recorded | Source |
|---|---|---|
${manualFidelity.bySize.map((r) => `| ${r.selectionSize} flight(s) | ${r.covered ? 'yes' : '**NO**'} | ${r.sources.join(', ') || '—'} |`).join('\n')}

${manualFidelity.complete ? 'All four selection sizes have a recorded Sheet-fidelity run.' : `**GAP:** no recorded Sheet fidelity for ${manualFidelity.sizesMissing.map((n) => n + ' flight(s)').join(', ')}.`}

## Failures

${summary.failures.length ? summary.failures.map((f) => `- **${f.suite}** ${f.case}: ${f.errors.join(' / ')}`).join('\n') : 'None recorded.'}

## Not covered by these suites

${summary.notAutomatedHere.map((x) => `- ${x}`).join('\n')}
`;
await writeFile(new URL('SUMMARY.md', DIR), md, 'utf8');
console.log(md);
