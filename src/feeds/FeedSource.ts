import { Contact } from './Contact';

export type ContactHandler = (contacts: Contact[]) => void;

/**
 * A source of real-world data. Live adapters (OpenSky aircraft, AIS ships, USGS quakes, ...) and the
 * recorded-replay source all implement this. Deferred for now — MockFeedSource stands in.
 */
export interface FeedSource {
  readonly id: string;
  start(onContacts: ContactHandler): void;
  stop(): void;
}
