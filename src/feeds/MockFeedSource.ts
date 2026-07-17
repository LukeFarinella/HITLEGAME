import { Contact } from './Contact';
import { FeedSource, ContactHandler } from './FeedSource';
import { GeoTransform } from '../core/geo';
import { LatLon } from '../core/types';

interface Track {
  id: string;
  type: string;
  lat: number;
  lon: number;
  vLat: number; // deg per tick
  vLon: number;
  heading: number;
}

/**
 * Placeholder feed: a handful of contacts drifting across the theater once per second.
 * Proves the whole seam (filter -> project -> spawn -> despawn) end-to-end with no network.
 * Swap for real adapters + a recorded-replay source later.
 */
export class MockFeedSource implements FeedSource {
  readonly id = 'mock';
  private timer: number | null = null;
  private tracks: Track[] = [];

  constructor(private center: LatLon, private radiusMeters: number, private count = 8) {}

  start(onContacts: ContactHandler): void {
    const geo = new GeoTransform(this.center);
    const r = this.radiusMeters * 0.8;

    for (let i = 0; i < this.count; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * r;
      const p = geo.toLatLon({ x: Math.cos(a) * d, z: Math.sin(a) * d });
      const spd = 120 + Math.random() * 180; // meters per tick
      const dir = Math.random() * Math.PI * 2;
      this.tracks.push({
        id: `mock-${i}`,
        type: Math.random() < 0.5 ? 'aircraft' : 'ship',
        lat: p.lat,
        lon: p.lon,
        vLat: (Math.sin(dir) * spd) / 111_320,
        vLon: (Math.cos(dir) * spd) / (111_320 * Math.cos((p.lat * Math.PI) / 180)),
        heading: (dir * 180) / Math.PI,
      });
    }

    const tick = () => {
      const now = Date.now();
      const out: Contact[] = this.tracks.map((t) => {
        t.lat += t.vLat;
        t.lon += t.vLon;
        return {
          sourceId: t.id,
          type: t.type,
          lat: t.lat,
          lon: t.lon,
          alt: t.type === 'aircraft' ? 8000 : 0,
          heading: t.heading,
          ts: now,
        };
      });
      onContacts(out);
    };

    tick();
    this.timer = window.setInterval(tick, 1000);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
