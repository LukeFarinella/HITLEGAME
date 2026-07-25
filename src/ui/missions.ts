import { MISSIONS, missions, type Fork, type MissionDef } from '../game/missions';
import { unlockName } from '../game/catalog';
import { icon } from './icons';
import { tolerance, toleranceLabel } from '../game/tolerance';
import { policy, policyLabel } from '../game/policy';
import { resistance, resistanceLabel } from '../game/resistance';

/**
 * The tasking panel: the mission chain on the right rail of the theater-select screen, mirroring
 * the command store on the left.
 *
 * One mission runs at a time. The active one is pinned at the top with its two counters — valid
 * marks toward the quota, invalid marks toward the ceiling — because those two numbers are the
 * only score the operator is kept to.
 */

const fmt = new Intl.NumberFormat('en-US');

/** What a tasking's quota is counted in — the mark it's scored on, pluralised for the objective line. */
const QUOTA_VERB: Record<string, string> = {
  fine: 'FINES',
  investigate: 'INVESTIGATIONS',
  execute: 'EXECUTIONS',
};
/** The order-mode badge for a tasking, by the mark it runs on. */
const MODE_LABEL: Record<string, string> = {
  fine: 'ENFORCE',
  investigate: 'SURVEIL',
  execute: 'LETHAL',
};

/** The arc, named per act — the theme evolving from citations to occupation. */
const ACT_TITLE: Record<string, string> = {
  I: 'TRAFFIC ENFORCEMENT',
  II: 'CUSTODY',
  III: 'LETHAL FORCE',
  IV: 'COUNTER-INSURGENCY',
  V: 'GLOBAL DOMINATION',
};

/**
 * The public-tolerance readout: a thin bar sharing the valid/invalid stack, because it belongs to
 * the same question — not "how am I doing" but "what am I allowed to do".
 */
function toleranceBar(): string {
  const pct = Math.round(tolerance.level * 100);
  const pol = Math.round(policy.level * 100);
  // Both dials, stacked, because every decision in the theater is read against both and showing one
  // of them here was quietly teaching that there is only one. The old caption named a single case
  // percentage that orders "need" — there is no such number any more: what a call needs depends on
  // which rung it is and who it is against.
  return (
    `<div class="c2-bar-row tolerance"><span class="c2-bar-k">PUBLIC</span>` +
    `<span class="c2-bar thin"><i class="tol" style="width:${pct}%"></i></span>` +
    `<span class="c2-bar-v">${pct}%</span></div>` +
    `<div class="c2-bar-row policy"><span class="c2-bar-k">POLICY</span>` +
    `<span class="c2-bar thin"><i class="pol" style="width:${pol}%"></i></span>` +
    `<span class="c2-bar-v">${pol}%</span></div>` +
    `<div class="c2-tol-note">${toleranceLabel(tolerance.level)} STREET · ${policyLabel(policy.level)} LICENCE</div>` +
    resistanceBar()
  );
}

/**
 * The resistance readout, directly under tolerance because the two are a pair: tolerance is what
 * the public will accept, resistance is what it costs when you go past it. Rising resistance means
 * more attacks on the net and more hiding out in unwatched ground.
 */
function resistanceBar(): string {
  const pct = Math.round(resistance.level * 100);
  const mult = resistance.pressure;
  return (
    `<div class="c2-bar-row tolerance"><span class="c2-bar-k">GROUND</span>` +
    `<span class="c2-bar thin"><i class="res" style="width:${pct}%"></i></span>` +
    `<span class="c2-bar-v">${pct}%</span></div>` +
    `<div class="c2-tol-note">${resistanceLabel(resistance.level)} · ${mult.toFixed(1)}× ATTACKS &amp; CELLS</div>`
  );
}

export interface MissionHooks {
  /** A mission started, finished or failed — the scene re-reads authorizations and re-renders. */
  onChange(): void;
  /** Surface a one-line notice on the globe (a failure). */
  notify(msg: string): void;
  /** A tasking was CLEARED — the scene raises the completion window and plays the reward. */
  onComplete(mission: MissionDef): void;
}

export class MissionPanel {
  private root: HTMLElement;
  private activeEl: HTMLElement;
  private ledgerEl: HTMLElement;
  private listEl: HTMLElement;
  /** Accordion open state, kept across the re-render that every order triggers. */
  private briefingOpen = false;

  constructor(private hooks: MissionHooks) {
    this.root = document.getElementById('c2-tasking')!;
    this.activeEl = document.getElementById('c2-active')!;
    this.ledgerEl = document.getElementById('c2-ledger-line')!;
    this.listEl = document.getElementById('c2-mission-list')!;

    document.getElementById('c2-tasking-collapse')?.addEventListener('click', () => {
      this.root.classList.toggle('collapsed');
    });

    tolerance.onChange(() => this.render());
    resistance.onChange(() => this.render());

    missions.onChange((e) => {
      if (e.type === 'complete') {
        this.hooks.onComplete(e.mission);
      } else if (e.type === 'failed') {
        this.hooks.notify(
          `MISSION FAILED · ${e.mission.name} · CAMPAIGN ROLLED BACK · −${fmt.format(e.mission.penalty)} FUNDING TOKENS`,
        );
      }
      this.render();
      this.hooks.onChange();
    });

    this.render();
  }

  render(): void {
    this.renderActive();
    this.renderLedger();
    this.renderList();
  }

  /**
   * The active tasking.
   *
   * Three parts, in the order they matter: what this job is called, the OBJECTIVE STEPS with live
   * progress against each, and the narrative behind an accordion. The steps are the operative
   * content — an operator mid-theater needs "8 of 20, two errors left" at a glance, not prose — so
   * the prose folds away and stays folded until it's asked for.
   */
  /**
   * The pending fork, if one is owed.
   *
   * A fork is a permanent, exclusive choice: a backer to partner with, or a capability that closes
   * the other off. It surfaces the moment the mission it hangs off is cleared and stays until the
   * operator commits, so it reads as a decision rather than a reward that scrolled past.
   */
  private renderFork(): HTMLElement | null {
    const pending = missions.pendingFork();
    if (!pending) return null;
    const { mission, fork } = pending;

    const box = document.createElement('div');
    box.className = `c2-fork kind-${fork.kind}`;
    box.innerHTML =
      `<div class="c2-fork-head">${icon('surveil')}DECISION · ${mission.name}</div>` +
      `<p class="c2-fork-prompt">${fork.prompt}</p>`;

    const choices = document.createElement('div');
    choices.className = 'c2-fork-choices';
    for (const c of fork.choices) {
      // The consequences, spelled out — what it pays, what it releases, and (for a partner) that it
      // makes a permanent enemy. A choice this final should never be made blind.
      const bits: string[] = [];
      if (c.funding) bits.push(`+${fmt.format(c.funding)} TOKENS`);
      if (c.unlocks?.length) bits.push(`RELEASES ${c.unlocks.map(unlockName).join(' · ')}`);
      if (c.grantsFaction) bits.push('PROTECTS A FACTION');
      if (c.angersFactions?.length) bits.push('MAKES AN ENEMY');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'c2-fork-choice';
      btn.innerHTML =
        `<span class="c2-fork-label">${c.label}</span>` +
        `<span class="c2-fork-blurb">${c.blurb}</span>` +
        (bits.length ? `<span class="c2-fork-bits">${bits.join(' · ')}</span>` : '');
      btn.addEventListener('click', () => {
        if (missions.chooseFork(mission.id, c.id)) this.hooks.notify(`DECISION TAKEN · ${c.label}`);
      });
      choices.append(btn);
    }
    box.append(choices);
    return box;
  }

  private renderActive(): void {
    const def = missions.activeDef();
    const run = missions.activeRun();
    this.activeEl.replaceChildren();

    // A cleared tasking's fork sits ABOVE whatever is now running — it's a decision owed on the last
    // job, and it should be the first thing the operator sees until it's made.
    const fork = this.renderFork();
    if (fork) this.activeEl.append(fork);

    if (!def || !run) {
      // The whole chain is cleared. Tolerance and resistance are campaign state, not tasking
      // state, so they stay up with nothing running.
      const idle = document.createElement('div');
      idle.innerHTML =
        `<p class="c2-note">CHAIN CLEARED · NO FURTHER TASKING</p>` +
        `<div class="c2-active c2-idle">${toleranceBar()}</div>`;
      this.activeEl.append(idle);
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'c2-active';

    const verb = QUOTA_VERB[def.mark] ?? 'ORDERS';
    wrap.innerHTML =
      `<div class="c2-active-head">` +
      `<span class="c2-name">${icon(def.mark === 'execute' ? 'lethal' : 'surveil')}${def.name}</span>` +
      `<span class="c2-order order-${def.mark}">${MODE_LABEL[def.mark] ?? ''}</span>` +
      `</div>` +
      `<div class="c2-obj-label">OBJECTIVES</div>` +
      this.step(
        `${def.target} valid ${verb.toLowerCase()}`,
        run.valid,
        def.target,
        'ok',
        run.valid >= def.target,
      ) +
      // The failure conditions are counted UP toward their ceiling rather than down from it: a
      // player reading "2 / 3" understands they have one left; "1 remaining" reads as a budget.
      this.step(`Stay under ${def.maxInvalid + 1} invalid`, run.invalid, def.maxInvalid, 'bad', false) +
      this.step(
        `Hold the net · max ${def.maxObelisksLost} sites lost`,
        run.obelisksLost,
        def.maxObelisksLost,
        'bad',
        false,
      ) +
      toleranceBar();

    wrap.append(this.accordion(def));
    this.activeEl.append(wrap);
  }

  /**
   * One objective line: label, progress bar, count.
   *
   * `tone` is which way the bar reads — 'ok' bars fill toward success, 'bad' bars fill toward
   * failing the tasking. Both are shown the same way on purpose, because to the operator they are
   * the same kind of fact: a number moving toward a threshold that ends the job.
   */
  private step(label: string, at: number, of: number, tone: 'ok' | 'bad', done: boolean): string {
    const pct = Math.min(100, of > 0 ? (at / of) * 100 : 0);
    return (
      `<div class="c2-obj${done ? ' done' : ''}">` +
      `<div class="c2-obj-top"><span class="c2-obj-tick">${done ? '◈' : '○'}</span>` +
      `<span class="c2-obj-text">${label}</span>` +
      `<span class="c2-obj-count">${at} / ${of}</span></div>` +
      `<span class="c2-bar"><i class="${tone}" style="width:${pct}%"></i></span>` +
      `</div>`
    );
  }

  /**
   * The narrative, folded away.
   *
   * Open state is remembered across re-renders — this panel redraws on every order, and an
   * accordion that snapped shut mid-sentence each time a contact was flagged would be unreadable.
   */
  private accordion(def: MissionDef): HTMLElement {
    const box = document.createElement('div');
    box.className = 'c2-acc';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'c2-acc-head';
    head.innerHTML = `<span class="c2-acc-caret">▸</span><span>BRIEFING</span>`;

    const body = document.createElement('div');
    body.className = 'c2-acc-body';
    body.innerHTML =
      def.briefing
        .split('\n\n')
        .map((para) => `<p class="c2-modal-p">${para}</p>`)
        .join('') +
      `<div class="c2-modal-objectives">` +
      `<div><span>ON CLEARANCE</span><b>+${fmt.format(def.reward)} tokens · +${Math.round(def.toleranceGain * 100)}% tolerance</b></div>` +
      `<div><span>ON FAILURE</span><b>rollback · −${fmt.format(def.penalty)} tokens</b></div>` +
      (def.grants
        ? `<div><span>GRANTS</span><b>${def.grants === 'execute' ? 'lethal authority' : 'custody authority'}</b></div>`
        : '') +
      `</div>`;

    if (this.briefingOpen) box.classList.add('open');
    head.addEventListener('click', () => {
      this.briefingOpen = !this.briefingOpen;
      box.classList.toggle('open', this.briefingOpen);
    });

    box.append(head, body);
    return box;
  }

  private renderLedger(): void {
    const l = missions.ledger;
    const total = l.valid + l.invalid;
    const rate = total ? Math.round((l.valid / total) * 100) : 0;
    this.ledgerEl.innerHTML =
      `<span><b>${fmt.format(l.investigations)}</b> INV</span>` +
      `<span><b>${fmt.format(l.executions)}</b> EXEC</span>` +
      `<span class="${rate >= 70 ? 'ok' : 'bad'}"><b>${total ? rate : '—'}%</b> VALID</span>`;
  }

  private renderList(): void {
    this.listEl.replaceChildren();
    let act = '';
    for (const m of MISSIONS) {
      if (m.act !== act) {
        act = m.act;
        const h = document.createElement('div');
        h.className = 'c2-act-head';
        h.innerHTML = `<span class="c2-act-num">ACT ${act}</span><span class="c2-act-title">${ACT_TITLE[act] ?? ''}</span>`;
        this.listEl.append(h);
      }
      this.listEl.append(this.row(m));
    }
  }

  /**
   * One link in the chain — a progress readout, not a control.
   *
   * Nothing here is clickable any more. The chain is assigned in order, so a row's only job is to
   * say where the campaign is in it: what's done, what's running, what's still coming and what it
   * will ask for when it arrives.
   */
  private row(m: MissionDef): HTMLElement {
    const status = missions.statusOf(m);
    const row = document.createElement('div');
    row.className = `c2-row mission ${status}`;

    const head = document.createElement('div');
    head.className = 'c2-row-head';
    head.innerHTML =
      `<span class="c2-name">${icon(m.mark === 'execute' ? 'lethal' : 'surveil')}${m.name}</span>` +
      `<span class="c2-tier">${status === 'available' ? 'UPCOMING' : status.toUpperCase()}</span>`;
    row.append(head);

    // A locked mission's brief is withheld: what the company wants next is not the operator's to
    // read ahead on, and it keeps the chain's turns as turns.
    if (status !== 'locked') {
      const brief = document.createElement('p');
      brief.className = 'c2-blurb';
      brief.textContent = m.brief;
      row.append(brief);
    }

    const meta = document.createElement('div');
    meta.className = 'c2-meta';
    const verb = QUOTA_VERB[m.mark] ?? 'ORDERS';
    meta.innerHTML = `<span>${m.target} VALID ${verb}</span><span>MAX ${m.maxInvalid} INVALID</span>`;
    row.append(meta);

    const pay = document.createElement('div');
    pay.className = 'c2-meta';
    pay.innerHTML =
      `<span class="ok">+${fmt.format(m.reward)} TOKENS</span>` +
      `<span class="bad">FAIL −${fmt.format(m.penalty)}</span>`;
    row.append(pay);

    // What clearing it actually opens up. Money is the least interesting half of a reward, and a
    // locked catalog entry is far more legible when the thing that unlocks it says so first.
    // The design sheet's four columns, each surfaced as its own tag row so the operator can read at a
    // glance what a tasking opens: the authority (an action or a dossier field), any new ground, the
    // hardware released, and the permanent choice it ends on.
    if (m.authority) {
      const a = document.createElement('div');
      a.className = 'c2-unlocks authority';
      a.innerHTML =
        `<span class="c2-unlocks-k">${m.authority.kind === 'action' ? 'ACTION' : 'INTEL'}</span>` +
        `<span class="c2-unlock">${m.authority.label}</span>`;
      row.append(a);
    }

    if (m.territory) {
      const t = document.createElement('div');
      t.className = 'c2-unlocks territory';
      t.innerHTML = `<span class="c2-unlocks-k">TERRITORY</span><span class="c2-unlock">${m.territory}</span>`;
      row.append(t);
    }

    if (m.unlocks?.length) {
      const rel = document.createElement('div');
      rel.className = 'c2-unlocks';
      rel.innerHTML =
        `<span class="c2-unlocks-k">RELEASES</span>` +
        m.unlocks.map((id) => `<span class="c2-unlock">${unlockName(id)}</span>`).join('');
      row.append(rel);
    }

    if (m.fork) {
      const f = document.createElement('div');
      f.className = 'c2-unlocks fork';
      const taken = missions.choiceOf(m.id);
      f.innerHTML =
        `<span class="c2-unlocks-k">CHOICE</span>` +
        m.fork.choices
          .map((c) => `<span class="c2-unlock${taken === c.id ? ' taken' : taken ? ' foreclosed' : ''}">${c.label}</span>`)
          .join('');
      row.append(f);
    }

    if (m.grants) {
      const grant = document.createElement('div');
      grant.className = 'c2-grant';
      grant.textContent =
        m.grants === 'execute' ? '◈ GRANTS EXECUTION AUTHORIZATION' : '◈ GRANTS CUSTODY AUTHORIZATION';
      row.append(grant);
    }

    return row;
  }
}

/**
 * The mission-complete window.
 *
 * Raised the moment a tasking clears, in the theater, over the running scene. It reports what the
 * clearance paid — reward, authority, ground, hardware — and then offers the one decision that
 * actually matters here: keep working this theater, or go back to the world map, where the store,
 * the next tasking, and any fork this clearance opened are waiting.
 *
 * Deliberately NOT auto-dismissed and NOT a toast: clearing a mission is the campaign's punctuation,
 * and it should stop the operator for a beat rather than scroll past.
 */
export function showMissionComplete(
  m: MissionDef,
  hooks: { onContinue(): void; onReturn(): void },
): void {
  if (document.getElementById('c2-complete')) return;

  const back = document.createElement('div');
  back.className = 'c2-modal-back';
  back.id = 'c2-complete';

  const box = document.createElement('div');
  box.className = 'c2-modal c2-complete';

  const rows: string[] = [
    `<div><span>REWARD</span><b>+${fmt.format(m.reward)} tokens · +${Math.round(m.toleranceGain * 100)}% tolerance</b></div>`,
  ];
  if (m.grants) {
    rows.push(
      `<div><span>GRANTS</span><b>${m.grants === 'execute' ? 'lethal authority' : 'custody authority'}</b></div>`,
    );
  }
  if (m.authority) {
    rows.push(`<div><span>${m.authority.kind === 'action' ? 'ACTION' : 'INTEL'}</span><b>${m.authority.label}</b></div>`);
  }
  if (m.territory) rows.push(`<div><span>TERRITORY</span><b>${m.territory}</b></div>`);

  box.innerHTML =
    `<div class="c2-modal-head">` +
    `<span class="c2-name">${icon('surveil')}MISSION COMPLETE</span>` +
    `<span class="c2-order order-investigate">${m.name}</span>` +
    `</div>` +
    `<p class="c2-modal-p">${m.brief}</p>` +
    `<div class="c2-modal-objectives">${rows.join('')}</div>` +
    (m.unlocks?.length
      ? `<div class="c2-unlocks"><span class="c2-unlocks-k">RELEASES</span>` +
        m.unlocks.map((id) => `<span class="c2-unlock">${unlockName(id)}</span>`).join('') +
        `</div>`
      : '') +
    (m.fork
      ? `<p class="c2-modal-p c2-complete-fork">◈ A DECISION IS WAITING ON THE WORLD MAP · ${m.fork.prompt}</p>`
      : '');

  const actions = document.createElement('div');
  actions.className = 'c2-modal-actions c2-complete-actions';

  const cont = document.createElement('button');
  cont.type = 'button';
  cont.className = 'c2-buy ghost';
  cont.textContent = 'CONTINUE OPERATION';
  cont.addEventListener('click', () => {
    back.remove();
    hooks.onContinue();
  });

  const ret = document.createElement('button');
  ret.type = 'button';
  ret.className = 'c2-buy';
  ret.textContent = 'RETURN TO WORLD MAP';
  ret.addEventListener('click', () => {
    back.remove();
    hooks.onReturn();
  });

  actions.append(cont, ret);
  box.append(actions);
  back.append(box);
  document.body.append(back);
}

/**
 * The decision window: a permanent, exclusive fork put to the operator as a centered, halting modal.
 *
 * This is the same shape as the founding window on purpose — a fork is a choice the campaign cannot
 * proceed past without an answer, so it stops the screen rather than sitting in the rail waiting to
 * be noticed. There is no cancel and no click-outside: the only way out is to take a branch, because
 * the branch not taken is closed for good and there is no neutral third option.
 *
 * Returns nothing; the caller chains to the next pending fork through {@link ForkHooks.onChosen}, so
 * a campaign that owes several decisions at once (a dev jump, a save reopened mid-fork) works through
 * them one blocking modal at a time.
 */
export interface ForkHooks {
  /** A branch was taken — the caller re-reads state and presents the next pending fork, if any. */
  onChosen(choiceLabel: string): void;
}

export function showForkDecision(mission: MissionDef, fork: Fork, hooks: ForkHooks): void {
  // One decision modal at a time — if one is already up, the chain will re-drive when it closes.
  if (document.getElementById('c2-decision')) return;

  const back = document.createElement('div');
  back.className = 'c2-modal-back';
  back.id = 'c2-decision';

  const box = document.createElement('div');
  box.className = `c2-modal c2-decision kind-${fork.kind}`;

  box.innerHTML =
    `<div class="c2-modal-head">` +
    `<span class="c2-name">${icon('surveil')}DECISION REQUIRED</span>` +
    `<span class="c2-order order-investigate">${mission.name}</span>` +
    `</div>` +
    `<p class="c2-modal-p">${fork.prompt}</p>` +
    `<p class="c2-modal-p c2-decision-note">This choice is permanent. The branch you pass over is ` +
    `closed for the rest of the campaign.</p>`;

  const choices = document.createElement('div');
  choices.className = `c2-fork kind-${fork.kind} c2-decision-choices`;
  for (const c of fork.choices) {
    // The consequences, spelled out — what it pays, what it releases, and (for a partner) that it
    // makes a permanent enemy. A choice this final should never be made blind.
    const bits: string[] = [];
    if (c.funding) bits.push(`+${fmt.format(c.funding)} TOKENS`);
    if (c.unlocks?.length) bits.push(`RELEASES ${c.unlocks.map(unlockName).join(' · ')}`);
    if (c.grantsFaction) bits.push('PROTECTS A FACTION');
    if (c.angersFactions?.length) bits.push('MAKES AN ENEMY');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'c2-fork-choice';
    btn.innerHTML =
      `<span class="c2-fork-label">${c.label}</span>` +
      `<span class="c2-fork-blurb">${c.blurb}</span>` +
      (bits.length ? `<span class="c2-fork-bits">${bits.join(' · ')}</span>` : '');
    btn.addEventListener('click', () => {
      if (!missions.chooseFork(mission.id, c.id)) return;
      back.remove();
      hooks.onChosen(c.label);
    });
    choices.append(btn);
  }
  box.append(choices);

  back.append(box);
  // Deliberately no click-outside-to-close and no cancel: progress halts here until a branch is taken.
  document.body.append(back);
}

/**
 * Put the oldest owed decision on screen, and chain to the next once it's answered.
 *
 * The single entry point the scene calls at every moment a fork might have come due — a clearance, a
 * dev jump, a campaign reopened. It is idempotent and self-terminating: no pending fork, or a modal
 * already up, and it does nothing; otherwise it shows one and re-drives itself on choice until the
 * campaign owes none. Kept here rather than in the scene so the halting behaviour travels with the
 * modal it belongs to.
 */
export function presentPendingForks(onDone?: () => void): void {
  const pending = missions.pendingFork();
  if (!pending) {
    onDone?.();
    return;
  }
  // Don't stack over the mission-complete window — it drives this itself when it closes.
  if (document.getElementById('c2-complete')) return;
  if (document.getElementById('c2-decision')) return;
  showForkDecision(pending.mission, pending.fork, {
    onChosen: () => presentPendingForks(onDone),
  });
}
