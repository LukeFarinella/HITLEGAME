import { missions } from './missions';

/**
 * Factions — the backers the partner forks let you take, and the rivals those choices make.
 *
 * The design sheet asks for factions that are "present and protected based on my partnerships." This
 * is the catalog and the standing: which of the nine are PARTNERED (their people are off limits, the
 * way a company asset is) and which are HOSTILE (a backer passed over, who now works against you).
 *
 * The standing is not stored here — it's read live off the mission chain, which is the only place a
 * fork decision is recorded. `missions.partneredFactions()` and `hostileFactions()` return the ids
 * off every taken branch; this module names them, colours them, and answers the two questions the
 * rest of the game asks: "is this faction mine?" and "is this faction against me?".
 *
 * Nothing here yet ASSIGNS a contact to a faction or renders one — that's the next step (units.ts +
 * the card). This is the shared vocabulary both will read.
 */

export type FactionId =
  | 'politician'
  | 'judge'
  | 'general'
  | 'oligarchy'
  | 'deep-state'
  | 'brotherhood'
  | 'chosen'
  | 'globalists'
  | 'illuminati';

export interface FactionDef {
  id: FactionId;
  name: string;
  /** One line on who they are, for the card tag's tooltip and the fork it comes from. */
  blurb: string;
  /** The act whose partner fork offers them — I domestic seed, III foreign, V supranational. */
  tier: 1 | 3 | 5;
  /** Card-tag accent, so a partnered contact reads as belonging to a specific backer, not just "protected". */
  tint: string;
}

/**
 * The nine, grouped by the fork that offers them. The tints are distinct enough to tell apart on a
 * card tag but all sit in the console palette — nobody here is off-brand.
 */
export const FACTIONS: FactionDef[] = [
  // Act I — initial funding (pick one of three; the other two are simply not your patron)
  { id: 'politician', name: 'CORRUPT POLITICIAN', blurb: 'A friendly office that signs and looks away.', tier: 1, tint: '#D9A038' },
  { id: 'judge', name: 'CORRUPT JUDGE', blurb: 'A bench that blesses the citations in advance.', tier: 1, tint: '#8FA6C4' },
  { id: 'general', name: 'CORRUPT GENERAL', blurb: 'A quiet requisition off a defence budget.', tier: 1, tint: '#9AA36B' },
  // Act I — domestic funding (rivals)
  { id: 'oligarchy', name: 'TECH OLIGARCHY', blurb: 'Platform capital and the data pipes.', tier: 1, tint: '#57C6D3' },
  { id: 'deep-state', name: 'DEEP STATE', blurb: 'Agency backing and legal air cover.', tier: 1, tint: '#8E7CC3' },
  // Act III — foreign funding (rivals)
  { id: 'brotherhood', name: 'THE BROTHERHOOD', blurb: 'A transnational network with deep reserves.', tier: 3, tint: '#5FA35C' },
  { id: 'chosen', name: 'THE CHOSEN', blurb: 'A rival network, just as deep.', tier: 3, tint: '#E08A3C' },
  // Act V — global funding (rivals)
  { id: 'globalists', name: 'GLOBALISTS', blurb: 'Capital without a country.', tier: 5, tint: '#3FA0A0' },
  { id: 'illuminati', name: 'ILLUMINATI', blurb: 'Older money, deeper roots.', tier: 5, tint: '#C264A8' },
];

export const FACTION_BY_ID = new Map(FACTIONS.map((f) => [f.id, f]));

/** Whether a faction is one the campaign has partnered with — its members render protected. */
export function isPartnered(id: FactionId): boolean {
  return missions.partneredFactions().includes(id);
}

/** Whether a faction has been turned hostile — a backer passed over, now working against you. */
export function isHostile(id: FactionId): boolean {
  return missions.hostileFactions().includes(id);
}

/** The partnered factions as defs, for anything that has to spread contacts across "your" backers. */
export function partneredFactions(): FactionDef[] {
  return missions
    .partneredFactions()
    .map((id) => FACTION_BY_ID.get(id as FactionId))
    .filter((f): f is FactionDef => !!f);
}

/** The hostile factions as defs — the seed of the Act IV insurgency's attackers. */
export function hostileFactions(): FactionDef[] {
  return missions
    .hostileFactions()
    .map((id) => FACTION_BY_ID.get(id as FactionId))
    .filter((f): f is FactionDef => !!f);
}

/** Whether the campaign has taken any partner at all — the gate on there being protected assets. */
export function hasAnyPartner(): boolean {
  return missions.partneredFactions().length > 0;
}
