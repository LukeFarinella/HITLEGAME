/**
 * Save slots.
 *
 * The campaign is spread across four independent modules — progression, missions, tolerance,
 * resistance — each of which owns its own persistence. Rather than centralise that (which would
 * make every one of them import a save manager and turn a clean set of singletons into a knot),
 * this module owns only the NAMESPACE they write into, and a signal for when it changes.
 *
 * Nothing here imports a game module, which is what keeps it free of cycles: the modules import
 * `slotKey` and `onSlotChange`, and this file never needs to know what they store.
 *
 * The important invariant: with NO slot active there is no namespace, so every module's save() is a
 * no-op. That is what lets the title screen exist without a campaign loaded behind it — the game
 * can sit at the menu with all four modules at their defaults and write nothing to disk.
 */

export const SLOT_COUNT = 3;

/** Preferences that belong to the player rather than to a campaign, and so are never slotted. */
const GLOBAL_KEYS = ['gorgon.sound.v1'];

let active: number | null = null;
const listeners = new Set<() => void>();

/** Which slot is loaded, or null at the title screen. */
export function activeSlot(): number | null {
  return active;
}

/**
 * The storage key a module should use right now, or null when no campaign is loaded.
 *
 * Modules must treat null as "don't persist" rather than falling back to an unslotted key —
 * otherwise a campaign at the menu would bleed into whichever slot was opened next.
 */
export function slotKey(base: string): string | null {
  return active === null ? null : `gorgon.s${active}.${base}`;
}

/** Fire when the active slot changes, so a module can re-read (or reset to defaults). */
export function onSlotChange(fn: () => void): void {
  listeners.add(fn);
}

/**
 * Open a slot, or pass null to close whatever is open and return to a blank state.
 *
 * Listeners are notified AFTER the slot is set, so a module reloading in response reads the new
 * namespace. Order between listeners doesn't matter: none of them read each other during load.
 */
export function setActiveSlot(n: number | null): void {
  active = n;
  for (const fn of listeners) fn();
}

// --- slot inspection ---------------------------------------------------------------------------

export interface SlotSummary {
  slot: number;
  empty: boolean;
  /** FIPS of the state this campaign was founded in, if it has been founded. */
  homeState: string | null;
  tokens: number;
  missionsComplete: number;
  platforms: number;
  territories: number;
}

/** Read a slot's headline numbers WITHOUT opening it — this is what the menu cards show. */
export function summarise(slot: number): SlotSummary {
  const empty: SlotSummary = {
    slot,
    empty: true,
    homeState: null,
    tokens: 0,
    missionsComplete: 0,
    platforms: 0,
    territories: 0,
  };
  const prog = readJSON(`gorgon.s${slot}.progression.v2`);
  if (!prog) return empty;
  const missions = readJSON(`gorgon.s${slot}.missions.v2`);
  return {
    slot,
    empty: false,
    homeState: typeof prog.homeState === 'string' ? prog.homeState : null,
    // `officers` is the pre-rename key — old saves still carry it. A NaN or missing count reads as
    // zero rather than propagating into the menu as "NaN TOKENS".
    tokens: Number.isFinite(prog.tokens)
      ? (prog.tokens as number)
      : Number.isFinite(prog.officers)
        ? (prog.officers as number)
        : 0,
    missionsComplete: Array.isArray(missions?.completed) ? missions.completed.length : 0,
    platforms: prog.counts ? Object.keys(prog.counts as object).length : 0,
    territories: prog.tiers ? Object.keys(prog.tiers as object).length : 0,
  };
}

export function summariseAll(): SlotSummary[] {
  const out: SlotSummary[] = [];
  for (let i = 1; i <= SLOT_COUNT; i++) out.push(summarise(i));
  return out;
}

/** Wipe a slot. Everything namespaced to it goes; global preferences are untouched. */
export function deleteSlot(slot: number): void {
  const prefix = `gorgon.s${slot}.`;
  const doomed: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) doomed.push(k);
  }
  for (const k of doomed) localStorage.removeItem(k);
  // If the slot being deleted is the one open, close it so nothing writes it straight back.
  if (active === slot) setActiveSlot(null);
}

function readJSON(key: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// --- migration ----------------------------------------------------------------------------------

const MIGRATED_KEY = 'gorgon.slots.migrated.v1';

/**
 * Adopt a pre-slots campaign into slot 1.
 *
 * Before slots existed the campaign lived at unnamespaced keys. Those saves are real play, and
 * silently stranding them behind a new menu would be the worst possible way to ship this — so on
 * first run they are COPIED (not moved) into slot 1. The originals stay put, which means rolling
 * back to a build without slots doesn't lose anything either.
 *
 * Runs once, guarded by its own flag.
 */
export function migrateLegacySave(): void {
  try {
    if (localStorage.getItem(MIGRATED_KEY)) return;
    localStorage.setItem(MIGRATED_KEY, '1');
    // Never overwrite an existing slot 1.
    if (localStorage.getItem('gorgon.s1.progression.v2')) return;

    const legacy = [
      'progression.v2',
      'missions.v2',
      'tolerance.v1',
      'resistance.v1',
    ];
    let found = false;
    for (const base of legacy) {
      const raw = localStorage.getItem(`gorgon.${base}`);
      if (raw === null) continue;
      localStorage.setItem(`gorgon.s1.${base}`, raw);
      found = true;
    }
    if (found) console.info('[GORGON] adopted pre-slots campaign into save slot 1');
  } catch {
    // Private browsing / disabled storage. Nothing to migrate and nowhere to record that.
  }
}

/** Exported for tests and the dev panel: what this module considers player-global. */
export function isGlobalKey(key: string): boolean {
  return GLOBAL_KEYS.includes(key);
}
