import { LatLon } from '../core/types';

/**
 * Normalized real-world (or mock) observation. Every FeedSource emits these, so the sim never
 * knows or cares which feed a contact came from. This is the stable seam for live-data adapters.
 */
export interface Contact extends LatLon {
  sourceId: string; // stable id from the feed (dedup key)
  type: string; // 'aircraft' | 'ship' | 'quake' | ...
  alt?: number; // meters
  heading?: number; // degrees
  props?: Record<string, unknown>;
  ts: number; // epoch ms
}
