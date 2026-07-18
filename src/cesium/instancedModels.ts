import * as Cesium from 'cesium';

/**
 * A batch of one low-poly model drawn many times via GPU instancing — the scalable way to render
 * thousands of MOVING units in Cesium.
 *
 * Everything else in this project bakes static geometry once (buildings, roads, obelisks). Units
 * move every frame, so that doesn't apply: rebuilding a Primitive per frame is impossible (shader
 * compile, async upload) and Entities charge a per-entity updater. Instead the model mesh is
 * uploaded ONCE and a per-instance buffer (position + heading + scale + colour) is rewritten each
 * frame and drawn in a single `drawElementsInstanced` call.
 *
 * This drops below Cesium's Primitive/Appearance layer to the renderer classes it exposes but
 * doesn't type (DrawCommand, VertexArray, Buffer, ShaderProgram) — hence the casts.
 *
 * Precision: unit ECEF positions are millions of metres, past float32's resolution, so each is
 * split into high/low parts (the same trick Cesium's own geometry uses) and reassembled relative
 * to the eye in the shader. The per-vertex model offset stays local metres, so it's exact.
 */

const R = Cesium as unknown as {
  Buffer: {
    createVertexBuffer(o: { context: unknown; typedArray?: ArrayBufferView; sizeInBytes?: number; usage: unknown }): CesiumBuffer;
    createIndexBuffer(o: { context: unknown; typedArray: ArrayBufferView; usage: unknown; indexDatatype: unknown }): CesiumBuffer;
  };
  VertexArray: new (o: unknown) => unknown;
  ShaderProgram: { fromCache(o: unknown): unknown };
  DrawCommand: new (o: unknown) => CesiumDrawCommand;
  RenderState: { fromCache(o: unknown): unknown };
  BufferUsage: { STATIC_DRAW: unknown; DYNAMIC_DRAW: unknown };
  Pass: { OPAQUE: unknown };
  IndexDatatype: { UNSIGNED_SHORT: unknown };
  EncodedCartesian3: {
    fromCartesian(c: Cesium.Cartesian3, r: { high: Cesium.Cartesian3; low: Cesium.Cartesian3 }): { high: Cesium.Cartesian3; low: Cesium.Cartesian3 };
  };
};

interface CesiumBuffer {
  copyFromArrayView(view: ArrayBufferView, offsetInBytes?: number): void;
  destroy(): void;
  isDestroyed(): boolean;
}
interface CesiumDrawCommand {
  instanceCount: number;
  boundingVolume: Cesium.BoundingSphere;
}

const FLOAT = Cesium.ComponentDatatype.FLOAT;

/** Floats per instance: posHigh(3) + posLow(3) + heading,scale(2) + colour(4). */
const STRIDE_F = 12;
const STRIDE_B = STRIDE_F * 4;

export interface ModelMesh {
  /** Local model-space vertices, metres, x=right y=forward z=up. */
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint16Array;
}

const VS = `
in vec3 position;      // model-local metres
in vec3 normal;        // model-local
in vec3 i_posHigh;     // instance ECEF, high part
in vec3 i_posLow;      // instance ECEF, low part
in vec2 i_headingScale;
in vec4 i_color;
out vec3 v_normalEC;
out vec4 v_color;

void main() {
  vec4 eyeRel = czm_translateRelativeToEye(i_posHigh, i_posLow);

  // Local ENU basis at the instance, built from its true ECEF direction. The precision lost in
  // i_posHigh + i_posLow is irrelevant here — it's only used as a direction.
  vec3 ecef = i_posHigh + i_posLow;
  vec3 up = normalize(ecef);
  vec3 east = normalize(cross(vec3(0.0, 0.0, 1.0), up));
  vec3 north = cross(up, east);

  float h = i_headingScale.x;      // clockwise from north
  float s = i_headingScale.y;
  float ch = cos(h), sh = sin(h);
  vec3 fwd = north * ch + east * sh;
  vec3 right = east * ch - north * sh;

  vec3 offset = (position.x * right + position.y * fwd + position.z * up) * s;
  vec4 pos = vec4(eyeRel.xyz + offset, 1.0);
  gl_Position = czm_modelViewProjectionRelativeToEye * pos;

  vec3 nWorld = normal.x * right + normal.y * fwd + normal.z * up;
  v_normalEC = czm_normal * nWorld;
  v_color = i_color;
}`;

const FS = `
in vec3 v_normalEC;
in vec4 v_color;
void main() {
  vec3 n = normalize(v_normalEC);
  vec3 l = normalize(czm_lightDirectionEC);
  float diff = max(dot(n, l), 0.0);
  // A touch of ambient + a rim so a unit reads against dark terrain even unlit.
  out_FragColor = vec4(v_color.rgb * (0.4 + 0.85 * diff), v_color.a);
}`;

const ATTRS = {
  position: 0,
  normal: 1,
  i_posHigh: 2,
  i_posLow: 3,
  i_headingScale: 4,
  i_color: 5,
};

/**
 * One model, up to `capacity` live instances. Add to `scene.primitives`. Each frame, fill the
 * instance data (see `beginFrame`/`setInstance`/`endFrame`) and it draws in one call.
 */
export class InstancedModelBatch {
  private mesh: ModelMesh;
  private capacity: number;
  private data: Float32Array;
  private count = 0;
  private dirty = true;
  show = true;

  private base?: CesiumBuffer;
  private index?: CesiumBuffer;
  private instance?: CesiumBuffer;
  private va?: unknown;
  private sp?: unknown;
  private rs?: unknown;
  private command?: CesiumDrawCommand;
  private bounds: Cesium.BoundingSphere;
  private blend: boolean;
  private destroyed = false;

  constructor(mesh: ModelMesh, capacity: number, bounds: Cesium.BoundingSphere, blend = false) {
    this.mesh = mesh;
    this.capacity = capacity;
    this.data = new Float32Array(capacity * STRIDE_F);
    this.bounds = bounds;
    this.blend = blend;
  }

  /** Reset the write cursor for a new frame's instances. */
  beginFrame(): void {
    this.count = 0;
  }

  private encoded = { high: new Cesium.Cartesian3(), low: new Cesium.Cartesian3() };

  /** Append one instance. `ecef` is its world position; heading is radians clockwise from north. */
  setInstance(ecef: Cesium.Cartesian3, heading: number, scale: number, color: Cesium.Color): void {
    if (this.count >= this.capacity) return;
    const o = this.count * STRIDE_F;
    R.EncodedCartesian3.fromCartesian(ecef, this.encoded);
    const { high, low } = this.encoded;
    this.data[o] = high.x;
    this.data[o + 1] = high.y;
    this.data[o + 2] = high.z;
    this.data[o + 3] = low.x;
    this.data[o + 4] = low.y;
    this.data[o + 5] = low.z;
    this.data[o + 6] = heading;
    this.data[o + 7] = scale;
    this.data[o + 8] = color.red;
    this.data[o + 9] = color.green;
    this.data[o + 10] = color.blue;
    this.data[o + 11] = color.alpha;
    this.count++;
  }

  endFrame(): void {
    this.dirty = true;
  }

  private init(context: unknown): void {
    // interleave base mesh: position(3) + normal(3)
    const n = this.mesh.positions.length / 3;
    const base = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      base[i * 6] = this.mesh.positions[i * 3];
      base[i * 6 + 1] = this.mesh.positions[i * 3 + 1];
      base[i * 6 + 2] = this.mesh.positions[i * 3 + 2];
      base[i * 6 + 3] = this.mesh.normals[i * 3];
      base[i * 6 + 4] = this.mesh.normals[i * 3 + 1];
      base[i * 6 + 5] = this.mesh.normals[i * 3 + 2];
    }
    this.base = R.Buffer.createVertexBuffer({ context, typedArray: base, usage: R.BufferUsage.STATIC_DRAW });
    this.index = R.Buffer.createIndexBuffer({
      context,
      typedArray: this.mesh.indices,
      usage: R.BufferUsage.STATIC_DRAW,
      indexDatatype: R.IndexDatatype.UNSIGNED_SHORT,
    });
    this.instance = R.Buffer.createVertexBuffer({
      context,
      sizeInBytes: this.capacity * STRIDE_B,
      usage: R.BufferUsage.DYNAMIC_DRAW,
    });

    const f = (index: number, comps: number, buffer: CesiumBuffer, offset: number, stride: number, div = 0) => ({
      index,
      vertexBuffer: buffer,
      componentsPerAttribute: comps,
      componentDatatype: FLOAT,
      offsetInBytes: offset,
      strideInBytes: stride,
      instanceDivisor: div,
    });
    this.va = new R.VertexArray({
      context,
      attributes: [
        f(ATTRS.position, 3, this.base, 0, 24),
        f(ATTRS.normal, 3, this.base, 12, 24),
        f(ATTRS.i_posHigh, 3, this.instance, 0, STRIDE_B, 1),
        f(ATTRS.i_posLow, 3, this.instance, 12, STRIDE_B, 1),
        f(ATTRS.i_headingScale, 2, this.instance, 24, STRIDE_B, 1),
        f(ATTRS.i_color, 4, this.instance, 32, STRIDE_B, 1),
      ],
      indexBuffer: this.index,
    });

    this.sp = R.ShaderProgram.fromCache({
      context,
      vertexShaderSource: VS,
      fragmentShaderSource: FS,
      attributeLocations: ATTRS,
    });
    // With blend on, opaque units (alpha 1) still write depth — only the faint out-of-sensor units
    // rely on the blend — so ordinary occlusion stays correct and the 30% units read through.
    this.rs = R.RenderState.fromCache({
      depthTest: { enabled: true },
      cull: { enabled: true, face: (Cesium as unknown as { CullFace: { BACK: unknown } }).CullFace.BACK },
      blending: this.blend
        ? {
            enabled: true,
            equationRgb: Cesium.BlendEquation.ADD,
            equationAlpha: Cesium.BlendEquation.ADD,
            functionSourceRgb: Cesium.BlendFunction.SOURCE_ALPHA,
            functionSourceAlpha: Cesium.BlendFunction.SOURCE_ALPHA,
            functionDestinationRgb: Cesium.BlendFunction.ONE_MINUS_SOURCE_ALPHA,
            functionDestinationAlpha: Cesium.BlendFunction.ONE_MINUS_SOURCE_ALPHA,
          }
        : { enabled: false },
    });
    this.command = new R.DrawCommand({
      boundingVolume: this.bounds,
      modelMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      vertexArray: this.va,
      shaderProgram: this.sp,
      renderState: this.rs,
      uniformMap: {},
      pass: R.Pass.OPAQUE,
      instanceCount: 0,
    });
  }

  /** Cesium calls this each frame for anything in scene.primitives. */
  update(frameState: { context: unknown; commandList: unknown[] }): void {
    if (this.destroyed || !this.show || this.count === 0) return;
    if (!this.command) this.init(frameState.context);
    if (this.dirty && this.instance) {
      this.instance.copyFromArrayView(this.data.subarray(0, this.count * STRIDE_F), 0);
      this.dirty = false;
    }
    this.command!.instanceCount = this.count;
    frameState.commandList.push(this.command);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): boolean {
    this.base?.destroy();
    this.index?.destroy();
    this.instance?.destroy();
    (this.va as { destroy?: () => void } | undefined)?.destroy?.();
    // ShaderProgram/RenderState come from a cache; releasing is optional and version-specific.
    this.destroyed = true;
    return true;
  }
}
