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
  spider: `${legs(6, 3.5, 9.5, Math.PI / 6)}<circle ${A} cx="12" cy="12" r="3.5"/>`,
  biped:
    `<rect ${A} x="7.5" y="3.5" width="9" height="9" rx="1"/>` +
    `<path ${A} d="M9.5 12.5 8 17l2.5 3.5M14.5 12.5 16 17l-2.5 3.5"/>`,
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

/** An icon as an inline SVG string, or empty if the name isn't in the set. */
export function icon(name: string): string {
  const g = GLYPHS[name];
  if (!g) return '';
  return `<svg class="c2-glyph" viewBox="0 0 24 24" aria-hidden="true">${g}</svg>`;
}

export function hasIcon(name: string): boolean {
  return name in GLYPHS;
}
