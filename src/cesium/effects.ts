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
const SCAN_WIDTH = 1.2;
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
        dashLength: 12,
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
    const alpha = 0.42 + 0.34 * (0.5 + 0.5 * Math.sin((this.t / SCAN_PERIOD) * Math.PI * 2));
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
      const line = this.rings.add({ positions, width: 3, material, show: false });
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
      b.core.pixelSize = 34 * (1 - ct) + 4;
      b.core.color = BLAST_CORE.withAlpha(1 - ct);
    }
  }

  destroy(): void {
    this.rings.destroy();
    this.cores.destroy();
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
const SPARK_POOL = 96;
const SPARK_LIFE = 0.75;
const SPARK_G = -9.8;
/**
 * Initial speed range, m/s. Measured rather than guessed: at 9 m/s the shower spread about 5 m,
 * which is physically about right for a cutting torch and completely invisible from anywhere above
 * street level. This is scaled to be legible from a low orbit of the site instead — the distress
 * pulse is what carries the alarm at theater altitude, so these only have to survive the zoom the
 * operator actually flies down to.
 */
const SPARK_SPEED = 15;
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
          pixelSize: 2,
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
      s.point.pixelSize = 4 * (1 - k) + 1.2;
    }
  }

  destroy(): void {
    this.collection.destroy();
  }
}
