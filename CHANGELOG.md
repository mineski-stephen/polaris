# Changelog

Every change and version update of Polaris, newest first. The version is
`APP.version` in `js/config.js`; the top bar shows it beside the name ("v1.0.0").

**Releasing a change:** bump `APP.version` (semver: patch for fixes, minor for
new features or behaviour, major when people must relearn something or old data
or links stop working), add an entry here with the same number and the date,
and say what changed in the team's words. `npm run check:shell` fails if the
two numbers differ.

## 1.2.1 · Oct 19, 2026

- **ANDON is sorted by Project Code, Z-A**, so the newest projects are on top
  (click *Project Code* to flip it to A-Z).
- **Switch the table beside the list.** Click the table's name (*Universe ▾*) to show
  Collections, ANDON or the Universe instead, whichever tab you're on. Each tab keeps
  its pick until you reload; pick the tab's own table to go back.

## 1.2.0 · Oct 19, 2026

- **Search finds everything.** The Universe and Collections searches look through
  every column of every row (description, PAR, MKT, remarks…), and in the Universe
  they include Lost, Stalled and Archived projects too. The year you picked still
  applies. With the search box empty, the tables look just as before.
- **ANDON has its own table.** On the ANDON tab, ANDON sits beside the cards
  (newest event first, searchable) instead of the Universe.
- **Click a row to open it.** Any row in the Universe, Collections or ANDON opens
  the whole record, every column, ready to change: text, amounts, dates, people,
  selects, checkboxes, links and files (add or remove). Formulas and lookups are
  shown but locked. The sheet lists each change you've made (with × to undo it);
  **Push** sends them to the queue. Before writing, Polaris re-reads the row; if
  someone changed one of the same cells meanwhile, nothing is written and the
  queue says which.

## 1.1.0 · Oct 19, 2026

- The **Audit** tab now checks that every *Fully Closed*, *For Closing*, *For
  Collection* and *Signed CE* project has its signed CE on file. A project whose
  **Signed CE (PDF)** is blank gets a card (even without a brief). **Fill** lets you
  add the PDF (one file or several); they're uploaded to Lark as you when the push
  runs, then put on the project's Universe row and read back to check.
- A card's other blanks can still be filled without the file: untick
  **Signed CE (PDF)**.

## 1.0.1 · Oct 16, 2026

- The lists no longer refresh on their own. Coming back to the tab after a while,
  or the queue finishing, doesn't reload them any more, so cards don't move while
  you're working; press **Refresh** to see what changed in Lark. A pushed card still
  leaves its list as soon as you push it.
- A card sliding out of the list no longer flashes a sideways scrollbar.

## 1.0.0 · Oct 16, 2026

- Initial release.
