import * as Cesium from 'cesium';

/**
 * The mission markers on the globe — big selectable arrows standing over the ground each contract
 * is fought on.
 *
 * This replaced a grid of cards, and the reason is the map itself: the campaign's progress is
 * already drawn on the globe (every theater you hold lights its obelisks), so putting the mission
 * list on the same surface means picking your next contract and reading how far you have got are
 * the same act of looking. A list can tell you 4/17; only the map can show you which quarter of the
 * country is lit.
 *
 * An arrow rather than a dot, because it has to survive being one of seventeen things on a sphere
 * viewed from 10,000 km: it points at its ground, it stands ABOVE the terrain so nothing occludes
 * the thing you are meant to click, and it reads at a glance as an interactive object rather than
 * as data. Held theaters keep their marker — they're replayable, and a marker that vanished on
 * completion would take the progress with it.
 */

export type MarkerState = 'open' | 'held' | 'locked';

export interface MissionMarker {
  /** Mission id — what {@link MissionMarkers.pick} hands back. */
  id: string;
  lon: number;
  lat: number;
  label: string;
  state: MarkerState;
}

/** Pixel size of the arrow at rest. Deliberately large: this is the primary control on the screen. */
const PIN_PX = 62;
/** How much the open markers breathe. Held and locked ones are static — only live options move. */
const PULSE = 0.12;
const PULSE_HZ = 0.55;

/**
 * Relative size per state.
 *
 * The three phases are all on the map at once and the domestic ones crowd — seventeen arrows over
 * one continent. Size is what sorts them: what you can take now is full weight, what you already
 * hold is a record and steps back, and what is still sealed is context. Colour alone did not do it
 * at the zoom the whole board is read from.
 */
const SIZE: Record<MarkerState, number> = { open: 1, held: 0.78, locked: 0.6 };

interface Look {
  fill: string;
  stroke: string;
  glow: string;
  text: Cesium.Color;
}

const LOOKS: Record<MarkerState, Look> = {
  // Brand red, bright edge: an available contract.
  open: { fill: 'rgba(226, 58, 46, 0.92)', stroke: '#F2EFEA', glow: 'rgba(226, 58, 46, 0.85)', text: Cesium.Color.fromCssColorString('#F2EFEA') },
  // The company green used everywhere else for "resolved". A held theater is done, not gone.
  held: { fill: 'rgba(79, 158, 122, 0.92)', stroke: '#CFE6DA', glow: 'rgba(79, 158, 122, 0.7)', text: Cesium.Color.fromCssColorString('#9FC9B4') },
  // Steel, no glow. Visible — you should be able to see the whole contract from mission one — but
  // obviously not a thing you can press yet.
  locked: { fill: 'rgba(58, 65, 74, 0.75)', stroke: '#6E7681', glow: 'rgba(0, 0, 0, 0)', text: Cesium.Color.fromCssColorString('#6E7681') },
};

/**
 * Draw one arrow to a canvas.
 *
 * Rendered at 2x and handed to Cesium as an image, rather than drawn as geometry: a billboard is one
 * quad, always faces the camera, and scales in PIXELS — so the marker is the same size on screen
 * whether the camera is at 700 km or 24,000 km, which is exactly what a control needs to be.
 */
function arrowCanvas(state: MarkerState, hot: boolean): HTMLCanvasElement {
  const S = 2;
  const w = 76 * S;
  const h = 104 * S;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const look = LOOKS[state];

  g.translate(w / 2, 0);
  g.scale(S, S);

  // Shaft, then head. One path so the outline runs round the silhouette rather than through the
  // join — the seam was visible at this size.
  g.beginPath();
  g.moveTo(-9, 6);
  g.lineTo(9, 6);
  g.lineTo(9, 56);
  g.lineTo(24, 56);
  g.lineTo(0, 96);
  g.lineTo(-24, 56);
  g.lineTo(-9, 56);
  g.closePath();

  if (look.glow !== 'rgba(0, 0, 0, 0)') {
    g.shadowColor = look.glow;
    g.shadowBlur = hot ? 26 : 14;
  }
  g.fillStyle = look.fill;
  g.fill();
  g.shadowBlur = 0;
  g.lineWidth = hot ? 3 : 2;
  g.strokeStyle = look.stroke;
  g.stroke();

  // A held marker carries a tick in the shaft — the state has to be readable without the colour,
  // for the same reason every other status in this game has a glyph as well as a hue.
  if (state === 'held') {
    g.beginPath();
    g.moveTo(-5, 30);
    g.lineTo(-1, 35);
    g.lineTo(6, 22);
    g.lineWidth = 3;
    g.strokeStyle = '#0E1013';
    g.stroke();
  }
  return c;
}

/**
 * Cache: three states x hot/cold is six images for seventeen markers.
 *
 * Data URLs rather than the canvases themselves. Cesium accepts either, but its billboard atlas
 * keys on the STRING — handing it canvases makes every assignment a fresh atlas entry, and the six
 * images would be re-uploaded on every hover swap.
 */
const IMAGES = new Map<string, string>();
function arrowImage(state: MarkerState, hot: boolean): string {
  const key = `${state}:${hot ? 1 : 0}`;
  let url = IMAGES.get(key);
  if (!url) IMAGES.set(key, (url = arrowCanvas(state, hot).toDataURL()));
  return url;
}

export class MissionMarkers {
  private readonly billboards: Cesium.BillboardCollection;
  private readonly labels: Cesium.LabelCollection;
  private readonly scene: Cesium.Scene;
  private data: MissionMarker[] = [];
  private clock = 0;
  private hot: string | null = null;

  constructor(scene: Cesium.Scene) {
    this.scene = scene;
    this.billboards = scene.primitives.add(new Cesium.BillboardCollection({ scene }));
    this.labels = scene.primitives.add(new Cesium.LabelCollection({ scene }));
  }

  /** Replace the whole set. Cheap at this count, and it keeps state changes trivially correct. */
  set(markers: MissionMarker[]): void {
    this.data = markers;
    this.billboards.removeAll();
    this.labels.removeAll();
    for (const m of markers) {
      const look = LOOKS[m.state];
      const pos = Cesium.Cartesian3.fromDegrees(m.lon, m.lat, 0);
      this.billboards.add({
        id: m.id,
        position: pos,
        image: arrowImage(m.state, false),
        // The tip of the arrow is the bottom of the image, so BOTTOM origin lands it on the site.
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        width: PIN_PX * 0.73 * SIZE[m.state],
        height: PIN_PX * SIZE[m.state],
        // Locked markers sit behind the live ones where they overlap.
        eyeOffset: new Cesium.Cartesian3(0, 0, m.state === 'locked' ? 0 : -1000),
      });
      this.labels.add({
        position: pos,
        text: m.label,
        font: '600 13px "IBM Plex Mono", ui-monospace, monospace',
        fillColor: look.text,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.9),
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        pixelOffset: new Cesium.Cartesian2(0, -PIN_PX * SIZE[m.state] - 6),
        // Sealed labels are the first thing to go when the view crowds: their arrows already say
        // "later", and the names are the only text on this screen that nobody needs to read yet.
        scale: m.state === 'locked' ? 0.82 : 1,
        // Labels are the noise in a crowded view — drop them before the arrows do.
        translucencyByDistance: new Cesium.NearFarScalar(1.0e6, 1.0, 3.0e7, 0.0),
      });
    }
  }

  /** Which mission is under this window point, or null. */
  pick(windowPos: Cesium.Cartesian2): string | null {
    const hit = this.scene.pick(windowPos) as { id?: unknown; primitive?: unknown } | undefined;
    if (!hit || typeof hit.id !== 'string') return null;
    return this.data.some((m) => m.id === hit.id) ? (hit.id as string) : null;
  }

  /**
   * Mark one marker as hovered. Swapping the image (rather than only scaling) is what makes the
   * hover survive at the small end of the zoom range, where a few percent of scale is invisible.
   */
  setHot(id: string | null): void {
    if (this.hot === id) return;
    this.hot = id;
    for (let i = 0; i < this.billboards.length; i++) {
      const b = this.billboards.get(i);
      const m = this.data.find((x) => x.id === b.id);
      if (m) b.image = arrowImage(m.state, m.id === id);
    }
  }

  /** Breathe the live markers. Called from the frame loop. */
  update(dt: number): void {
    this.clock += dt;
    const s = 1 + Math.sin(this.clock * PULSE_HZ * Math.PI * 2) * PULSE;
    for (let i = 0; i < this.billboards.length; i++) {
      const b = this.billboards.get(i);
      const m = this.data.find((x) => x.id === b.id);
      if (!m) continue;
      const k = SIZE[m.state] * (m.state === 'open' ? s : 1);
      b.width = PIN_PX * 0.73 * k;
      b.height = PIN_PX * k;
    }
  }

  set show(on: boolean) {
    this.billboards.show = on;
    this.labels.show = on;
  }

  destroy(): void {
    this.scene.primitives.remove(this.billboards);
    this.scene.primitives.remove(this.labels);
  }
}
