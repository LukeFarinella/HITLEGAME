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
  | 'skid';

/** Every kind, in one place — iterate this instead of re-listing the literals. */
export const UNIT_KINDS: UnitKind[] = [
  'land', 'sea', 'air', 'foot',
  'drone', 'dog', 'quad', 'spider', 'biped', 'walker', 'naval', 'interceptor', 'skid',
];

/**
 * The player-controlled kinds. These are hero units — one of each at most, purchased, ordered
 * directly and carrying gear — as opposed to the ambient population the sim spawns in thousands.
 * (The skidsteer worker is RTS-only; it's a platform for selection/ordering but has no campaign
 * catalog entry.)
 */
export const PLATFORM_KINDS: UnitKind[] = [
  'drone', 'dog', 'quad', 'spider', 'biped', 'walker', 'naval', 'interceptor', 'skid',
];

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
};
