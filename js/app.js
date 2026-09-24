import { load, save, uid, isValidState, requestPersistence, downloadBackup } from './store.js';
import {
  activeBlock, blocksOf, findSession, isDeload, setCount, entryDone, sessionDone,
  positionKey, history, suggestNext, formatSet, titleCase,
} from './logic.js';

const APP_VERSION = '1.0.0';

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

const today = () => new Date().toISOString().slice(0, 10);
const round2 = (n) => Math.round(n * 100) / 100;

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

function currentEntry(block, ex) {
  const s = findSession(state, person().id, block.id, ui.week, viewedDay(block).id);
  return s?.entries[ex.id];
}

// What a set row shows: what was entered, else the same set last time.
function shownSet(block, day, ex, i) {
  const entry = currentEntry(block, ex);
  const own = entry?.sets[i];
  if (own) return { ...own, suggested: false };
  const name = entry?.name ?? ex.name;
  const [last] = history(state, person().id, name, positionKey(state, person().id, block.id, ui.week, day.id), 1);
  const prev = last?.entry.sets[i] ?? last?.entry.sets.filter(Boolean).at(-1);
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
  root.innerHTML = `
    <header class="top">
      <div class="seg people">
        ${state.people.map((x) => `<button data-action="person" data-id="${x.id}" class="${x.id === p.id ? 'on' : ''}">${h(x.name)}</button>`).join('')}
      </div>
    </header>
    <main>${ui.tab === 'log' ? renderLog() : ui.tab === 'program' ? renderProgram() : renderSettings()}</main>
    <nav class="tabs">
      ${[['log', 'Log'], ['program', 'Program'], ['settings', 'Settings']].map(([id, label]) =>
        `<button data-action="tab" data-id="${id}" class="${ui.tab === id ? 'on' : ''}">${label}</button>`).join('')}
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
          ${sessionDone(findSession(state, pid, block.id, ui.week, d.id)) ? '✓ ' : ''}${h(d.name.replace(/\s*\(.*\)$/, ''))}</button>`).join('')}
    </div>
    <h2 class="dayname">${h(day.name)} · Week ${ui.week}${isDeload(block, ui.week) ? ' · <span class="chip warn">Deload: RPE 6-7</span>' : ''}
      ${session?.date ? `<small>${session.date}</small>` : session?.imported ? '<small>from Excel</small>' : ''}</h2>
    ${day.exercises.map((ex) => renderExercise(block, day, ex, next, ro)).join('') || '<p class="empty">No exercises on this day.</p>'}
    ${!ro && !next && day.exercises.length ? `<p class="finished">Day complete 💪</p>` : ''}`;
}

function renderExercise(block, day, ex, next, ro) {
  const entry = currentEntry(block, ex);
  const name = entry?.name ?? ex.name;
  const swapped = name !== ex.name;
  const n = setCount(ex, block, ui.week);
  const hist = history(state, person().id, name, positionKey(state, person().id, block.id, ui.week, day.id), 3);
  const wt = ex.weightType;
  const wLabel = wt === 'assisted' ? 'assist kg' : wt === 'bodyweight' ? '+kg' : 'kg';
  const rpe = isDeload(block, ui.week) ? '6-7' : ex.rpe;

  const rows = Array.from({ length: n }, (_, i) => {
    const s = shownSet(block, day, ex, i);
    const isNext = next && next.ex.id === ex.id && next.i === i;
    const dis = ro ? 'disabled' : '';
    return `
      <div class="set ${s.done ? 'done' : ''} ${isNext ? 'next' : ''}" id="set-${ex.id}-${i}" data-ex="${ex.id}" data-i="${i}">
        <span class="num">${i + 1}</span>
        <div class="stepper">
          <button data-action="step" data-field="reps" data-d="-1" ${dis} aria-label="fewer reps">−</button>
          <input data-field="reps" inputmode="numeric" pattern="[0-9]*" value="${s.reps ?? ''}" placeholder="reps" class="${s.suggested ? 'sug' : ''}" ${dis}>
          <button data-action="step" data-field="reps" data-d="1" ${dis} aria-label="more reps">+</button>
        </div>
        <div class="stepper">
          <button data-action="step" data-field="weight" data-d="-1" ${dis} aria-label="less weight">−</button>
          <input data-field="weight" inputmode="decimal" value="${s.weight ?? ''}" placeholder="${wLabel}" class="${s.suggested ? 'sug' : ''}" ${dis}>
          <button data-action="step" data-field="weight" data-d="1" ${dis} aria-label="more weight">+</button>
        </div>
        <button class="check" data-action="toggle" ${dis} aria-label="${s.done ? 'undo set' : 'log set'}">✓</button>
      </div>`;
  }).join('');

  return `
    <section class="ex" id="ex-${ex.id}">
      <div class="exhead">
        <h3>${ex.superset ? `<span class="chip">${h(ex.superset)}</span> ` : ''}${h(titleCase(name))}
          ${swapped ? `<small>sub for ${h(titleCase(ex.name))}</small>` : ''}</h3>
        <div class="icons">
          ${ex.video ? `<a class="icon" href="${h(ex.video)}" target="_blank" rel="noopener" aria-label="video">▶</a>` : ''}
          ${ex.notes ? `<button class="icon" data-action="notes" data-ex="${ex.id}" aria-label="notes">i</button>` : ''}
          ${ex.sub && !ro ? `<button class="icon" data-action="swap" data-ex="${ex.id}" aria-label="swap exercise">⇄</button>` : ''}
        </div>
      </div>
      <div class="rx">${n} × ${h(ex.reps)} · RPE ${h(rpe)} · ${h(ex.rest)}${ex.warmup && ex.warmup !== '0' ? ` · WU ${h(ex.warmup)}` : ''}${ex.sub && !swapped ? ` · alt: ${h(titleCase(ex.sub))}` : ''}</div>
      ${ui.openNotes.has(ex.id) ? `<p class="notes">${h(ex.notes)}</p>` : ''}
      ${hist.length ? `<div class="hist">${hist.map(({ session, entry }) =>
        `<span><b>W${session.week}${session.blockId !== block.id ? '*' : ''}</b> ${entry.sets.filter((s) => s?.done).map((s) => formatSet(s, wt)).join(' ')}</span>`).join('')}</div>` : ''}
      ${entry?.flag ? `<p class="flag">⚠ ${h(entry.flag)} <button data-action="clearflag" data-ex="${ex.id}">OK</button></p>` : ''}
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
          <button class="icon" data-action="moveDay" data-di="${di}" data-d="-1" aria-label="move day up">↑</button>
          <button class="icon" data-action="moveDay" data-di="${di}" data-d="1" aria-label="move day down">↓</button>
          <button class="icon danger" data-action="delDay" data-di="${di}" aria-label="delete day">✕</button>
        </div>
        <ol class="exlist">
          ${d.exercises.map((ex, ei) => `
            <li>
              <button class="exedit" data-action="editEx" data-di="${di}" data-ei="${ei}">
                <b>${ex.superset ? h(ex.superset) + ' ' : ''}${h(titleCase(ex.name))}</b>
                <small>${ex.sets} × ${h(ex.reps)} · RPE ${h(ex.rpe)} · ${h(ex.rest)}${ex.video ? ' · ▶' : ''}</small>
              </button>
              <button class="icon" data-action="moveEx" data-di="${di}" data-ei="${ei}" data-d="-1" aria-label="move up">↑</button>
              <button class="icon" data-action="moveEx" data-di="${di}" data-ei="${ei}" data-d="1" aria-label="move down">↓</button>
            </li>`).join('')}
        </ol>
        <button data-action="addEx" data-di="${di}">+ Add exercise</button>
      </section>`).join('')}
    <button data-action="addDay">+ Add day</button>`;
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
  ['warmup', 'Warm-up sets', 'text'], ['rest', 'Rest', 'text'], ['sub', 'Substitute', 'text'],
  ['increment', '+/− step (kg)', 'number'], ['video', 'YouTube link', 'url'],
];

function openExerciseEditor(di, ei) {
  const block = viewedBlock();
  const isNew = ei == null;
  const ex = isNew
    ? { id: uid(), name: '', superset: '', warmup: '0', sets: 3, reps: '8-12', rpe: '8', rest: '2 min', sub: '', notes: '', video: '', weightType: 'load', increment: 2.5 }
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
      <label class="check-label"><input type="checkbox" name="videoAll" checked> Use this video for every exercise with this name (both people)</label>
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
    for (const [f, , type] of EX_FIELDS) ex[f] = type === 'number' ? Number(data[f]) || 0 : data[f].trim();
    ex.name = ex.name.toUpperCase();
    ex.sub = ex.sub.toUpperCase();
    ex.superset = ex.superset.toUpperCase();
    ex.sets = Math.max(1, Math.round(ex.sets));
    ex.weightType = data.weightType;
    ex.notes = data.notes.trim();
    if (data.videoAll) {
      for (const b of state.blocks) for (const d of b.days) for (const e of d.exercises) {
        if (e.name === ex.name) e.video = ex.video;
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
    const { block, day, ex, i } = setContext(el);
    const s = shownSet(block, day, ex, i);
    const { entry } = ensureEntry(block, ex);
    const field = el.dataset.field;
    const step = field === 'reps' ? 1 : ex.increment || 1;
    const value = round2(Math.max(0, (s[field] ?? 0) + Number(el.dataset.d) * step));
    entry.sets[i] = { reps: s.reps, weight: s.weight, done: s.done, [field]: value };
    commit();
  },
  toggle(el) {
    const { block, day, ex, i } = setContext(el);
    const s = shownSet(block, day, ex, i);
    const { session, entry } = ensureEntry(block, ex);
    if (s.done) {
      entry.sets[i] = { ...entry.sets[i], done: false };
    } else {
      if (s.reps == null) {
        el.closest('.set').querySelector('[data-field=reps]').focus();
        return;
      }
      entry.sets[i] = { reps: s.reps, weight: s.weight, done: true };
      session.date ??= session.imported ? null : today();
      const next = nextOpenSet(block, day);
      if (next) ui.scrollTo = `set-${next.ex.id}-${next.i}`;
    }
    commit();
  },
  swap(el) {
    const block = viewedBlock();
    const ex = viewedDay(block).exercises.find((e) => e.id === el.dataset.ex);
    const { entry } = ensureEntry(block, ex);
    entry.name = entry.name === ex.name ? ex.sub : ex.name;
    entry.sets = entry.sets.map((s) => (s?.done ? s : null));
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
    }
  },
  // Typed values in a set row.
  setField(el) {
    const { block, day, ex, i } = setContext(el);
    const s = shownSet(block, day, ex, i);
    const { entry } = ensureEntry(block, ex);
    const raw = el.value.replace(',', '.').trim();
    const value = raw === '' ? null : round2(Math.max(0, Number(raw) || 0));
    entry.sets[i] = { reps: s.reps, weight: s.weight, done: s.done, [el.dataset.field]: value };
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
  return { block, day, ex, i: Number(row.dataset.i) };
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
