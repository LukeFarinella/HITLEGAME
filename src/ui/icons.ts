/**
 * Line icons for everything the store and the tasking panel sell or set.
 *
 * Inline SVG rather than canvas or a font: they inherit `currentColor`, so one glyph reads orange
 * in the store, cyan on a fielded platform and green when complete without a second asset. All are
 * drawn on the same 24-unit grid with the same 1.5 stroke, so they sit together as a set.
 *
 * The platform glyphs deliberately echo the 24 px map markers in unitModels.ts — leg count is what
 * separates the walkers there and here, so a player learns one vocabulary, not two.
 */

const A = 'stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';

/** Radial legs, for the walker glyphs. */
function legs(n: number, r0: number, r1: number, phase: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    parts.push(`M${(12 + c * r0).toFixed(1)} ${(12 + s * r0).toFixed(1)}L${(12 + c * r1).toFixed(1)} ${(12 + s * r1).toFixed(1)}`);
  }
  return `<path ${A} d="${parts.join('')}"/>`;
}

const GLYPHS: Record<string, string> = {
  // ---- platforms (mirror the map markers) ----
  drone: `<circle ${A} cx="12" cy="12" r="8"/><circle ${A} cx="12" cy="12" r="3"/>`,
  // Four legs off an oblong body with the head cantilevered forward. The only platform glyph with
  // a front and a back, which is what separates it from the arachnid at a glance.
  dog:
    `<rect ${A} x="8.5" y="7" width="7" height="9.5" rx="1.2"/>` +
    `<circle ${A} cx="12" cy="4.6" r="2.3"/>` +
    `<path ${A} d="M9.5 7.5 7.4 10M14.5 7.5l2.1 2.5M9.5 16l-2.1 3.5M14.5 16l2.1 3.5"/>`,
  // Rotor rings on an X. Rings rather than legs is the whole distinction from the dog, which sits
  // at the same size and fills the same role.
  quad:
    `<rect ${A} x="9.8" y="9.8" width="4.4" height="4.4" rx="0.8"/>` +
    `<path ${A} d="M10 10 7.6 7.6M14 10l2.4-2.4M10 14l-2.4 2.4M14 14l2.4 2.4"/>` +
    `<circle ${A} cx="6.2" cy="6.2" r="3"/><circle ${A} cx="17.8" cy="6.2" r="3"/>` +
    `<circle ${A} cx="6.2" cy="17.8" r="3"/><circle ${A} cx="17.8" cy="17.8" r="3"/>`,
  spider: `${legs(6, 3.5, 9.5, Math.PI / 6)}<circle ${A} cx="12" cy="12" r="3.5"/>`,
  biped:
    `<rect ${A} x="7.5" y="3.5" width="9" height="9" rx="1"/>` +
    `<path ${A} d="M9.5 12.5 8 17l2.5 3.5M14.5 12.5 16 17l-2.5 3.5"/>`,
  // Hull from above with outriggers — a trimaran, seen the way the map marker draws it.
  naval:
    `<path ${A} d="M12 3.2 14.8 8.2v11.3H9.2V8.2Z"/>` +
    `<path ${A} d="M5.4 8.6v7.6M18.6 8.6v7.6M5.4 12.4h3.8M18.6 12.4h-3.8"/>`,
  // The planform, which is the entire identity of the wing.
  interceptor: `<path ${A} d="M12 3 20.5 19.5 12 15.2 3.5 19.5Z"/>`,
  walker: `${legs(4, 5, 10, Math.PI / 4)}<rect ${A} x="7" y="7" width="10" height="10" rx="1"/>`,

  // ---- gear ----
  laser: `<path ${A} d="M4 12h5m2.5-3.5L20 4M11.5 15.5 20 20"/><circle ${A} cx="11" cy="12" r="2.5"/>`,
  'sensor-pod':
    `<circle ${A} cx="12" cy="12" r="7"/><circle ${A} cx="12" cy="12" r="2"/>` +
    `<path ${A} d="M12 5v3M12 16v3M5 12h3M16 12h3"/>`,
  detainer:
    `<circle ${A} cx="7.5" cy="12" r="4"/><circle ${A} cx="16.5" cy="12" r="4"/><path ${A} d="M11.5 12h1"/>`,
  'deep-scan':
    `<path ${A} d="M12 19a7 7 0 0 1 0-14M12 16.5a4.5 4.5 0 0 1 0-9"/>` +
    `<circle ${A} cx="12" cy="12" r="1.5"/><path ${A} d="M16 5.5 20 3M16 18.5 20 21"/>`,

  // ---- network (obelisk infrastructure) ----
  // The obelisk itself: the tall pyramid the whole game is built around.
  'obelisk-uprate':
    `<path ${A} d="M12 3 16 20H8Z"/><path ${A} d="M4.5 9a6 6 0 0 0 0 7M19.5 9a6 6 0 0 1 0 7"/>`,
  'obelisk-laser': `<path ${A} d="M12 6 16 21H8Z"/><path ${A} d="M12 5V2M9 4 7 2M15 4l2-2"/>`,
  relay:
    `<rect ${A} x="9.5" y="9.5" width="5" height="5" rx="1"/>` +
    `<path ${A} d="M9.5 12H4M14.5 12H20M12 9.5V4M12 14.5V20"/>`,
  // Emergency powers: the barrier, with the bar broken out of it. This is the purchase that removes
  // the public-tolerance gate outright, so the glyph is a gate that no longer closes.
  'emergency-powers':
    `<path ${A} d="M4 6.5v13M20 6.5v13"/>` +
    `<path ${A} d="M4 11h5.5M14.5 11H20"/>` +
    `<path ${A} d="M12.6 7.2 9.8 12.4h3.4L10.9 17"/>`,
  // Marking automation: the tasking glyph it automates, under a loop.
  'auto-investigate':
    `<path ${A} d="M3.5 14.5S6.6 9.5 12 9.5s8.5 5 8.5 5-3.1 5-8.5 5-8.5-5-8.5-5Z"/>` +
    `<circle ${A} cx="12" cy="14.5" r="2.2"/>` +
    `<path ${A} d="M6.2 6.4a8 8 0 0 1 11.6 0"/><path ${A} d="M18.4 3.4v3.2h-3.2"/>`,
  'auto-execute':
    `<circle ${A} cx="12" cy="14.5" r="5.5"/>` +
    `<path ${A} d="M12 7.5v2.4M12 19.1v2.4M5.5 14.5h2.4M16.1 14.5h2.4"/>` +
    `<path ${A} d="M6.2 6.4a8 8 0 0 1 11.6 0"/><path ${A} d="M18.4 3.4v3.2h-3.2"/>`,

  // ---- territory ----
  state: `<path ${A} d="M12 21s6-5.5 6-10a6 6 0 1 0-12 0c0 4.5 6 10 6 10Z"/><circle ${A} cx="12" cy="11" r="2"/>`,
  block:
    `<rect ${A} x="3.5" y="3.5" width="7" height="7"/><rect ${A} x="13.5" y="3.5" width="7" height="7"/>` +
    `<rect ${A} x="3.5" y="13.5" width="7" height="7"/><rect ${A} x="13.5" y="13.5" width="7" height="7"/>`,
  foreign:
    `<circle ${A} cx="12" cy="12" r="8.5"/><path ${A} d="M3.5 12h17"/>` +
    `<path ${A} d="M12 3.5a13 13 0 0 1 0 17a13 13 0 0 1 0-17Z"/>`,

  // ---- taskings ----
  surveil: `<path ${A} d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle ${A} cx="12" cy="12" r="2.5"/>`,
  lethal:
    `<circle ${A} cx="12" cy="12" r="7.5"/><path ${A} d="M12 1.5v5M12 17.5v5M1.5 12h5M17.5 12h5"/>` +
    `<circle ${A} cx="12" cy="12" r="1"/>`,
};

/** Names already reported missing, so a per-frame re-render warns once rather than every time. */
const warned = new Set<string>();

/**
 * An icon as an inline SVG string.
 *
 * A name with no glyph returns EMPTY and complains in dev. It used to return empty and say nothing,
 * which is how four platforms and three network purchases shipped with a blank space where their
 * icon should be — every one of them added after the icon set and never noticed, because nothing
 * anywhere failed. Adding a platform without adding its glyph should be loud.
 */
export function icon(name: string): string {
  const g = GLYPHS[name];
  if (!g) {
    if (import.meta.env.DEV && !warned.has(name)) {
      warned.add(name);
      console.warn(`[GORGON] no icon glyph for "${name}" — add one to src/ui/icons.ts`);
    }
    return '';
  }
  return `<svg class="c2-glyph" viewBox="0 0 24 24" aria-hidden="true">${g}</svg>`;
}

/**
 * Every name this set can draw. Exported so a caller can assert its own catalog is covered.
 */
export function iconNames(): string[] {
  return Object.keys(GLYPHS);
}

export function hasIcon(name: string): boolean {
  return name in GLYPHS;
}
