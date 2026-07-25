import type { StructureType } from './structures';

/**
 * Research — upgrades a facility works on over time, the way it produces a unit, but the payoff is a
 * standing capability rather than a machine. For now the Tech facility's one project: AUTO-FINE,
 * which turns the traffic-incident income from a click-to-collect chore into passive revenue.
 *
 * Deliberately tiny and data-driven, so adding "faster workers" or "cheaper obelisks" later is one
 * entry here plus one flag-read where it matters.
 */

export type ResearchId = 'auto-fine';

export interface ResearchDef {
  id: ResearchId;
  name: string;
  blurb: string;
  cost: number;
  /** Seconds the facility spends researching it. */
  timeS: number;
  /** The building that researches it — selecting that building offers it. */
  producedBy: StructureType;
  hotkey: string;
}

export const RESEARCH: Record<ResearchId, ResearchDef> = {
  'auto-fine': {
    id: 'auto-fine',
    name: 'AUTO-FINE',
    blurb: 'Obelisks fine traffic violations on their own — passive income, no alerts to answer.',
    cost: 300,
    timeS: 30,
    producedBy: 'tech',
    hotkey: 'F',
  },
};

export const RESEARCH_LIST: ResearchDef[] = Object.values(RESEARCH);

/** What a building can research, in order — its command card offers these alongside any units. */
export function researchFrom(type: StructureType): ResearchDef[] {
  return RESEARCH_LIST.filter((r) => r.producedBy === type);
}
