# Changelog

Every change and version update of Polaris, newest first. The version is
`APP.version` in `js/config.js`; the top bar shows it beside the name ("v1.0.0").

**Releasing a change:** bump `APP.version` (semver: patch for fixes, minor for
new features or behaviour, major when people must relearn something or old data
or links stop working), add an entry here with the same number and the date,
and say what changed in the team's words. `npm run check:shell` fails if the
two numbers differ.

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
