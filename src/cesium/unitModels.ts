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

/**
 * The worker: a skid-steer loader, nose (bucket) toward +y. Compact body, a set-back operator cab,
 * two lift arms reaching forward to a wide bucket, four stubby wheels. The one construction machine
 * in the roster — it reads as "builder", not "combatant".
 */
function skidMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, -1, 4, 8, 10, 6); // main body
  m.box(0, -2.5, 9, 6.5, 6, 5); // cab, set back and raised
  m.box(4.2, 4, 5, 1.4, 10, 1.8); // right lift arm, reaching forward
  m.box(-4.2, 4, 5, 1.4, 10, 1.8); // left lift arm
  m.box(0, 9.5, 2.6, 9, 2.4, 4); // bucket scoop at the nose
  for (const sx of [-4.6, 4.6]) for (const sy of [-3.5, 3.5]) m.box(sx, sy, 2, 1.8, 3.4, 4); // wheels
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
 * Quad-legged ground scout — the "dog".
 *
 * The campaign's opening platform and deliberately the humblest thing on the board: roughly the
 * size of a large animal, walking on four plantigrade legs at a pace only slightly better than the
 * people it watches. It is also the ONLY platform bound to the road network, which is the whole
 * shape of it as a piece of equipment — a dog can go where a car can go and nowhere else.
 *
 * Built low and long with the sensor head cantilevered forward off a short neck, so that even at
 * icon scale the silhouette reads as an animal rather than as a table.
 */
function dogMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, 0, 3.0, 2.6, 5.4, 2.0); // torso
  m.box(0, 3.2, 3.6, 1.6, 1.4, 1.4); // shoulder / neck root
  m.box(0, 4.4, 4.2, 1.9, 1.6, 1.3); // sensor head, held forward and slightly up
  m.box(0, 5.3, 4.2, 1.2, 0.5, 0.7); // muzzle sensor

  // Four legs, knees folding backward on the rear pair and forward on the front — the asymmetry is
  // what makes it read as a quadruped instead of a stool.
  for (const [y, knee] of [
    [2.0, 1],
    [-2.0, -1],
  ] as [number, number][]) {
    for (const side of [1, -1]) {
      const hip: V = [side * 1.4, y, 3.0];
      const kn: V = [side * 1.7, y + knee * 0.9, 1.7];
      const foot: V = [side * 1.7, y, 0];
      m.strut(hip, kn, 0.34, 0.28);
      m.strut(kn, foot, 0.28, 0.18);
    }
  }
  m.box(0, -1.0, 4.3, 1.2, 1.8, 0.9); // hardpoint nub, dorsal
  return m.build();
}

const DOG_HARDPOINT: Hardpoint = { x: 0, y: -1.0, z: 4.9 };

/**
 * Quadcopter scout.
 *
 * The dog's aerial counterpart: same class of sensor, same modest pace, but it ignores the ground
 * entirely. Where the dog has to follow the street grid to reach anything, this crosses whatever is
 * in between — which is the trade the pair exists to offer.
 *
 * Four arms off a compact core, each ending in a rotor ring. The rings are what make it legible
 * from above, where a quadcopter is otherwise just a dot.
 */
function quadMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, 0, 0, 3.0, 3.6, 1.5); // core
  m.box(0, 2.2, -0.3, 1.6, 1.2, 0.9); // forward sensor pod

  const ARM = 4.4;
  for (const sx of [1, -1]) {
    for (const sy of [1, -1]) {
      const hub: V = [sx * ARM, sy * ARM, 0.5];
      m.strut([sx * 1.2, sy * 1.2, 0], hub, 0.3, 0.24);
      m.box(hub[0], hub[1], hub[2], 0.9, 0.9, 0.5); // motor can
      // Rotor disc as a thin octagonal ring — cheap, and reads as a spinning blade at distance.
      const R = 2.5;
      for (let i = 0; i < 8; i++) {
        const a0 = (i / 8) * Math.PI * 2;
        const a1 = ((i + 1) / 8) * Math.PI * 2;
        m.strut(
          [hub[0] + Math.cos(a0) * R, hub[1] + Math.sin(a0) * R, hub[2] + 0.5],
          [hub[0] + Math.cos(a1) * R, hub[1] + Math.sin(a1) * R, hub[2] + 0.5],
          0.12,
        );
      }
    }
  }
  m.box(0, -1.4, -1.1, 1.4, 1.6, 0.8); // hardpoint, slung underneath
  return m.build();
}

const QUAD_HARDPOINT: Hardpoint = { x: 0, y: -1.4, z: -1.6 };

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

/**
 * Naval drone — a low trimaran hull. Wide enough to read as a boat from above rather than as a
 * sliver, and deliberately flat: it sits ON the water plane, so anything tall would look beached.
 * ~60 m before scale.
 */
function navalMesh(): ModelMesh {
  const m = new MeshBuilder();
  const L = 30; // half-length
  const W = 5; // main hull half-width
  const D = 3.4; // depth

  // Centre hull, tapering to a point at the bow.
  m.box(0, -4, D / 2, W * 2, (L - 8) * 2, D);
  m.tri([W, L - 12, 0], [0, L, D / 2], [W, L - 12, D]);
  m.tri([-W, L - 12, D], [0, L, D / 2], [-W, L - 12, 0]);
  m.tri([W, L - 12, D], [0, L, D / 2], [-W, L - 12, D]);
  m.tri([-W, L - 12, 0], [0, L, D / 2], [W, L - 12, 0]);

  // Outriggers, set back and outboard — the trimaran read.
  for (const side of [1, -1]) {
    m.strut([side * 13, -18, D * 0.4], [side * 11, L - 16, D * 0.4], 1.5, 0.9);
    m.strut([side * 5, -2, D * 0.8], [side * 13, -2, D * 0.6], 1.1); // cross beam
  }

  m.box(0, -12, D + 2.2, 7, 11, 4.4); // superstructure
  m.box(0, -20, D + 3.4, 3, 4, 2.6); // hardpoint nub, aft
  return m.build();
}

/** Aft mount, behind the superstructure. */
const NAVAL_HARDPOINT: Hardpoint = { x: 0, y: -20, z: 8 };

/**
 * Interceptor — a flying wing. A single swept triangle with a thin spine, nothing else: it is the
 * one platform defined entirely by its planform, because from above that is all you ever see of it.
 * ~70 m span before scale.
 */
function interceptorMesh(): ModelMesh {
  const m = new MeshBuilder();
  const span = 35; // half-span
  const nose = 30;
  const tail = -14;
  const th = 2.2; // half-thickness at the spine

  // Upper and lower surfaces, each a pair of triangles from the nose to the swept trailing edge.
  for (const side of [1, -1]) {
    const tip: V = [side * span, tail + 6, 0];
    m.tri([0, nose, th], [0, tail, th], tip);
    m.tri([0, tail, -th], [0, nose, -th], tip);
  }
  // Spine, giving it a readable thickness edge-on.
  m.box(0, (nose + tail) / 2, 0, 3.4, nose - tail, th * 2);
  m.box(0, tail + 3, th + 1.6, 2.4, 9, 3.2); // hardpoint nub, dorsal
  return m.build();
}

/** Dorsal spine mount. */
const INTERCEPTOR_HARDPOINT: Hardpoint = { x: 0, y: -11, z: 5 };

/** Dorsal mount on the disc, just off the dome. */
const DISC_HARDPOINT: Hardpoint = { x: 0, y: 0, z: 22 };

/**
 * USV — a small unmanned surface vessel. The cheap picket boat, and the water's answer to the kite.
 *
 * A flat planing hull with a hard chine, a low sensor mast and a single pintle forward. Deliberately
 * a fraction of the littoral's size: against the trimaran's outriggers and superstructure this reads
 * as something you field four of, which is the point of it. ~14 m before scale.
 */
function usvMesh(): ModelMesh {
  const m = new MeshBuilder();
  const L = 7;
  const W = 2.2;
  const D = 1.4;
  m.box(0, -1, D / 2, W * 2, (L - 1.5) * 2, D); // hull
  // Planing bow: a wedge rather than a point, so it reads as a small fast boat.
  m.tri([W, L - 4, 0], [0, L, D], [W, L - 4, D]);
  m.tri([-W, L - 4, D], [0, L, D], [-W, L - 4, 0]);
  m.tri([W, L - 4, D], [0, L, D], [-W, L - 4, D]);
  m.box(0, -2.5, D + 1.1, 2.6, 4.5, 2.2); // low deckhouse
  m.strut([0, -2.5, D + 2.2], [0, -2.5, D + 6], 0.35); // sensor mast
  m.box(0, 2.6, D + 0.9, 1.5, 2.4, 1.4); // forward pintle mount
  return m.build();
}

/** Foredeck, beside the pintle. */
const USV_HARDPOINT: Hardpoint = { x: 0, y: 2.6, z: 3.6 };

// ---- Millstone chassis ---------------------------------------------------------------------------
//
// The rival army, and deliberately a different DESIGN LANGUAGE rather than a palette swap of the
// player's. Gorgon is legged and aerospace: struts, tapered limbs, planforms, things that walk on
// their toes or hold themselves in the air. Millstone is INDUSTRIAL — welded slab, track units,
// exposed drums and cutting gear, prows built to be driven into things. Where a Gorgon platform is
// shaped around a sensor, a Millstone one is shaped around the tool bolted to its front.
//
// That reads at every zoom: legs versus tracks at mesh scale, and at icon scale a Gorgon silhouette
// has limbs radiating off a body while a Millstone one is a solid block with something ugly on the
// nose. You should never have to check the colour to know whose army you are looking at.
//
// Each is sized against its Gorgon counterpart so the two rosters field at comparable scale.

/**
 * Drudge — Millstone's worker. A tracked hauler with a clamshell grab where the skid-steer has a
 * bucket: the same job done by a machine that looks like it would rather be demolishing something.
 * ~16 m before scale, matching the skid.
 */
function drudgeMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, -1, 4.5, 8.6, 11, 6.5); // welded body
  m.box(0, -3.4, 10, 6.4, 5.6, 4.6); // armoured cab — a slit, not a window
  for (const sx of [-5.6, 5.6]) m.box(sx, 0, 3, 2.6, 13, 5.4); // track units
  m.box(0, 5.6, 7.4, 2, 8, 1.8); // grab boom, reaching forward
  for (const sx of [-2.7, 2.7]) m.box(sx, 10.2, 5.6, 1.7, 4.2, 4.2); // clamshell jaws
  return m.build();
}

/**
 * Ripper — the cheap line unit, and the one that defines how Millstone fights. A low tracked wedge
 * with a toothed cutter drum across the prow; it has no gun at all, so every kill it gets is one it
 * drove into. ~11 m, deliberately the same read as the dog it is sent against.
 */
function ripperMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, -0.5, 2.8, 5.2, 7.6, 3.4); // low hull
  m.box(0, -2.6, 5.6, 3.6, 3.2, 2.4); // dorsal engine block
  for (const sx of [-3.2, 3.2]) m.box(sx, 0, 2.3, 1.6, 8.6, 3.6); // track pods
  m.strut([-3.5, 5.5, 2.3], [3.5, 5.5, 2.3], 2); // cutter drum, spanning the nose
  for (const tx of [-2.3, 0, 2.3]) m.box(tx, 6.8, 2.3, 0.9, 1.5, 0.9); // drum teeth
  return m.build();
}

/**
 * Flenser — the pursuit unit. Three wheels and two long blade arms held out ahead of it, so the
 * silhouette is mostly reach: it is built to catch something and open it, and nothing else. Sized
 * against the arachnid it chases.
 */
function flenserMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, 0, 3.4, 3.4, 8.2, 2.8); // spine hull
  m.box(0, 4.4, 4.4, 2.4, 3, 2.2); // low sensor head
  for (const sx of [-3.5, 3.5]) m.box(sx, -2.8, 2.5, 1.7, 4.8, 5); // rear drive wheels
  m.box(0, 5.4, 2.3, 1.6, 4.4, 4.6); // single forward wheel
  for (const side of [1, -1]) {
    m.strut([side * 1.9, 2.6, 4.6], [side * 5.3, 6.6, 3.5], 0.9, 0.6); // arm
    m.strut([side * 5.3, 6.6, 3.5], [side * 6.5, 10.8, 2.7], 0.6, 0.2); // blade, tapering to nothing
  }
  return m.build();
}

/**
 * Bulwark — the heavy. An armoured slab on two track units with a mortar tube over the back, and a
 * glacis prow it can still shove with. The counterpart to the marshal, and about as tall.
 */
function bulwarkMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, 0, 15, 22, 30, 15); // slab hull
  m.box(0, -6, 26.5, 14, 14, 8); // turret block
  m.strut([0, -4, 30], [0, 12, 45], 2.6, 2.2); // mortar tube, angled up and forward
  for (const sx of [-12.6, 12.6]) m.box(sx, 0, 7.5, 5, 32, 13); // track units
  m.box(0, 15.5, 13, 18, 4, 11); // glacis plate
  m.box(0, -14, 31, 4, 5, 4); // hardpoint nub
  return m.build();
}

/** An octagonal duct ring — the cheap way to read "ducted fan" from above. */
function ductRing(m: MeshBuilder, cx: number, cy: number, cz: number, r: number, t: number): void {
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    m.box(cx + Math.cos(a) * r, cy + Math.sin(a) * r, cz, t, t, t * 0.8);
  }
}

/**
 * Mote — the light air scout. Two ducted fans on stubs off a tiny core: no wings, no planform, just
 * enough machine to hold a gun in the air. The kite's opposite number.
 */
function moteMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, 0, 3, 3.2, 3.8, 2.6); // core
  m.box(0, 2.8, 3.2, 1.7, 1.8, 1.5); // sensor bulb
  for (const side of [1, -1]) {
    m.strut([side * 1.6, 0, 3.2], [side * 4.2, 0, 3.4], 0.6);
    ductRing(m, side * 5.6, 0, 3.4, 2.4, 1.1);
  }
  return m.build();
}

/**
 * Shrike — the strike aircraft. A short delta with rocket rails slung under both wings, so unlike
 * the interceptor's clean planform it reads as loaded: the ordnance is the silhouette. ~66 m span.
 */
function shrikeMesh(): ModelMesh {
  const m = new MeshBuilder();
  const span = 33;
  const nose = 26;
  const tail = -16;
  const th = 2.4;
  for (const side of [1, -1]) {
    const tip: V = [side * span, tail + 10, 0];
    m.tri([0, nose, th], [0, tail, th], tip);
    m.tri([0, tail, -th], [0, nose, -th], tip);
    // Rail pylons and the rounds on them — the loaded read.
    m.box(side * 13, -2, -th - 1.4, 1.6, 5, 2.4);
    m.strut([side * 13, -9, -th - 2.6], [side * 13, 7, -th - 2.6], 1.1);
    m.box(side * 20, -2, -th - 1.2, 1.4, 4.4, 2);
    m.strut([side * 20, -8, -th - 2.2], [side * 20, 5, -th - 2.2], 0.9);
  }
  m.box(0, (nose + tail) / 2, 0, 4.2, nose - tail, th * 2); // spine
  m.box(0, tail + 4, th + 1.6, 2.6, 9, 3.2); // hardpoint nub
  return m.build();
}

/**
 * Hulk — the naval platform. A slab-sided barge with a deck gun forward, riding low. Against the
 * littoral's trimaran it is all displacement and no finesse: one hull, straight sides, a bow built
 * to push through rather than cut. ~60 m before scale.
 */
function hulkMesh(): ModelMesh {
  const m = new MeshBuilder();
  const L = 29;
  const W = 8;
  const D = 4;
  m.box(0, -3, D / 2, W * 2, (L - 6) * 2, D); // barge hull
  // Blunt raked bow: two triangles rather than a point.
  m.tri([W, L - 9, 0], [0, L, D], [W, L - 9, D]);
  m.tri([-W, L - 9, D], [0, L, D], [-W, L - 9, 0]);
  m.tri([W, L - 9, D], [0, L, D], [-W, L - 9, D]);
  m.box(0, -13, D + 3.5, 11, 14, 7); // blockhouse superstructure
  m.box(0, 12, D + 2.4, 7, 8, 4.8); // gun mount, forward
  m.strut([0, 14, D + 4.4], [0, 26, D + 6.6], 1.5, 1.2); // barrel
  m.box(0, -22, D + 3, 3.4, 4.4, 2.8); // hardpoint nub, aft
  return m.build();
}

/**
 * Censer — the high-altitude support platform. A holed ring with emitter pods hanging off its
 * underside, turning slowly above the fight. Where the disc observer is a sealed hull, this is a
 * frame with its working parts exposed and swinging. ~88 m across.
 */
function censerMesh(): ModelMesh {
  const m = new MeshBuilder();
  const N = 16;
  const R = 44;
  const inner = 30;
  const th = 5;
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2;
    const a1 = ((i + 1) / N) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    const o0: V = [R * c0, R * s0, 0], o1: V = [R * c1, R * s1, 0];
    const i0: V = [inner * c0, inner * s0, 0], i1: V = [inner * c1, inner * s1, 0];
    const o0t: V = [R * c0, R * s0, th], o1t: V = [R * c1, R * s1, th];
    const i0t: V = [inner * c0, inner * s0, th], i1t: V = [inner * c1, inner * s1, th];
    m.quad(i0t, i1t, o1t, o0t); // top face of the ring
    m.quad(o0, o1, i1, i0); // bottom face
    m.quad(o0, o0t, o1t, o1); // outer rim
    m.quad(i1, i1t, i0t, i0); // inner rim
  }
  m.box(0, 0, 4, 16, 16, 8); // hub, spanning the hole
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const x = Math.cos(a) * 37, y = Math.sin(a) * 37;
    m.strut([x, y, 0], [x, y, -13], 1.6); // hanger
    m.box(x, y, -16, 6, 6, 6); // emitter pod
  }
  return m.build();
}

/**
 * Leviathan — the capstone, and the army's name made literal: a siege engine built around an
 * enormous vertical grinding wheel that it drives into whatever it reaches. No legs, no elegance —
 * four track units under a hull the size of a city block, and a wheel taller than the hull.
 * ~170 m before scale, matching the giga walker.
 */
function leviathanMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, -10, 62, 84, 116, 44); // primary hull
  m.box(0, -46, 100, 40, 40, 32); // command blockhouse, set well back
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      m.box(sx * 46, sy * 40, 26, 16, 74, 52); // track units, four of them
    }
  }
  // The wheel: a disc standing in the y=const plane at the prow, built from rim segments.
  const N = 20;
  const R = 52;
  const half = 7;
  const cy = 62;
  const cz = 54;
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2;
    const a1 = ((i + 1) / N) * Math.PI * 2;
    const p0: V = [Math.cos(a0) * R, cy + half, cz + Math.sin(a0) * R];
    const p1: V = [Math.cos(a1) * R, cy + half, cz + Math.sin(a1) * R];
    const q0: V = [Math.cos(a0) * R, cy - half, cz + Math.sin(a0) * R];
    const q1: V = [Math.cos(a1) * R, cy - half, cz + Math.sin(a1) * R];
    m.quad(q0, q1, p1, p0); // tread face
    m.tri([0, cy + half, cz], p0, p1); // near hub fan
    m.tri([0, cy - half, cz], q1, q0); // far hub fan
    // A tooth every other segment, so the rim reads as cutting gear rather than a tyre.
    if (i % 2 === 0) {
      const a = (a0 + a1) / 2;
      m.box(Math.cos(a) * (R + 5), cy, cz + Math.sin(a) * (R + 5), 6, half * 2.2, 6);
    }
  }
  m.box(0, 30, 60, 30, 26, 30); // wheel mounting yoke, tying it to the hull
  for (const y of [20, -20, -60]) m.box(0, y, 88, 10, 12, 9); // hardpoint nubs along the spine
  return m.build();
}

// ---- RTS building meshes -----------------------------------------------------------------------
//
// Distinct low-poly silhouettes so the four facilities read apart at a glance, built up from z=0
// (ground) like the unit meshes. Sized ~40-60 units; the build layer scales them to read at theater
// zoom. Convention as above: x=right, y=forward, z=up.

/** Data center: a long low server hall with a row of rooftop coolers — wide and squat. */
export function dataCenterMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, 0, 11, 62, 40, 22); // main hall
  for (const x of [-20, -7, 7, 20]) m.box(x, 6, 25, 8, 9, 6); // rooftop cooling units
  m.box(0, -15, 9, 64, 6, 18); // side vent bank
  return m.build();
}

/** Robotics factory: a boxy hangar with a ridged roof and a tall chimney. */
export function roboticsMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, 0, 13, 50, 46, 26); // main hangar
  for (const y of [-13, 0, 13]) m.box(0, y, 29, 50, 7, 8); // ridged roof
  m.box(-18, -16, 34, 9, 9, 44); // chimney
  return m.build();
}

/** Tech lab: a stepped ziggurat tower with an antenna mast — the tallest, most vertical shape. */
export function techMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, 0, 9, 42, 42, 18); // base step
  m.box(0, 0, 26, 30, 30, 18); // mid step
  m.box(0, 0, 41, 18, 18, 14); // top step
  m.box(0, 0, 58, 2.5, 2.5, 20); // antenna mast
  return m.build();
}

/**
 * Acquisitions: a corporate headquarters, and the only building in the base that looks like one.
 *
 * A wide plinth, a colonnade across the front, and a slab tower set back behind it — the vocabulary
 * of a bank rather than of a factory, because what this building does is not manufacture anything.
 * It buys ground, raises money and widens what the company is permitted to do, and it should read as
 * the place those decisions are taken.
 */
export function acquisitionsMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, 0, 3, 62, 46, 6); // plinth
  m.box(0, -4, 14, 48, 30, 16); // main block
  // Colonnade: six columns along the front edge, under a shallow entablature.
  for (let i = 0; i < 6; i++) {
    m.box(-25 + i * 10, 16, 13, 3.5, 3.5, 20);
  }
  m.box(0, 16, 25, 58, 6, 4); // entablature over the columns
  m.box(-2, -10, 34, 26, 20, 24); // set-back tower
  m.box(-2, -10, 48, 18, 14, 6); // tower cap
  m.box(-2, -10, 54, 2.5, 2.5, 12); // flagpole
  return m.build();
}

/** Aviation hangar: a broad arched shed with a control tower off one corner. */
export function aviationMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, 0, 11, 58, 48, 22); // hangar body
  m.box(0, 0, 24, 52, 48, 8); // arched roof, stacked narrowing boxes
  m.box(0, 0, 30, 40, 48, 8);
  m.box(0, 0, 35, 26, 48, 6);
  m.box(24, 17, 28, 12, 12, 46); // control tower
  m.box(24, 17, 53, 16, 16, 6); // tower cab
  return m.build();
}

/**
 * Harbor: a quay with two mooring fingers reaching out, a boat shed and a pair of gantry cranes.
 *
 * Faces +y like everything else, and the fingers point that way on purpose — the building's own
 * silhouette says which side the water is on, which matters because it is the one facility whose
 * placement is decided by the coastline rather than by your base.
 */
export function harborMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, -14, 6, 62, 30, 12); // quay apron
  m.box(-16, -18, 18, 26, 20, 12); // boat shed
  m.box(-16, -18, 26, 28, 22, 5); // shed roof overhang
  // Two mooring fingers reaching into the water.
  for (const sx of [-20, 20]) m.box(sx, 12, 4, 8, 44, 5);
  m.box(0, 30, 5, 48, 6, 4); // outer breakwater tying the fingers together
  // Gantry cranes on the apron: a leg pair and a jib cantilevered out over the water.
  for (const sx of [-4, 22]) {
    m.box(sx, -8, 22, 4, 4, 32);
    m.box(sx, -20, 22, 4, 4, 32);
    m.box(sx, 2, 40, 5, 40, 4); // jib
  }
  return m.build();
}

/**
 * Skyhook: an orbital tether. A broad anchor pad, a mast that tapers as it climbs, four guy cables
 * raking out to ground anchors, and a climber car partway up.
 *
 * Built to be the TALLEST thing in the base by a wide margin, and to run off the top of its own
 * silhouette — the tether is supposed to read as going somewhere the frame doesn't reach, which is
 * the whole idea of the building.
 */
export function skyhookMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, 0, 5, 46, 46, 10); // anchor pad
  m.box(0, 0, 13, 30, 30, 8); // machinery deck
  // The mast: stacked boxes narrowing as they climb, so it tapers without needing a cone.
  const segs: [number, number][] = [[26, 9], [46, 7], [68, 5.5], [92, 4], [118, 3]];
  for (const [z, w] of segs) m.box(0, 0, z, w, w, z === 118 ? 30 : 22);
  // Guy cables from high on the mast out to four ground anchors.
  for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as [number, number][]) {
    m.strut([sx * 2, sy * 2, 70], [sx * 21, sy * 21, 2], 0.9, 0.5);
    m.box(sx * 21, sy * 21, 3, 6, 6, 6); // anchor block
  }
  m.box(0, 5, 54, 9, 9, 7); // climber car, riding the mast
  return m.build();
}

/**
 * Special facility: a heavy assembly bay — a broad windowless block with a gantry crane spanning it
 * and two buttress towers. Reads as the biggest, most industrial thing in the base, which is what
 * builds the walker.
 */
export function specialMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, 0, 15, 66, 52, 30); // assembly hall
  m.box(0, 0, 33, 70, 12, 6); // gantry beam spanning the roof
  for (const sx of [-30, 30]) m.box(sx, 0, 36, 8, 10, 18); // gantry towers
  m.box(0, -30, 10, 40, 8, 20); // loading dock face
  return m.build();
}

/**
 * Gun emplacement: a low armoured tub with a stubby barrel over it, pointing flat.
 *
 * Deliberately the smallest thing in the base and deliberately HORIZONTAL. Both defences have to be
 * told apart from across a theater at a glance, and the only reliable cue at that size is which way
 * the barrel points — flat means it answers the ground.
 */
export function turretMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, 0, 3, 26, 26, 6); // concrete pad
  m.box(0, 0, 9, 18, 18, 8); // armoured tub
  m.box(0, 0, 15, 12, 14, 6); // mantlet
  m.box(0, 13, 15, 3.5, 16, 3.5); // barrel, level
  m.box(0, 22, 15, 5, 4, 5); // muzzle brake
  return m.build();
}

/**
 * Flak launcher: the same pad under a rack of tubes angled UP.
 *
 * Shares the emplacement's base on purpose — they are the same class of thing, built at the same
 * rung, and the difference between them should read as one detail rather than as two unrelated
 * buildings. The detail is the elevation.
 */
export function flakMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, 0, 3, 26, 26, 6); // same pad
  m.box(0, 0, 9, 16, 16, 8); // turntable
  // Four tubes in a block, raked back and up.
  for (const sx of [-4, 4]) {
    for (const sy of [-3, 3]) {
      m.box(sx, sy - 2, 20, 3, 4, 20);
      m.box(sx, sy - 5, 30, 3, 8, 12);
    }
  }
  m.box(9, 0, 13, 5, 9, 7); // radar box off one shoulder
  return m.build();
}

/**
 * Millstone's power generator: a squat reactor drum flanked by two cooling stacks.
 *
 * Nothing in Millstone's base looks like the player's, and this is why: GORGON runs on obelisks —
 * clean vertical monuments that watch — and Millstone runs on a generator, which is industrial,
 * horizontal and visibly burning something. Two ways of being powered, and you can tell whose base
 * you are looking at from the silhouette alone.
 */
export function generatorMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, 0, 4, 46, 40, 8); // slab
  m.box(0, 0, 18, 26, 26, 22); // reactor drum
  m.box(0, 0, 31, 32, 32, 6); // drum cap
  for (const sx of [-17, 17]) {
    m.box(sx, 6, 26, 9, 9, 38); // cooling stacks
    m.box(sx, 6, 47, 12, 12, 5); // stack crowns
  }
  m.box(0, -19, 12, 34, 6, 14); // switchgear along the front
  return m.build();
}

/** Millstone's residence block: a bare slab of housing. Supply, drawn as the people it is made of. */
export function residenceMesh(): ModelMesh {
  const m = new MeshBuilder();
  m.box(0, 0, 2, 50, 30, 4); // podium
  // Three slabs of differing height, so a row of them reads as a district rather than a repeat.
  m.box(-15, 0, 24, 16, 24, 44);
  m.box(2, 0, 30, 16, 24, 56);
  m.box(19, 0, 20, 16, 24, 36);
  for (const sx of [-15, 2, 19]) m.box(sx, 0, 50, 18, 26, 3); // roof caps
  return m.build();
}

export type UnitKind =
  | 'land'
  | 'sea'
  | 'air'
  | 'foot'
  | 'drone'
  | 'dog'
  | 'quad'
  | 'spider'
  | 'biped'
  | 'walker'
  | 'naval'
  | 'interceptor'
  | 'skid'
  | 'usv'
  // Millstone's chassis. Disjoint from the player's by design — the two armies no longer share
  // hardware, so a mesh kind identifies both the machine AND whose it is.
  | 'drudge'
  | 'ripper'
  | 'flenser'
  | 'bulwark'
  | 'mote'
  | 'shrike'
  | 'hulk'
  | 'censer'
  | 'leviathan';

/** Millstone's chassis, in roster order. The rival army's half of {@link PLATFORM_KINDS}. */
export const MILLSTONE_KINDS: UnitKind[] = [
  'drudge', 'ripper', 'flenser', 'bulwark', 'mote', 'shrike', 'hulk', 'censer', 'leviathan',
];

/** The player's chassis, in roster order. */
export const GORGON_KINDS: UnitKind[] = [
  'drone', 'dog', 'quad', 'spider', 'biped', 'walker', 'naval', 'interceptor', 'skid', 'usv',
];

/** Every kind, in one place — iterate this instead of re-listing the literals. */
export const UNIT_KINDS: UnitKind[] = [
  'land', 'sea', 'air', 'foot',
  ...GORGON_KINDS,
  ...MILLSTONE_KINDS,
];

/**
 * Combat HARDWARE, either army's — as opposed to the ambient population the sim spawns in
 * thousands. This is the test the whole field uses to mean "not a civilian": hardware is never
 * assessed, marked, infected, detained or counted in the contact bands, and it renders as a
 * platform rather than as a contact.
 *
 * It deliberately includes Millstone's chassis. An enemy unit is not a member of the public, and
 * every one of those exclusions is as true of theirs as of yours. What separates the two armies is
 * `rtsc.side`, which the ownership checks (selection, orders, sensor coverage) test instead — see
 * `spawnRtsEnemy`, which keeps enemy units out of `platformIdx` so they are never "your platforms".
 */
export const PLATFORM_KINDS: UnitKind[] = [...GORGON_KINDS, ...MILLSTONE_KINDS];

export const UNIT_MESHES: Record<UnitKind, ModelMesh> = {
  land: vehicleMesh(),
  sea: shipMesh(),
  air: aircraftMesh(),
  foot: footMesh(),
  drone: droneMesh(),
  dog: dogMesh(),
  quad: quadMesh(),
  spider: spiderMesh(),
  biped: bipedMesh(),
  walker: walkerMesh(),
  naval: navalMesh(),
  interceptor: interceptorMesh(),
  skid: skidMesh(),
  usv: usvMesh(),
  drudge: drudgeMesh(),
  ripper: ripperMesh(),
  flenser: flenserMesh(),
  bulwark: bulwarkMesh(),
  mote: moteMesh(),
  shrike: shrikeMesh(),
  hulk: hulkMesh(),
  censer: censerMesh(),
  leviathan: leviathanMesh(),
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
  // The dog is the small one: ~25 m on screen against a 78 m ground vehicle and a 54 m foot unit,
  // so it reads as an animal moving through traffic rather than as another vehicle.
  dog: 2.2,
  quad: 2.4, // ~30 m rotor-tip to rotor-tip — the dog's counterpart, held in the air
  // Promoted from infantry scale to VEHICLE scale: ~105 m, so it sits visibly above the 78 m
  // ground traffic it now outruns. It is a machine that drives, not a machine that sneaks.
  spider: 4.2,
  biped: 3.4,
  walker: 3,
  naval: 3, // ~180 m — reads as a ship against the 78 m ground vehicles
  interceptor: 3, // ~210 m span, between a ground vehicle and the disc
  skid: 2.4, // ~40 m — a small work vehicle, a touch bigger than the dog
  usv: 2.6, // ~36 m — a fifth of the littoral, so a picket reads as small next to a hull
  // Millstone, each matched to the Gorgon unit it is sent against so the two rosters field at the
  // same read. Where a pair differs it is because the machine is genuinely a different size, not
  // because the scale is doing the work.
  drudge: 2.4, // ~40 m, against the skid
  ripper: 2.2, // ~25 m, against the dog
  flenser: 4.2, // against the arachnid
  bulwark: 3.4, // against the marshal
  mote: 2.4, // ~30 m, against the kite
  shrike: 3, // ~200 m span, against the interceptor
  hulk: 3, // ~175 m, against the littoral
  censer: 2, // ~176 m across, against the disc
  leviathan: 3, // ~510 m, against the giga walker
};

/**
 * Map icons for the platforms — 24 px on screen, so a hero unit stays findable once its mesh has
 * gone sub-pixel at theater zoom.
 *
 * Drawn at 2x and displayed at 24 so they stay crisp on retina. Each is the platform's silhouette
 * from above rather than an abstract symbol: a disc, and three walkers distinguished by leg count,
 * which is the one thing that separates them at a glance.
 */
const ICON_PX = 48;

function iconCanvas(draw: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = ICON_PX;
  c.height = ICON_PX;
  const g = c.getContext('2d')!;
  g.translate(ICON_PX / 2, ICON_PX / 2);
  g.strokeStyle = '#E23A2E';
  g.fillStyle = 'rgba(11, 12, 14, 0.72)';
  g.lineWidth = 2.5;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  draw(g);
  return c;
}

/** Radial legs from a body of radius `r0` out to `r1`, `n` of them. */
function legs(g: CanvasRenderingContext2D, n: number, r0: number, r1: number, phase = 0) {
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
  }
  g.stroke();
}

const PLATFORM_ICONS: Partial<Record<UnitKind, HTMLCanvasElement>> = {
  // Disc: concentric rings, no legs.
  drone: iconCanvas((g) => {
    g.beginPath();
    g.arc(0, 0, 17, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.beginPath();
    g.arc(0, 0, 7, 0, Math.PI * 2);
    g.stroke();
  }),
  // Dog: four legs off an oblong body, head forward. The one silhouette with a front and a back.
  dog: iconCanvas((g) => {
    g.beginPath();
    g.moveTo(-6, -8); g.lineTo(-8, -1);
    g.moveTo(6, -8); g.lineTo(8, -1);
    g.moveTo(-6, 8); g.lineTo(-8, 15);
    g.moveTo(6, 8); g.lineTo(8, 15);
    g.stroke();
    g.beginPath();
    g.rect(-7, -9, 14, 19);
    g.fill();
    g.stroke();
    g.beginPath();
    g.arc(0, -13, 4.5, 0, Math.PI * 2); // head
    g.fill();
    g.stroke();
  }),
  // Quadcopter: four rotor rings on an X. Rings, not legs — that is the whole distinction from the
  // dog at 24 px, and the two are otherwise the same size and role.
  quad: iconCanvas((g) => {
    for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as [number, number][]) {
      g.beginPath();
      g.moveTo(sx * 3, sy * 3);
      g.lineTo(sx * 11, sy * 11);
      g.stroke();
      g.beginPath();
      g.arc(sx * 12.5, sy * 12.5, 5.5, 0, Math.PI * 2);
      g.stroke();
    }
    g.beginPath();
    g.rect(-4.5, -4.5, 9, 9);
    g.fill();
    g.stroke();
  }),
  // Arachnid: six legs off a small body.
  spider: iconCanvas((g) => {
    legs(g, 6, 6, 19, Math.PI / 6);
    g.beginPath();
    g.arc(0, 0, 7, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }),
  // Biped: two legs, drawn as a standing figure rather than a plan view — it's the tall one.
  biped: iconCanvas((g) => {
    g.beginPath();
    g.moveTo(-7, 18);
    g.lineTo(-4, 2);
    g.moveTo(7, 18);
    g.lineTo(4, 2);
    g.stroke();
    g.beginPath();
    g.rect(-9, -16, 18, 18);
    g.fill();
    g.stroke();
  }),
  // Interceptor: the planform, which is the whole identity.
  interceptor: iconCanvas((g) => {
    g.beginPath();
    g.moveTo(0, -19);
    g.lineTo(18, 14);
    g.lineTo(0, 7);
    g.lineTo(-18, 14);
    g.closePath();
    g.fill();
    g.stroke();
  }),
  // Naval: a hull seen from above, with outriggers.
  naval: iconCanvas((g) => {
    g.beginPath();
    g.moveTo(0, -19);
    g.lineTo(6, -4);
    g.lineTo(6, 15);
    g.lineTo(-6, 15);
    g.lineTo(-6, -4);
    g.closePath();
    g.fill();
    g.stroke();
    g.beginPath();
    g.moveTo(-14, -2); g.lineTo(-14, 11);
    g.moveTo(14, -2); g.lineTo(14, 11);
    g.moveTo(-14, 4); g.lineTo(-6, 4);
    g.moveTo(14, 4); g.lineTo(6, 4);
    g.stroke();
  }),
  // Colossus: four heavy legs off a square hull.
  walker: iconCanvas((g) => {
    legs(g, 4, 9, 20, Math.PI / 4);
    g.beginPath();
    g.rect(-10, -10, 20, 20);
    g.fill();
    g.stroke();
  }),
  /**
   * USV: one small hull, no outriggers, with a mast tick.
   *
   * Deliberately the littoral's silhouette with the outriggers removed and shrunk — at 24 px the
   * difference between "hull with wings" and "hull alone" is the whole read, and it maps to the
   * actual distinction between the two boats.
   */
  usv: iconCanvas((g) => {
    g.beginPath();
    g.moveTo(0, -14);
    g.lineTo(4.5, -3);
    g.lineTo(4.5, 11);
    g.lineTo(-4.5, 11);
    g.lineTo(-4.5, -3);
    g.closePath();
    g.fill();
    g.stroke();
    g.beginPath();
    g.moveTo(0, 4); g.lineTo(0, -8); // mast
    g.stroke();
  }),
  // Skidsteer: a boxy body with a bucket reaching forward (up), and four wheels.
  skid: iconCanvas((g) => {
    g.beginPath();
    g.rect(-8, -6, 16, 14); // body
    g.fill();
    g.stroke();
    g.beginPath();
    g.moveTo(-9, -6); g.lineTo(-9, -14); g.lineTo(9, -14); g.lineTo(9, -6); // bucket, forward
    g.stroke();
    g.beginPath();
    for (const sx of [-9, 9]) for (const sy of [-3, 5]) { g.moveTo(sx - 2, sy - 3); g.rect(sx - 2, sy - 3, 4, 6); }
    g.stroke();
  }),

  // ---- Millstone ------------------------------------------------------------------------------
  // Solid blocks flanked by track bars, with the working tool on the nose. Nothing here radiates
  // limbs, which is what separates the two armies at 24 px without reading the colour.

  /** Drudge: hauler body between two tracks, clamshell jaws forward. */
  drudge: iconCanvas((g) => {
    g.beginPath();
    g.rect(-6, -5, 12, 13); // body
    g.fill();
    g.stroke();
    g.beginPath();
    for (const sx of [-10, 6]) g.rect(sx, -7, 4, 16); // track bars
    g.stroke();
    g.beginPath();
    for (const sx of [-6, 2]) g.rect(sx, -14, 4, 6); // jaws
    g.stroke();
  }),
  /** Ripper: a wedge with a toothed drum across its nose. */
  ripper: iconCanvas((g) => {
    g.beginPath();
    g.moveTo(-7, 9); g.lineTo(7, 9); g.lineTo(5, -6); g.lineTo(-5, -6); g.closePath();
    g.fill();
    g.stroke();
    g.beginPath();
    for (const sx of [-10, 6]) g.rect(sx, -5, 4, 13); // tracks
    g.stroke();
    g.beginPath();
    g.rect(-8, -12, 16, 5); // drum
    g.fill();
    g.stroke();
    g.beginPath();
    for (const tx of [-5, 0, 5]) { g.moveTo(tx, -12); g.lineTo(tx, -16); } // teeth
    g.stroke();
  }),
  /** Flenser: a narrow spine with two blades reaching well ahead of it. */
  flenser: iconCanvas((g) => {
    g.beginPath();
    g.moveTo(-4, -10); g.lineTo(4, -10); g.lineTo(4, 8); g.lineTo(-4, 8); g.closePath();
    g.fill();
    g.stroke();
    g.beginPath();
    for (const side of [1, -1]) { g.moveTo(side * 3, -4); g.lineTo(side * 9, -11); g.lineTo(side * 11, -19); }
    g.stroke();
    g.beginPath();
    for (const sx of [-8, 4]) g.rect(sx, 4, 4, 7); // rear wheels
    g.stroke();
  }),
  /** Bulwark: a heavy slab with a mortar tube over the bow. */
  bulwark: iconCanvas((g) => {
    g.beginPath();
    g.rect(-8, -7, 16, 16);
    g.fill();
    g.stroke();
    g.beginPath();
    for (const sx of [-13, 9]) g.rect(sx, -9, 4, 20); // track units
    g.stroke();
    g.beginPath();
    g.moveTo(0, -3); g.lineTo(0, -17); // tube
    g.stroke();
  }),
  /** Mote: a tiny core between two duct rings. Rings like the kite's, but only two of them. */
  mote: iconCanvas((g) => {
    g.beginPath();
    g.rect(-3.5, -3.5, 7, 7);
    g.fill();
    g.stroke();
    for (const side of [1, -1]) {
      g.beginPath();
      g.moveTo(side * 3, 0); g.lineTo(side * 8, 0);
      g.stroke();
      g.beginPath();
      g.arc(side * 12, 0, 6, 0, Math.PI * 2);
      g.stroke();
    }
  }),
  /** Shrike: a delta with ordnance rails under the wings — a loaded planform. */
  shrike: iconCanvas((g) => {
    g.beginPath();
    g.moveTo(0, -17); g.lineTo(15, 11); g.lineTo(0, 5); g.lineTo(-15, 11); g.closePath();
    g.fill();
    g.stroke();
    g.beginPath();
    for (const side of [1, -1]) for (const r of [6, 10]) { g.moveTo(side * r, -2); g.lineTo(side * r, 7); }
    g.stroke();
  }),
  /** Hulk: a barge with a raked bow and a gun forward. */
  hulk: iconCanvas((g) => {
    g.beginPath();
    g.moveTo(-7, 12); g.lineTo(7, 12); g.lineTo(7, -8); g.lineTo(0, -14); g.lineTo(-7, -8); g.closePath();
    g.fill();
    g.stroke();
    g.beginPath();
    g.rect(-4, 2, 8, 7); // blockhouse
    g.stroke();
    g.beginPath();
    g.moveTo(0, -4); g.lineTo(0, -12); // barrel
    g.stroke();
  }),
  /** Censer: a holed ring with four pods slung under it. */
  censer: iconCanvas((g) => {
    g.beginPath();
    g.arc(0, 0, 16, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.arc(0, 0, 10, 0, Math.PI * 2);
    g.stroke();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      g.beginPath();
      g.arc(Math.cos(a) * 13, Math.sin(a) * 13, 3.5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
  }),
  /** Leviathan: a hull on four tracks behind an enormous grinding wheel. */
  leviathan: iconCanvas((g) => {
    g.beginPath();
    g.rect(-9, -2, 18, 18);
    g.fill();
    g.stroke();
    g.beginPath();
    for (const sx of [-14, 10]) for (const sy of [-1, 8]) g.rect(sx, sy, 4, 8); // four track units
    g.stroke();
    g.beginPath();
    g.arc(0, -9, 9, 0, Math.PI * 2); // the wheel
    g.fill();
    g.stroke();
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      g.moveTo(Math.cos(a) * 9, -9 + Math.sin(a) * 9);
      g.lineTo(Math.cos(a) * 13, -9 + Math.sin(a) * 13);
    }
    g.stroke();
  }),
};

export function platformIcon(kind: UnitKind): HTMLCanvasElement | undefined {
  return PLATFORM_ICONS[kind];
}

/**
 * The same icon in Millstone's colours, for enemy hardware in an RTS match. Derived from the
 * company icon by swapping the red and green channels — company red (#E23A2E) becomes hostile
 * green — so every chassis keeps its silhouette and only changes flag. Cached per kind.
 */
const HOSTILE_ICONS = new Map<UnitKind, HTMLCanvasElement>();
export function hostilePlatformIcon(kind: UnitKind): HTMLCanvasElement | undefined {
  const hit = HOSTILE_ICONS.get(kind);
  if (hit) return hit;
  const base = PLATFORM_ICONS[kind];
  if (!base) return undefined;
  const c = document.createElement('canvas');
  c.width = base.width;
  c.height = base.height;
  const g = c.getContext('2d')!;
  g.drawImage(base, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    d[i] = d[i + 1];
    d[i + 1] = r;
  }
  g.putImageData(img, 0, 0);
  HOSTILE_ICONS.set(kind, c);
  return c;
}

/** Where gear installs on each platform. Only platform kinds have one. */
export const HARDPOINTS: Partial<Record<UnitKind, Hardpoint>> = {
  drone: DISC_HARDPOINT,
  dog: DOG_HARDPOINT,
  quad: QUAD_HARDPOINT,
  spider: SPIDER_HARDPOINT,
  biped: BIPED_HARDPOINT,
  walker: WALKER_HARDPOINT,
  naval: NAVAL_HARDPOINT,
  interceptor: INTERCEPTOR_HARDPOINT,
  usv: USV_HARDPOINT,
};
