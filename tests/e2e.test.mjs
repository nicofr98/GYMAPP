// Drives the real app in headless Chromium at phone size.
// Needs `npm install` (playwright-core) and a Chromium: set CHROMIUM_PATH, or
// have Playwright's browsers installed. Skipped when either is missing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { DEFAULT_STATE } from '../js/default-program.js';

const ROOT = resolve(import.meta.dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

let chromium = null;
try {
  ({ chromium } = await import('playwright-core'));
} catch {}
const executablePath = process.env.CHROMIUM_PATH
  ?? ['/opt/pw-browsers/chromium'].find((p) => existsSync(p));
const skip = !chromium ? 'playwright-core not installed (run npm install)' : false;

let server, browser, baseUrl, backupPath;

// A backup where Nico logged weeks 1-2 of Lower A and week 1 of Upper A.
function fixture() {
  const state = structuredClone(DEFAULT_STATE);
  const nico = state.blocks.find((b) => b.personId === 'nico');
  const [lowerA, upperA] = nico.days;
  const session = (week, day, entries) => ({
    id: `t-${week}-${day.id}`, personId: 'nico', blockId: nico.id, week, dayId: day.id, date: null, imported: true, entries,
  });
  const sets = (n, reps, weight) => Array.from({ length: n }, () => ({ reps, weight, done: true }));
  const squat = lowerA.exercises[0];
  state.sessions.push(
    session(1, lowerA, { [squat.id]: { name: squat.name, sets: sets(1, 5, 100) } }),
    session(2, lowerA, { [squat.id]: { name: squat.name, sets: sets(1, 6, 100), flag: 'Imported from Excel without reps. Check this.' } }),
    session(1, upperA, Object.fromEntries(upperA.exercises.map((e) => [e.id, { name: e.name, sets: sets(e.sets, 8, 40) }]))),
  );
  return state;
}

before(async () => {
  if (skip) return;
  server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    try {
      const body = await readFile(join(ROOT, path.endsWith('/') ? `${path}index.html` : path));
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'text/html' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://localhost:${server.address().port}/`;
  browser = await chromium.launch(executablePath ? { executablePath } : {});
  backupPath = join(await mkdtemp(join(tmpdir(), 'gymapp-')), 'gymapp-backup-test.json');
  await writeFile(backupPath, JSON.stringify(fixture()));
});

after(async () => {
  await browser?.close();
  server?.close();
});

async function openApp() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(baseUrl);
  return { page, errors };
}

async function importBackup(page) {
  await page.click('[data-action=tab][data-id=settings]');
  await page.setInputFiles('input[type=file]', backupPath);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('gymapp.v1') ?? 'null')?.sessions?.length === 3);
  await page.click('[data-action=tab][data-id=log]');
}

const go = async (page, week, dayIdx) => {
  await page.click(`[data-action=week][data-w="${week}"]`);
  await page.click(`[data-action=day][data-i="${dayIdx}"]`);
};
const row = (page, n) => page.locator('.set').nth(n);
const val = (r, field) => r.locator(`input[data-field=${field}]`).inputValue();

test('fresh install shows the bundled program on week 1 day 1', { skip }, async () => {
  const { page, errors } = await openApp();
  assert.match(await page.textContent('.dayname'), /Lower A \(Strength\) · Week 1/);
  assert.equal(await page.locator('.ex').count(), 7);
  assert.deepEqual(errors, []);
});

test('import opens on the day after the last one logged', { skip }, async () => {
  const { page, errors } = await openApp();
  await importBackup(page);
  // Latest logged is week 2 Lower A, so the next one is week 2 Upper A.
  assert.match(await page.textContent('.dayname'), /Upper A \(Strength\) · Week 2/);
  await go(page, 2, 0);
  assert.match(await page.textContent('.flag'), /without reps/);
  await page.click('.flag button');
  assert.equal(await page.locator('.flag').count(), 0);
  assert.deepEqual(errors, []);
});

test('log sets: prefill, step, check, auto-advance, persist', { skip }, async () => {
  const { page, errors } = await openApp();
  await importBackup(page);
  await go(page, 2, 1);

  // Pre-filled from week 1, shown as a suggestion.
  assert.equal(await val(row(page, 0), 'reps'), '8');
  assert.equal(await val(row(page, 0), 'weight'), '40');
  assert.equal(await row(page, 0).locator('input.sug').count(), 2);
  assert.match(await page.locator('.ex').first().locator('.hist').textContent(), /W1\s+8×40/);

  // +2.5 kg (barbell increment), then log it.
  await row(page, 0).locator('[data-action=step][data-field=weight][data-d="1"]').click();
  assert.equal(await val(row(page, 0), 'weight'), '42.5');
  await row(page, 0).locator('[data-action=toggle]').click();
  assert.match(await row(page, 0).getAttribute('class'), /done/);
  assert.match(await row(page, 1).getAttribute('class'), /next/);

  // Typed reps are rounded to whole numbers.
  await row(page, 1).locator('input[data-field=reps]').fill('7.6');
  await row(page, 1).locator('input[data-field=reps]').press('Enter');
  await row(page, 1).locator('input[data-field=reps]').blur();
  assert.equal(await val(row(page, 1), 'reps'), '8');

  // Undo a set.
  await row(page, 0).locator('[data-action=toggle]').click();
  assert.doesNotMatch(await row(page, 0).getAttribute('class'), /done/);
  await row(page, 0).locator('[data-action=toggle]').click();

  await page.reload();
  await go(page, 2, 1);
  assert.equal(await page.locator('.set.done').count(), 1);
  assert.equal(await val(row(page, 0), 'weight'), '42.5');
  assert.match(await page.textContent('.dayname'), /\d{4}-\d{2}-\d{2}/, 'date is stamped');
  assert.deepEqual(errors, []);
});

test('check on an empty set focuses reps and saves nothing', { skip }, async () => {
  const { page } = await openApp();
  await row(page, 0).locator('[data-action=toggle]').click();
  assert.equal(await page.evaluate(() => document.activeElement.dataset.field), 'reps');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('gymapp.v1') ?? 'null'));
  assert.equal(saved?.sessions?.length ?? 0, 0);
});

test('tapping through a day follows set order, alternating supersets', { skip }, async () => {
  const { page, errors } = await openApp();
  await importBackup(page);
  await go(page, 2, 1); // Upper A, everything pre-filled from week 1
  const order = [];
  while (await page.locator('.set.next').count()) {
    const next = page.locator('.set.next');
    order.push(`${await next.getAttribute('data-ex')}#${await next.getAttribute('data-i')}`);
    await next.locator('[data-action=toggle]').click();
  }
  const upperA = DEFAULT_STATE.blocks[0].days[1].exercises;
  const [a1, a2] = upperA.filter((e) => e.superset).map((e) => e.id);
  const i = order.indexOf(`${a1}#0`);
  assert.deepEqual(order.slice(i, i + 4), [`${a1}#0`, `${a2}#0`, `${a1}#1`, `${a2}#1`]);
  assert.equal(order.length, upperA.reduce((n, e) => n + e.sets, 0));
  assert.match(await page.textContent('.finished'), /Day complete/);
  assert.deepEqual(errors, []);
});

test('swap to substitute uses its own history and can swap back', { skip }, async () => {
  const { page } = await openApp();
  await go(page, 1, 0);
  const squat = page.locator('.ex').first();
  await squat.locator('[data-action=swap]').click();
  assert.match(await squat.locator('h3').textContent(), /Hack Squat\s+sub for Back Squat \(Top Set\)/);
  await squat.locator('[data-action=swap]').click();
  assert.doesNotMatch(await squat.locator('h3').textContent(), /Hack Squat/);
});

test('switching person keeps week and day; deload shows fewer sets', { skip }, async () => {
  const { page } = await openApp();
  await go(page, 8, 2);
  await page.click('[data-action=person][data-id=alexa]');
  assert.match(await page.textContent('.dayname'), /Lower B .* Week 8 .*Deload/);
  assert.equal(await page.locator('.ex').first().locator('.set').count(), 2); // 3 sets → 2
});

test('renaming an exercise keeps its history', { skip }, async () => {
  const { page } = await openApp();
  await importBackup(page);
  await page.click('[data-action=tab][data-id=program]');
  await page.locator('.exedit').first().click();
  await page.fill('dialog input[name=name]', 'Low bar squat');
  await page.click('dialog button[value=save]');
  await page.click('[data-action=tab][data-id=log]');
  await go(page, 3, 0);
  const first = page.locator('.ex').first();
  assert.match(await first.locator('h3').textContent(), /Low Bar Squat/);
  assert.match(await first.locator('.hist').textContent(), /W2\s+6×100.*W1\s+5×100/s);
});

test('new block copies the program and makes the old one read only', { skip }, async () => {
  const { page } = await openApp();
  await importBackup(page);
  await page.click('[data-action=tab][data-id=program]');
  await page.click('[data-action=newBlock]');
  await page.click('[data-action=tab][data-id=log]');
  assert.match(await page.textContent('.dayname'), /Week 1/);
  // History from the old block is shown (marked with *) and pre-fills.
  assert.match(await page.locator('.ex').first().locator('.hist').textContent(), /W2\*/);
  assert.equal(await val(row(page, 0), 'weight'), '100');

  await page.selectOption('.blockpick select', { index: 0 });
  assert.equal(await page.locator('.banner').count(), 1);
  assert.equal(await row(page, 0).locator('[data-action=toggle]').isDisabled(), true);
});

test('invalid backup is rejected and can be retried', { skip }, async () => {
  const { page } = await openApp();
  const badPath = join(resolve(backupPath, '..'), 'bad.json');
  await writeFile(badPath, '{"hello": 1}');
  const messages = [];
  page.removeAllListeners('dialog');
  page.on('dialog', (d) => { messages.push(d.message()); d.accept(); });
  await page.click('[data-action=tab][data-id=settings]');
  await page.setInputFiles('input[type=file]', badPath);
  await page.waitForFunction(() => true);
  await page.waitForTimeout(100);
  assert.match(messages.join(), /not a GymApp backup/);
  assert.equal(await page.locator('input[type=file]').inputValue(), '');
});
