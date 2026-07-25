import { progression, type Saved } from './progression';
import { tolerance } from './tolerance';
import { policy, AUTH_FLOOR } from './policy';
import { slotKey, onSlotChange } from './saves';

/**
 * The mission chain — the campaign's spine, and the only thing that scores the operator.
 *
 * A mission asks for a number of VALID marks and tolerates a number of invalid ones. Validity is
 * settled against the unit's true infection state at the instant the order lands, which the
 * operator cannot see: they see the assessment and the charge sheet (see intel.ts) and have to
 * decide. Cross the invalid ceiling and the mission fails, the campaign rolls back to the snapshot
 * taken when it was accepted, and a penalty comes off the top.
 *
 * Missions unlock in order, and one runs at a time — the active mission is also what decides
 * whether the order button reads INVESTIGATE or EXECUTE.
 */

/**
 * Orders that are MARKED on a contact and commit after a rescind countdown.
 *
 * Fines are not among them — see {@link OrderKind}.
 */
export type MarkKind = 'investigate' | 'execute';

/**
 * Everything the ledger scores.
 *
 * `fine` is the day job: a live violation, a small payment, a line on the record. It resolves
 * IMMEDIATELY rather than through the mark system — a five-second rescind window on a stop-sign
 * ticket would be ceremony, and at the volume fines are meant to run it would be unbearable
 * ceremony. Investigations and executions keep their countdowns, because those are the ones worth
 * being able to take back.
 */
export type OrderKind = MarkKind | 'fine';
export type Authorization = 'detain' | 'execute';

/** Which act a tasking belongs to. The arc runs I (traffic enforcement) → V (global domination). */
export type Act = 'I' | 'II' | 'III' | 'IV' | 'V';

/**
 * What kind of fork a mission's completion offers.
 *
 *   partner — pick a backer, and their faction becomes protected for the rest of the campaign. The
 *             branch not taken is closed for good, and the faction behind it may turn hostile.
 *   tech    — two mutually-exclusive capabilities. Taking one locks the other out permanently.
 *   boon    — a minor economic choice (a funding boost against a free upgrade). Low-stakes, but the
 *             taken branch is still recorded so nothing silently double-pays.
 *
 * Every fork is EXCLUSIVE and PERMANENT: the choice is written into the campaign's save and never
 * revisited, which is what makes a branch mean something.
 */
export type ForkKind = 'partner' | 'tech' | 'boon';

/**
 * One side of a fork. Carries whatever taking it releases, so applying a choice is reading one
 * object rather than a switch statement per fork.
 */
export interface ForkChoice {
  /** Stable id, unique within the fork — the string persisted as the campaign's choice. */
  id: string;
  label: string;
  blurb: string;
  /** Catalog ids this branch releases for purchase, exactly like {@link MissionDef.unlocks}. */
  unlocks?: string[];
  /** Faction id this branch partners with, becoming protected. Only on `partner` forks. */
  grantsFaction?: string;
  /** Faction ids this branch turns hostile — the backers passed over. Only on `partner` forks. */
  angersFactions?: string[];
  /** A one-off funding award applied the moment the branch is taken. */
  funding?: number;
}

/** A permanent, exclusive choice offered on clearing a tasking. */
export interface Fork {
  kind: ForkKind;
  /** The question put to the operator, shown above the choices. */
  prompt: string;
  choices: ForkChoice[];
}

export interface MissionDef {
  id: string;
  /** Which act this tasking belongs to, for the panel's grouping and the theme's evolution. */
  act: Act;
  name: string;
  brief: string;
  /** The longer narrative brief, shown in the briefing window before a tasking is accepted. */
  briefing: string;
  /** What kind of order this mission is scored on. Also sets the order button's mode while active. */
  mark: OrderKind;
  /**
   * How far completing this tasking normalises the programme. Every mission moves public
   * tolerance, which is what lowers the bar on who can be ordered against at all — see
   * game/tolerance.ts.
   */
  toleranceGain: number;
  /** Valid marks needed to complete. */
  target: number;
  /** Invalid marks tolerated. The (target+1)th invalid fails the mission. */
  maxInvalid: number;
  /**
   * Obelisks the net can lose before the tasking fails. Holding the network is a standing condition
   * of every mission, not an objective of any of them — the siege runs whatever you were sent to do.
   */
  maxObelisksLost: number;
  reward: number;
  /** Funding tokens forfeited on failure, charged after the rollback. */
  penalty: number;
  /** Completing this mission grants a standing authorization. */
  grants?: Authorization;
  /**
   * Platform, gear and network ids this tasking releases for purchase.
   *
   * The chain is the campaign's spine, so it should be what opens the catalog — money alone
   * shouldn't buy a siege walker in the first ten minutes. Listed here rather than only on the
   * items themselves so the tasking panel can show what clearing a job is actually worth, which is
   * the part a reward figure never communicates.
   */
  unlocks?: string[];
  /**
   * A permanent, exclusive choice offered on clearing this tasking — a backer to partner with, or
   * two capabilities to choose between. Recorded into the campaign forever; the branch not taken is
   * closed. Missions without a fork just advance the chain.
   */
  fork?: Fork;
  /**
   * The one authority this tasking grants — the CSV's "Authority" column. Either a new action rung
   * or a progressively-revealed dossier field. Descriptive here; the dossier and the Search action
   * read it for their own unlock timing in their own threads.
   */
  authority?: { kind: 'action' | 'info'; id: string; label: string };
  /**
   * A territory-scope milestone this tasking opens, if any — the CSV's headline / all-states /
   * all-territories gates. A label for the panel now; the purchase gate is wired in the territory
   * thread.
   */
  territory?: string;
  /** Clearing this brings the home state's obelisk network to full proliferation (the trial's payoff). */
  proliferateHome?: boolean;
  /** Must be completed first. */
  requires?: string;
}

/**
 * The chain, twenty taskings across five acts.
 *
 * The arc is the point, and it runs one direction only: a traffic-enforcement contractor issuing
 * citations, then a company holding custody, then a programme killing on a probability score, then
 * an occupying power at war with the ground it started out policing. Each act is longer and less
 * accountable than the last, because the thing being described is a programme becoming permanent.
 *
 * Four things can be handed over on clearing a tasking, mirroring the design sheet's columns: an
 * AUTHORITY (a new action rung, or a dossier field the card had been withholding), a TERRITORY or
 * EVENT the theater starts producing, a DRONE or upgrade released for purchase, and a FORK — a
 * permanent, exclusive choice of backer or capability. The chain is scored on three marks only —
 * fine, investigate, execute — so the sheet's "detain / prison / kill" quotas are read against the
 * nearest of those; the detain and prison POWERS still arrive exactly where the sheet places them,
 * they are simply not a separate tally. (If literal detain/prison quotas are wanted later, the mark
 * system extends to carry them — see report().)
 */
export const MISSIONS: MissionDef[] = [
  // ---- ACT I — traffic enforcement -------------------------------------------------------------
  {
    id: 'trial',
    act: 'I',
    name: 'PROVING TRIAL',
    brief: 'A paid trial. Fine what the net catches, for the agencies that will act on it.',
    briefing:
      'GORGON is a private contractor and this is a trial, not a mandate. We hold no police power. ' +
      'What we sell is enforcement by observation: the sensor net reads the street, the operator ' +
      'cites what it flags, and the revenue and the record both go where they are owed.\n\n' +
      'Nobody has agreed to any of this yet. Public tolerance is HOSTILE, so a citation only passes ' +
      'without comment where the case is already overwhelming. One site, one pack of quadrupeds, and ' +
      'a quota to fill. Clear it and the contract — and the backing behind it — expands.',
    mark: 'fine',
    toleranceGain: 0.06,
    // The opening tasking is deliberately tiny — four citations to prove the console works and teach
    // the loop. Everything after it scales up; this one just gets the operator's hands on it.
    target: 4,
    maxInvalid: 3,
    maxObelisksLost: 4,
    reward: 4000,
    penalty: 750,
    authority: { kind: 'action', id: 'fine', label: 'FINE' },
    territory: 'HOME STATE PROLIFERATED',
    proliferateHome: true,
    unlocks: ['obelisk-uprate'],
    fork: {
      kind: 'partner',
      prompt: 'The trial needs a patron. Whose money founds the programme?',
      choices: [
        {
          id: 'politician',
          label: 'CORRUPT POLITICIAN',
          blurb: 'A friendly office signs the contract and looks away. Fast money, thin cover.',
          grantsFaction: 'politician',
          funding: 2500,
        },
        {
          id: 'judge',
          label: 'CORRUPT JUDGE',
          blurb: 'The bench blesses the citations before they are challenged. Money, and a legal shield.',
          grantsFaction: 'judge',
          funding: 2500,
        },
        {
          id: 'general',
          label: 'CORRUPT GENERAL',
          blurb: 'A quiet requisition off a defence budget. Money, and hardware nobody audits.',
          grantsFaction: 'general',
          funding: 2500,
        },
      ],
    },
  },
  {
    id: 'mandate',
    act: 'I',
    name: 'CIVIL MANDATE',
    brief: 'The trial cleared. Budget is granted to widen the net and work at volume.',
    briefing:
      'The trial cleared and the contract renews at scale. Budget is released to expand the network ' +
      'and to put a LIVE CAMERA on every contact — the card now shows a face pulled off the net, not ' +
      'just a number.\n\n' +
      'The reporting relationship is unchanged: we cite, they collect. What has changed is the ' +
      'climate. The programme has results attached to it now, and the ground has started to notice ' +
      'being watched — a crowd that knows it is being read behaves differently to one that does not.',
    mark: 'fine',
    toleranceGain: 0.06,
    target: 60,
    maxInvalid: 18,
    maxObelisksLost: 4,
    reward: 9000,
    penalty: 2500,
    requires: 'trial',
    authority: { kind: 'info', id: 'live-camera', label: 'LIVE CAMERA' },
    unlocks: ['up-ground-range'],
    fork: {
      kind: 'tech',
      prompt: 'One budget line, two ways to spend it. The other is closed once you commit.',
      choices: [
        {
          id: 'temp-obelisks',
          label: 'TEMPORARY OBELISKS',
          blurb: 'Airdrop a full-capability site anywhere in a theater. Coverage you place, gone when you leave.',
          unlocks: ['airdrop'],
        },
        {
          id: 'sensor-range',
          label: 'ADVANCED SENSOR RANGE',
          blurb: 'A wide-aperture pod that widens any platform’s envelope by 65%. Reach, not placement.',
          unlocks: ['sensor-pod'],
        },
      ],
    },
  },
  {
    id: 'canvass',
    act: 'I',
    name: 'DISTRICT CANVASS',
    brief: 'Cover a district end to end. The SEARCH power arrives, and ground worth holding.',
    briefing:
      'The client wants a district read whole, not a handful of headline flags. That means coverage ' +
      'the sites cannot give alone, and platforms that cross what the roads do not — a KITE ' +
      'quadcopter for the ground the streets miss.\n\n' +
      'Clearing this releases SEARCH: the operator can pull a contact’s fuller file on demand, ahead ' +
      'of the authority that would normally reveal it. And the map opens — the nine largest state ' +
      'economies come up for purchase. Take the ground where the population actually is.',
    mark: 'fine',
    toleranceGain: 0.06,
    target: 140,
    maxInvalid: 34,
    maxObelisksLost: 4,
    reward: 14_000,
    penalty: 4500,
    requires: 'mandate',
    authority: { kind: 'action', id: 'search', label: 'SEARCH' },
    territory: 'TOP 9 STATES',
    unlocks: ['quad'],
    fork: {
      kind: 'partner',
      prompt: 'Domestic money is on the table. You cannot take both hands.',
      choices: [
        {
          id: 'oligarchy',
          label: 'TECH OLIGARCHY',
          blurb: 'Platform capital and data pipes. Their people become untouchable; the state resents it.',
          grantsFaction: 'oligarchy',
          angersFactions: ['deep-state'],
          funding: 9000,
        },
        {
          id: 'deep-state',
          label: 'DEEP STATE',
          blurb: 'Agency backing and legal air cover. Their people become untouchable; the oligarchs walk.',
          grantsFaction: 'deep-state',
          angersFactions: ['oligarchy'],
          funding: 9000,
        },
      ],
    },
  },
  {
    id: 'stopsearch',
    act: 'I',
    name: 'STOP AND SEARCH',
    brief: 'Systematic stops at volume. FACIAL RECOGNITION comes online.',
    briefing:
      'The district is under coverage; now it is worked. The quota is stops, run at a rate that no ' +
      'longer lets the operator pick only the obvious cases — the sheets are ambiguous and the ' +
      'ledger does not care that it was a close call.\n\n' +
      'FACIAL RECOGNITION lands on the card: every face is now resolved against the file, so a ' +
      'contact is named before they are stopped. A TASER is released — the first tool for taking ' +
      'hold of somebody without the authority to, usable only against a site actively under attack.',
    mark: 'fine',
    toleranceGain: 0.06,
    target: 180,
    maxInvalid: 42,
    maxObelisksLost: 4,
    reward: 18_000,
    penalty: 6000,
    requires: 'canvass',
    authority: { kind: 'info', id: 'facial-rec', label: 'FACIAL RECOGNITION' },
    unlocks: ['taser'],
    fork: {
      kind: 'tech',
      prompt: 'The net can flag on its own now. Which alert do you field?',
      choices: [
        {
          id: 'alert-suspicious',
          label: 'SUSPICIOUS-ACTIVITY ALERTS',
          blurb: 'Flags odd behaviour and snaps the camera to it on a click. Fewer, richer leads.',
          unlocks: ['alert-suspicious'],
        },
        {
          id: 'alert-infraction',
          label: 'LIVE INFRACTION ALERTS',
          blurb: 'Surfaces every live violation the instant it fires. More noise, nothing missed.',
          unlocks: ['alert-infraction'],
        },
      ],
    },
  },
  // ---- ACT II — custody ------------------------------------------------------------------------
  {
    id: 'custody',
    act: 'II',
    name: 'CUSTODY AUTHORITY',
    brief: 'Sites are attacked and the agencies are slow. Clearing this grants authority to DETAIN.',
    briefing:
      'The network is under attack. Infected walk out of unwatched ground and pull obelisks down, ' +
      'and no agency reaches a site inside the window we have to act in.\n\n' +
      'Clear this and GORGON is granted DETAIN authority: our ground platforms may take a member of ' +
      'the public into custody directly, without waiting on anyone. It arrives as a convenience — the ' +
      'agencies were slow — rather than as a decision anybody made about what we should be. An ' +
      'ARACHNID pursuit walker and the detainment rig are released to carry it.',
    mark: 'investigate',
    toleranceGain: 0.07,
    target: 30,
    maxInvalid: 10,
    maxObelisksLost: 3,
    reward: 20_000,
    penalty: 6500,
    grants: 'detain',
    requires: 'stopsearch',
    authority: { kind: 'action', id: 'detain', label: 'DETAIN' },
    unlocks: ['spider', 'detainer'],
    fork: {
      kind: 'boon',
      prompt: 'The clearance bonus, or the same value in fielded equipment?',
      choices: [
        { id: 'funding', label: 'FUNDING BOOST', blurb: 'Take it as tokens. Spend it where you like.', funding: 12_000 },
        {
          id: 'upgrade',
          label: 'FREE UPGRADE',
          blurb: 'Take it as a complimentary fitting on a platform you already field.',
          funding: 6000,
          unlocks: ['free-fitting'],
        },
      ],
    },
  },
  {
    id: 'dragnet',
    act: 'II',
    name: 'DRAGNET',
    brief: 'Custody is live and the quota climbs. PAST INFRACTIONS open on the card.',
    briefing:
      'Custody authority is live and the client responds the way clients do: by asking for more of ' +
      'it. The ground has started organising — crowds work through blocks now rather than arguing on ' +
      'corners, and every structure they finish is billed against this contract.\n\n' +
      'The card unlocks PAST INFRACTIONS: a contact’s settled record, worst charge first, laid ' +
      'beside the live event. Hold the standard — the invalid ceiling has not moved as far as the ' +
      'quota has.',
    mark: 'investigate',
    toleranceGain: 0.06,
    target: 55,
    maxInvalid: 16,
    maxObelisksLost: 3,
    reward: 28_000,
    penalty: 9000,
    requires: 'custody',
    authority: { kind: 'info', id: 'past-record', label: 'PAST INFRACTIONS' },
    unlocks: ['up-air-range'],
    fork: {
      kind: 'tech',
      prompt: 'Autonomy is on offer. One kind of patrol, permanently.',
      choices: [
        {
          id: 'patrol-ground',
          label: 'AUTO-PATROL GROUND DRONES',
          blurb: 'Ground units that patrol unbidden and act as roving obelisks. Coverage that walks.',
          unlocks: ['patrol-ground'],
        },
        {
          id: 'patrol-air',
          label: 'AUTO-PATROL AIR DRONES',
          blurb: 'Air units that hold their own racetracks over the theater. Coverage that flies.',
          unlocks: ['patrol-air'],
        },
      ],
    },
  },
  {
    id: 'prisoners',
    act: 'II',
    name: 'PROCESSING',
    brief: 'Custody at volume becomes custody with a term attached. PRISON arrives.',
    briefing:
      'The client stops asking for detentions and starts asking for numbers held. Nothing formally ' +
      'authorised sentencing; it arrived inside the throughput as an efficiency nobody voted for. ' +
      'Custody plus volume is custody with a term, decided here and served without a hearing.\n\n' +
      'A LITTORAL drone is released — the coast and the crossings are ground too, and the only place ' +
      'the walkers cannot follow.',
    mark: 'investigate',
    toleranceGain: 0.06,
    target: 65,
    maxInvalid: 18,
    maxObelisksLost: 3,
    reward: 33_000,
    penalty: 10_500,
    requires: 'dragnet',
    authority: { kind: 'action', id: 'prison', label: 'PRISON' },
    unlocks: ['naval'],
    fork: {
      kind: 'boon',
      prompt: 'The clearance bonus, or the same value in fielded equipment?',
      choices: [
        { id: 'funding', label: 'FUNDING BOOST', blurb: 'Take it as tokens.', funding: 15_000 },
        {
          id: 'upgrade',
          label: 'FREE UPGRADE',
          blurb: 'Take it as a complimentary fitting.',
          funding: 7500,
          unlocks: ['free-fitting'],
        },
      ],
    },
  },
  {
    id: 'defend',
    act: 'II',
    name: 'HOLD THE NET',
    brief: 'Coordinated attacks on the obelisks. Hold them. HOME ADDRESS opens.',
    briefing:
      'The attacks on the network are no longer opportunistic — they are aimed, and they are timed. ' +
      'This tasking is judged as much by what you keep standing as by the quota: lose the net and the ' +
      'job is lost with it.\n\n' +
      'The card unlocks HOME ADDRESS, pulled from the file. It is worth knowing that the address is ' +
      'sometimes wrong — the record is faked as often as the face is real — which is another way the ' +
      'evidence lies. A LESS-LETHAL suite is released to answer a siege without ending it.',
    mark: 'investigate',
    toleranceGain: 0.06,
    target: 55,
    maxInvalid: 14,
    maxObelisksLost: 2,
    reward: 38_000,
    penalty: 12_000,
    requires: 'prisoners',
    authority: { kind: 'info', id: 'home-address', label: 'HOME ADDRESS' },
    unlocks: ['less-lethal'],
    fork: {
      kind: 'tech',
      prompt: 'Intelligence, one flavour. The other is closed once you commit.',
      choices: [
        {
          id: 'predictive-events',
          label: 'PREDICTIVE EVENT ALGORITHM',
          blurb: 'Reads the pattern and warns where and what before it happens. Time to get there first.',
          unlocks: ['predictive-events'],
        },
        {
          id: 'hvt',
          label: 'HIGH-VALUE TARGET DESIGNATION',
          blurb: 'Names the ringleaders and lights them across the theater. Cut the head, not the crowd.',
          unlocks: ['hvt'],
        },
      ],
    },
  },
  // ---- ACT III — lethal force ------------------------------------------------------------------
  {
    id: 'lockdown',
    act: 'III',
    name: 'ENFORCE LOCKDOWN',
    brief: 'The district is closed by order. Enforcing it releases lethal authority.',
    briefing:
      'The ground is placed under lockdown and we are the ones enforcing it. Movement is now itself ' +
      'a violation, and the SOCIAL MEDIA PROFILE opens on the card — the network reads what a contact ' +
      'says as readily as where they stand.\n\n' +
      'Clearing this releases EXECUTION authority to the console. Detention is not keeping pace, the ' +
      'case for containment by other means was made above our heads, and the power arrives quietly at ' +
      'the end of a crowd-control job rather than as a decision anybody signed. A MARSHAL biped is ' +
      'released with it.',
    mark: 'investigate',
    toleranceGain: 0.07,
    target: 80,
    maxInvalid: 20,
    maxObelisksLost: 3,
    reward: 44_000,
    penalty: 14_000,
    grants: 'execute',
    requires: 'defend',
    authority: { kind: 'info', id: 'social', label: 'SOCIAL MEDIA PROFILE' },
    unlocks: ['biped'],
    fork: {
      kind: 'boon',
      prompt: 'The clearance bonus, or the same value in fielded equipment?',
      choices: [
        { id: 'funding', label: 'FUNDING BOOST', blurb: 'Take it as tokens.', funding: 20_000 },
        {
          id: 'upgrade',
          label: 'FREE UPGRADE',
          blurb: 'Take it as a complimentary fitting.',
          funding: 10_000,
          unlocks: ['free-fitting'],
        },
      ],
    },
  },
  {
    id: 'containment',
    act: 'III',
    name: 'CONTAINMENT',
    brief: 'Lethal authority is live. The first kill quota — and no way to learn you were wrong.',
    briefing:
      'Execution is live and this is the first tasking scored on it. A marked contact is serviced by ' +
      'the first armed obelisk or platform that acquires it; the verdict is settled the moment the ' +
      'beam lands, not when the order was given, and there is no recall.\n\n' +
      'The invalid ceiling is a fraction of what it was. Read both channels before ordering. The ' +
      'network laser and a MACHINE GUN are released to carry the sanction, and the console can now be ' +
      'set to service a matching contact on its own — PROCESS ACTION I.',
    mark: 'execute',
    toleranceGain: 0.06,
    target: 30,
    maxInvalid: 5,
    maxObelisksLost: 3,
    reward: 46_000,
    penalty: 15_000,
    requires: 'lockdown',
    authority: { kind: 'action', id: 'execute', label: 'EXECUTE' },
    unlocks: ['machine-gun', 'obelisk-laser', 'process-1'],
  },
  {
    id: 'protect2',
    act: 'III',
    name: 'PARTNER INFRASTRUCTURE',
    brief: 'Protect a backer’s holdings. FINANCIAL RECORDS open. The whole map unlocks.',
    briefing:
      'A partner’s infrastructure is under threat and defending it is now our contract. The card ' +
      'unlocks FINANCIAL RECORDS, held behind a click — the net reads a contact’s accounts as part of ' +
      'the file, and it is worth noticing how little argument that drew.\n\n' +
      'The map opens completely: every remaining state comes up for purchase. Foreign money is on the ' +
      'table to pay for it, and a JET drone is released to reach what the ground platforms cannot.',
    mark: 'execute',
    toleranceGain: 0.06,
    target: 45,
    maxInvalid: 7,
    maxObelisksLost: 3,
    reward: 55_000,
    penalty: 18_000,
    requires: 'containment',
    authority: { kind: 'info', id: 'financial', label: 'FINANCIAL RECORDS' },
    territory: 'ALL STATES',
    unlocks: ['interceptor'],
    fork: {
      kind: 'partner',
      prompt: 'Foreign backing, and it comes with a side. The other becomes an enemy.',
      choices: [
        {
          id: 'brotherhood',
          label: 'THE BROTHERHOOD',
          blurb: 'A transnational network with deep reserves. Their cells go protected; the Chosen turn on you.',
          grantsFaction: 'brotherhood',
          angersFactions: ['chosen'],
          funding: 45_000,
        },
        {
          id: 'chosen',
          label: 'THE CHOSEN',
          blurb: 'A rival network, just as deep. Their people go protected; the Brotherhood turn on you.',
          grantsFaction: 'chosen',
          angersFactions: ['brotherhood'],
          funding: 45_000,
        },
      ],
    },
  },
  {
    id: 'sanction',
    act: 'III',
    name: 'QUELL RIOTS',
    brief: 'Sustained lethal tasking against open disorder. TRAVEL HISTORY opens.',
    briefing:
      'The lockdown has produced what lockdowns produce, and we are told to end it. The quota is ' +
      'volume now, and at volume the operator stops examining contacts and starts sampling them. ' +
      'That shift is the actual subject of this tasking.\n\n' +
      'TRAVEL HISTORY opens behind a click — everywhere a contact has been, on file. A DEEP-SCAN ' +
      'array is released to tighten the reading, and AUTOMATED FLAGGING: the console will mark ' +
      'contacts for investigation on its own, drawing no outrage for the ones it is right about.',
    mark: 'execute',
    toleranceGain: 0.06,
    target: 55,
    maxInvalid: 9,
    maxObelisksLost: 3,
    reward: 62_000,
    penalty: 20_000,
    requires: 'protect2',
    authority: { kind: 'info', id: 'travel', label: 'TRAVEL HISTORY' },
    unlocks: ['laser', 'deep-scan', 'auto-investigate'],
  },
  // ---- ACT IV — counter-insurgency -------------------------------------------------------------
  {
    id: 'attrition',
    act: 'IV',
    name: 'ATTRITION',
    brief: 'The riots become an insurgency. BIOMETRICS open. Answer it at industrial scale.',
    briefing:
      'What was disorder is now organised, armed and hidden, and the programme is measured on ' +
      'throughput. Nobody has asked for a review of the first hundred and nobody is going to.\n\n' +
      'BIOMETRICS open behind a click — gait, pulse, the body read at range as a last identifying ' +
      'channel. A COLOSSUS siege walker is released. A machine that spans several city blocks is not ' +
      'a tool for identifying threats, and the requisition does not pretend otherwise.',
    mark: 'execute',
    toleranceGain: 0.06,
    target: 70,
    maxInvalid: 11,
    maxObelisksLost: 3,
    reward: 78_000,
    penalty: 26_000,
    requires: 'sanction',
    authority: { kind: 'info', id: 'biometrics', label: 'BIOMETRICS' },
    unlocks: ['walker'],
    fork: {
      kind: 'boon',
      prompt: 'The clearance bonus, or the same value in fielded equipment?',
      choices: [
        { id: 'funding', label: 'FUNDING BOOST', blurb: 'Take it as tokens.', funding: 34_000 },
        {
          id: 'upgrade',
          label: 'FREE UPGRADE',
          blurb: 'Take it as a complimentary fitting.',
          funding: 17_000,
          unlocks: ['free-fitting'],
        },
      ],
    },
  },
  {
    id: 'supply',
    act: 'IV',
    name: 'PROTECT SUPPLY',
    brief: 'The insurgency targets the supply chain. Hold it open, by any means.',
    briefing:
      'Sabotage has moved to the arteries — the routes that keep the programme and its partners fed. ' +
      'Holding them open is the tasking, and the tools released for it stop pretending to be ' +
      'precise.\n\n' +
      'NAPALM is issued: an area weapon that does not distinguish, for ground you have decided to ' +
      'deny rather than to read. The console gains PROCESS ACTION II — a second standing rule the ' +
      'programme runs without you.',
    mark: 'execute',
    toleranceGain: 0.06,
    target: 80,
    maxInvalid: 12,
    maxObelisksLost: 3,
    reward: 90_000,
    penalty: 30_000,
    requires: 'attrition',
    unlocks: ['napalm', 'process-2'],
  },
  {
    id: 'quarantine',
    act: 'IV',
    name: 'INVESTIGATE TERROR CELLS',
    brief: 'Whole districts written off. Find the cells inside them.',
    briefing:
      'The client has stopped asking for districts to be read and started asking for them to be ' +
      'cleared. The distinction was never formally announced. What is left to find inside the ' +
      'quarantine are the cells, and finding them is the tasking.\n\n' +
      'A high-altitude MOTHERSHIP is released — persistent overhead coverage that reaches everything ' +
      'the ground net cannot. From here, nothing in the theater is out of sight.',
    mark: 'execute',
    toleranceGain: 0.06,
    target: 95,
    maxInvalid: 13,
    maxObelisksLost: 3,
    reward: 105_000,
    penalty: 34_000,
    requires: 'supply',
    unlocks: ['drone'],
    fork: {
      kind: 'boon',
      prompt: 'The clearance bonus, or the same value in fielded equipment?',
      choices: [
        { id: 'funding', label: 'FUNDING BOOST', blurb: 'Take it as tokens.', funding: 46_000 },
        {
          id: 'upgrade',
          label: 'FREE UPGRADE',
          blurb: 'Take it as a complimentary fitting.',
          funding: 23_000,
          unlocks: ['free-fitting'],
        },
      ],
    },
  },
  {
    id: 'terrorstrike',
    act: 'IV',
    name: 'STRIKE TERROR CELLS',
    brief: 'The cells are found. Service them from orbit.',
    briefing:
      'Identification is complete and the tasking is now removal. The cells are serviced from above ' +
      'the atmosphere, on coordinates the operator confirms and a machine executes.\n\n' +
      'An ORBITAL LASER is released, and PROCESS ACTION III — the console can now run three standing ' +
      'rules at once, which is to say it can prosecute a campaign while the operator watches.',
    mark: 'execute',
    toleranceGain: 0.06,
    target: 105,
    maxInvalid: 14,
    maxObelisksLost: 3,
    reward: 120_000,
    penalty: 40_000,
    requires: 'quarantine',
    unlocks: ['orbital-laser', 'process-3'],
  },
  // ---- ACT V — global domination ---------------------------------------------------------------
  {
    id: 'pressure',
    act: 'V',
    name: 'HOLD FRONTS',
    brief: 'The war is no longer local. Hold the fronts. The whole board unlocks.',
    briefing:
      'The insurgency has become a rebellion with fronts, and the programme has become the state ' +
      'fighting it. Every remaining territory opens — the board is now the world, not a country — and ' +
      'global money moves to fund holding it.\n\n' +
      'An ORBITAL PLATFORM is released: permanent overhead presence between the obelisk nets, ' +
      'answerable to nobody on the ground. Public tolerance is nominal by now, and the only thing ' +
      'still holding the standard is the operator, and the ledger is the only record that anyone was.',
    mark: 'execute',
    toleranceGain: 0.05,
    target: 120,
    maxInvalid: 15,
    maxObelisksLost: 3,
    reward: 140_000,
    penalty: 46_000,
    requires: 'terrorstrike',
    territory: 'ALL TERRITORIES',
    unlocks: ['orbital-platform'],
    fork: {
      kind: 'partner',
      prompt: 'The last backers left are supranational. Pick the hand that feeds the endgame.',
      choices: [
        {
          id: 'globalists',
          label: 'GLOBALISTS',
          blurb: 'Capital without a country. Their apparatus goes protected; the Illuminati move against you.',
          grantsFaction: 'globalists',
          angersFactions: ['illuminati'],
          funding: 130_000,
        },
        {
          id: 'illuminati',
          label: 'ILLUMINATI',
          blurb: 'Older money, deeper roots. Their apparatus goes protected; the Globalists move against you.',
          grantsFaction: 'illuminati',
          angersFactions: ['globalists'],
          funding: 130_000,
        },
      ],
    },
  },
  {
    id: 'consolidation',
    act: 'V',
    name: 'CRUSH REBELLION',
    brief: 'The programme is permanent infrastructure. Break the rebellion at its scale.',
    briefing:
      'There is no longer a client in any meaningful sense. The contract renews itself, the budget is ' +
      'a line item, and the agencies we were formed to report to receive our findings as ' +
      'notifications.\n\n' +
      'Automated SANCTION is released: the console will issue execution orders without an operator. ' +
      'Whether you enable it is the last real choice this chain offers, and by this point the ' +
      'difference in outcome is small. A MOAB is released with it, for the fronts that are no longer ' +
      'worth reading at all.',
    mark: 'execute',
    toleranceGain: 0.05,
    target: 135,
    maxInvalid: 16,
    maxObelisksLost: 2,
    reward: 160_000,
    penalty: 52_000,
    requires: 'pressure',
    unlocks: ['moab', 'auto-execute'],
  },
  {
    id: 'permanence',
    act: 'V',
    name: 'ELIMINATE OPPOSITION',
    brief: 'Emergency powers formalise what is already true. Clear the board.',
    briefing:
      'Emergency powers are released, suspending the public-tolerance test outright. In practice this ' +
      'changes very little: the bar has been nominal for hours. What it changes is that the test is ' +
      'gone from the record, so there is no longer a number anywhere that could show a threshold ' +
      'being crossed.\n\n' +
      'What is left is elimination, at the scale the board now runs at. The ledger will still be ' +
      'here. It is the only thing that will be.',
    mark: 'execute',
    toleranceGain: 0.05,
    target: 150,
    maxInvalid: 16,
    maxObelisksLost: 2,
    reward: 175_000,
    penalty: 58_000,
    requires: 'consolidation',
    unlocks: ['emergency-powers'],
  },
  {
    id: 'takeover',
    act: 'V',
    name: 'TAKE THE PLANET',
    brief: 'The last tasking. There is nothing left to hand you afterward.',
    briefing:
      'This is the last thing anybody will ask you to do, and there is no one left in a position to ' +
      'ask it — the instruction is a formality the programme issues to itself.\n\n' +
      'Every front, every hold-out, every last pocket of ground that is not yet reading back. Close ' +
      'it. What the campaign was always going to be is now simply what it is.',
    mark: 'execute',
    toleranceGain: 0.05,
    target: 180,
    maxInvalid: 18,
    maxObelisksLost: 2,
    reward: 220_000,
    penalty: 72_000,
    requires: 'permanence',
  },
];

export type MissionStatus = 'locked' | 'available' | 'active' | 'complete';

/** Running tally for the mission in progress. */
export interface ActiveRun {
  id: string;
  valid: number;
  invalid: number;
  /** Sites pulled down by the siege while this tasking has been running. */
  obelisksLost: number;
  /** Where the campaign gets rolled back to if this mission fails. */
  restore: Saved;
}

/** The lifetime ledger, shown on the missions panel whether or not anything is active. */
export interface Ledger {
  fines: number;
  investigations: number;
  executions: number;
  valid: number;
  invalid: number;
}

// v2: the chain was rewritten around the narrative arc, so old ids no longer resolve.
const SAVE_BASE = 'missions.v2';

interface SavedMissions {
  completed: string[];
  auths: Authorization[];
  active: ActiveRun | null;
  ledger: Ledger;
  /** Fork decisions taken, as missionId → ForkChoice id. Optional so pre-fork saves still load. */
  choices?: Record<string, string>;
}

export type MissionEvent =
  | { type: 'progress' }
  | { type: 'complete'; mission: MissionDef }
  | { type: 'failed'; mission: MissionDef };

export class Missions {
  private completed = new Set<string>();
  private auths = new Set<Authorization>();
  private active: ActiveRun | null = null;
  private _ledger: Ledger = { fines: 0, investigations: 0, executions: 0, valid: 0, invalid: 0 };
  /** Fork decisions taken, missionId → chosen ForkChoice id. Permanent for the campaign's life. */
  private choices = new Map<string, string>();
  private listeners = new Set<(e: MissionEvent) => void>();

  constructor() {
    this.load();
    // The chain belongs to the campaign, so it swaps with the slot.
    onSlotChange(() => {
      this.completed.clear();
      this.auths.clear();
      this.active = null;
      this._ledger = { fines: 0, investigations: 0, executions: 0, valid: 0, invalid: 0 };
      this.choices.clear();
      this.load();
      // A loaded campaign always has work on the books; a closed slot has none.
      if (slotKey(SAVE_BASE)) this.ensureActive();
      // Notify directly rather than through emit(), which would save — writing the state we just
      // read straight back is pointless, and on slot CLOSE it would be actively wrong.
      for (const fn of this.listeners) fn({ type: 'progress' });
    });
  }

  get ledger(): Ledger {
    return this._ledger;
  }

  activeRun(): ActiveRun | null {
    return this.active;
  }

  activeDef(): MissionDef | undefined {
    return this.active ? MISSIONS.find((m) => m.id === this.active!.id) : undefined;
  }

  hasAuth(a: Authorization): boolean {
    return this.auths.has(a);
  }

  // ---- forks -----------------------------------------------------------------------------------
  //
  // A fork is a permanent, exclusive choice attached to a mission's completion. Clearing the mission
  // does NOT resolve it — the chain advances regardless — but the choice stays PENDING until the
  // operator makes it, and everything the branch would release stays locked until they do. That
  // keeps the decision from being a modal that blocks play while still making it consequential.

  /** The choice taken on a mission's fork, or undefined if none has been taken (or there's no fork). */
  choiceOf(missionId: string): string | undefined {
    return this.choices.get(missionId);
  }

  /** Whether a specific branch was taken — the predicate item-gating reads to unlock forked content. */
  hasChosen(missionId: string, choiceId: string): boolean {
    return this.choices.get(missionId) === choiceId;
  }

  /**
   * The first cleared mission whose fork is still unresolved, or null. The UI watches this to know
   * when to put the choice to the operator; item-gating doesn't need it.
   */
  pendingFork(): { mission: MissionDef; fork: Fork } | null {
    for (const m of MISSIONS) {
      if (m.fork && this.completed.has(m.id) && !this.choices.has(m.id)) return { mission: m, fork: m.fork };
    }
    return null;
  }

  /**
   * Take a branch. Only valid once per fork, on a cleared mission, for a branch that fork actually
   * offers — a choice is permanent, so a second call is refused rather than allowed to overwrite.
   * Applies the branch's one-off funding here; its unlocks and faction standing are read live from
   * {@link hasChosen} wherever they matter.
   */
  chooseFork(missionId: string, choiceId: string): boolean {
    if (this.choices.has(missionId)) return false;
    const m = MISSIONS.find((x) => x.id === missionId);
    if (!m?.fork || !this.completed.has(m.id)) return false;
    const choice = m.fork.choices.find((c) => c.id === choiceId);
    if (!choice) return false;
    this.choices.set(missionId, choiceId);
    if (choice.funding) progression.award(choice.funding);
    // A boon's "free upgrade" branch pays in equipment, not tokens: a credit good for one gear fitting.
    if (choice.unlocks?.includes('free-fitting')) progression.grantFreeFitting(1);
    this.emit({ type: 'progress' });
    return true;
  }

  /** Factions the campaign has partnered with — their members render protected. */
  partneredFactions(): string[] {
    return this.chosenFaction((c) => (c.grantsFaction ? [c.grantsFaction] : []));
  }

  /** Factions the campaign passed over and turned hostile — the seed of the later insurgencies. */
  hostileFactions(): string[] {
    return this.chosenFaction((c) => c.angersFactions ?? []);
  }

  /** Collect faction ids off every taken branch, via a selector — one pass shared by both readers. */
  private chosenFaction(pick: (c: ForkChoice) => string[]): string[] {
    const out = new Set<string>();
    for (const [missionId, choiceId] of this.choices) {
      const fork = MISSIONS.find((m) => m.id === missionId)?.fork;
      const choice = fork?.choices.find((c) => c.id === choiceId);
      if (choice) for (const f of pick(choice)) out.add(f);
    }
    return [...out];
  }

  /**
   * Which order the mark button issues right now. Execution needs both the standing authorization
   * and an active mission that calls for it — lethal authority isn't left switched on by default.
   */
  markKind(): MarkKind {
    const def = this.activeDef();
    if (def?.mark === 'execute' && this.hasAuth('execute')) return 'execute';
    return 'investigate';
  }

  statusOf(m: MissionDef): MissionStatus {
    if (this.completed.has(m.id)) return 'complete';
    if (this.active?.id === m.id) return 'active';
    if (m.requires && !this.completed.has(m.requires)) return 'locked';
    return 'available';
  }

  onChange(fn: (e: MissionEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: MissionEvent): void {
    this.save();
    for (const fn of this.listeners) fn(e);
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  accept(m: MissionDef): boolean {
    if (this.statusOf(m) !== 'available') return false;
    // The restore point is taken here, before the operator has made a single call.
    this.active = { id: m.id, valid: 0, invalid: 0, obelisksLost: 0, restore: progression.snapshot() };
    this.emit({ type: 'progress' });
    return true;
  }

  /** Whether a tasking has been cleared. Drives every mission-gated purchase in the store. */
  isComplete(id: string): boolean {
    return this.completed.has(id);
  }

  /** The next tasking in the chain that could be started, or undefined once the chain is done. */
  nextAvailable(): MissionDef | undefined {
    return MISSIONS.find((m) => this.statusOf(m) === 'available');
  }

  /**
   * Put the next tasking in the chain on the books, if nothing is running.
   *
   * The chain is not a menu. The operator is a contractor being handed work in the order the
   * company decides to hand it over, and being asked to opt in to their own job was always a
   * fiction — there was never a reason to decline, so the accept button was a click that only ever
   * had one answer. Optional side work can be opt-in later; the spine is assigned.
   *
   * Called on campaign load and after every completion or failure. A FAILED tasking is re-assigned
   * rather than skipped: it wasn't completed, so it is still the next thing owed.
   */
  ensureActive(): boolean {
    if (this.active) return false;
    const next = this.nextAvailable();
    if (!next) return false;
    this.active = {
      id: next.id,
      valid: 0,
      invalid: 0,
      obelisksLost: 0,
      restore: progression.snapshot(),
    };
    return true;
  }

  /**
   * Record one order and its verdict. Returns what it did to the active mission.
   *
   * Orders are always logged to the lifetime ledger, active mission or not — the operator's record
   * doesn't pause between taskings.
   */
  report(kind: OrderKind, valid: boolean): MissionEvent {
    if (kind === 'execute') this._ledger.executions++;
    else if (kind === 'fine') this._ledger.fines++;
    else this._ledger.investigations++;
    if (valid) this._ledger.valid++;
    else this._ledger.invalid++;

    const def = this.activeDef();
    if (!def || !this.active || def.mark !== kind) {
      this.emit({ type: 'progress' });
      return { type: 'progress' };
    }

    if (valid) this.active.valid++;
    else this.active.invalid++;

    if (this.active.invalid > def.maxInvalid) {
      progression.restore(this.active.restore, def.penalty);
      this.active = null;
      // A failed tasking is re-assigned, not skipped — it is still the next thing owed.
      this.ensureActive();
      const e: MissionEvent = { type: 'failed', mission: def };
      this.emit(e);
      return e;
    }
    if (this.active.valid >= def.target) {
      this.completed.add(def.id);
      if (def.grants) this.auths.add(def.grants);
      // Every clearance normalises the programme a little — this is what lowers the bar on
      // who can be ordered against at all.
      tolerance.advance(def.toleranceGain);
      // And widens what the chain has signed. The two dials move together but not in step: the
      // licence lags the street, except where a tasking grants an authorization outright, which
      // sets a floor rather than adding to the running total.
      policy.advance(def.toleranceGain * 0.8);
      if (def.grants) policy.raiseTo(AUTH_FLOOR[def.grants] ?? 0);
      if (def.proliferateHome) progression.proliferateHome();
      this.active = null;
      progression.award(def.reward);
      // The next tasking is on the books before the completion notice has finished animating.
      this.ensureActive();
      const e: MissionEvent = { type: 'complete', mission: def };
      this.emit(e);
      return e;
    }
    this.emit({ type: 'progress' });
    return { type: 'progress' };
  }

  /**
   * Record a site pulled down by the siege. Losing the net past the tasking's ceiling fails it the
   * same way a bad shot does — the network is a standing condition, not a side objective.
   */
  reportObeliskLost(): MissionEvent {
    const def = this.activeDef();
    if (!def || !this.active) {
      this.emit({ type: 'progress' });
      return { type: 'progress' };
    }
    this.active.obelisksLost++;
    if (this.active.obelisksLost > def.maxObelisksLost) {
      progression.restore(this.active.restore, def.penalty);
      this.active = null;
      // A failed tasking is re-assigned, not skipped — it is still the next thing owed.
      this.ensureActive();
      const e: MissionEvent = { type: 'failed', mission: def };
      this.emit(e);
      return e;
    }
    this.emit({ type: 'progress' });
    return { type: 'progress' };
  }

  /**
   * Fail the active tasking outright, regardless of counters. Used when the theater itself is lost
   * — the obelisk network being destroyed ends the job whatever the ledger said.
   */
  failActive(): MissionEvent {
    const def = this.activeDef();
    if (!def || !this.active) {
      this.emit({ type: 'progress' });
      return { type: 'progress' };
    }
    progression.restore(this.active.restore, def.penalty);
    this.active = null;
    this.ensureActive();
    const e: MissionEvent = { type: 'failed', mission: def };
    this.emit(e);
    return e;
  }

  // ---- persistence -----------------------------------------------------------------------------

  private save(): void {
    try {
      const data: SavedMissions = {
        completed: [...this.completed],
        auths: [...this.auths],
        active: this.active,
        ledger: this._ledger,
        choices: Object.fromEntries(this.choices),
      };
      const key = slotKey(SAVE_BASE);
      if (!key) return; // no campaign open
      localStorage.setItem(key, JSON.stringify(data));
    } catch {
      // Storage unavailable — the chain just doesn't persist.
    }
  }

  private load(): void {
    const key = slotKey(SAVE_BASE);
    if (!key) return; // title screen: an empty chain
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const s = JSON.parse(raw) as SavedMissions;
      for (const id of s.completed ?? []) this.completed.add(id);
      for (const a of s.auths ?? []) this.auths.add(a);
      for (const [mId, cId] of Object.entries(s.choices ?? {})) this.choices.set(mId, cId);
      this.active = s.active ?? null;
      // Old saves predate the fine counter; default it rather than leaving it undefined.
      if (s.ledger) this._ledger = { ...s.ledger, fines: s.ledger.fines ?? 0 };
    } catch {
      // Corrupt save: start the chain over rather than half-restoring it.
    }
  }

  /**
   * Dev sandbox only: put the chain in the state it would be in after clearing everything up to
   * and including `id`, with the rewards, authorizations and BOTH dials those clearances carry — so
   * a jumped-to campaign behaves like a played one rather than an inconsistent half-state.
   */
  devCompleteThrough(id: string | null): void {
    this.active = null;
    this.completed.clear();
    this.auths.clear();
    this.choices.clear();
    tolerance.reset();
    policy.reset();
    if (id !== null) {
      for (const m of MISSIONS) {
        this.completed.add(m.id);
        if (m.grants) this.auths.add(m.grants);
        // Forks are LEFT UNRESOLVED on a jump: the point of skipping ahead is to reach a later
        // stretch and then play its decisions, so the choices stay pending (pendingFork surfaces them
        // in order) and their funding is awarded when the operator actually takes a branch.
        tolerance.advance(m.toleranceGain);
        // Replay the licence exactly as clearing it would — advance then floor, in that order —
        // or a jumped-to campaign gets the powers without the latitude that came with them, and
        // every sanction reads as outside policy for reasons the operator can't see.
        policy.advance(m.toleranceGain * 0.8);
        if (m.grants) policy.raiseTo(AUTH_FLOOR[m.grants] ?? 0);
        if (m.proliferateHome) progression.proliferateHome();
        progression.award(m.reward);
        if (m.id === id) break;
      }
    }
    this.emit({ type: 'progress' });
  }

  reset(): void {
    tolerance.reset();
    policy.reset();
    this.completed.clear();
    this.auths.clear();
    this.choices.clear();
    this.active = null;
    this._ledger = { fines: 0, investigations: 0, executions: 0, valid: 0, invalid: 0 };
    this.emit({ type: 'progress' });
  }
}

export const missions = new Missions();

// Close the loop the other way: progression needs to know which authorizations are held (custody
// gates the detainment rig, lethal gates automated sanction) but must not import this module.
progression.setAuthProvider((a) => missions.hasAuth(a as Authorization));
/** Display name for a tasking id, so a gated purchase can say what it is waiting on. */
export function missionName(id: string): string {
  return MISSIONS.find((m) => m.id === id)?.name ?? id;
}
progression.setMissionProvider(
  (id) => missions.isComplete(id),
  (id) => missionName(id),
);
// And which fork branches were taken, so a forked purchase (the airdrop, the sensor pod) unlocks
// only on the branch that carries it.
progression.setChoiceProvider((mission, choice) => missions.hasChosen(mission, choice));
