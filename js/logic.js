// Pure helpers over the app state. No DOM access here.

export function activeBlock(state, personId) {
  const person = state.people.find((p) => p.id === personId);
  return state.blocks.find((b) => b.id === person?.activeBlockId)
    ?? state.blocks.filter((b) => b.personId === personId).at(-1);
}

export function blocksOf(state, personId) {
  return state.blocks.filter((b) => b.personId === personId);
}

export function findSession(state, personId, blockId, week, dayId) {
  return state.sessions.find((s) =>
    s.personId === personId && s.blockId === blockId && s.week === week && s.dayId === dayId);
}

export function isDeload(block, week) {
  return week === block.deloadWeek;
}

// Deload drops ~40% of the sets: 3→2, 2→1, never below 1.
export function setCount(ex, block, week) {
  return isDeload(block, week) ? Math.max(1, Math.round(ex.sets * 0.6)) : ex.sets;
}

export function entryDone(entry) {
  return !!entry?.sets?.some((s) => s?.done);
}

export function sessionDone(session) {
  return !!session && Object.values(session.entries).some(entryDone);
}

// Chronological position of a (block, week, day) for one person.
export function positionKey(state, personId, blockId, week, dayId) {
  const blocks = blocksOf(state, personId);
  const bi = blocks.findIndex((b) => b.id === blockId);
  const di = blocks[bi]?.days.findIndex((d) => d.id === dayId) ?? 0;
  return bi * 10000 + week * 100 + di;
}

// Most recent logged entries of an exercise (matched by name, so history
// carries over to new blocks and to swapped-in substitutes), newest first,
// strictly before the given position.
export function history(state, personId, name, beforeKey, limit = 3) {
  const out = [];
  for (const s of state.sessions) {
    if (s.personId !== personId) continue;
    const key = positionKey(state, personId, s.blockId, s.week, s.dayId);
    if (key >= beforeKey) continue;
    for (const entry of Object.values(s.entries)) {
      if (entry.name === name && entryDone(entry)) out.push({ key, session: s, entry });
    }
  }
  return out.sort((a, b) => b.key - a.key).slice(0, limit);
}

// The day after the latest one logged; week 1 day 1 when nothing is logged.
export function suggestNext(state, personId) {
  const block = activeBlock(state, personId);
  if (!block || block.days.length === 0) return { week: 1, dayId: null };
  let last = null;
  for (const s of state.sessions) {
    if (s.personId !== personId || s.blockId !== block.id || !sessionDone(s)) continue;
    const di = block.days.findIndex((d) => d.id === s.dayId);
    if (di < 0) continue;
    const key = s.week * 100 + di;
    if (!last || key > last.key) last = { key, week: s.week, di };
  }
  if (!last) return { week: 1, dayId: block.days[0].id };
  let { week, di } = last;
  di += 1;
  if (di >= block.days.length) {
    di = 0;
    week = Math.min(week + 1, block.weeks);
  }
  return { week, dayId: block.days[di].id };
}

export function formatSet(set, weightType) {
  if (!set) return '–';
  const reps = set.reps ?? '?';
  if (weightType === 'bodyweight') return set.weight ? `${reps}×BW+${set.weight}` : `${reps}×BW`;
  if (weightType === 'assisted') return `${reps}×(−${set.weight ?? '?'})`;
  return `${reps}×${set.weight ?? '?'}`;
}

export function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_, p, c) => p + c.toUpperCase())
    .replace(/\b(Rdl|Ez|Db)\b/g, (m) => m.toUpperCase());
}
