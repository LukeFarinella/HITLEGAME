/**
 * The routing graph: the road network as something a platform can actually navigate.
 *
 * Deliberately separate from the traffic graph in units.ts. That structure exists for ambient
 * vehicles, which only ever traverse one way at a time and pick a new one at a junction — it never
 * needs to know whether two streets connect. Routing does, and measuring a real theater showed the
 * traffic graph cannot answer it: it creates a node only where two ways share an ENDPOINT, and in
 * vector-tile road data ways are not split at intersections. Miami came out as 19,554 segments in
 * 14,357 disconnected pieces, the largest holding 1.4% of the network. Nothing could be routed.
 *
 * The fix is to node every VERTEX rather than every endpoint, on a spatial grid, so two roads that
 * cross at a shared point become connected whether or not either way happens to end there. Same
 * theater rebuilt this way: the largest component goes from 1.4% to roughly half the network.
 *
 * {@link CELL_DEG} is the whole tuning dial and it is a genuine trade. Too fine and real junctions
 * are missed because the two roads' vertices land in adjacent cells; too coarse and parallel
 * streets weld into one, which would let a platform sidestep between roads it ought to drive
 * around. ~25 m sits under typical urban street spacing while still catching junctions whose
 * coordinates disagree by a few metres between tiles.
 */

const CELL_DEG = 1 / 4400; // ~25 m
const DEG = Math.PI / 180;
const mPerLat = 111_320;

/** Just the geometry — this module doesn't care what class the caller keeps its roads in. */
export interface RoadLine {
  pts: number[][];
}

export interface LonLat {
  lon: number;
  lat: number;
}

export class RouteGraph {
  /** Flattened lon/lat per node. */
  private pos: number[] = [];
  private adj: number[][] = [];
  private idx = new Map<string, number>();
  /**
   * Which connected piece each node belongs to.
   *
   * Precomputed so an impossible route is rejected in constant time. Without it every order at an
   * unreachable target would run A* until it had exhausted a whole component — up to ~100k nodes of
   * fruitless search, on a click that was always going to be refused.
   */
  private comp: Int32Array = new Int32Array(0);

  constructor(lines: RoadLine[]) {
    for (const line of lines) {
      if (line.pts.length < 2) continue;
      let prev = this.node(line.pts[0]);
      for (let i = 1; i < line.pts.length; i++) {
        const cur = this.node(line.pts[i]);
        if (cur === prev) continue; // consecutive vertices fell in one cell
        this.adj[prev].push(cur);
        this.adj[cur].push(prev);
        prev = cur;
      }
    }
    this.label();
    this.bridge();
    this.label();
  }

  /**
   * Reconnect road ends that vector tiling cut apart.
   *
   * Even with every vertex noded, a theater came out in ~5,400 pieces. Measuring the distance from
   * each stranded piece to the main network explained why: a median of 76 m, three quarters inside
   * 131 m. Those are not real gaps in the road system — they are ways clipped at a tile boundary
   * and resumed a short distance away with coordinates that don't line up.
   *
   * So this bridges DEAD ENDS only — nodes with exactly one neighbour, which is precisely the shape
   * a clipped road end has. A junction or a mid-street vertex is never touched, so the pass cannot
   * invent a shortcut through the middle of a block; the worst it can do is rejoin two ends of what
   * was almost certainly one road.
   *
   * {@link BRIDGE_M} is capped below a typical city block for the same reason.
   */
  private bridge(): void {
    const BRIDGE_M = 120;
    const reach = Math.ceil(BRIDGE_M / 25);
    const added: [number, number][] = [];

    for (let n = 0; n < this.adj.length; n++) {
      if (this.adj[n].length !== 1) continue; // dead ends only
      const lon = this.pos[n * 2];
      const lat = this.pos[n * 2 + 1];
      const cx = Math.round(lon / CELL_DEG);
      const cy = Math.round(lat / CELL_DEG);
      let best = -1;
      let bestD = BRIDGE_M;
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const m = this.idx.get(`${cx + dx},${cy + dy}`);
          if (m === undefined || m === n) continue;
          // Only across a break. Same-component nodes are already reachable by road, and linking
          // them would cut a corner the platform ought to drive around.
          if (this.comp[m] === this.comp[n]) continue;
          const d = this.distTo(m, lon, lat);
          if (d < bestD) {
            bestD = d;
            best = m;
          }
        }
      }
      if (best >= 0) added.push([n, best]);
    }

    // Applied after the scan so one pass sees a consistent set of components — otherwise the first
    // few bridges change the labels the rest of the scan is testing against.
    for (const [a, b] of added) {
      this.adj[a].push(b);
      this.adj[b].push(a);
    }
  }

  private node(p: number[]): number {
    const key = `${Math.round(p[0] / CELL_DEG)},${Math.round(p[1] / CELL_DEG)}`;
    let n = this.idx.get(key);
    if (n === undefined) {
      n = this.adj.length;
      this.idx.set(key, n);
      this.adj.push([]);
      this.pos.push(p[0], p[1]);
    }
    return n;
  }

  /** Flood-fill component ids. Runs once, at build. */
  private label(): void {
    this.comp = new Int32Array(this.adj.length).fill(-1);
    let next = 0;
    const stack: number[] = [];
    for (let n = 0; n < this.adj.length; n++) {
      if (this.comp[n] >= 0) continue;
      const id = next++;
      this.comp[n] = id;
      stack.push(n);
      while (stack.length) {
        const c = stack.pop()!;
        for (const nb of this.adj[c]) {
          if (this.comp[nb] >= 0) continue;
          this.comp[nb] = id;
          stack.push(nb);
        }
      }
    }
  }

  get size(): number {
    return this.adj.length;
  }

  /** Size of the largest connected piece, as a fraction. Diagnostic — the dev panel reads it. */
  get connectivity(): number {
    if (!this.adj.length) return 0;
    const counts = new Map<number, number>();
    let best = 0;
    for (let i = 0; i < this.comp.length; i++) {
      const c = (counts.get(this.comp[i]) ?? 0) + 1;
      counts.set(this.comp[i], c);
      if (c > best) best = c;
    }
    return best / this.adj.length;
  }

  private distTo(n: number, lon: number, lat: number): number {
    const mLon = mPerLat * Math.cos(lat * DEG);
    const dx = (this.pos[n * 2] - lon) * mLon;
    const dy = (this.pos[n * 2 + 1] - lat) * mPerLat;
    return Math.hypot(dx, dy);
  }

  /**
   * Nearest node to a point.
   *
   * Walks outward through grid cells rather than scanning every node: at a quarter-million nodes
   * per theater a linear scan costs tens of milliseconds on every click, and this resolves any
   * point near a road in a handful of cell lookups.
   */
  nearest(lon: number, lat: number): number {
    const cx = Math.round(lon / CELL_DEG);
    const cy = Math.round(lat / CELL_DEG);
    for (let r = 0; r <= 60; r++) {
      let best = -1;
      let bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          // Only the ring's edge is new each pass; the interior was covered at smaller r.
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const n = this.idx.get(`${cx + dx},${cy + dy}`);
          if (n === undefined) continue;
          const d = this.distTo(n, lon, lat);
          if (d < bestD) {
            bestD = d;
            best = n;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /** Whether two points are on the same piece of the network at all. Constant time. */
  connected(from: LonLat, to: LonLat): boolean {
    const a = this.nearest(from.lon, from.lat);
    const b = this.nearest(to.lon, to.lat);
    return a >= 0 && b >= 0 && this.comp[a] === this.comp[b];
  }

  /**
   * Shortest drive between two points, as waypoints along real street geometry.
   *
   * A* with straight-line distance as the heuristic — admissible, since no road is shorter than the
   * line between its ends. Returns null when the points sit on different pieces of the network,
   * which is a real answer: the caller refuses the order rather than pretending.
   */
  path(from: LonLat, to: LonLat): LonLat[] | null {
    const start = this.nearest(from.lon, from.lat);
    const goal = this.nearest(to.lon, to.lat);
    if (start < 0 || goal < 0) return null;
    if (this.comp[start] !== this.comp[goal]) return null; // see the note on `comp`
    if (start === goal) return [{ lon: this.pos[goal * 2], lat: this.pos[goal * 2 + 1] }];

    const gLon = this.pos[goal * 2];
    const gLat = this.pos[goal * 2 + 1];
    const h = (n: number) => this.distTo(n, gLon, gLat);

    const gScore = new Map<number, number>([[start, 0]]);
    const cameFrom = new Map<number, number>();
    const open: { n: number; f: number }[] = [{ n: start, f: h(start) }];

    const push = (item: { n: number; f: number }) => {
      open.push(item);
      let i = open.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (open[p].f <= open[i].f) break;
        [open[p], open[i]] = [open[i], open[p]];
        i = p;
      }
    };
    const pop = () => {
      const top = open[0];
      const last = open.pop()!;
      if (open.length) {
        open[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < open.length && open[l].f < open[m].f) m = l;
          if (r < open.length && open[r].f < open[m].f) m = r;
          if (m === i) break;
          [open[m], open[i]] = [open[i], open[m]];
          i = m;
        }
      }
      return top;
    };

    const closed = new Set<number>();
    let guard = 200_000;
    let found = false;
    while (open.length && guard-- > 0) {
      const cur = pop();
      if (cur.n === goal) {
        found = true;
        break;
      }
      if (closed.has(cur.n)) continue;
      closed.add(cur.n);
      const gc = gScore.get(cur.n) ?? Infinity;
      const clon = this.pos[cur.n * 2];
      const clat = this.pos[cur.n * 2 + 1];
      for (const nb of this.adj[cur.n]) {
        if (closed.has(nb)) continue;
        const tentative = gc + this.distTo(nb, clon, clat);
        if (tentative >= (gScore.get(nb) ?? Infinity)) continue;
        gScore.set(nb, tentative);
        cameFrom.set(nb, cur.n);
        push({ n: nb, f: tentative + h(nb) });
      }
    }
    if (!found) return null;

    const out: LonLat[] = [];
    let n = goal;
    while (n !== start) {
      out.push({ lon: this.pos[n * 2], lat: this.pos[n * 2 + 1] });
      const prev = cameFrom.get(n);
      if (prev === undefined) return null;
      n = prev;
    }
    out.reverse();
    return out.length ? out : null;
  }
}
