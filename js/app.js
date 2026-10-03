import { load, save, uid, isValidState, requestPersistence, downloadBackup } from './store.js';
import {
  activeBlock, blocksOf, findSession, isDeload, setCount, sessionDone,
  positionKey, history, suggestNext, formatSet, titleCase,
} from './logic.js';

const APP_VERSION = '1.1.0';

let state = load();
const ui = {
  tab: 'log',
  week: 1,
  dayIdx: 0,
  viewBlock: {},        // personId -> blockId being viewed in the log
  openNotes: new Set(), // exercise ids with notes expanded
  scrollTo: null,       // set row to bring into view after render
  persisted: null,
};

const root = document.getElementById('app');
const dialog = document.getElementById('dialog');

// ---------- helpers ----------

const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Local calendar date; toISOString() would give tomorrow for late workouts west of UTC.
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const round2 = (n) => Math.round(n * 100) / 100;

// Line icons on a 24 grid, drawn in currentColor.
const ICONS = {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  swap: '<path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
  check: '<path d="M5 12.5 10 17.5 19 7"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  alert: '<path d="M12 3.5 2.5 20h19L12 3.5z"/><path d="M12 10v4M12 17h.01"/>',
  done: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
  log: '<path d="M6 7v10M18 7v10M3 10v4M21 10v4M6 12h12"/>',
  program: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
};
const icon = (name, size = 20, stroke = 1.75) =>
  `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

function commit() {
  save(state);
  render();
}

function person() {
  return state.people.find((p) => p.id === state.activePersonId) ?? state.people[0];
}

function viewedBlock() {
  const p = person();
  const id = ui.viewBlock[p.id];
  return state.blocks.find((b) => b.id === id && b.personId === p.id) ?? activeBlock(state, p.id);
}

function viewedDay(block) {
  return block?.days[Math.min(ui.dayIdx, block.days.length - 1)];
}

function isReadOnly(block) {
  return block.id !== person().activeBlockId;
}

function jumpToSuggested() {
  const p = person();
  const block = activeBlock(state, p.id);
  const next = suggestNext(state, p.id);
  ui.week = next.week;
  ui.dayIdx = Math.max(0, block?.days.findIndex((d) => d.id === next.dayId) ?? 0);
}

function ensureEntry(block, ex) {
  const day = viewedDay(block);
  let session = findSession(state, person().id, block.id, ui.week, day.id);
  if (!session) {
    session = { id: uid(), personId: person().id, blockId: block.id, week: ui.week, dayId: day.id, date: null, entries: {} };
    state.sessions.push(session);
  }
  session.entries[ex.id] ??= { name: ex.name, sets: [] };
  return { session, entry: session.entries[ex.id] };
}

// Working sets live in entry.sets, warm-ups in entry.warmups.
const listKey = (kind) => (kind === 'wu' ? 'warmups' : 'sets');

function currentEntry(block, ex) {
  const s = findSession(state, person().id, block.id, ui.week, viewedDay(block).id);
  return s?.entries[ex.id];
}

// What a set row shows: what was entered, else the same set last time.
// Warm-ups only copy the same warm-up, never a working set.
function shownSet(block, day, ex, i, kind = 'set') {
  const entry = currentEntry(block, ex);
  const own = entry?.[listKey(kind)]?.[i];
  if (own) return { ...own, suggested: false };
  const name = entry?.name ?? ex.name;
  const past = history(state, person().id, name, positionKey(state, person().id, block.id, ui.week, day.id), 3);
  let prev;
  if (kind === 'wu') prev = past.find((x) => x.entry.warmups?.[i])?.entry.warmups[i];
  else prev = past[0]?.entry.sets[i] ?? past[0]?.entry.sets.filter(Boolean).at(-1);
  return { reps: prev?.reps ?? null, weight: prev?.weight ?? null, done: false, suggested: true };
}

// Set order for "what's next": supersets (A1/A2) alternate set by set.
function setSequence(block, day) {
  const seq = [];
  const exs = day.exercises;
  for (let k = 0; k < exs.length; k++) {
    const letter = exs[k].superset?.[0];
    let group = [exs[k]];
    while (letter && exs[k + 1]?.superset?.[0] === letter) group.push(exs[++k]);
    const max = Math.max(...group.map((e) => setCount(e, block, ui.week)));
    for (let i = 0; i < max; i++) {
      for (const e of group) if (i < setCount(e, block, ui.week)) seq.push({ ex: e, i });
    }
  }
  return seq;
}

function nextOpenSet(block, day) {
  return setSequence(block, day).find(({ ex, i }) => !currentEntry(block, ex)?.sets[i]?.done);
}

// ---------- render ----------

function render() {
  const p = person();
  // Each person gets their own accent: dark green, then pastel pink.
  document.documentElement.dataset.accent = String(Math.max(0, state.people.indexOf(p)) % 2);
  root.innerHTML = `
    <header class="top">
      <div class="seg people">
        ${state.people.map((x) => `<button data-action="person" data-id="${x.id}" class="${x.id === p.id ? 'on' : ''}">${h(x.name)}</button>`).join('')}
      </div>
    </header>
    <main>${ui.tab === 'log' ? renderLog() : ui.tab === 'program' ? renderProgram() : renderSettings()}</main>
    <nav class="tabs">
      ${[['log', 'Log'], ['program', 'Program'], ['settings', 'Settings']].map(([id, label]) =>
        `<button data-action="tab" data-id="${id}" class="${ui.tab === id ? 'on' : ''}"><span class="ind">${icon(id, 22)}</span>${label}</button>`).join('')}
    </nav>`;
  if (ui.scrollTo) {
    document.getElementById(ui.scrollTo)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    ui.scrollTo = null;
  }
}

function renderLog() {
  const block = viewedBlock();
  if (!block || block.days.length === 0) return `<p class="empty">No program yet. Add days and exercises in the Program tab.</p>`;
  const day = viewedDay(block);
  const pid = person().id;
  const ro = isReadOnly(block);
  const weekDone = (w) => block.days.some((d) => sessionDone(findSession(state, pid, block.id, w, d.id)));
  const next = ro ? null : nextOpenSet(block, day);
  const session = findSession(state, pid, block.id, ui.week, day.id);

  return `
    ${blocksOf(state, pid).length > 1 ? `
      <label class="blockpick">Block
        <select data-change="viewBlock">
          ${blocksOf(state, pid).map((b) => `<option value="${b.id}" ${b.id === block.id ? 'selected' : ''}>${h(b.name)}${b.id === person().activeBlockId ? ' (current)' : ''}</option>`).join('')}
        </select>
      </label>` : ''}
    ${ro ? `<p class="banner">Old block, read only.</p>` : ''}
    <div class="weeks">
      ${Array.from({ length: block.weeks }, (_, k) => k + 1).map((w) => `
        <button data-action="week" data-w="${w}" class="${w === ui.week ? 'on' : ''} ${weekDone(w) ? 'has' : ''}">
          ${w}${isDeload(block, w) ? '<small>D</small>' : ''}</button>`).join('')}
    </div>
    <div class="days">
      ${block.days.map((d, i) => `
        <button data-action="day" data-i="${i}" class="${d.id === day.id ? 'on' : ''}">
          ${sessionDone(findSession(state, pid, block.id, ui.week, d.id)) ? icon('check', 14, 2.25) : ''}${h(d.name.replace(/\s*\(.*\)$/, ''))}</button>`).join('')}
    </div>
    <h2 class="dayname">${h(day.name)} <small>· Week ${ui.week}</small>${isDeload(block, ui.week) ? ' <span class="chip warn">Deload · RPE 6-7</span>' : ''}
      ${session?.date ? `<small>· ${session.date}</small>` : session?.imported ? '<small>· from Excel</small>' : ''}</h2>
    ${day.exercises.map((ex) => renderExercise(block, day, ex, next, ro)).join('') || '<p class="empty">No exercises on this day.</p>'}
    ${!ro && !next && day.exercises.length ? `<p class="finished">${icon('done', 22)}Day complete</p>` : ''}`;
}

function renderSetRow(block, day, ex, i, kind, isNext, ro) {
  const s = shownSet(block, day, ex, i, kind);
  const wu = kind === 'wu';
  const wt = ex.weightType;
  const wLabel = wt === 'assisted' ? 'assist kg' : wt === 'bodyweight' ? '+kg' : 'kg';
  const dis = ro ? 'disabled' : '';
  const what = wu ? 'warm-up set' : 'set';
  return `
    <div class="set ${wu ? 'wu' : ''} ${s.done ? 'done' : ''} ${isNext ? 'next' : ''}" id="${wu ? 'wu' : 'set'}-${ex.id}-${i}" data-ex="${ex.id}" data-i="${i}" data-kind="${kind}">
      <span class="num">${wu ? 'W' : ''}${i + 1}</span>
      <div class="stepper">
        <button data-action="step" data-field="reps" data-d="-1" ${dis} aria-label="fewer reps">${icon('minus', 18)}</button>
        <input data-field="reps" inputmode="numeric" pattern="[0-9]*" value="${h(s.reps)}" placeholder="reps" aria-label="reps" class="${s.suggested ? 'sug' : ''}" ${dis}>
        <button data-action="step" data-field="reps" data-d="1" ${dis} aria-label="more reps">${icon('plus', 18)}</button>
      </div>
      <div class="stepper">
        <button data-action="step" data-field="weight" data-d="-1" ${dis} aria-label="less weight">${icon('minus', 18)}</button>
        <input data-field="weight" inputmode="decimal" value="${h(s.weight)}" placeholder="${wLabel}" aria-label="${wLabel}" class="${s.suggested ? 'sug' : ''}" ${dis}>
        <button data-action="step" data-field="weight" data-d="1" ${dis} aria-label="more weight">${icon('plus', 18)}</button>
      </div>
      <button class="check" data-action="toggle" ${dis} aria-label="${s.done ? `undo ${what}` : `log ${what}`}">${icon('check', 20, s.done || isNext ? 2.25 : 1.75)}</button>
    </div>`;
}

function renderExercise(block, day, ex, next, ro) {
  const entry = currentEntry(block, ex);
  const name = entry?.name ?? ex.name;
  const swapped = name !== ex.name;
  const n = setCount(ex, block, ui.week);
  const hist = history(state, person().id, name, positionKey(state, person().id, block.id, ui.week, day.id), 3);
  const wt = ex.weightType;
  const rpe = isDeload(block, ui.week) ? '6-7' : ex.rpe;
  const warmups = entry?.warmups ?? [];
  const lastWu = warmups.at(-1);

  const wuRows = warmups.map((_, i) => renderSetRow(block, day, ex, i, 'wu', false, ro)).join('');
  const rows = Array.from({ length: n }, (_, i) =>
    renderSetRow(block, day, ex, i, 'set', next && next.ex.id === ex.id && next.i === i, ro)).join('');

  return `
    <section class="ex" id="ex-${ex.id}">
      <div class="exhead">
        <h3>${ex.superset ? `<span class="chip">${h(ex.superset)}</span> ` : ''}${h(titleCase(name))} <span class="rxh">· ${n} × ${h(ex.reps)}</span>
          ${swapped ? `<small>sub for ${h(titleCase(ex.name))}</small>` : ''}</h3>
        <div class="icons">
          ${ex.notes ? `<button class="icon ${ui.openNotes.has(ex.id) ? 'on' : ''}" data-action="notes" data-ex="${ex.id}" aria-label="notes">${icon('info')}</button>` : ''}
          ${ex.sub && !ro ? `<button class="icon ${swapped ? 'on' : ''}" data-action="swap" data-ex="${ex.id}" aria-label="swap exercise">${icon('swap')}</button>` : ''}
        </div>
      </div>
      <div class="rx">RPE ${h(rpe)} · ${h(ex.rest)}${ex.warmup && ex.warmup !== '0' ? ` · Warm-up ${h(ex.warmup)}` : ''}${ex.sub && !swapped ? ` · alt ${h(titleCase(ex.sub))}` : ''}</div>
      ${ui.openNotes.has(ex.id) ? `<p class="notes">${h(ex.notes)}</p>` : ''}
      ${hist.length ? `<div class="hist">${hist.map(({ session, entry }) =>
        `<span><b>W${session.week}${session.blockId !== block.id ? '*' : ''}</b> ${entry.sets.filter((s) => s?.done).map((s) => formatSet(s, wt)).join(' ')}</span>`).join('')}</div>` : ''}
      ${entry?.flag ? `<p class="flag">${icon('alert', 18)}<span>${h(entry.flag)}</span><button data-action="clearflag" data-ex="${ex.id}">OK</button></p>` : ''}
      ${warmups.length ? `<div class="label">Warm-up</div>${wuRows}` : ''}
      ${ro ? '' : `<div class="wuctl">
        <button data-action="addWarmup" data-ex="${ex.id}">${icon('plus', 18)}Warm-up</button>
        ${warmups.length && !lastWu?.done ? `<button data-action="removeWarmup" data-ex="${ex.id}">Remove</button>` : ''}
      </div>`}
      <div class="label">${n === 1 ? 'Working set' : 'Working sets'}</div>
      ${rows}
    </section>`;
}

function renderProgram() {
  const p = person();
  const block = viewedBlock();
  const blocks = blocksOf(state, p.id);
  if (!block) return `<button class="primary" data-action="newBlock">Create a program</button>`;
  const isActive = block.id === p.activeBlockId;
  return `
    <div class="card">
      <label class="blockpick">Block
        <select data-change="viewBlock">
          ${blocks.map((b) => `<option value="${b.id}" ${b.id === block.id ? 'selected' : ''}>${h(b.name)}${b.id === p.activeBlockId ? ' (current)' : ''}</option>`).join('')}
        </select>
      </label>
      <div class="grid3">
        <label>Name<input data-change="blockField" data-f="name" value="${h(block.name)}"></label>
        <label>Weeks<input data-change="blockField" data-f="weeks" type="number" min="1" max="52" value="${block.weeks}"></label>
        <label>Deload week<input data-change="blockField" data-f="deloadWeek" type="number" min="0" max="52" value="${block.deloadWeek ?? 0}"></label>
      </div>
      <div class="row">
        ${isActive ? '' : `<button data-action="activateBlock">Make current</button>`}
        <button data-action="newBlock">Start new block from this one</button>
      </div>
    </div>
    ${block.days.map((d, di) => `
      <section class="card">
        <div class="row">
          <input class="dayinput" data-change="dayName" data-di="${di}" value="${h(d.name)}">
          <button class="icon" data-action="moveDay" data-di="${di}" data-d="-1" aria-label="move day up">${icon('up')}</button>
          <button class="icon" data-action="moveDay" data-di="${di}" data-d="1" aria-label="move day down">${icon('down')}</button>
          <button class="icon danger" data-action="delDay" data-di="${di}" aria-label="delete day">${icon('x')}</button>
        </div>
        <ol class="exlist">
          ${d.exercises.map((ex, ei) => `
            <li>
              <button class="exedit" data-action="editEx" data-di="${di}" data-ei="${ei}">
                <b>${ex.superset ? h(ex.superset) + ' ' : ''}${h(titleCase(ex.name))} <span>· ${ex.sets} × ${h(ex.reps)}</span></b>
                <small>${ex.warmup && ex.warmup !== '0' ? `Warm-up ${h(ex.warmup)} · ` : ''}RPE ${h(ex.rpe)} · ${h(ex.rest)}</small>
              </button>
              <button class="icon" data-action="moveEx" data-di="${di}" data-ei="${ei}" data-d="-1" aria-label="move up">${icon('up')}</button>
              <button class="icon" data-action="moveEx" data-di="${di}" data-ei="${ei}" data-d="1" aria-label="move down">${icon('down')}</button>
            </li>`).join('')}
        </ol>
        <button data-action="addEx" data-di="${di}">${icon('plus', 18)}Add exercise</button>
      </section>`).join('')}
    <button data-action="addDay">${icon('plus', 18)}Add day</button>`;
}

function renderSettings() {
  return `
    <section class="card">
      <h3>People</h3>
      ${state.people.map((x) => `<label>Name<input data-change="personName" data-id="${x.id}" value="${h(x.name)}"></label>`).join('')}
    </section>
    <section class="card">
      <h3>Backup</h3>
      <p class="muted">Your data only lives on this phone. Export a backup now and then, and after importing the Excel file.</p>
      <div class="row">
        <button class="primary" data-action="export">Export backup</button>
        <label class="button">Import backup<input type="file" accept="application/json,.json" data-change="import" hidden></label>
      </div>
      <p class="muted">Storage: ${ui.persisted === null ? 'checking…' : ui.persisted ? 'protected from automatic cleanup' : 'may be cleared by the browser if space runs low'}</p>
    </section>
    <section class="card">
      <h3>Reset</h3>
      <button class="danger" data-action="reset">Erase everything</button>
    </section>
    <p class="muted center">GymApp ${APP_VERSION}</p>`;
}

// ---------- exercise editor ----------

const EX_FIELDS = [
  ['name', 'Exercise', 'text'], ['superset', 'Superset (e.g. A1)', 'text'],
  ['sets', 'Working sets', 'number'], ['reps', 'Reps', 'text'], ['rpe', 'RPE', 'text'],
  ['warmup', 'Warm-up sets (guide)', 'text'], ['rest', 'Rest', 'text'], ['sub', 'Substitute', 'text'],
  ['increment', '+/− step (kg)', 'number'],
];

function openExerciseEditor(di, ei) {
  const block = viewedBlock();
  const isNew = ei == null;
  const ex = isNew
    ? { id: uid(), name: '', superset: '', warmup: '0', sets: 3, reps: '8-12', rpe: '8', rest: '2 min', sub: '', notes: '', weightType: 'load', increment: 2.5 }
    : block.days[di].exercises[ei];

  dialog.innerHTML = `
    <form method="dialog" class="exform">
      <h3>${isNew ? 'Add exercise' : 'Edit exercise'}</h3>
      ${EX_FIELDS.map(([f, label, type]) => `
        <label>${label}<input name="${f}" type="${type}" ${type === 'number' ? 'step="any" min="0"' : ''} value="${h(ex[f])}" ${f === 'name' ? 'required' : ''}></label>`).join('')}
      <label>Weight type
        <select name="weightType">
          ${[['load', 'Weight (kg)'], ['bodyweight', 'Bodyweight (+kg added)'], ['assisted', 'Assisted (kg of help)']].map(([v, l]) =>
            `<option value="${v}" ${ex.weightType === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
      <label>Notes<textarea name="notes" rows="3">${h(ex.notes)}</textarea></label>
      <div class="row">
        ${isNew ? '' : '<button value="delete" class="danger" formnovalidate>Delete</button>'}
        <span class="spacer"></span>
        <button value="cancel" formnovalidate>Cancel</button>
        <button value="save" class="primary">Save</button>
      </div>
    </form>`;

  dialog.onclose = () => {
    const form = dialog.querySelector('form');
    if (dialog.returnValue === 'delete') {
      if (confirm(`Delete ${ex.name}? Logged history is kept.`)) {
        block.days[di].exercises.splice(ei, 1);
        commit();
      }
      return;
    }
    if (dialog.returnValue !== 'save') return;
    const data = Object.fromEntries(new FormData(form));
    const oldName = ex.name;
    for (const [f, , type] of EX_FIELDS) ex[f] = type === 'number' ? Number(data[f]) || 0 : data[f].trim();
    ex.name = ex.name.toUpperCase();
    ex.sub = ex.sub.toUpperCase();
    ex.superset = ex.superset.toUpperCase();
    ex.sets = Math.max(1, Math.round(ex.sets));
    ex.weightType = data.weightType;
    ex.notes = data.notes.trim();
    // History is matched by name, so carry this person's logs over to the new name.
    if (!isNew && oldName !== ex.name) {
      for (const s of state.sessions) {
        if (s.personId !== block.personId) continue;
        for (const entry of Object.values(s.entries)) if (entry.name === oldName) entry.name = ex.name;
      }
    }
    if (isNew) block.days[di].exercises.push(ex);
    commit();
  };
  dialog.returnValue = '';
  dialog.showModal();
}

// ---------- actions ----------

function copyBlock(src) {
  const blocks = blocksOf(state, src.personId);
  const nb = structuredClone(src);
  nb.id = uid();
  nb.name = `Block ${blocks.length + 1}`;
  nb.createdAt = today();
  for (const d of nb.days) {
    d.id = uid();
    for (const e of d.exercises) e.id = uid();
  }
  return nb;
}

const actions = {
  person(el) {
    state.activePersonId = el.dataset.id;
    save(state);
    // Keep the same week/day so switching mid-workout lands in the same place.
    render();
  },
  tab(el) {
    ui.tab = el.dataset.id;
    render();
    window.scrollTo(0, 0);
  },
  week(el) {
    ui.week = Number(el.dataset.w);
    render();
  },
  day(el) {
    ui.dayIdx = Number(el.dataset.i);
    render();
  },
  notes(el) {
    const id = el.dataset.ex;
    ui.openNotes.has(id) ? ui.openNotes.delete(id) : ui.openNotes.add(id);
    render();
  },
  step(el) {
    const { block, day, ex, i, kind } = setContext(el);
    const s = shownSet(block, day, ex, i, kind);
    const list = setList(block, ex, kind);
    const field = el.dataset.field;
    const step = field === 'reps' ? 1 : ex.increment || 1;
    const value = round2(Math.max(0, (s[field] ?? 0) + Number(el.dataset.d) * step));
    list[i] = { reps: s.reps, weight: s.weight, done: s.done, [field]: value };
    commit();
  },
  toggle(el) {
    const { block, day, ex, i, kind } = setContext(el);
    const s = shownSet(block, day, ex, i, kind);
    if (!s.done && s.reps == null) {
      el.closest('.set').querySelector('input[data-field=reps]').focus();
      return;
    }
    const list = setList(block, ex, kind);
    if (s.done) {
      list[i] = { ...list[i], done: false };
    } else {
      list[i] = { reps: s.reps, weight: s.weight, done: true };
      const session = findSession(state, person().id, block.id, ui.week, day.id);
      session.date ??= session.imported ? null : today();
      const next = kind === 'set' && nextOpenSet(block, day);
      if (next) ui.scrollTo = `set-${next.ex.id}-${next.i}`;
    }
    commit();
  },
  addWarmup(el) {
    const block = viewedBlock();
    const ex = viewedDay(block).exercises.find((e) => e.id === el.dataset.ex);
    // null = not touched yet, so the row shows last session's value as a suggestion.
    setList(block, ex, 'wu').push(null);
    commit();
  },
  removeWarmup(el) {
    const block = viewedBlock();
    const ex = viewedDay(block).exercises.find((e) => e.id === el.dataset.ex);
    const list = setList(block, ex, 'wu');
    if (!list.at(-1)?.done) list.pop();
    commit();
  },
  swap(el) {
    const block = viewedBlock();
    const ex = viewedDay(block).exercises.find((e) => e.id === el.dataset.ex);
    const { entry } = ensureEntry(block, ex);
    entry.name = entry.name === ex.name ? ex.sub : ex.name;
    entry.sets = entry.sets.map((s) => (s?.done ? s : null));
    if (entry.warmups) entry.warmups = entry.warmups.map((s) => (s?.done ? s : null));
    commit();
  },
  clearflag(el) {
    const block = viewedBlock();
    const ex = viewedDay(block).exercises.find((e) => e.id === el.dataset.ex);
    delete currentEntry(block, ex).flag;
    commit();
  },
  activateBlock() {
    person().activeBlockId = viewedBlock().id;
    jumpToSuggested();
    commit();
  },
  newBlock() {
    const src = viewedBlock();
    if (src && !confirm(`Start a new block for ${person().name} by copying "${src.name}"? The current block stays in history.`)) return;
    const nb = src ? copyBlock(src) : {
      id: uid(), personId: person().id, name: 'Block 1', weeks: 8, deloadWeek: 8, createdAt: today(),
      days: [{ id: uid(), name: 'Day 1', exercises: [] }],
    };
    state.blocks.push(nb);
    person().activeBlockId = nb.id;
    ui.viewBlock[person().id] = nb.id;
    ui.week = 1;
    ui.dayIdx = 0;
    commit();
  },
  addDay() {
    const block = viewedBlock();
    block.days.push({ id: uid(), name: `Day ${block.days.length + 1}`, exercises: [] });
    commit();
  },
  delDay(el) {
    const block = viewedBlock();
    const d = block.days[Number(el.dataset.di)];
    if (!confirm(`Delete "${d.name}" and its exercises? Logged history is kept.`)) return;
    block.days.splice(Number(el.dataset.di), 1);
    commit();
  },
  moveDay(el) {
    moveItem(viewedBlock().days, Number(el.dataset.di), Number(el.dataset.d));
    commit();
  },
  moveEx(el) {
    moveItem(viewedBlock().days[Number(el.dataset.di)].exercises, Number(el.dataset.ei), Number(el.dataset.d));
    commit();
  },
  editEx(el) {
    openExerciseEditor(Number(el.dataset.di), Number(el.dataset.ei));
  },
  addEx(el) {
    openExerciseEditor(Number(el.dataset.di), null);
  },
  export() {
    downloadBackup(state);
  },
  reset() {
    if (!confirm('Erase all logged workouts and programs on this phone?')) return;
    if (!confirm('Really? Export a backup first if unsure.')) return;
    localStorage.clear();
    location.reload();
  },
};

const changes = {
  viewBlock(el) {
    ui.viewBlock[person().id] = el.value;
    ui.week = Math.min(ui.week, viewedBlock().weeks);
    render();
  },
  blockField(el) {
    const block = viewedBlock();
    const f = el.dataset.f;
    block[f] = f === 'name' ? el.value.trim() || block.name : Math.max(f === 'weeks' ? 1 : 0, Number(el.value) || 0);
    ui.week = Math.min(ui.week, block.weeks);
    commit();
  },
  dayName(el) {
    viewedBlock().days[Number(el.dataset.di)].name = el.value.trim() || 'Day';
    commit();
  },
  personName(el) {
    state.people.find((x) => x.id === el.dataset.id).name = el.value.trim() || 'Person';
    commit();
  },
  async import(el) {
    const file = el.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!isValidState(data)) throw new Error('not a GymApp backup');
      if (!confirm(`Replace everything on this phone with "${file.name}"?`)) return;
      state = data;
      ui.viewBlock = {};
      jumpToSuggested();
      commit();
      alert(`Imported ${state.sessions.length} logged days.`);
    } catch (err) {
      alert(`Could not import: ${err.message}`);
    } finally {
      el.value = ''; // let the same file be picked again
    }
  },
  // Typed values in a set row.
  setField(el) {
    const { block, day, ex, i, kind } = setContext(el);
    const s = shownSet(block, day, ex, i, kind);
    const list = setList(block, ex, kind);
    const raw = el.value.replace(',', '.').trim();
    const field = el.dataset.field;
    const n = Math.max(0, Number(raw) || 0);
    const value = raw === '' ? null : field === 'reps' ? Math.round(n) : round2(n);
    list[i] = { reps: s.reps, weight: s.weight, done: s.done, [field]: value };
    commit();
  },
};

function moveItem(arr, i, d) {
  const j = i + d;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}

function setContext(el) {
  const row = el.closest('.set');
  const block = viewedBlock();
  const day = viewedDay(block);
  const ex = day.exercises.find((e) => e.id === row.dataset.ex);
  return { block, day, ex, i: Number(row.dataset.i), kind: row.dataset.kind };
}

// The entry's working sets or warm-ups, created on first write.
function setList(block, ex, kind) {
  const { entry } = ensureEntry(block, ex);
  return (entry[listKey(kind)] ??= []);
}

root.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el && !el.disabled) actions[el.dataset.action]?.(el);
});

root.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.change) changes[el.dataset.change]?.(el);
  else if (el.closest('.set') && el.dataset.field) changes.setField(el);
});

// Select the whole value on focus so typing replaces it.
root.addEventListener('focusin', (e) => {
  if (e.target.matches('.set input')) e.target.select();
});

// ---------- boot ----------

jumpToSuggested();
render();
requestPersistence().then((ok) => {
  ui.persisted = ok;
  if (ui.tab === 'settings') render();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
