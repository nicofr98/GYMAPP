import { DEFAULT_STATE } from './default-program.js';

const KEY = 'gymapp.v1';

export function uid() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-5);
}

export function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (isValidState(saved)) return saved;
  } catch {}
  return structuredClone(DEFAULT_STATE);
}

export function save(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function isValidState(s) {
  return !!s && s.version === 1 && Array.isArray(s.people) && Array.isArray(s.blocks) && Array.isArray(s.sessions);
}

// Ask the browser not to evict our data under storage pressure.
export async function requestPersistence() {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export function downloadBackup(state) {
  const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gymapp-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
