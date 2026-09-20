// Gate C browser runner.
//
// The PRD requires current Chrome, Edge and Mozilla Firefox on OCC workstations
// (PRD §12.10). This resolver therefore prefers the REAL installed browsers via
// Playwright channels and falls back to the bundled engines when a channel is
// unavailable, recording which one was actually used in the evidence.
import { chromium, firefox, webkit } from 'playwright';

export const ALL_ENGINES = [
  { id: 'chrome', label: 'Chrome (installed, real)', type: chromium, channel: 'chrome', primary: true },
  { id: 'msedge', label: 'Edge (installed, real)', type: chromium, channel: 'msedge', primary: true },
  { id: 'firefox', label: 'Firefox (installed, real)', type: firefox, channel: 'firefox', primary: true },
  { id: 'firefox-bundled', label: 'Firefox (Playwright bundled)', type: firefox, bundled: true },
  { id: 'chromium', label: 'Chromium (Playwright bundled)', type: chromium, bundled: true },
  { id: 'webkit', label: 'WebKit (Playwright bundled, non-target)', type: webkit, bundled: true }
];

const byId = new Map(ALL_ENGINES.map((e) => [e.id, e]));

export function resolveEngines(spec) {
  if (!spec || spec === 'all') return ALL_ENGINES;
  const ids = String(spec).split(',').map((s) => s.trim()).filter(Boolean);
  return ids.map((id) => {
    // "firefox:channel" style override lets a caller force a specific launch mode.
    const [base, mode] = id.split(':');
    const engine = byId.get(base);
    if (!engine) throw new Error(`unknown engine "${id}" (known: ${[...byId.keys()].join(', ')})`);
    if (!mode) return engine;
    if (mode === 'bundled') return { ...engine, channel: undefined, bundled: true };
    return { ...engine, channel: mode, bundled: false };
  });
}

/**
 * Launch one engine and return { browser, info } with the resolved version.
 * Throws a labelled error so the matrix can record launch failure as evidence
 * rather than crashing the run.
 */
export async function launchEngine(engine) {
  const options = {};
  if (engine.channel) options.channel = engine.channel;
  const browser = await engine.type.launch(options);
  return {
    browser,
    info: {
      engine: engine.id,
      label: engine.label,
      channel: engine.channel || null,
      primary: !!engine.primary,
      version: browser.version(),
      headless: true
    }
  };
}
