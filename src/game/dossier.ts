import { MISSIONS, missions } from './missions';

/**
 * The dossier — what the network is willing to show the operator about a contact, and when.
 *
 * The card used to lay everything out at once: face, record, the lot. The design sheet makes that a
 * progression instead. Authority is earned a field at a time, and until it is, the row reads
 * [SEALED] rather than blank — the withholding is the point, and a redacted line the operator cannot
 * read yet is a promise about where the programme is going.
 *
 * Two sources of truth, both the mission chain:
 *   - WHICH mission unlocks a field is read straight off that mission's `authority` column, so the
 *     chain (game/missions.ts) is the only place the ladder is declared. Nothing here restates it.
 *   - SEARCH — released at DISTRICT CANVASS — is the verb that pulls a field the card is holding
 *     back: the "behind a click" fields once earned, or a not-yet-earned field pulled AHEAD of the
 *     authority, which is overreach and costs the ground (charged by the caller, not here).
 *
 * Every value is generated from the contact's callsign, deterministic and cached-free like the
 * capture plates — the same contact always reads the same file, and only the ones actually looked at
 * are ever built.
 */

// ---- gating, derived from the chain -------------------------------------------------------------

/** Info field id → the mission that unlocks free viewing of it. Built once off the authority column. */
const INFO_UNLOCK = new Map<string, string>();
/** The mission that releases the SEARCH action, if the chain declares one. */
let SEARCH_MISSION = '';
for (const m of MISSIONS) {
  if (m.authority?.kind === 'info') INFO_UNLOCK.set(m.authority.id, m.id);
  if (m.authority?.kind === 'action' && m.authority.id === 'search') SEARCH_MISSION = m.id;
}

/** Whether a field is freely visible — its unlocking tasking is cleared (or it was never gated). */
export function infoUnlocked(fieldId: string): boolean {
  const mid = INFO_UNLOCK.get(fieldId);
  return mid ? missions.isComplete(mid) : true;
}

/** The tasking a still-sealed field is waiting on, for the row's caption. */
export function infoUnlockName(fieldId: string): string {
  const mid = INFO_UNLOCK.get(fieldId);
  if (!mid) return '';
  return MISSIONS.find((m) => m.id === mid)?.name ?? mid.toUpperCase();
}

/** Whether the SEARCH action has been released — the operator can pull sealed files at all. */
export function searchAvailable(): boolean {
  return SEARCH_MISSION ? missions.isComplete(SEARCH_MISSION) : false;
}

// ---- the extra fields (everything past face / identity / record) --------------------------------

/**
 * A generated dossier line. `note` is a flag the sensor net attaches — an address it could not
 * verify, a financial risk marker — another channel that can be wrong.
 */
export interface DossierRow {
  id: string;
  label: string;
  value: string;
  note?: string;
  /** Even once unlocked, this one only shows after a SEARCH — the sheet's "behind a click" fields. */
  sealed: boolean;
}

/** Deterministic PRNG (mulberry32), seeded from the callsign so a file never changes. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const pick = <T>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)];
const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

const STREETS = ['MERIDIAN', 'ASHFORD', 'CANAL', 'DELANEY', 'HOLLOW', 'KESTREL', 'VERNON', 'PALISADE', 'ORCHARD', 'LOWRY'];
const STREET_TYPE = ['AVE', 'ST', 'BLVD', 'ROW', 'WALK', 'CT'];
const PLATFORMS_ = ['STREAMR', 'PULSE', 'CIVIQ', 'HALLO', 'FEEDLY', 'NODE', 'TAPESTRY'];
const CITIES = ['SF', 'DEN', 'PHX', 'ATL', 'CHI', 'SEA', 'DFW', 'MIA', 'BOS', 'LAX'];

/**
 * The five fields past the face, the identity and the record — home address through biometrics.
 *
 * Seeded ONLY from the callsign, never from the contact's true state: the card is imperfect evidence
 * everywhere, and a field that quietly correlated with the sim's answer would be a tell the whole
 * judgement the game is about is meant not to have. The flags below (an UNVERIFIED address, a risk
 * marker) are noise the operator has to weigh, not signal.
 */
export function extraFields(callsign: string): DossierRow[] {
  const r = seeded(hash(callsign));

  // home address — sometimes UNVERIFIED, i.e. the record is faked, another lie on the card.
  const addr = `${int(r, 100, 9980)} ${pick(r, STREETS)} ${pick(r, STREET_TYPE)}`;
  const faked = r() < 0.3;

  // social
  const handle = `@${pick(r, PLATFORMS_).toLowerCase()}_${int(r, 100, 9999)}`;
  const posts = int(r, 20, 900);
  const flags = int(r, 0, 6);

  // financial
  const bal = int(r, -8, 90) * 1000 + int(r, 0, 999);
  const accts = int(r, 1, 6);
  const risk = pick(r, ['NOMINAL', 'NOMINAL', 'ELEVATED', 'HIGH']);

  // travel
  const legs = int(r, 2, 4);
  const trail = Array.from({ length: legs }, () => pick(r, CITIES)).join(' → ');
  const crossings = int(r, 0, 4);

  // biometrics
  const height = (150 + int(r, 0, 45)) / 100;
  const pulse = int(r, 58, 104);
  const gait = pick(r, ['MATCHED', 'MATCHED', 'PARTIAL', 'ANOMALOUS']);

  return [
    { id: 'home-address', label: 'Home address', value: addr, note: faked ? 'UNVERIFIED' : undefined, sealed: false },
    { id: 'social', label: 'Social profile', value: `${handle} · ${posts} posts`, note: flags ? `${flags} flagged` : undefined, sealed: false },
    { id: 'financial', label: 'Financial', value: `$${bal.toLocaleString('en-US')} net · ${accts} accts`, note: `${risk} risk`, sealed: true },
    { id: 'travel', label: 'Travel history', value: trail, note: crossings ? `${crossings} crossings` : undefined, sealed: true },
    { id: 'biometrics', label: 'Biometrics', value: `${height.toFixed(2)} m · ${pulse} bpm`, note: `gait ${gait}`, sealed: true },
  ];
}
