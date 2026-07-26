import type { UnitKind } from '../../cesium/unitModels';

/**
 * Millstone's roster — the rival army.
 *
 * Deliberately NOT shaped like {@link ./units RTS_UNITS}. The player's roster carries costs, build
 * times, supply and producers because the player has an economy; Millstone has a clock (see
 * {@link ./millstone}), so its units carry only identity: what the machine is, what it is called
 * when it kills you, and which of your units it exists to answer.
 *
 * The army is built on one idea: it CLOSES. Its line units carry no gun at all — a ripper's only
 * weapon is the drum on its nose — so every point of damage Millstone deals is damage it drove
 * through your fire to deal. That makes the whole matchup legible from the first wave: your job is
 * to keep them at range, theirs is to arrive. Everything else in the roster serves that idea —
 * bulwarks shell the position you're holding so that holding it costs something, censers and
 * shrikes come over the top of a line built to face forward, and the leviathan is what happens if
 * you never solved the problem.
 */

export type MillstoneUnitId =
  | 'drudge'
  | 'ripper'
  | 'flenser'
  | 'bulwark'
  | 'mote'
  | 'shrike'
  | 'hulk'
  | 'censer'
  | 'leviathan';

export interface MillstoneUnitDef {
  id: MillstoneUnitId;
  name: string;
  /** The mesh it renders as. One-to-one with the id — Millstone chassis are not shared. */
  meshKind: UnitKind;
  /** One line for the selection card when the player clicks an enemy. */
  blurb: string;
  /** The Gorgon unit this is the answer to, for the intel readout. */
  counterpart: string;
}

export const MILLSTONE_UNITS: Record<MillstoneUnitId, MillstoneUnitDef> = {
  drudge: {
    id: 'drudge',
    name: 'DRUDGE',
    meshKind: 'drudge',
    blurb: 'Tracked hauler with a grab claw. Millstone’s builder, and it will still take a swing at you.',
    counterpart: 'WORKER',
  },
  ripper: {
    id: 'ripper',
    name: 'RIPPER',
    meshKind: 'ripper',
    blurb: 'Low tracked wedge with a cutter drum. Carries no gun — everything it kills, it drove into.',
    counterpart: 'QUADRUPED',
  },
  flenser: {
    id: 'flenser',
    name: 'FLENSER',
    meshKind: 'flenser',
    blurb: 'Three wheels and two blade arms. Fast enough to choose its fight, and it only has one kind.',
    counterpart: 'ARACHNID',
  },
  bulwark: {
    id: 'bulwark',
    name: 'BULWARK',
    meshKind: 'bulwark',
    blurb: 'Armoured slab with a mortar over its back. Shells the ground you are holding, and shoots back up close.',
    counterpart: 'MARSHAL',
  },
  mote: {
    id: 'mote',
    name: 'MOTE',
    meshKind: 'mote',
    blurb: 'Two ducted fans and a light gun. Cheap eyes over the line, and dies to anything that looks at it.',
    counterpart: 'KITE',
  },
  shrike: {
    id: 'shrike',
    name: 'SHRIKE',
    meshKind: 'shrike',
    blurb: 'Loaded delta. Rocket rails for the standoff pass, a gun for the one after it.',
    counterpart: 'INTERCEPTOR',
  },
  hulk: {
    id: 'hulk',
    name: 'HULK',
    meshKind: 'hulk',
    blurb: 'Slab-sided gun barge. Holds the water your ground line cannot follow it onto.',
    counterpart: 'LITTORAL',
  },
  censer: {
    id: 'censer',
    name: 'CENSER',
    meshKind: 'censer',
    blurb: 'A turning ring with emitters slung beneath it. Reaches a long way and comes over the top.',
    counterpart: 'DISC OBSERVER',
  },
  leviathan: {
    id: 'leviathan',
    name: 'LEVIATHAN',
    meshKind: 'leviathan',
    blurb: 'A grinding wheel the size of a city block, on tracks, with batteries. Answered by an army or not at all.',
    counterpart: 'GIGA WALKER',
  },
};

export const MILLSTONE_UNIT_LIST: MillstoneUnitDef[] = Object.values(MILLSTONE_UNITS);

/** Look a Millstone unit up by the mesh it renders as — the field only knows a unit by its kind. */
export const MILLSTONE_BY_KIND = new Map<UnitKind, MillstoneUnitDef>(
  MILLSTONE_UNIT_LIST.map((u) => [u.meshKind, u]),
);
