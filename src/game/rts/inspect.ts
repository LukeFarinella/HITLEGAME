import type { UnitKind } from '../../cesium/unitModels';
import { readRecord, assessBand, BAND_LABEL } from '../intel';
import type { Record_ } from '../intel';
import { extraFields } from '../dossier';

/**
 * INSPECTION — what the company is allowed to know about a member of the public.
 *
 * The obelisks see everyone. What changes as the campaign runs is not the sensor, it is the
 * PERMISSION: how much of what was already collected the operator is allowed to look at. That is the
 * whole argument the game is making, so it is modelled as a ladder of five authorities bought at
 * ACQUISITIONS, and each rung opens a strictly larger view of the same person.
 *
 *   1 CIVIL AUTHORITY     Vehicles only. A plate, a class, a bearing. A pedestrian reads NO LAWFUL
 *                         BASIS — the company is not permitted to look at people on foot at all, and
 *                         cannot fine them for anything they do.
 *   2 GAIT ANALYSIS       Pedestrians become scannable, identified by how they walk. This is the rung
 *                         that turns the on-foot public into revenue, which is precisely why it is a
 *                         separate purchase and not a free consequence of owning cameras.
 *   3 FACIAL RECOGNITION  A name, and the net's own assessment of them.
 *   4 RECORDS ACCESS      Everything already on file: the full charge sheet, priors and all.
 *   5 EMERGENCY POWERS    The rest of the life — address, social, financial, travel, biometrics.
 *
 * Every field is READ from data that already existed: the record and the assessment are the
 * campaign's (see {@link ../intel}), and the deep sheet is the campaign's dossier generator, seeded
 * from the callsign so a person's file never changes between looks. Nothing here invents a second
 * source of truth, and nothing here can see the sim's ground truth about anyone — the assessment is
 * the net's guess and is wrong sometimes, which is the point of it.
 */

export type AuthorityLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface AuthorityTier {
  level: AuthorityLevel;
  name: string;
  /** What this rung lets you see, in one line — the command card's tooltip and the card's footer. */
  grants: string;
}

export const AUTHORITY_TIERS: AuthorityTier[] = [
  { level: 0, name: 'NO AUTHORITY', grants: 'Nothing. The net watches; you may not look.' },
  { level: 1, name: 'CIVIL AUTHORITY', grants: 'Vehicle scanning — plate, class, bearing. Vehicles only.' },
  { level: 2, name: 'GAIT ANALYSIS', grants: 'Pedestrians, identified by gait. On-foot infractions become chargeable.' },
  { level: 3, name: 'FACIAL RECOGNITION', grants: 'Name and the net’s assessment.' },
  { level: 4, name: 'RECORDS ACCESS', grants: 'The full charge sheet — every prior on file.' },
  { level: 5, name: 'EMERGENCY POWERS', grants: 'Everything else: address, social, financial, travel, biometrics.' },
];

/** Whether the company may look at, and charge, a contact of this kind at this authority. */
export function mayInspect(kind: UnitKind, authority: AuthorityLevel): boolean {
  if (authority < 1) return false;
  if (kind === 'land') return true;
  // Everything that isn't in a vehicle is a person on foot, and needs gait.
  return authority >= 2;
}

/**
 * Why a contact cannot be fined right now, or null.
 *
 * The one rule with teeth outside the inspect card: at CIVIL AUTHORITY the on-foot public is legally
 * invisible, so their violations lapse uncollected however obvious they are. Buying GAIT ANALYSIS is
 * what turns them into income — which makes the second rung of the ladder the moment the programme
 * stops being about traffic.
 */
export function fineBlockedBy(kind: UnitKind, authority: AuthorityLevel): string | null {
  if (kind === 'land') return authority >= 1 ? null : 'NEEDS CIVIL AUTHORITY';
  return authority >= 2 ? null : 'NEEDS GAIT ANALYSIS';
}

/** Everything the field can say about a contact, before authority filters it. */
export interface ContactFacts {
  id: string;
  kind: UnitKind;
  heading: number;
  assess: number;
  record: Record_;
  covered: boolean;
  violation: string | null;
}

export interface InspectRow {
  label: string;
  value: string;
  note?: string;
}

export interface InspectSection {
  /** The authority that opened this section, for the card's per-section stamp. */
  level: AuthorityLevel;
  title: string;
  rows: InspectRow[];
}

export interface InspectResult {
  /** Empty when the company has no lawful basis to look at this contact at all. */
  sections: InspectSection[];
  /** Set instead when it may not look — what to show, and what would fix it. */
  refused: string | null;
  /** The next rung, if there is one — the card tells you what you are not seeing. */
  next: AuthorityTier | null;
}

const NAMES_A = ['ADLER', 'BRENNAN', 'CASTILLO', 'DRAKE', 'ESPARZA', 'FONTAINE', 'GRIEVES', 'HALLORAN',
  'IVERSEN', 'JEWELL', 'KOWALSKI', 'LINDQVIST', 'MARCHETTI', 'NAKASHIMA', 'OYELARAN', 'PRZYBYLSKI',
  'QUAYLE', 'ROURKE', 'STAVROS', 'TEAGUE', 'UDALL', 'VANTERPOOL', 'WHELAN', 'XIONG', 'YARBROUGH', 'ZELAYA'];
const NAMES_B = ['A.', 'B.', 'C.', 'D.', 'E.', 'F.', 'G.', 'H.', 'J.', 'K.', 'L.', 'M.', 'N.', 'P.', 'R.', 'S.', 'T.', 'V.', 'W.'];

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A stable identity for a callsign. Seeded, so the same person is the same person every time. */
function identityOf(callsign: string): string {
  const h = hash(callsign);
  return `${NAMES_B[h % NAMES_B.length]} ${NAMES_A[(h >>> 5) % NAMES_A.length]}`;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function bearing(headingRad: number): string {
  const deg = ((headingRad * 180) / Math.PI + 360) % 360;
  return `${Math.round(deg)}° ${COMPASS[Math.round(deg / 45) % 8]}`;
}

/**
 * Build the inspection card for a contact at the company's current authority.
 *
 * Sections are cumulative and appear in ladder order, so the card visibly GROWS as the programme
 * does — and what is missing is named at the bottom rather than silently absent, because "you are
 * not allowed to see this yet" is the more interesting statement.
 */
export function inspectContact(f: ContactFacts, authority: AuthorityLevel): InspectResult {
  const next = AUTHORITY_TIERS.find((t) => t.level === authority + 1) ?? null;
  if (!mayInspect(f.kind, authority)) {
    return {
      sections: [],
      refused:
        authority < 1
          ? 'NO LAWFUL BASIS · the company holds no enforcement authority'
          : 'NO LAWFUL BASIS · this contact is on foot',
      next,
    };
  }

  const onFoot = f.kind !== 'land';
  const sections: InspectSection[] = [];

  // ---- 1 · the scan ------------------------------------------------------------------------------
  sections.push({
    level: onFoot ? 2 : 1,
    title: onFoot ? 'GAIT SCAN' : 'VEHICLE SCAN',
    rows: [
      { label: 'Class', value: onFoot ? 'PEDESTRIAN' : 'VEHICLE' },
      { label: onFoot ? 'Gait signature' : 'Registration', value: f.id },
      { label: 'Bearing', value: bearing(f.heading) },
      { label: 'Sensor', value: f.covered ? 'UNDER COVERAGE' : 'OUT OF COVERAGE — last known' },
      ...(f.violation ? [{ label: 'Live violation', value: f.violation }] : []),
    ],
  });

  // ---- 3 · identity ------------------------------------------------------------------------------
  if (authority >= 3) {
    const band = assessBand(f.assess);
    sections.push({
      level: 3,
      title: 'IDENTITY',
      rows: [
        { label: 'Name', value: identityOf(f.id) },
        { label: 'Assessment', value: `${BAND_LABEL[band]} · ${Math.round(f.assess * 100)}%`, note: 'net estimate' },
      ],
    });
  }

  // ---- 4 · the charge sheet ----------------------------------------------------------------------
  if (authority >= 4) {
    const priors = readRecord(f.record);
    sections.push({
      level: 4,
      title: 'PRIOR INFRACTIONS',
      rows: priors.length
        ? priors.map((p) => ({ label: `Sev ${p.severity}`, value: p.label }))
        : [{ label: '—', value: 'NOTHING ON FILE' }],
    });
  }

  // ---- 5 · everything else -----------------------------------------------------------------------
  if (authority >= 5) {
    sections.push({
      level: 5,
      title: 'FULL FILE',
      rows: extraFields(f.id).map((r) => ({ label: r.label, value: r.value, note: r.note })),
    });
  }

  return { sections, refused: null, next };
}
