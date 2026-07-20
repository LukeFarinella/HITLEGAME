import * as Cesium from 'cesium';

/**
 * Airdropped obelisks.
 *
 * Functionally these are obelisks — they are appended to the sensor field and inherit coverage,
 * servicing and the alert glow with no special case anywhere. What makes them different is that
 * they are TEMPORARY and they are OURS in a way the fixed network isn't: the permanent sites were
 * surveyed, costed and bought as territory, while these are dropped out of an aircraft onto
 * whatever ground the operator wants watched for the next few minutes.
 *
 * So they don't look like the network. A fixed site is a heavy stone pyramid that reads as
 * infrastructure; a drop is a thin diamond turning slowly in place, which reads as equipment that
 * arrived and will leave. The spin is doing the work there — a static diamond just looks like a
 * smaller obelisk, and the whole point is that the operator can tell at a glance which parts of
 * their coverage will still exist next session.
 *
 * Positions are never persisted. See the note in gorgonGlobe on why that is a rule and not an
 * oversight.
 */

/** Half-height of the diamond, metres. Tall and narrow, so it reads at theater zoom. */
const HEIGHT_M = 190;
/** Half-width at the waist. Deliberately a fraction of the height — "thin diamond". */
const WAIST_M = 34;
/** Metres from the ground to the diamond's waist, so it appears to hover. */
const HOVER_M = 120;
/** Full turns per second. Slow: this is a beacon, not a hazard light. */
const SPIN_HZ = 0.12;

const BODY = Cesium.Color.fromCssColorString('#7FE3F0');
const EDGE = Cesium.Color.fromCssColorString('#E8FBFF');

/**
 * An octahedron, built by hand.
 *
 * Six vertices and eight faces, with flat per-face normals so the facets catch the light
 * separately — a smooth-shaded diamond reads as a blob at distance, and the facets turning past the
 * sun are most of what makes the spin legible.
 */
function diamondGeometry(): Cesium.Geometry {
  const apexTop = [0, 0, HEIGHT_M];
  const apexBot = [0, 0, -HEIGHT_M];
  const waist = [
    [WAIST_M, 0, 0],
    [0, WAIST_M, 0],
    [-WAIST_M, 0, 0],
    [0, -WAIST_M, 0],
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  const face = (a: number[], b: number[], c: number[]) => {
    const base = positions.length / 3;
    positions.push(...a, ...b, ...c);
    // Flat normal from the cross product of two edges.
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    for (let i = 0; i < 3; i++) normals.push(n[0] / len, n[1] / len, n[2] / len);
    indices.push(base, base + 1, base + 2);
  };

  for (let i = 0; i < 4; i++) {
    const a = waist[i];
    const b = waist[(i + 1) % 4];
    face(apexTop, a, b);
    face(apexBot, b, a);
  }

  const attributes = new Cesium.GeometryAttributes();
  attributes.position = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.DOUBLE,
    componentsPerAttribute: 3,
    values: new Float64Array(positions),
  });
  attributes.normal = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.FLOAT,
    componentsPerAttribute: 3,
    values: new Float32Array(normals),
  });

  return new Cesium.Geometry({
    attributes,
    indices: new Uint16Array(indices),
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(positions),
  });
}

interface Drop {
  primitive: Cesium.Primitive;
  /** East-north-up frame at the site, without the spin. */
  frame: Cesium.Matrix4;
  lon: number;
  lat: number;
}

export class DropSites {
  readonly collection = new Cesium.PrimitiveCollection();
  private drops: Drop[] = [];
  private spin = 0;
  private geometry = diamondGeometry();
  private scratch = new Cesium.Matrix4();
  private rot = new Cesium.Matrix3();

  /** Where every live drop stands. Read by the scene to redraw markers. */
  get sites(): { lon: number; lat: number }[] {
    return this.drops.map((d) => ({ lon: d.lon, lat: d.lat }));
  }

  get count(): number {
    return this.drops.length;
  }

  /**
   * Put a diamond down. `groundM` is the terrain height at the point.
   *
   * Returns the world position of the diamond's centre, which is what the sensor field wants as the
   * site's apex — a beam should leave from the body of the thing, not from the dirt under it.
   */
  add(lon: number, lat: number, groundM: number): Cesium.Cartesian3 {
    const origin = Cesium.Cartesian3.fromDegrees(lon, lat, groundM + HOVER_M + HEIGHT_M);
    const frame = Cesium.Transforms.eastNorthUpToFixedFrame(origin);

    const primitive = new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: this.geometry,
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(BODY.withAlpha(0.55)),
        },
      }),
      appearance: new Cesium.PerInstanceColorAppearance({
        flat: false,
        translucent: true,
        // Faceted, so the turn is readable as facets catching light rather than as a rotating blob.
        closed: true,
      }),
      modelMatrix: Cesium.Matrix4.clone(frame),
      asynchronous: false,
    });

    this.collection.add(primitive);
    this.drops.push({ primitive, frame, lon, lat });
    return origin;
  }

  /** Turn them. Call once per frame. */
  update(dt: number): void {
    this.spin = (this.spin + dt * SPIN_HZ * Math.PI * 2) % (Math.PI * 2);
    Cesium.Matrix3.fromRotationZ(this.spin, this.rot);
    Cesium.Matrix4.fromRotationTranslation(this.rot, Cesium.Cartesian3.ZERO, this.scratch);
    for (const d of this.drops) {
      // Spin about the site's own up axis: frame * rotZ, not rotZ * frame, or it orbits the planet.
      Cesium.Matrix4.multiply(d.frame, this.scratch, d.primitive.modelMatrix);
    }
  }

  /** Tear every drop down. Called on theater exit — nothing here outlives a sortie. */
  clear(): void {
    this.collection.removeAll();
    this.drops = [];
  }

  destroy(): void {
    this.collection.destroy();
  }
}

export { EDGE as DROP_EDGE_COLOR, HEIGHT_M as DROP_HEIGHT_M, HOVER_M as DROP_HOVER_M };
