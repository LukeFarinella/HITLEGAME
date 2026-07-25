import { processActions, PROCESS_SLOTS, type TriggerKind } from '../game/processActions';
import { missions } from '../game/missions';
import type { SanctionId } from '../game/sanctions';
import type { Severity } from '../game/intel';
import type { ViolationClass } from '../game/violations';

/**
 * The Process Actions editor — the panel where the operator authors the rules the console then runs
 * without them (see game/processActions.ts).
 *
 * One row per RELEASED slot. Each is a sentence: WHEN a trigger matches → an action. The trigger is
 * a past record at a severity, or a live event of a class; the action is any rung on the ladder. A
 * detain or execute rule is written freely but only FIRES once the chain has granted the authority —
 * the same asymmetry the ladder has, surfaced here as a note rather than a wall.
 *
 * Kept deliberately plain: native selects, no custom dropdowns. This is a config surface, not a
 * showpiece, and the interesting thing about it is what it does when nobody is looking at it.
 */

const ACTIONS: { id: SanctionId; label: string }[] = [
  { id: 'fine', label: 'FINE' },
  { id: 'investigate', label: 'INVESTIGATE' },
  { id: 'detain', label: 'DETAIN' },
  { id: 'prison', label: 'PRISON' },
  { id: 'execute', label: 'EXECUTE' },
];
const SEVERITIES: { v: Severity; label: string }[] = [
  { v: 1, label: 'ANY RECORD' },
  { v: 2, label: 'MODERATE+' },
  { v: 3, label: 'SEVERE+' },
  { v: 4, label: 'CRITICAL' },
];
const CLASSES: { v: ViolationClass; label: string }[] = [
  { v: 'traffic', label: 'TRAFFIC' },
  { v: 'civil', label: 'CIVIL' },
  { v: 'suspicious', label: 'SUSPICIOUS' },
];
const TRIGGERS: { v: TriggerKind; label: string }[] = [
  { v: 'record', label: 'PAST RECORD' },
  { v: 'violation', label: 'LIVE EVENT' },
];

/** A styled native select. `onPick` gets the chosen value as a string. */
function select(
  options: { value: string; label: string }[],
  current: string,
  onPick: (v: string) => void,
): HTMLSelectElement {
  const s = document.createElement('select');
  s.className = 'gp-sel';
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === current) opt.selected = true;
    s.append(opt);
  }
  s.addEventListener('change', () => onPick(s.value));
  return s;
}

export class ProcessPanel {
  private root: HTMLElement;

  constructor() {
    this.root = document.getElementById('g-process')!;
    processActions.onChange(() => this.render());
    // A completion may release a new slot, so the panel has to redraw when the chain moves too.
    missions.onChange(() => this.render());
    this.render();
  }

  render(): void {
    const n = processActions.slotsUnlocked();
    this.root.hidden = n === 0;
    if (n === 0) {
      this.root.replaceChildren();
      return;
    }
    const frag = document.createDocumentFragment();
    const head = document.createElement('div');
    head.className = 'gp-head';
    head.textContent = 'PROCESS ACTIONS';
    frag.append(head);
    for (let i = 0; i < n; i++) frag.append(this.row(i));
    this.root.replaceChildren(frag);
  }

  private row(i: number): HTMLElement {
    const rule = processActions.ruleAt(i);
    const row = document.createElement('div');
    row.className = `gp-row${rule.enabled ? ' on' : ''}`;

    const en = document.createElement('button');
    en.type = 'button';
    en.className = 'gp-en';
    en.textContent = rule.enabled ? '◈' : '○';
    en.title = rule.enabled ? 'Armed — click to disarm' : 'Off — click to arm';
    en.addEventListener('click', () => processActions.update(i, { enabled: !rule.enabled }));

    const name = document.createElement('span');
    name.className = 'gp-name';
    name.textContent = PROCESS_SLOTS[i]?.name.replace('PROCESS ACTION ', '') ?? String(i + 1);

    const when = document.createElement('span');
    when.className = 'gp-k';
    when.textContent = 'WHEN';

    const trig = select(
      TRIGGERS.map((t) => ({ value: t.v, label: t.label })),
      rule.trigger,
      (v) => processActions.update(i, { trigger: v as TriggerKind }),
    );

    const param =
      rule.trigger === 'record'
        ? select(
            SEVERITIES.map((s) => ({ value: String(s.v), label: s.label })),
            String(rule.minSeverity),
            (v) => processActions.update(i, { minSeverity: Number(v) as Severity }),
          )
        : select(
            CLASSES.map((c) => ({ value: c.v, label: c.label })),
            rule.violationClass,
            (v) => processActions.update(i, { violationClass: v as ViolationClass }),
          );

    const arrow = document.createElement('span');
    arrow.className = 'gp-k arrow';
    arrow.textContent = '→';

    const act = select(
      ACTIONS.map((a) => ({ value: a.id, label: a.label })),
      rule.action,
      (v) => processActions.update(i, { action: v as SanctionId }),
    );

    row.append(en, name, when, trig, param, arrow, act);

    // A note when an armed rule can't actually fire yet — it needs an authority the chain hasn't
    // granted. The rule is still editable; it just waits, the way a locked ladder rung does.
    const needsDetain = rule.action === 'detain' || rule.action === 'prison';
    const needsExec = rule.action === 'execute';
    if (rule.enabled && ((needsDetain && !missions.hasAuth('detain')) || (needsExec && !missions.hasAuth('execute')))) {
      const warn = document.createElement('span');
      warn.className = 'gp-warn';
      warn.textContent = needsExec ? 'NO LETHAL AUTHORITY' : 'NO CUSTODY AUTHORITY';
      row.append(warn);
    }

    return row;
  }
}
