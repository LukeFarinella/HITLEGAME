import { PLATFORM_BY_ID, GEAR_BY_ID } from './platforms';
import { ASSETS } from './progression';

/**
 * One lookup across everything a tasking can release.
 *
 * Unlocks are declared on missions as bare ids — `'walker'`, `'auto-execute'` — because a mission
 * shouldn't need to know which of three catalogs an id lives in. Something does, though, the moment
 * it has to be printed, and this is that something.
 *
 * Deliberately its own module rather than a method on any one catalog: platforms, gear and network
 * assets are defined in two files that don't import each other, and putting the resolver in either
 * of them would mean one catalog importing the other purely to render a label.
 */
/**
 * Names for things the chain already RELEASES but nothing has BUILT yet.
 *
 * The mission chain is the design sheet made real, and it advertises the whole arc — gear, drones
 * and capabilities that arrive in later threads. Rather than let the panel print a raw slug for a
 * not-yet-built id (`MACHINE-GUN`), each one gets its real display name here. When the item lands in
 * its own catalog, the lookup below finds it first and this entry becomes dead — safe to delete then.
 */
const PENDING_LABELS: Record<string, string> = {
  // boon placeholder
  'free-fitting': 'COMPLIMENTARY FITTING',
  // capabilities / automation
  'process-1': 'PROCESS ACTION I',
  'process-2': 'PROCESS ACTION II',
  'process-3': 'PROCESS ACTION III',
  'alert-suspicious': 'SUSPICIOUS-ACTIVITY ALERTS',
  'alert-infraction': 'LIVE INFRACTION ALERTS',
  'patrol-ground': 'AUTO-PATROL GROUND DRONES',
  'patrol-air': 'AUTO-PATROL AIR DRONES',
  'predictive-events': 'PREDICTIVE EVENT ALGORITHM',
  hvt: 'HIGH-VALUE TARGET DESIGNATION',
};

export function unlockName(id: string): string {
  return (
    PLATFORM_BY_ID.get(id as never)?.name ??
    GEAR_BY_ID.get(id)?.name ??
    ASSETS.find((a) => a.id === id)?.name ??
    PENDING_LABELS[id] ??
    id.toUpperCase()
  );
}

/** Whether an id is known to any catalog. Used to catch typos in a mission's unlock list. */
export function unlockExists(id: string): boolean {
  return (
    PLATFORM_BY_ID.has(id as never) || GEAR_BY_ID.has(id) || ASSETS.some((a) => a.id === id)
  );
}
