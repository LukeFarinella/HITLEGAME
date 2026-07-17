import * as THREE from 'three';
import { Contact } from './Contact';
import { FeedSource } from './FeedSource';
import { GeoTransform, haversineMeters } from '../core/geo';
import { HeightField } from '../world/HeightField';
import { LatLon } from '../core/types';
import { applySpawnRules } from './SpawnRules';

/**
 * Consumes FeedSources: clips contacts to the circular theater, projects them to ENU, sits them on
 * the terrain (or at altitude), and reconciles spawn/update/despawn against the scene.
 */
export class EventBus {
  private markers = new Map<string, THREE.Object3D>();
  private sources: FeedSource[] = [];

  constructor(
    private center: LatLon,
    private radiusMeters: number,
    private geo: GeoTransform,
    private field: HeightField,
    private group: THREE.Group,
  ) {}

  add(source: FeedSource): void {
    this.sources.push(source);
    source.start((contacts) => this.ingest(contacts));
  }

  private ingest(contacts: Contact[]): void {
    const seen = new Set<string>();

    for (const c of contacts) {
      if (haversineMeters(this.center, c) > this.radiusMeters) continue;
      seen.add(c.sourceId);

      const enu = this.geo.toEnu(c);
      const groundY = this.field.heightAt(enu.x, enu.z);
      const y = (c.alt && c.alt > 0 ? c.alt : groundY) + 60;

      let marker = this.markers.get(c.sourceId);
      if (!marker) {
        marker = applySpawnRules(c);
        this.markers.set(c.sourceId, marker);
        this.group.add(marker);
      }
      marker.position.set(enu.x, y, enu.z);
      if (c.heading !== undefined) marker.rotation.y = -(c.heading * Math.PI) / 180;
    }

    // Despawn contacts that left the theater or dropped off the feed.
    for (const [id, obj] of this.markers) {
      if (!seen.has(id)) {
        this.group.remove(obj);
        this.markers.delete(id);
      }
    }
  }

  dispose(): void {
    this.sources.forEach((s) => s.stop());
  }
}
