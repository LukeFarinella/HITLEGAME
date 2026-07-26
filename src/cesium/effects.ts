import * as Cesium from 'cesium';

/**
 * The visible half of every action the operator takes.
 *
 * Orders in this game are issued through menus and resolved in code, which means that without
 * something drawn between the machine and the person, the whole theater reads as a map where
 * contacts occasionally stop existing. These effects exist to close that gap: every one of them
 * connects a SOURCE to a CONSEQUENCE, so it is always legible which asset did a thing and to whom.
 *
 * Four vocabularies, deliberately distinct at a glance:
 *   SCAN    — thin cyan, dashed, breathing. Surveillance. Nobody is hurt by a scan line.
 *   BEAM    — hot red, solid, gone in half a second. See lasers.ts.
 *   BLAST   — an expanding ground ring at the weapon's true lethal radius, plus a core flash.
 *   SPARKS  — a spray of hot particles where an attacker is cutting into a site.
 *
 * All four are pooled. Effects arrive in bursts (a marked convoy rolling into an armed obelisk, a
 * strike detonating in a crowd), and allocating per event would churn Cesium Materials — which is
 * expensive, because every Polyline destroys its own material along with the collection.
 */

// --- scan lines ---------------------------------------------------------------------------------

/**
 * The sensor link between whatever is doing the watching and whoever is being watched.
 *
 * Drawn for as long as a contact is marked for investigation and something can actually see it, so
 * the line appearing is the order landing, and the line vanishing is the contact leaving coverage.
 * That second case matters: a scan line that drops out is the operator learning that their
 * investigation has gone dark, which no readout communicates half as fast.
 *
 * Capped rather than grown. Late in a campaign the operator may have hundreds of contacts flagged
 * at once, and past a few dozen lines the picture is noise — the cap keeps a busy theater legible
 * and the frame budget flat.
 */
const SCAN_POOL = 48;
const SCAN_COLOR = Cesium.Color.fromCssColorString('#5FD8E8');
/**
 * Polyline width is in PIXELS, so a scan line holds its thickness at every zoom — the problem was
 * never that it shrank, it was that it was drawn as a hairline against a whole city. Sized here to
 * be followable from the altitude the operator actually watches a theater from.
 */
const SCAN_WIDTH = 3.6;
/** Seconds for one breath of the scan pulse. */
const SCAN_PERIOD = 1.1;

export class ScanBeams {
  readonly collection = new Cesium.PolylineCollection();
  private lines: {
    line: Cesium.Polyline;
    positions: [Cesium.Cartesian3, Cesium.Cartesian3];
    material: Cesium.Material;
  }[] = [];
  private used = 0;
  private t = 0;

  constructor() {
    for (let i = 0; i < SCAN_POOL; i++) {
      const positions: [Cesium.Cartesian3, Cesium.Cartesian3] = [
        new Cesium.Cartesian3(),
        new Cesium.Cartesian3(),
      ];
      // Dashed, so a scan never reads as a weapon even at a glance. The dash is the whole
      // distinction between "you are being looked at" and "you are being shot".
      const material = Cesium.Material.fromType('PolylineDash', {
        color: SCAN_COLOR.withAlpha(0.7),
        dashLength: 22,
      });
      const line = this.collection.add({ positions, width: SCAN_WIDTH, material, show: false });
      this.lines.push({ line, positions, material });
    }
  }

  /** Start a frame's worth of links. */
  begin(): void {
    this.used = 0;
  }

  /** Draw one link. Ignored once the pool is full — see the cap note above. */
  add(from: Cesium.Cartesian3, to: Cesium.Cartesian3): void {
    if (this.used >= SCAN_POOL) return;
    const s = this.lines[this.used++];
    Cesium.Cartesian3.clone(from, s.positions[0]);
    Cesium.Cartesian3.clone(to, s.positions[1]);
    s.line.positions = s.positions; // reassign so Cesium re-uploads
    s.line.show = true;
  }

  /** Hide whatever wasn't claimed this frame, and breathe the ones that were. */
  end(dt: number): void {
    this.t += dt;
    // A slow sine rather than a flat line: a static beam reads as geometry, a breathing one reads
    // as a machine doing continuous work.
    const alpha = 0.62 + 0.34 * (0.5 + 0.5 * Math.sin((this.t / SCAN_PERIOD) * Math.PI * 2));
    for (let i = 0; i < this.used; i++) {
      (this.lines[i].material.uniforms as { color: Cesium.Color }).color =
        SCAN_COLOR.withAlpha(alpha);
    }
    for (let i = this.used; i < SCAN_POOL; i++) this.lines[i].line.show = false;
  }

  destroy(): void {
    this.collection.destroy();
  }
}

// --- screen-space rings ---------------------------------------------------------------------------

/**
 * A ring texture, drawn once and shared.
 *
 * Everything below that has to survive being zoomed out is a BILLBOARD sized in pixels rather than
 * geometry sized in metres. That is the whole trick, and it is the same one pulse.ts uses: a
 * 260 m shockwave is honest about what the weapon did and completely invisible from the altitude a
 * theater is actually watched from, which is exactly backwards — the moment you most need to see
 * that something went off is when you are looking at the whole map.
 *
 * So the world-space ring stays (it is the truth about the lethal radius, up close) and a
 * screen-space ring is drawn over it (it is the legibility, from everywhere else).
 */
function ringTexture(size: number, color: string, lineWidth: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d')!;
  g.translate(size / 2, size / 2);
  g.strokeStyle = color;
  g.lineWidth = lineWidth;
  g.beginPath();
  g.arc(0, 0, size / 2 - lineWidth, 0, Math.PI * 2);
  g.stroke();
  return c;
}

/** A soft filled disc, for flashes. */
function discTexture(size: number, inner: string, outer: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d')!;
  g.translate(size / 2, size / 2);
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, size / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.45, outer);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(0, 0, size / 2, 0, Math.PI * 2);
  g.fill();
  return c;
}

/**
 * Screen-space impact marks: one-shot rings and flashes that hold their size at any zoom.
 *
 * Used for every event that has to register from theater altitude — a contact being serviced, an
 * area strike going off, a site taking a hit. Pooled and recycled like everything else here.
 */
interface Mark {
  ring: Cesium.Billboard;
  flash: Cesium.Billboard;
  age: number;
  life: number;
  minPx: number;
  maxPx: number;
  live: boolean;
}

export class Impacts {
  readonly collection = new Cesium.BillboardCollection();
  private pool: Mark[] = [];
  private cursor = 0;

  constructor(size = 24) {
    const ring = ringTexture(128, '#FF6A3D', 11) as unknown as string;
    const flash = discTexture(128, 'rgba(255,238,200,0.95)', 'rgba(255,120,40,0.5)') as unknown as string;
    for (let i = 0; i < size; i++) {
      this.pool.push({
        ring: this.collection.add({
          position: Cesium.Cartesian3.ZERO,
          image: ring,
          width: 1,
          height: 1,
          show: false,
          disableDepthTestDistance: 1e12,
        }),
        flash: this.collection.add({
          position: Cesium.Cartesian3.ZERO,
          image: flash,
          width: 1,
          height: 1,
          show: false,
          disableDepthTestDistance: 1e12,
        }),
        age: 0,
        life: 0.6,
        minPx: 12,
        maxPx: 90,
        live: false,
      });
    }
  }

  /** Mark a point. `maxPx` is how big the ring gets on screen, whatever the camera is doing. */
  at(position: Cesium.Cartesian3, maxPx = 90, life = 0.6, minPx = 12): void {
    const m = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.pool.length;
    m.ring.position = position;
    m.flash.position = position;
    m.age = 0;
    m.life = life;
    m.minPx = minPx;
    m.maxPx = maxPx;
    m.live = true;
    m.ring.show = true;
    m.flash.show = true;
  }

  update(dt: number): void {
    for (const m of this.pool) {
      if (!m.live) continue;
      m.age += dt;
      if (m.age >= m.life) {
        m.live = false;
        m.ring.show = false;
        m.flash.show = false;
        continue;
      }
      const t = m.age / m.life;
      // Ring expands and fades outward; flash is bright immediately and gone first.
      const px = m.minPx + (m.maxPx - m.minPx) * (1 - Math.pow(1 - t, 2.4));
      m.ring.width = px;
      m.ring.height = px;
      m.ring.color = Cesium.Color.WHITE.withAlpha(1 - t);

      const ft = Math.min(1, t / 0.4);
      const fpx = m.maxPx * 0.55 * (1 - ft) + m.minPx * 0.5;
      m.flash.width = fpx;
      m.flash.height = fpx;
      m.flash.color = Cesium.Color.WHITE.withAlpha(1 - ft);
    }
  }

  destroy(): void {
    this.collection.destroy();
  }
}

// --- blasts -------------------------------------------------------------------------------------

/**
 * An area weapon going off.
 *
 * The ring is drawn at the weapon's ACTUAL lethal radius and expands to it over the effect's life,
 * which makes it the one honest readout of what a strike just did. The operator ordered an area
 * weapon into a street; the ring is the size of the area. Anyone inside the circle it stops at is
 * someone who is now dead, and several of them were probably not the target.
 */
const BLAST_POOL = 6;
const BLAST_LIFETIME = 0.9;
const BLAST_SEGMENTS = 64;
const BLAST_CORE = Cesium.Color.fromCssColorString('#FFD9A0');
const BLAST_RING = Cesium.Color.fromCssColorString('#FF7A2E');
/** Metres above terrain, so the ring doesn't z-fight the ground it sits on. */
const BLAST_LIFT_M = 12;

interface Blast {
  line: Cesium.Polyline;
  positions: Cesium.Cartesian3[];
  material: Cesium.Material;
  core: Cesium.PointPrimitive;
  lon: number;
  lat: number;
  height: number;
  radiusM: number;
  age: number;
  live: boolean;
}

export class Blasts {
  readonly rings = new Cesium.PolylineCollection();
  readonly cores = new Cesium.PointPrimitiveCollection();
  private pool: Blast[] = [];
  private cursor = 0;

  constructor() {
    for (let i = 0; i < BLAST_POOL; i++) {
      const positions: Cesium.Cartesian3[] = [];
      for (let k = 0; k <= BLAST_SEGMENTS; k++) positions.push(new Cesium.Cartesian3());
      const material = Cesium.Material.fromType('Color', { color: BLAST_RING.withAlpha(0) });
      const line = this.rings.add({ positions, width: 9, material, show: false });
      const core = this.cores.add({
        position: Cesium.Cartesian3.ZERO,
        color: BLAST_CORE.withAlpha(0),
        pixelSize: 1,
        show: false,
        disableDepthTestDistance: 1e12,
      });
      this.pool.push({
        line,
        positions,
        material,
        core,
        lon: 0,
        lat: 0,
        height: 0,
        radiusM: 1,
        age: 0,
        live: false,
      });
    }
  }

  /**
   * Detonate at a point. `radiusM` should be the weapon's real lethal radius — the ring is a
   * statement about what was killed, not decoration.
   */
  fire(lon: number, lat: number, height: number, radiusM: number): void {
    const b = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % BLAST_POOL;
    b.lon = lon;
    b.lat = lat;
    b.height = height;
    b.radiusM = radiusM;
    b.age = 0;
    b.live = true;
    b.line.show = true;
    b.core.show = true;
  }

  update(dt: number): void {
    for (const b of this.pool) {
      if (!b.live) continue;
      b.age += dt;
      if (b.age >= BLAST_LIFETIME) {
        b.live = false;
        b.line.show = false;
        b.core.show = false;
        continue;
      }
      const t = b.age / BLAST_LIFETIME;
      // Fast out of the gate, easing into its final radius: a shockwave decelerates, and a ring
      // travelling at constant speed reads as an animation rather than an explosion.
      const r = b.radiusM * (1 - Math.pow(1 - t, 2.2));
      const mLon = 111_320 * Math.cos((b.lat * Math.PI) / 180);
      for (let k = 0; k <= BLAST_SEGMENTS; k++) {
        const a = (k / BLAST_SEGMENTS) * Math.PI * 2;
        Cesium.Cartesian3.fromDegrees(
          b.lon + (Math.cos(a) * r) / mLon,
          b.lat + (Math.sin(a) * r) / 111_320,
          b.height + BLAST_LIFT_M,
          undefined,
          b.positions[k],
        );
      }
      b.line.positions = b.positions;
      (b.material.uniforms as { color: Cesium.Color }).color = BLAST_RING.withAlpha(1 - t);

      // The core is the flash at the centre: big and bright immediately, gone well before the ring.
      b.core.position = Cesium.Cartesian3.fromDegrees(b.lon, b.lat, b.height + BLAST_LIFT_M);
      const ct = Math.min(1, t / 0.35);
      b.core.pixelSize = 96 * (1 - ct) + 8;
      b.core.color = BLAST_CORE.withAlpha(1 - ct);
    }
  }

  destroy(): void {
    this.rings.destroy();
    this.cores.destroy();
  }
}

/**
 * Violation pings — a marker over every contact the net has just accused.
 *
 * Screen-space, like everything else that has to survive being zoomed out, and yellow because that
 * is already this game's colour for "the machine has noticed something" rather than "the company is
 * acting". Two rings per event: one on the contact and one on the installation that saw it, so the
 * operator can read WHO from WHERE without hunting.
 *
 * These are the primary call to action, so they pulse. Everything else in the effects layer fires
 * once and fades; a ping persists until it is answered or lapses, and a static marker in a field of
 * 24,000 moving units is genuinely hard to find.
 */
const PING_POOL = 16;
const PING_COLOR = Cesium.Color.fromCssColorString('#F2C13B');
/** Seconds per pulse. */
const PING_PERIOD = 1.4;

export class ViolationPings {
  readonly collection = new Cesium.BillboardCollection();
  private contact: Cesium.Billboard[] = [];
  private site: Cesium.Billboard[] = [];
  private used = 0;
  private t = 0;

  constructor() {
    const ring = ringTexture(128, '#F2C13B', 10) as unknown as string;
    const dot = discTexture(128, 'rgba(242,193,59,0.95)', 'rgba(242,193,59,0.35)') as unknown as string;
    for (let i = 0; i < PING_POOL; i++) {
      this.contact.push(
        this.collection.add({ position: Cesium.Cartesian3.ZERO, image: ring, width: 26, height: 26, show: false, disableDepthTestDistance: 1e12 }),
      );
      this.site.push(
        this.collection.add({ position: Cesium.Cartesian3.ZERO, image: dot, width: 14, height: 14, show: false, disableDepthTestDistance: 1e12 }),
      );
    }
  }

  begin(): void {
    this.used = 0;
  }

  /** Mark one accusation. `at` is the contact, `from` the installation that saw it. */
  add(at: Cesium.Cartesian3, from: Cesium.Cartesian3 | null): void {
    if (this.used >= PING_POOL) return;
    const i = this.used++;
    this.contact[i].position = at;
    this.contact[i].show = true;
    if (from) {
      this.site[i].position = from;
      this.site[i].show = true;
    } else {
      this.site[i].show = false;
    }
  }

  end(dt: number): void {
    this.t += dt;
    // Breathe between 22 and 40 px. Large enough to spot across a theater, small enough that six of
    // them at once doesn't wallpaper the screen.
    const k = 0.5 + 0.5 * Math.sin((this.t / PING_PERIOD) * Math.PI * 2);
    const px = 22 + k * 18;
    const alpha = 0.65 + k * 0.35;
    for (let i = 0; i < this.used; i++) {
      const c = this.contact[i];
      c.width = px;
      c.height = px;
      c.color = PING_COLOR.withAlpha(alpha);
      this.site[i].color = PING_COLOR.withAlpha(alpha * 0.8);
    }
    for (let i = this.used; i < PING_POOL; i++) {
      this.contact[i].show = false;
      this.site[i].show = false;
    }
  }

  destroy(): void {
    this.collection.destroy();
  }
}

// --- restraint projectile ---------------------------------------------------------------------

/**
 * The cuff round: what a detainment actually looks like.
 *
 * Custody was the one action in the game with no visual at all — an attacker simply stopped
 * existing and a line of text appeared. That made the most interesting choice the game offers (take
 * them alive instead of killing them) read as less consequential than the one that kills, which is
 * precisely backwards.
 *
 * So it fires something. A pair of rings joined by a bar, tumbling end over end across the gap, and
 * the attacker is taken when it lands. Sized in PIXELS like the rest of the impact layer, so a
 * detainment across a theater is as visible as an execution.
 */
const CUFF_POOL = 12;
/** Seconds of flight. Long enough to read as a throw rather than a teleport. */
const CUFF_FLIGHT = 0.45;
/** Turns over the whole flight. */
const CUFF_SPINS = 3.5;
const CUFF_PX = 46;
/** How high the round arcs above the straight line, as a fraction of the gap. */
const CUFF_ARC = 0.14;

/** Two rings and a bar. Drawn once and shared by the pool. */
function cuffTexture(size = 128): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d')!;
  g.translate(size / 2, size / 2);
  g.strokeStyle = '#DDE6EE';
  g.lineWidth = size * 0.075;
  g.lineCap = 'round';
  // Two cuffs, side by side.
  const r = size * 0.2;
  const off = size * 0.24;
  for (const s of [-1, 1]) {
    g.beginPath();
    g.arc(s * off, 0, r, 0, Math.PI * 2);
    g.stroke();
  }
  // The short chain between them.
  g.lineWidth = size * 0.055;
  g.beginPath();
  g.moveTo(-off + r * 0.75, 0);
  g.lineTo(off - r * 0.75, 0);
  g.stroke();
  // A cold highlight so it reads as metal rather than as a drawn outline.
  g.strokeStyle = 'rgba(120,190,225,0.75)';
  g.lineWidth = size * 0.03;
  for (const s of [-1, 1]) {
    g.beginPath();
    g.arc(s * off, 0, r, Math.PI * 1.05, Math.PI * 1.65);
    g.stroke();
  }
  return c;
}

interface Cuff {
  bill: Cesium.Billboard;
  from: Cesium.Cartesian3;
  to: Cesium.Cartesian3;
  /** Midpoint lifted above the chord, so the round travels an arc rather than a ruler line. */
  apex: Cesium.Cartesian3;
  age: number;
  live: boolean;
}

export class Cuffs {
  readonly collection = new Cesium.BillboardCollection();
  private pool: Cuff[] = [];
  private cursor = 0;
  private scratchA = new Cesium.Cartesian3();
  private scratchB = new Cesium.Cartesian3();
  /** Fired when a round lands, so the caller can put an impact mark there. */
  onLand?: (at: Cesium.Cartesian3) => void;

  constructor() {
    const image = cuffTexture() as unknown as string;
    for (let i = 0; i < CUFF_POOL; i++) {
      this.pool.push({
        bill: this.collection.add({
          position: Cesium.Cartesian3.ZERO,
          image,
          width: CUFF_PX,
          height: CUFF_PX,
          show: false,
          disableDepthTestDistance: 1e12,
        }),
        from: new Cesium.Cartesian3(),
        to: new Cesium.Cartesian3(),
        apex: new Cesium.Cartesian3(),
        age: 0,
        live: false,
      });
    }
  }

  /** Throw a round from one point to another. */
  fire(from: Cesium.Cartesian3, to: Cesium.Cartesian3): void {
    const c = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % CUFF_POOL;
    Cesium.Cartesian3.clone(from, c.from);
    Cesium.Cartesian3.clone(to, c.to);

    // Lift the midpoint along its own surface normal — "up" is outward from the globe, not +Z.
    const mid = Cesium.Cartesian3.midpoint(from, to, new Cesium.Cartesian3());
    const gap = Cesium.Cartesian3.distance(from, to);
    const up = Cesium.Cartesian3.normalize(mid, this.scratchA);
    Cesium.Cartesian3.add(
      mid,
      Cesium.Cartesian3.multiplyByScalar(up, gap * CUFF_ARC + 20, this.scratchB),
      c.apex,
    );

    c.age = 0;
    c.live = true;
    c.bill.show = true;
  }

  update(dt: number): void {
    for (const c of this.pool) {
      if (!c.live) continue;
      c.age += dt;
      if (c.age >= CUFF_FLIGHT) {
        c.live = false;
        c.bill.show = false;
        this.onLand?.(c.to);
        continue;
      }
      const t = c.age / CUFF_FLIGHT;
      // Quadratic Bezier through the lifted midpoint.
      const a = Cesium.Cartesian3.lerp(c.from, c.apex, t, this.scratchA);
      const b = Cesium.Cartesian3.lerp(c.apex, c.to, t, this.scratchB);
      c.bill.position = Cesium.Cartesian3.lerp(a, b, t, new Cesium.Cartesian3());
      // Tumbling end over end. Billboard rotation is screen-space, which is exactly what's wanted:
      // the spin should read the same whatever angle the camera is at.
      c.bill.rotation = -t * CUFF_SPINS * Math.PI * 2;
      // Fades in fast and holds; it is caught rather than dissipating.
      c.bill.color = Cesium.Color.WHITE.withAlpha(Math.min(1, t * 6));
    }
  }

  destroy(): void {
    this.collection.destroy();
  }
}

// --- sparks -------------------------------------------------------------------------------------

/**
 * Hot particles thrown off a point — an attacker cutting into an obelisk.
 *
 * A site under attack already has a distress pulse over it (see pulse.ts), but the pulse is a
 * screen-space alarm that says WHERE. The sparks say WHAT, and they say it at ground level, at the
 * exact spot the attacker is standing. Somebody with a torch is taking apart a piece of hardware,
 * and that should look like work being done rather than a state flag being set.
 *
 * Ballistic, in the local horizon frame: thrown up and out, pulled back down. Cheap enough to run
 * continuously for the whole 30-second assault.
 */
const SPARK_POOL = 220;
const SPARK_LIFE = 1.05;
const SPARK_G = -9.8;
/**
 * Initial speed range, m/s. Measured rather than guessed: at 9 m/s the shower spread about 5 m,
 * which is physically about right for a cutting torch and completely invisible from anywhere above
 * street level. This is scaled to be legible from a low orbit of the site instead — the distress
 * pulse is what carries the alarm at theater altitude, so these only have to survive the zoom the
 * operator actually flies down to.
 */
const SPARK_SPEED = 46;
const SPARK_HOT = Cesium.Color.fromCssColorString('#FFE9B0');
const SPARK_COOL = Cesium.Color.fromCssColorString('#E2541E');

interface Spark {
  point: Cesium.PointPrimitive;
  /** Launch velocity in the local east/north/up frame, m/s. */
  vx: number;
  vy: number;
  vz: number;
  origin: Cesium.Cartesian3;
  frame: Cesium.Matrix4;
  age: number;
  live: boolean;
}

export class Sparks {
  readonly collection = new Cesium.PointPrimitiveCollection();
  private pool: Spark[] = [];
  private cursor = 0;
  private scratch = new Cesium.Cartesian3();

  constructor() {
    for (let i = 0; i < SPARK_POOL; i++) {
      this.pool.push({
        point: this.collection.add({
          position: Cesium.Cartesian3.ZERO,
          color: SPARK_HOT,
          pixelSize: 6,
          show: false,
          // Has to read through the obelisk it's being struck off, and from theater altitude.
          disableDepthTestDistance: 1e12,
        }),
        vx: 0,
        vy: 0,
        vz: 0,
        origin: new Cesium.Cartesian3(),
        frame: new Cesium.Matrix4(),
        age: 0,
        live: false,
      });
    }
  }

  /** Throw `n` sparks off a world position. Call repeatedly for a sustained shower. */
  emit(at: Cesium.Cartesian3, n = 3): void {
    const frame = Cesium.Transforms.eastNorthUpToFixedFrame(at);
    for (let i = 0; i < n; i++) {
      const s = this.pool[this.cursor];
      this.cursor = (this.cursor + 1) % SPARK_POOL;
      const a = Math.random() * Math.PI * 2;
      // Biased upward and outward, the way grinding sparks actually leave a cut.
      const speed = SPARK_SPEED * (0.4 + Math.random() * 0.6);
      const up = 0.45 + Math.random() * 0.55;
      const flat = Math.sqrt(Math.max(0, 1 - up * up));
      s.vx = Math.cos(a) * flat * speed;
      s.vy = Math.sin(a) * flat * speed;
      s.vz = up * speed;
      Cesium.Cartesian3.clone(at, s.origin);
      Cesium.Matrix4.clone(frame, s.frame);
      s.age = 0;
      s.live = true;
      s.point.show = true;
    }
  }

  update(dt: number): void {
    for (const s of this.pool) {
      if (!s.live) continue;
      s.age += dt;
      if (s.age >= SPARK_LIFE) {
        s.live = false;
        s.point.show = false;
        continue;
      }
      const t = s.age;
      // Ballistic in the local horizon frame, then lifted into world space by the ENU matrix.
      this.scratch.x = s.vx * t;
      this.scratch.y = s.vy * t;
      this.scratch.z = s.vz * t + 0.5 * SPARK_G * t * t;
      const offset = Cesium.Matrix4.multiplyByPointAsVector(s.frame, this.scratch, this.scratch);
      s.point.position = Cesium.Cartesian3.add(s.origin, offset, new Cesium.Cartesian3());

      // Cool from white-hot to ember as it falls, and shrink — a spark burns out, it doesn't fade.
      const k = t / SPARK_LIFE;
      s.point.color = Cesium.Color.lerp(SPARK_HOT, SPARK_COOL, k, new Cesium.Color()).withAlpha(
        1 - k * k,
      );
      s.point.pixelSize = 9 * (1 - k) + 2.5;
    }
  }

  destroy(): void {
    this.collection.destroy();
  }
}

// ---- rounds in flight ---------------------------------------------------------------------------

/** Player ordnance, and Millstone's — the same two flags the beams use. */
const ROUND_FRIENDLY = Cesium.Color.fromCssColorString('#FFC24A');
const ROUND_HOSTILE = Cesium.Color.fromCssColorString('#7FE3A6');
/** Sized so a shell is visible crossing a theater without becoming a balloon up close. */
const ROUND_PX = 7;
/**
 * Ceiling on rounds drawn at once. Well above what a wave of artillery puts in the air; anything
 * past it is dropped for the frame, which is invisible in practice and bounds the primitive count.
 */
const ROUND_POOL = 192;

/**
 * Rounds in the air.
 *
 * Unlike every other effect here, these are not FIRED at this layer — the combat sim owns them,
 * because their arrival deals damage and damage cannot live in the renderer. This just draws the
 * list the sim hands it each frame, which is why it has a `show` rather than a `fire`: there is no
 * per-round state on this side at all, and a round that vanishes from the list has landed.
 */
export class Rounds {
  readonly collection = new Cesium.PointPrimitiveCollection();
  private pool: Cesium.PointPrimitive[] = [];

  constructor() {
    for (let i = 0; i < ROUND_POOL; i++) {
      this.pool.push(
        this.collection.add({
          position: Cesium.Cartesian3.ZERO,
          color: ROUND_FRIENDLY,
          pixelSize: ROUND_PX,
          show: false,
          // Reads through terrain, like the sparks — a shell arcing behind a ridge is still the
          // clearest signal available that artillery is firing at you.
          disableDepthTestDistance: 1e12,
        }),
      );
    }
  }

  /** Draw exactly this list of rounds and hide the rest of the pool. Call once per frame. */
  show(rounds: { lon: number; lat: number; alt: number; side: 0 | 1 }[]): void {
    const n = Math.min(rounds.length, ROUND_POOL);
    for (let i = 0; i < n; i++) {
      const r = rounds[i];
      const p = this.pool[i];
      p.position = Cesium.Cartesian3.fromDegrees(r.lon, r.lat, r.alt);
      p.color = r.side === 1 ? ROUND_HOSTILE : ROUND_FRIENDLY;
      p.show = true;
    }
    for (let i = n; i < ROUND_POOL; i++) {
      if (this.pool[i].show) this.pool[i].show = false;
      else break; // the tail past the first hidden slot is already hidden
    }
  }

  destroy(): void {
    this.collection.destroy();
  }
}
