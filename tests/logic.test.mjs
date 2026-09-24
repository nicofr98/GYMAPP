import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeBlock, findSession, setCount, sessionDone, positionKey,
  history, suggestNext, formatSet, titleCase,
} from '../js/logic.js';
import { DEFAULT_STATE } from '../js/default-program.js';

// Two days, 4 weeks, deload in week 4.
function makeState() {
  const block = (id, personId) => ({
    id, personId, name: id, weeks: 4, deloadWeek: 4,
    days: [
      { id: `${id}-d1`, name: 'Lower', exercises: [{ id: `${id}-e1`, name: 'SQUAT', sets: 3 }] },
      { id: `${id}-d2`, name: 'Upper', exercises: [{ id: `${id}-e2`, name: 'BENCH', sets: 2 }] },
    ],
  });
  return {
    version: 1,
    activePersonId: 'a',
    people: [{ id: 'a', name: 'A', activeBlockId: 'a1' }, { id: 'b', name: 'B', activeBlockId: 'b1' }],
    blocks: [block('a1', 'a'), block('b1', 'b')],
    sessions: [],
  };
}

function log(state, personId, blockId, week, dayIdx, name, sets, done = true) {
  const block = state.blocks.find((b) => b.id === blockId);
  const day = block.days[dayIdx];
  const s = { id: `${blockId}-${week}-${dayIdx}`, personId, blockId, week, dayId: day.id, date: null, entries: {} };
  s.entries[day.exercises[0].id] = { name, sets: sets.map(([reps, weight]) => ({ reps, weight, done })) };
  state.sessions.push(s);
  return s;
}

test('setCount drops ~40% of sets in the deload week, never below 1', () => {
  const block = { deloadWeek: 8 };
  assert.equal(setCount({ sets: 3 }, block, 1), 3);
  assert.equal(setCount({ sets: 3 }, block, 8), 2);
  assert.equal(setCount({ sets: 2 }, block, 8), 1);
  assert.equal(setCount({ sets: 1 }, block, 8), 1);
});

test('activeBlock follows the person pointer and falls back to their last block', () => {
  const s = makeState();
  assert.equal(activeBlock(s, 'a').id, 'a1');
  s.people[0].activeBlockId = 'missing';
  assert.equal(activeBlock(s, 'a').id, 'a1');
});

test('sessionDone needs at least one completed set', () => {
  const s = makeState();
  const session = log(s, 'a', 'a1', 1, 0, 'SQUAT', [[5, 100]], false);
  assert.equal(sessionDone(session), false);
  session.entries['a1-e1'].sets[0].done = true;
  assert.equal(sessionDone(session), true);
  assert.equal(sessionDone(undefined), false);
});

test('suggestNext starts at week 1 day 1 with nothing logged', () => {
  assert.deepEqual(suggestNext(makeState(), 'a'), { week: 1, dayId: 'a1-d1' });
});

test('suggestNext goes to the day after the latest logged one', () => {
  const s = makeState();
  log(s, 'a', 'a1', 1, 0, 'SQUAT', [[5, 100]]);
  log(s, 'a', 'a1', 2, 0, 'SQUAT', [[5, 100]]);
  assert.deepEqual(suggestNext(s, 'a'), { week: 2, dayId: 'a1-d2' });
});

test('suggestNext wraps to the next week after the last day', () => {
  const s = makeState();
  log(s, 'a', 'a1', 2, 1, 'BENCH', [[5, 60]]);
  assert.deepEqual(suggestNext(s, 'a'), { week: 3, dayId: 'a1-d1' });
});

test('suggestNext stays on the last day once the block is finished', () => {
  const s = makeState();
  log(s, 'a', 'a1', 4, 1, 'BENCH', [[5, 60]]);
  assert.deepEqual(suggestNext(s, 'a'), { week: 4, dayId: 'a1-d2' });
});

test('suggestNext ignores other people and sessions with no done sets', () => {
  const s = makeState();
  log(s, 'b', 'b1', 3, 0, 'SQUAT', [[5, 100]]);
  log(s, 'a', 'a1', 3, 0, 'SQUAT', [[5, 100]], false);
  assert.deepEqual(suggestNext(s, 'a'), { week: 1, dayId: 'a1-d1' });
});

test('history returns entries before a position, newest first, limited', () => {
  const s = makeState();
  for (const w of [1, 2, 3]) log(s, 'a', 'a1', w, 0, 'SQUAT', [[5, 90 + w]]);
  const before = positionKey(s, 'a', 'a1', 3, 'a1-d1');
  const h = history(s, 'a', 'SQUAT', before, 3);
  assert.deepEqual(h.map((x) => x.session.week), [2, 1]);
  assert.equal(history(s, 'a', 'SQUAT', Infinity, 1)[0].session.week, 3);
});

test('history matches by name, so substitutes keep their own history', () => {
  const s = makeState();
  log(s, 'a', 'a1', 1, 0, 'HACK SQUAT', [[8, 120]]);
  log(s, 'a', 'a1', 2, 0, 'SQUAT', [[5, 100]]);
  const h = history(s, 'a', 'HACK SQUAT', Infinity);
  assert.equal(h.length, 1);
  assert.equal(h[0].entry.sets[0].weight, 120);
  assert.equal(history(s, 'b', 'SQUAT', Infinity).length, 0);
});

test('history carries across blocks in block order', () => {
  const s = makeState();
  s.blocks.push({ ...structuredClone(s.blocks[0]), id: 'a2', days: [{ id: 'a2-d1', name: 'Lower', exercises: [{ id: 'a2-e1', name: 'SQUAT', sets: 3 }] }] });
  log(s, 'a', 'a1', 4, 0, 'SQUAT', [[5, 110]]);
  const newBlockStart = positionKey(s, 'a', 'a2', 1, 'a2-d1');
  assert.equal(history(s, 'a', 'SQUAT', newBlockStart)[0].entry.sets[0].weight, 110);
});

test('findSession looks up by person, block, week and day', () => {
  const s = makeState();
  const session = log(s, 'a', 'a1', 2, 1, 'BENCH', [[5, 60]]);
  assert.equal(findSession(s, 'a', 'a1', 2, 'a1-d2'), session);
  assert.equal(findSession(s, 'a', 'a1', 1, 'a1-d2'), undefined);
});

test('formatSet shows load, bodyweight and assisted sets', () => {
  assert.equal(formatSet({ reps: 8, weight: 60 }, 'load'), '8×60');
  assert.equal(formatSet({ reps: 8, weight: null }, 'bodyweight'), '8×BW');
  assert.equal(formatSet({ reps: 8, weight: 10 }, 'bodyweight'), '8×BW+10');
  assert.equal(formatSet({ reps: 8, weight: 30 }, 'assisted'), '8×(−30)');
  assert.equal(formatSet({ reps: null, weight: 17.5 }, 'load'), '?×17.5');
});

test('titleCase handles hyphens, parentheses and abbreviations', () => {
  assert.equal(titleCase('BACK SQUAT (TOP SET)'), 'Back Squat (Top Set)');
  assert.equal(titleCase('CHEST-SUPPORTED T-BAR ROW'), 'Chest-Supported T-Bar Row');
  assert.equal(titleCase('DUMBBELL RDL'), 'Dumbbell RDL');
  assert.equal(titleCase('A2. EZ BAR SKULL CRUSHER').includes('EZ Bar'), true);
});

test('bundled default program is valid and has no logged data', () => {
  assert.equal(DEFAULT_STATE.version, 1);
  assert.deepEqual(DEFAULT_STATE.sessions, []);
  assert.deepEqual(DEFAULT_STATE.people.map((p) => p.id), ['nico', 'alexa']);
  for (const p of DEFAULT_STATE.people) {
    const block = activeBlock(DEFAULT_STATE, p.id);
    assert.equal(block.days.length, 4);
    assert.equal(block.weeks, 8);
    assert.equal(block.deloadWeek, 8);
    const ids = block.days.flatMap((d) => d.exercises.map((e) => e.id));
    assert.equal(new Set(ids).size, ids.length, 'exercise ids are unique');
  }
});
