import type { ModelMesh } from './instancedModels';

/**
 * Procedural low-poly unit models. No art assets exist, and these need to read as silhouettes at
 * theater scale, not be photoreal — so they're built from a handful of boxes/wedges with flat
 * normals. Convention: x = right, y = forward (nose/bow), z = up, metres. Sizes are deliberately
 * much larger than life (a real car is sub-pixel at 300 m/px); per-instance scale tunes further.
 */

type V = [number, number, number];

/** Accumulates flat-shaded triangles into growable arrays, then freezes to a ModelMesh. */
class MeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private idx: number[] = [];

  /** A quad (a,b,c,d CCW) with one flat normal. */
  quad(a: V, b: V, c: V, d: V): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const base = this.pos.length / 3;
    for (const p of [a, b, c, d]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(nx, ny, nz);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Axis-aligned box centred at (cx,cy,cz) with full sizes (sx,sy,sz). */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): void {
    const x0 = cx - sx / 2, x1 = cx + sx / 2;
    const y0 = cy - sy / 2, y1 = cy + sy / 2;
    const z0 = cz - sz / 2, z1 = cz + sz / 2;
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // top
    this.quad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]); // bottom
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // front (-y)
    this.quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]); // back (+y)
    this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]); // right (+x)
    this.quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]); // left (-x)
  }

  /**
   * A square-section beam between two arbitrary points — the primitive every leg is made of.
   *
   * Legs bend, so an axis-aligned box can't express them. This builds a 4-sided prism along a->b
   * with a basis derived from the direction, which is enough for flat-shaded limbs read at theater
   * scale. `r0`/`r1` let a limb taper toward the foot.
   */
  strut(a: V, b: V, r0: number, r1 = r0): void {
    let dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;
    // Any vector not parallel to the limb works as a seed for the perpendicular basis.
    const seed: V = Math.abs(dz) > 0.9 ? [1, 0, 0] : [0, 0, 1];
    let ux = dy * seed[2] - dz * seed[1];
    let uy = dz * seed[0] - dx * seed[2];
    let uz = dx * seed[1] - dy * seed[0];
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;

    const ring = (p: V, r: number): V[] => [
      [p[0] + (ux + vx) * r, p[1] + (uy + vy) * r, p[2] + (uz + vz) * r],
      [p[0] + (-ux + vx) * r, p[1] + (-uy + vy) * r, p[2] + (-uz + vz) * r],
      [p[0] + (-ux - vx) * r, p[1] + (-uy - vy) * r, p[2] + (-uz - vz) * r],
      [p[0] + (ux - vx) * r, p[1] + (uy - vy) * r, p[2] + (uz - vz) * r],
    ];
    const A = ring(a, r0);
    const B = ring(b, r1);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.quad(A[i], A[j], B[j], B[i]);
    }
    this.quad(A[3], A[2], A[1], A[0]); // cap at a
    this.quad(B[0], B[1], B[2], B[3]); // cap at b
  }

  /** Triangle with a flat normal. */
  tri(a: V, b: V, c: V): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const base = this.pos.length / 3;
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(nx, ny, nz);
    }
    this.idx.push(base, base + 1, base + 2);
  }

  build(): ModelMesh {
    return {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nrm),
      indices: new Uint16Array(this.idx),
    };
  }
}

/** Ground vehicle: a hull with a raised cab, nose toward +y. ~28 m long. */
function vehicleMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, 0, 4, 12, 26, 8); // body
  m.box(0, 3, 10, 10, 12, 5); // cab, set back
  return m.build();
}

/** Sea vessel: a hull that tapers to a bow at +y, with a small superstructure. ~48 m. */
function shipMesh(): ModelMesh {
  const m = new MeshBuilder();
  const w = 8, hz0 = 0, hz1 = 7, yBack = -22, yMid = 14;
  // hull sides back->mid
  m.quad([w, yBack, hz0], [w, yMid, hz0], [w, yMid, hz1], [w, yBack, hz1]);
  m.quad([-w, yMid, hz0], [-w, yBack, hz0], [-w, yBack, hz1], [-w, yMid, hz1]);
  // deck + bottom back->mid
  m.quad([-w, yBack, hz1], [w, yBack, hz1], [w, yMid, hz1], [-w, yMid, hz1]);
  m.quad([w, yBack, hz0], [-w, yBack, hz0], [-w, yMid, hz0], [w, yMid, hz0]);
  m.quad([w, yBack, hz0], [w, yBack, hz1], [-w, yBack, hz1], [-w, yBack, hz0]); // stern
  // bow: taper mid -> point at +y
  const bow: V = [0, 26, (hz0 + hz1) / 2];
  m.tri([w, yMid, hz1], [bow[0], bow[1], bow[2]], [w, yMid, hz0]);
  m.tri([-w, yMid, hz0], [bow[0], bow[1], bow[2]], [-w, yMid, hz1]);
  m.tri([w, yMid, hz1], [-w, yMid, hz1], [bow[0], bow[1], bow[2]]); // deck triangle
  m.tri([-w, yMid, hz0], [w, yMid, hz0], [bow[0], bow[1], bow[2]]); // bottom triangle
  m.box(0, -6, hz1 + 3, 9, 12, 6); // superstructure
  return m.build();
}

/** Aircraft: swept delta wing + fuselage, nose toward +y. ~30 m span. */
function aircraftMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, 0, 0, 4, 26, 4); // fuselage
  // delta wing: nose-ish to swept trailing tips
  m.tri([0, 12, 0], [16, -10, 0], [0, -6, 0]);
  m.tri([0, 12, 0], [0, -6, 0], [-16, -10, 0]);
  m.box(0, -11, 3, 2, 4, 7); // tail fin
  return m.build();
}

/** Foot unit: a small figure — torso + head. Tiny, so scaled up hard when spawned. ~6 m. */
function footMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, 0, 3, 3, 2.5, 6); // torso
  m.box(0, 0, 7.5, 2.5, 2.5, 3); // head
  return m.build();
}

/**
 * GORGON drone: a saucer. Radially symmetric (heading is cosmetic), built as a ring of segments
 * skirting out to a wide rim with a dome above and a shallower hull below. Deliberately enormous —
 * it's the one hero unit on the field and has to read as such from theater altitude.
 */
function droneMesh(): ModelMesh {
  const m = new MeshBuilder();
  const N = 28; // rim segments
  const R = 46; // rim radius (~92 m across before per-instance scale)
  const topR = 20;
  const topZ = 14;
  const botR = 16;
  const botZ = -10;
  const apex: V = [0, 0, topZ + 7];
  const nadir: V = [0, 0, botZ - 5];
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2;
    const a1 = ((i + 1) / N) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    const r0: V = [R * c0, R * s0, 0];
    const r1: V = [R * c1, R * s1, 0];
    const t0: V = [topR * c0, topR * s0, topZ];
    const t1: V = [topR * c1, topR * s1, topZ];
    const b0: V = [botR * c0, botR * s0, botZ];
    const b1: V = [botR * c1, botR * s1, botZ];
    m.quad(r0, r1, t1, t0); // upper skirt (rim -> dome base)
    m.quad(b0, b1, r1, r0); // lower skirt (hull -> rim)
    m.tri(t0, t1, apex); // dome cap
    m.tri(b1, b0, nadir); // hull cap
  }
  return m.build();
}

/**
 * Every platform carries a HARDPOINT — a mount point on the hull where gear installs. It's modelled
 * as a visible nub so the mount reads on the silhouette, and its offset is exported so anything
 * that needs to originate at the gear (a beam, a marker) can start from the right place rather than
 * from the unit's centre.
 *
 * Local model metres, x=right y=forward z=up, pre-scale — same convention as the meshes.
 */
export interface Hardpoint {
  x: number;
  y: number;
  z: number;
}

/**
 * Six-legged spider drone — infantry-scale, so it's sized against the foot unit rather than the
 * vehicles. Low hull slung under three pairs of two-segment legs, sensor cluster forward.
 * ~12 m across before scale, which lands it alongside a foot unit on screen.
 */
function spiderMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, 0, 2.4, 4.6, 6.4, 1.8); // hull
  m.box(0, 3.4, 3.2, 2.2, 1.8, 1.4); // forward sensor cluster
  // Three leg pairs. Knees ride ABOVE the hull, which is what makes it read as a spider rather
  // than a table — the femur goes out and up, the tibia comes back down to the ground.
  for (const y of [2.4, 0, -2.4]) {
    for (const side of [1, -1]) {
      const hip: V = [side * 2.1, y, 2.4];
      const knee: V = [side * 4.6, y * 1.15, 4.4];
      const foot: V = [side * 5.6, y * 1.3, 0];
      m.strut(hip, knee, 0.42, 0.34);
      m.strut(knee, foot, 0.34, 0.2);
    }
  }
  m.box(0, -0.6, 4.0, 1.5, 2.2, 1.2); // hardpoint nub, dorsal
  return m.build();
}

/** Dorsal mount, between the rear leg pairs. */
const SPIDER_HARDPOINT: Hardpoint = { x: 0, y: -0.6, z: 4.6 };

/**
 * Bipedal walker on digitigrade legs — roughly twice a ground vehicle, so it towers over traffic
 * without competing with the disc. ~50 m tall before scale.
 *
 * Digitigrade means it stands on its toes with a reversed knee: hip forward-down to the knee, then
 * BACK to the ankle, then forward again to the toe. That reverse Z is the whole silhouette, so the
 * joints are placed to make it obvious from above as well as from the side.
 */
function bipedMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, 0, 34, 13, 10, 15); // torso
  m.box(0, 2.5, 43.5, 5.5, 6, 4.5); // sensor head
  for (const side of [1, -1]) {
    const hip: V = [side * 4.6, 0, 27];
    const knee: V = [side * 5.2, 5.5, 17.5]; // forward
    const ankle: V = [side * 5.2, -3.5, 7.5]; // back — the digitigrade reversal
    const toe: V = [side * 5.2, 4.5, 0]; // forward again, onto the toe
    m.strut(hip, knee, 2.3, 1.9);
    m.strut(knee, ankle, 1.9, 1.5);
    m.strut(ankle, toe, 1.5, 1.1);
    m.box(side * 5.2, 5.2, 0.7, 3, 6, 1.4); // foot pad
    m.box(side * 8.6, 0, 39, 4.5, 6.5, 4.5); // shoulder mount
  }
  m.box(0, -5.5, 42, 3.5, 4, 3); // hardpoint nub, dorsal spine
  return m.build();
}

/** Dorsal spine mount, behind the head. */
const BIPED_HARDPOINT: Hardpoint = { x: 0, y: -5.5, z: 44 };

/**
 * Quad-legged siege walker — the largest thing on the field by a wide margin. ~200 m across before
 * scale, so on screen it spans several city blocks and genuinely straddles the road network.
 *
 * Built deliberately top-heavy: a slab hull carried high on four multi-segment legs, so from
 * theater altitude the readable shape is a dark platform with daylight under it.
 */
function walkerMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, 0, 118, 86, 132, 30); // primary hull
  m.box(0, -18, 148, 38, 48, 30); // command tower
  m.box(0, 52, 126, 44, 30, 16); // forward sensor prow
  for (const sx of [1, -1]) {
    for (const sy of [1, -1]) {
      const hip: V = [sx * 36, sy * 52, 108];
      const knee: V = [sx * 62, sy * 70, 64];
      const foot: V = [sx * 72, sy * 78, 0];
      m.strut(hip, knee, 8, 6.5);
      m.strut(knee, foot, 6.5, 4);
      m.box(sx * 72, sy * 78, 3, 16, 16, 6); // foot pad
    }
  }
  // Four hardpoint nubs along the hull spine — the only platform with more than one mount.
  for (const y of [46, 14, -18, -50]) m.box(0, y, 136, 9, 11, 8);
  return m.build();
}

/** Forward-most of the four spine mounts; the rest sit behind it at 32 m intervals. */
const WALKER_HARDPOINT: Hardpoint = { x: 0, y: 46, z: 142 };

/** Dorsal mount on the disc, just off the dome. */
const DISC_HARDPOINT: Hardpoint = { x: 0, y: 0, z: 22 };

export type UnitKind = 'land' | 'sea' | 'air' | 'foot' | 'drone' | 'spider' | 'biped' | 'walker';

/** Every kind, in one place — iterate this instead of re-listing the literals. */
export const UNIT_KINDS: UnitKind[] = ['land', 'sea', 'air', 'foot', 'drone', 'spider', 'biped', 'walker'];

/**
 * The player-controlled kinds. These are hero units — one of each at most, purchased, ordered
 * directly and carrying gear — as opposed to the ambient population the sim spawns in thousands.
 */
export const PLATFORM_KINDS: UnitKind[] = ['drone', 'spider', 'biped', 'walker'];

export const UNIT_MESHES: Record<UnitKind, ModelMesh> = {
  land: vehicleMesh(),
  sea: shipMesh(),
  air: aircraftMesh(),
  foot: footMesh(),
  drone: droneMesh(),
  spider: spiderMesh(),
  biped: bipedMesh(),
  walker: walkerMesh(),
};

/** Per-kind display scale so each reads at theater zoom without being absurd up close. */
export const UNIT_SCALE: Record<UnitKind, number> = {
  land: 3,
  sea: 3,
  air: 3.5,
  foot: 6,
  drone: 2, // mesh is already huge; ~185 m across on screen
  // Measured against the units they're specified relative to, not guessed: a ground vehicle reads
  // 78 m long on screen and a foot unit ~54 m tall, so these land at ~35 m (infantry-scale, wide
  // and low), 158 m (2.03x a vehicle) and 516 m (five to six city blocks).
  spider: 3,
  biped: 3.4,
  walker: 3,
};

/** Where gear installs on each platform. Only platform kinds have one. */
export const HARDPOINTS: Partial<Record<UnitKind, Hardpoint>> = {
  drone: DISC_HARDPOINT,
  spider: SPIDER_HARDPOINT,
  biped: BIPED_HARDPOINT,
  walker: WALKER_HARDPOINT,
};
