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
export function unlockName(id: string): string {
  return (
    PLATFORM_BY_ID.get(id as never)?.name ??
    GEAR_BY_ID.get(id)?.name ??
    ASSETS.find((a) => a.id === id)?.name ??
    id.toUpperCase()
  );
}

/** Whether an id is known to any catalog. Used to catch typos in a mission's unlock list. */
export function unlockExists(id: string): boolean {
  return (
    PLATFORM_BY_ID.has(id as never) || GEAR_BY_ID.has(id) || ASSETS.some((a) => a.id === id)
  );
}
