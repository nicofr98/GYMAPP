# GymApp – Requirements (v1 draft)

## Goal
Log reps and weight during the workout as fast as possible, for two people
(Nico and Alexa), on one phone, with no internet needed.

## Platform
- Installable web app (PWA) on the phone that works fully offline.
- Data is stored only on the device (localStorage, with persistent storage requested). No accounts and no backend.
- Export and import a JSON backup file so data survives a phone change or a
  browser data wipe.
- Hosted as static files (e.g. GitHub Pages). That is needed only to install
  the app; after that it runs offline.

## People
- Two people, Nico and Alexa, logged from the same phone.
- Switching the active person is a single tap and always visible.
- Each person has their own program copy and their own history.

## Program model (mirrors the Excel)
- **Block**: 8 weeks, and week 8 is a deload.
- **Day**: 4 per week (Lower A, Upper A, Lower B, Upper B).
- **Exercise slot**: name, warm-up sets, working sets, rep range, RPE target,
  rest, substitute exercise and notes.
- Supersets (A1/A2) are grouped together.
- Weight type for each exercise: `load`, `bodyweight` or `assisted`
  (for assisted, a higher number means easier).

## Logging (the core flow)
1. Open app → last used person is selected → the next day that hasn't been
   done is suggested.
2. Each exercise lists its working sets. Every set is pre-filled with the
   reps/weight from the same set last session.
3. Tap ✓ to accept a set as it is, or change it with +/− steppers
   (reps ±1, weight ± the exercise's increment).
4. Logging a set moves the focus to the next set or exercise.
5. The substitute can be swapped in for today with one tap. The log records
   which exercise was actually done.
6. The notes are one tap away on each exercise.
7. The deload week shows fewer sets automatically (3→2, 2→1).

## Program editing / new blocks
- Add, remove, reorder and edit exercises and all of their prescription fields.
- Start a new block: copy the current program, then edit it. Old blocks stay
  in the history and can be read but not edited.

## Excel import
- One-time import of `Upper_Lower_Nico_Alexa.xlsx` (sheets `Nico` and `Alexa`):
  program plus the weeks already logged.
- The Excel only has one reps/weight value per exercise per week. It is
  imported as that value applied to every set.
- Known data fixes:
  - Nico, Day 1, Hip Abduction, weeks 1–2: the values are shifted one column
    and need to be realigned.
  - `"."` in a weight cell → bodyweight.
  - Alexa's Lat Pulldown → assisted.
  - Rows that have a weight but no reps (e.g. Alexa Bench top set wk5,
    Nico DB shoulder press wk2) are flagged for review, not guessed.

## Out of scope for v1
Rest timer, progression suggestions, charts, RPE logging per set, cloud sync.

## Later
- YouTube link per exercise (Nico provides the URLs), shipped as its own feature.

## Decisions
- Units: kg everywhere.
- UI language: English (program notes are translated during import).
- Default weight steps: 2.5 kg barbell and cable, 2 kg dumbbell, 5 kg
  machine. Editable per exercise.
- Last 3 sessions of each exercise are shown while logging.
- The repo is public, so logged numbers never go into it. The program
  template is bundled with the app; the Excel history is converted to a
  backup file that is imported on the phone.
