/**
 * Biometric capture plates — a face for every contact on the board.
 *
 * Drawn procedurally from the unit's own callsign, so a given contact always has the same face and
 * ~24,000 of them cost nothing but the ones actually looked at. Nothing here depicts a real person:
 * these are assembled from a handful of primitives, and they are deliberately rendered as a LOW-
 * FIDELITY SENSOR CAPTURE — duotone, scanlined, vignetted — rather than as a photograph.
 *
 * That styling is doing real work. The card is where an operator decides whether to flag or kill
 * somebody, and a face makes that decision land in a way a percentage never does. But the face has
 * to read as something the NETWORK produced — a plate pulled off a camera — not as a portrait of a
 * person who exists. The scanlines are the argument.
 */

/** Portrait plate size. Small on purpose: this is a capture, not a headshot. */
export const MUG_W = 76;
export const MUG_H = 94;

/** Deterministic PRNG (mulberry32), seeded from the callsign so a face never changes. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Skin tones, spread across a real range and pulled toward the console palette.
 *
 * A population looks like a population; rendering everyone one shade would be both a lie and a
 * worse image. The desaturation is what keeps them reading as sensor plates rather than portraits.
 */
const SKIN = [
  '#4e3a2c',
  '#6f5340',
  '#8a6a52',
  '#9a7355',
  '#a9835f',
  '#c09472',
  '#d3a882',
  '#e0b998',
];

const HAIR = ['#241d18', '#3b2d22', '#161311', '#5c4632', '#7d6a52', '#8d8d8d', '#2a2320'];

type G = CanvasRenderingContext2D;

/** A rough ellipse, jittered so no two heads are quite the same shape. */
function head(g: G, r: () => number, cx: number, cy: number, w: number, h: number) {
  g.beginPath();
  const steps = 22;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const jitter = 0.94 + r() * 0.12;
    const x = cx + Math.cos(a) * (w / 2) * jitter;
    // Jaw is narrower than the cranium: squash the lower half.
    const y = cy + Math.sin(a) * (h / 2) * (Math.sin(a) > 0 ? 1.06 : 0.94) * jitter;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  g.fill();
}

/**
 * Draw one capture plate. `id` is the unit's callsign — the whole seed.
 */
export function drawPortrait(id: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = MUG_W;
  c.height = MUG_H;
  const g = c.getContext('2d')!;
  const r = seededRandom(hash(id));

  // --- plate background: the sensor's own frame ---
  g.fillStyle = '#0d0f13';
  g.fillRect(0, 0, MUG_W, MUG_H);

  const skin = SKIN[Math.floor(r() * SKIN.length)];
  const hair = HAIR[Math.floor(r() * HAIR.length)];
  const cx = MUG_W / 2 + (r() - 0.5) * 3;
  const cy = MUG_H * 0.52;
  const hw = MUG_W * (0.52 + r() * 0.1);
  const hh = MUG_H * (0.58 + r() * 0.1);

  // --- neck and shoulders, so the head isn't floating ---
  g.fillStyle = '#1b1f26';
  g.fillRect(cx - hw * 0.55, cy + hh * 0.34, hw * 1.1, MUG_H);
  g.fillStyle = skin;
  g.fillRect(cx - hw * 0.17, cy + hh * 0.2, hw * 0.34, hh * 0.3);

  // --- head ---
  g.fillStyle = skin;
  head(g, r, cx, cy, hw, hh);

  // --- hair: one of four coarse treatments ---
  const style = Math.floor(r() * 4);
  g.fillStyle = hair;
  if (style === 0) {
    // cropped
    g.beginPath();
    g.ellipse(cx, cy - hh * 0.3, hw * 0.51, hh * 0.28, 0, Math.PI, 0);
    g.fill();
  } else if (style === 1) {
    // longer, falling past the jaw
    g.beginPath();
    g.ellipse(cx, cy - hh * 0.24, hw * 0.56, hh * 0.36, 0, Math.PI, 0);
    g.fill();
    g.fillRect(cx - hw * 0.56, cy - hh * 0.24, hw * 0.13, hh * 0.55);
    g.fillRect(cx + hw * 0.43, cy - hh * 0.24, hw * 0.13, hh * 0.55);
  } else if (style === 2) {
    // receding — a thin band only
    g.beginPath();
    g.ellipse(cx, cy - hh * 0.32, hw * 0.46, hh * 0.16, 0, Math.PI, 0);
    g.fill();
  }
  // style 3: bald, nothing drawn

  // --- brows, eyes, nose, mouth ---
  const eyeY = cy - hh * 0.06;
  const eyeDx = hw * 0.2;
  const eyeR = 1.5 + r() * 1.2;

  g.fillStyle = '#1a1512';
  const browH = 1.2 + r() * 1.6;
  const browTilt = (r() - 0.5) * 3;
  for (const s of [-1, 1]) {
    g.save();
    g.translate(cx + s * eyeDx, eyeY - hh * 0.1);
    g.rotate((s * browTilt * Math.PI) / 180);
    g.fillRect(-eyeDx * 0.55, -browH / 2, eyeDx * 1.1, browH);
    g.restore();
  }

  for (const s of [-1, 1]) {
    g.fillStyle = '#e9e6e0';
    g.beginPath();
    g.ellipse(cx + s * eyeDx, eyeY, eyeR * 1.7, eyeR, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#15100d';
    g.beginPath();
    g.arc(cx + s * eyeDx, eyeY, eyeR * 0.8, 0, Math.PI * 2);
    g.fill();
  }

  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(cx, eyeY + hh * 0.04);
  g.lineTo(cx + (r() - 0.5) * 3, eyeY + hh * 0.16);
  g.stroke();

  // Mouths run flat to slightly down. Nobody in this file is smiling.
  g.strokeStyle = 'rgba(30,18,14,0.75)';
  g.lineWidth = 1.4;
  const mw = hw * (0.16 + r() * 0.12);
  const my = cy + hh * 0.26;
  g.beginPath();
  g.moveTo(cx - mw, my);
  g.quadraticCurveTo(cx, my + (r() * 2.4 - 0.4), cx + mw, my);
  g.stroke();

  // --- accessories ---
  if (r() < 0.22) {
    // glasses
    g.strokeStyle = 'rgba(220,225,232,0.55)';
    g.lineWidth = 1;
    for (const s of [-1, 1]) {
      g.strokeRect(cx + s * eyeDx - eyeR * 2.2, eyeY - eyeR * 1.6, eyeR * 4.4, eyeR * 3.2);
    }
    g.beginPath();
    g.moveTo(cx - eyeDx + eyeR * 2.2, eyeY);
    g.lineTo(cx + eyeDx - eyeR * 2.2, eyeY);
    g.stroke();
  }
  if (r() < 0.24) {
    // stubble / beard along the jaw
    g.fillStyle = hair;
    g.globalAlpha = 0.5;
    g.beginPath();
    g.ellipse(cx, cy + hh * 0.26, hw * 0.34, hh * 0.2, 0, 0, Math.PI);
    g.fill();
    g.globalAlpha = 1;
  }

  // --- capture treatment: this is what makes it a plate and not a portrait ---
  // Scanlines.
  g.fillStyle = 'rgba(0,0,0,0.28)';
  for (let y = 0; y < MUG_H; y += 2) g.fillRect(0, y, MUG_W, 1);

  // Vignette.
  const vg = g.createRadialGradient(cx, cy, MUG_W * 0.2, cx, cy, MUG_W * 0.78);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(5,7,12,0.72)');
  g.fillStyle = vg;
  g.fillRect(0, 0, MUG_W, MUG_H);

  // A cold cast over everything, so the plate sits in the console's palette.
  g.fillStyle = 'rgba(90,120,150,0.10)';
  g.fillRect(0, 0, MUG_W, MUG_H);

  // Corner ticks — the frame the capture was cropped to.
  g.strokeStyle = 'rgba(226,58,46,0.75)';
  g.lineWidth = 1;
  const t = 7;
  for (const [x, y, dx, dy] of [
    [1, 1, 1, 1],
    [MUG_W - 1, 1, -1, 1],
    [1, MUG_H - 1, 1, -1],
    [MUG_W - 1, MUG_H - 1, -1, -1],
  ]) {
    g.beginPath();
    g.moveTo(x + dx * t, y);
    g.lineTo(x, y);
    g.lineTo(x, y + dy * t);
    g.stroke();
  }

  return c;
}

/**
 * Cached plates. Only the contacts actually inspected are ever drawn, and the cache is bounded so
 * a long session sweeping thousands of units doesn't accumulate thousands of canvases.
 */
const CACHE_MAX = 240;
const cache = new Map<string, HTMLCanvasElement>();

export function portraitFor(id: string): HTMLCanvasElement {
  const hit = cache.get(id);
  if (hit) {
    // Refresh recency so the cache evicts what hasn't been looked at.
    cache.delete(id);
    cache.set(id, hit);
    return hit;
  }
  const made = drawPortrait(id);
  cache.set(id, made);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return made;
}
