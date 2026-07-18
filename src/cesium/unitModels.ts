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

export type UnitKind = 'land' | 'sea' | 'air' | 'foot';

export const UNIT_MESHES: Record<UnitKind, ModelMesh> = {
  land: vehicleMesh(),
  sea: shipMesh(),
  air: aircraftMesh(),
  foot: footMesh(),
};

/** Per-kind display scale so each reads at theater zoom without being absurd up close. */
export const UNIT_SCALE: Record<UnitKind, number> = {
  land: 3,
  sea: 3,
  air: 3.5,
  foot: 6,
};
