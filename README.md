# Polaris

Polaris keeps the **🌌 Universe** and **💸 Collections** Lark tables in step with
what gets filed. Each change the trackers need shows up as a card;
**Push** makes it with one click, **Ignore** hides it for good (with Undo). It works on a
phone and on a PC, and every change is made as you, with your own Lark login.

| Source | Becomes |
| ------ | ------- |
| **Project Brief** (by Account Managers) | a new **Universe** row |
| **Project Approval (PAR)** | the request number in the project's Universe **PAR** column |
| **Won project** (in the Universe, with a PAR) | a **For Invoicing** row in **Collections** |
| **Invoice Request** (by Account Managers) | moves its Collections row along: **Pending Invoice Request Approval** when filed, **For Collection** when approved |
| **Project Brief** (any department) | a new **ANDON** row (Project Management's board) |

> **Connected to the live tables.** `ENV_LABEL` in `js/config.js` is empty, so the
> header shows no *Test copy* badge and every push changes real data. See
> [Going live](#going-live) for switching between the test copies and production.

---

## Contents

- [Using Polaris](#using-polaris)
- [What shows up as a card](#what-shows-up-as-a-card)
- [What gets written](#what-gets-written)
- [The audit](#the-audit)
- [The Universe view](#the-universe-view)
- [Safety checks](#safety-checks)
- [Running it on your computer](#running-it-on-your-computer)
- [Hosting it for phones](#hosting-it-for-phones)
- [Going live](#going-live)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)
- [Files](#files)
- [Known limits](#known-limits)

---

## Using Polaris

1. **Log in with Lark.** A login lasts about 2 hours. The clock in the header
   shows how long you have left (it turns yellow in the last 10 minutes), and
   Settings shows the exact time it ends. **Log in again** there to get a fresh 2 hours.
2. **Briefs / PARs** tabs list what isn't in the Universe yet; **Invoices** lists
   every change Collections needs (see [Invoices](#invoices-the-collections-lifecycle)).
   Newest first; search narrows the list.
3. **Push** opens a sheet that shows exactly what will be written:
   - *Brief:* type the **Client**, pick the **BD** (blank unless you pick someone;
     frequent BDs are listed first), choose **VAT** (the amount updates as you
     switch), and optionally **Add other links** (blank by default).
   - *PAR:* shows the PAR cell before and after. If several Universe rows share
     the code, you choose the row.
   - *Invoice:* shows which Collections row changes and how, each cell with what
     it was before. Pick another row (or a new one) if Polaris guessed wrong; a new
     row's **AR Name** can be edited (for example add "Downpayment"). For an
     approved request you can add the invoice details (number, SI, date, file).
4. **Ignore** hides a card by ticking the source row's IGNORE box. **Undo** in the
   message brings it back.
5. On a wide screen the **Universe** table sits beside the cards, so you can watch
   a pushed brief land (it glows briefly). On a phone, open the **Universe** tab
   or tap **View** in the message after a push.
6. **Settings** (the gear next to **Data Audit** in the top bar): your login, Light / Dark / System
   theme, and connection status. **This browser > Clear local data** forgets the
   audit cards you hid and how the tables are sorted and folded (your login and
   theme stay); **Undo** in the message puts them back.

---

## What shows up as a card

All five tables are read **in full**, never through a view (the Universe view in
the link shows only part of the table; reading through it would make projects
look missing and get them added twice).

**Project Briefs:** `Initiator department` is *Account Managers* or *Sales* (its
name before Oct 2025; the same goes for invoice requests everywhere in Polaris),
`IGNORE` isn't ticked, the `Project Code` isn't in any Universe row, and the status
isn't Rejected, Recalled, Canceled, Deleted or Terminated. Codes are compared
in canonical form, so `"2025TEG-P0313 "` with a trailing space still counts.
A card says *Note: looks like "…" (code), already in the Universe* when a Universe
project has a very similar name: usually a re-filed brief to ignore.

**PARs:** the request number isn't anywhere in the Universe's PAR column, and the
project is in the Universe. A PAR whose brief is still waiting shows as *Push
this project's brief first.* with a link to that brief. The project is found
through the PAR's `Associated Project Brief` (more reliable than its hand-typed
code); any disagreement is shown as a note.

**Invoices:** see the next section.

Under each list: *Not shown: 233 already in the Universe · 24 ignored · …*

### Invoices: the Collections lifecycle

A Collections row moves through three stages, and the Invoices tab shows each
move that's due, as one card:

| Card | When | Push |
| ---- | ---- | ---- |
| **Won** | A Universe project is won (*Won - Awaiting CE Signature*, *Signed CE* or *For Collection*), has a PAR, and has no Collections row and no invoice request yet | adds a **For Invoicing** row |
| **Under Review** (request filed) | An invoice request is filed and isn't on any row | puts its number on the project's For Invoicing row and sets **Pending Invoice Request Approval** (or adds a new Pending row if there's none) |
| **Approved** | The request is approved and its row isn't For Collection yet | sets **For Collection**, updates the amount to the invoiced one if it changed, and takes the invoice details if you add them (a row can skip Pending when the approval is quick) |
| **Recalled / Rejected** (withdrawn) | A request on a Pending row was withdrawn | clears the number and puts the row back to **For Invoicing** |

So one invoice request comes up twice: when it's filed, and again when it's approved.

- **Which row.** A project can have several For Invoicing rows (tranches). Each
  request goes to the one in the same currency with the closest amount, one
  request per row. The card says which row (*"Tranche 2" · For Invoicing → Pending…*)
  and the sheet lets you pick another, or a new row.
- **Rows recorded by hand.** Many invoices were added to Collections without
  their request number. When an approved request has exactly the same amount as
  one of those rows (as filed, or VAT-ex), the card offers to **add the request
  number** to that row, and nothing else changes on it (*For Collection · adds
  the request number*). Ties go to the request approved closest to the row's
  Invoice Date. If a row is close but not equal, the card asks you to check it.
- **Requests filed again.** If a recalled request is replaced by a new one, the
  new request simply takes the row over; no *withdrawn* card is shown for it.
- **Which project.** The request's typed Project Code, or, when that code isn't in
  the Universe, the project its PAR (*Associated Project Approval*) is on. If the
  two disagree, the card says so.
- **Not shown:** other departments' requests (unless already on a Collections row:
  those are followed whoever filed them), ignored ones, rejected or recalled ones
  that aren't on a row, projects not in the Universe, and **closed or lost
  projects** (*For Closing*, *Fully Closed*, *Lost*, *Stalled*, *Archived*), unless
  a row of theirs is still waiting in For Invoicing.
- **Blocked:** a new row for a project with **no PAR** in the Universe (*Add this
  project's PAR to the Universe first*, with a link to the PAR card if there is
  one), and a won project with no amount yet.
- **Ignore** ticks the request's IGNORE box. For a *Won* card it ticks an
  **IGNORE** checkbox on the project's Universe row, which the Universe doesn't
  have yet: until someone adds that column, Ignore is greyed out on *Won* cards.
- **Mark invalid** (on *Won* cards) is the way to keep a won project out of the
  list without that column: it adds the project to Collections with Status
  **Invalid** (it works even when the project has no amount). Any Collections
  row for a project, Invalid included, means it's no longer offered as *Won*.
  To undo it, delete or change that row in Collections.

---

## What gets written

Empty values are never written, so nothing is blanked.

### Project Brief → new Universe row

| Universe column | Value |
| --------------- | ----- |
| Project Code | the brief's code, canonical |
| Project | Project Name |
| Client | what you type in the sheet (blank if you leave it) |
| BD | who you pick in the sheet (blank by default) |
| AM, MKT | the brief's AM and MKT |
| Amount (VAT-Ex.) (PHP) | Contract Value × **57** if USD, then **÷ 1.12** for 12% VAT, to the centavo |
| VAT% | chosen in the sheet: **12%** (default for PHP) or **0%** (default for USD). The sheet quotes any VAT sentence from the brief's remarks. |
| Project Description | Remarks |
| Project Start / End | Start date / End date |
| RFP Received Date | the day the brief was submitted (Manila time) |
| Year | from the code, e.g. `2026` |
| Status / Mancom Phase | `For CE/Pitch Creation` / `1. Client Brief Kickoff` |
| Other Links | what you add in the sheet (blank by default) |

Business Unit, Tribe and AM Lookup are lookups in the Universe and fill themselves in.

### Project Brief → new ANDON row

ANDON takes briefs from **every** department (the Universe only takes Account
Managers'). A brief shows on the **ANDON** tab while its code isn't in ANDON.

| ANDON column | Value |
| ------------ | ----- |
| Project, Project Code | the brief's Project Name and canonical code |
| AM | the brief's AM (ANDON holds one) |
| MKT (PITCH) | the brief's MKT |
| PM (LEAD) | who you pick in the sheet (blank by default; frequent ANDON PMs first) |
| TRIBE | picked in the sheet (blank by default; it can't be worked out from the brief) |
| Business Unit, Tools | the brief's, when ANDON has a matching option |
| Event Start / End | Start date / End date |

The live ANDON fills Brief, Brief Status, Brief Contract Value, Brief Currency,
Remarks, YEAR, MONTH, Contract Value (USD) and Budget Tier itself (lookups and
formulas from the Project Code and dates), so Polaris never writes those; it writes
only the columns a person would type. Budget Tier is left to ANDON. The Universe's
Business Unit and Tribe are lookups from ANDON, so they fill in once the ANDON row exists.

**Ignore** uses the brief's one IGNORE box, so an ignored brief disappears from both the
Universe and ANDON lists.

### PAR → Universe PAR

The request number goes into the project row's `PAR`, after any PAR already there
(`202607030034, 202610080029`), never replacing it.

### Collections changes

| Change | Collections columns written |
| ------ | --------------------------- |
| Won → new row | AR Name (the project, editable), Project Code, Invoice Amount = the Universe's **Amount (VAT-Inc.)** in PHP, Currency `PHP`, Status `For Invoicing`, Business Unit (the Universe's, matched to a Collections option) |
| Filed → its row | Invoice Request (the number) and Status `Pending Invoice Request Approval`; nothing else |
| Filed → new row | AR Name, Project Code, Invoice Amount and Currency (as filed), Invoice Request, Status `Pending…`, Business Unit |
| Approved → its row | Status `For Collection`; Invoice Amount and Currency when the request's differ; the request number if the row didn't have it; any invoice details you add |
| Approved → a row recorded by hand | Invoice Request only (plus any invoice details you add) |
| Approved → new row | as *Filed → new row*, with Status `For Collection` |
| Withdrawn → its row | Invoice Request cleared, Status `For Invoicing` |

Only cells that change are written. PAR, Project Name, Client Name and AM are
lookups in Collections and fill themselves from the Universe through the Project
Code. Select values are only ever written with an option that already exists.

All rules are in [`js/config.js`](js/config.js) and [`js/sync.js`](js/sync.js).

---

## The audit

The **Audit** tab checks every Universe and ANDON row against its Project Brief
(matched by project code; the newest brief that wasn't rejected or withdrawn) and
lists each row that has **blank cells the brief can fill**: AM, MKT, the amount,
Project Description, start and end dates, RFP Received Date and Year for the
Universe; the typed ANDON columns (AM, MKT (PITCH), Business Unit, Tools, Event
Start / End…) for ANDON.

- **Fill** shows each blank with an editor, pre-filled from the brief. Briefs go
  out of date, so change anything before pushing (text, amounts, dates, people,
  Business Unit, Tools); untick any you'd rather leave blank. The sheet says which
  values are from the brief and which you edited. If the amount is blank and the
  row has no VAT%, pick the VAT (it's written to VAT% too).
- Only blank cells are ever written. The row is re-read just before writing: a
  cell someone filled meanwhile is left alone, then everything written is read back.
- Never audited: what a person decides (Client, BD, Other Links, Status, Mancom
  Phase, VAT% on its own, PM (LEAD), TRIBE) and what Lark computes (lookups, formulas).
- **Hide** removes a card **on this device only** (nothing is written to Lark).
  It comes back if another cell of that row goes blank.

---

## The Universe view

Grouped by **Status** (in the column's own option order, each group with its count
and total), filtered to one **Year** (this year by default; pick another or *All
years*), **Lost, Stalled and Archived hidden**, sorted by **RFP Received Date**
(newest first; click the column to flip it). Columns: Client, Project, Amount
(VAT-Ex.) (PHP), BD, AM, Project Code, RFP Received Date. Groups can be folded.

After a push, Polaris re-reads the Universe from Lark (not just its own copy), so
the row you see is the row that's really there.

---

## The Collections view

On the **Invoices** tab, the right-hand pane shows **Collections** instead of the
Universe (on a phone, the last tab becomes *Collections*). Columns: AR Name,
Project Code, Invoice Amount, Currency, Sales Remarks, Status, AM; grouped by
**Status** (in the column's own order) and sorted by **Invoice Number** (newest
first; click *Invoice No.* to flip). The invoice number, SI number, date and file
count show under each AR name. After you add an invoice, the new row glows.

**Invoice details.** Invoice Number, SI Number, Invoice Date and the Invoice file
are filled in by hand. If the invoice is already issued, add them when you **Push**
(*Add invoice details* in the sheet; files upload before the row is created, so a
failed upload writes nothing). Otherwise add them later with the **+** (or the
pencil, to edit) on the Collections row: the sheet saves only what you changed, uploads files
first (PDF or image, up to 10 MB each, the most the connection service takes),
then reads the row back to confirm. Clearing a field empties it in Lark.

**Dates.** Every date field takes a typed date (*Oct 14, 2026*, *2026-10-14*,
*10/14/2026*, *14 Oct*…) or opens a calendar on a double-click (or the calendar
button, handy on phones). A date Polaris can't read is outlined in red and blocks
the push until it's fixed.

**Click to copy.** Request numbers, project codes, PAR numbers, invoice numbers and
SI numbers copy to the clipboard when clicked: on cards (including inside notes),
in the push sheets, and in the Universe and Collections tables.

## Safety checks

- **Every column is checked on load** (name, type, and the select options Polaris
  writes). If anything doesn't match, pushing is switched off and the problem is listed.
- **The destination is re-read just before every push.** If it's already there
  (someone else pushed it), nothing is written and the list refreshes. A
  Collections change also checks its row still says what the card saw (same
  Status, same request number) and that no other row took the request meanwhile.
- **Creates are idempotent** (`client_token`), so a retry can't make a second row.
- **Every write is read back** and compared field by field. The message says
  *All 15 fields checked in Lark*, or lists what didn't match.
- Ignore is instant and rolls back (with the reason) if Lark refuses it.

---

## Running it on your computer

```bash
python -m http.server 9123 --bind 127.0.0.1
```

Open **http://127.0.0.1:9123/**. That address is registered as a redirect URL on
Lark app `cli_aab0716138b8ded3`. The connection service (the Lark proxy on Render)
sleeps when idle, so the first load can take up to a minute; Polaris says so
while it waits.

---

## Hosting it for phones

Any static host works (for example GitHub Pages); there's no build step.

1. Upload the folder (the `tests/` folder isn't needed, and must never include a preview snapshot).
2. Register the page's exact address, e.g. `https://<user>.github.io/polaris/`,
   in the Lark developer console under *Security Settings > Redirect URLs*.
   Polaris checks this on the login screen and says if it's missing.
3. It must be served over `https://`. On a phone you can *Add to Home Screen*.

---

## Going live

1. In [`js/config.js`](js/config.js), replace the five links in `TABLE_LINKS` with
   the production tables and set `ENV_LABEL = ""` (this is how it's set now). To
   go back to the test copies, for example to run the end-to-end check, put their
   links back and set `ENV_LABEL = "Test copy"`.
2. Run `npm run check:live` (or just open Polaris). Any column that's named or typed
   differently in production is listed, and pushing stays off until it's fixed.
3. Everyone who uses Polaris needs edit access to those Bases (it writes as them).
4. Older items that predate the Universe: ignore them once in Polaris.

---

## Tests

```bash
npm test                 # offline: transfer rules and the Universe view, with fixtures from real data quirks
npm run check:live       # read-only: column check, the card lists and every payload, against the live tables
```

**Preview mode (developers, no login).** `npm run preview:fixture` saves a read-only
snapshot of the tables to `tests/.preview-fixture.json`; then open
**http://127.0.0.1:9123/?preview** in its own tab. Polaris runs unchanged, but every
Lark call is answered from the snapshot and pushes are simulated in the tab (a red
badge says so); nothing is sent to Lark. It only works on localhost. The snapshot
holds real business data: never publish it (it's in `.gitignore`) and delete it when done.

**End-to-end (writes to the test copy).** The Lark app can read these Bases but
not edit them, so this runs as you, in the browser: log in to Polaris, then open
**http://127.0.0.1:9123/tests/e2e.html** in the same tab and click *Run the check*
twice. It snapshots every stored field of all five tables, pushes one brief, one
PAR, one Collections change that adds a row and one that moves a row along,
ignores and restores one brief, re-pushes each (expecting *already done*), and
requires the before/after difference to be exactly those writes. It refuses to
run unless `ENV_LABEL` is `"Test copy"`, so it can't run while Polaris points at
the live tables.

---

## Troubleshooting

| You see | What to do |
| ------- | ---------- |
| *Waking up the connection… This can take up to a minute.* | Nothing; the free Render service is starting. It retries for up to 3 minutes. |
| *Polaris can't reach its connection service.* (red box, mentions an ad blocker) | Allow `lark-proxy-dwiw.onrender.com` in your ad blocker or privacy extension (or pause it on this page), then **Reload**. |
| *This address (…) isn't registered on the Lark app* on the login screen | Add that exact address under *Security Settings > Redirect URLs* for the app. |
| *Your login ended after about 2 hours.* | Log in again. Watch the clock in the header; *Log in again* in Settings renews it early. |
| *Your login is about to end, so this wasn't sent.* | Log in again, then push. |
| *These columns don't match what Polaris expects…* | A column was renamed or changed type (common when switching to production). Fix the table or `js/config.js`. |
| *Your login can only read the tables.* | Log in again so Lark grants editing. |
| *Lark says your account can't open or edit this Base.* | Ask the Base owner for edit access. |
| *… is already in the Universe. Someone else already did this.* | Nothing; it was pushed elsewhere. The list refreshed. |
| *Check these in Lark: …* after a push | A value didn't land as sent. Open the row in Lark and correct it. |
| *Note: looks like "…" already in the Universe* | Probably a re-filed brief. Ignore it if it's the same project. |
| *Push this project's brief first.* | Use **Go to the brief**, push it, then the PAR or invoice can go. |
| *Add this project's PAR to the Universe first.* | Use **Go to the PAR** (if it's listed), push it, then the invoice can go. |
| *"…" changed since the list was loaded.* | Someone updated that Collections row meanwhile. Nothing was written; the list refreshed, so check the card again. |
| **Ignore** is greyed out on a *Won* card | The Universe has no IGNORE checkbox column yet. Add one (named `IGNORE`) to hide won projects that shouldn't go to Collections. |
| A card would add a new Collections row you think already exists | Pick that row in the sheet instead (rows recorded by hand show *add the number only*), or ignore the card. |

---

## Files

| File | Purpose |
| ---- | ------- |
| `index.html` | The page. |
| `css/theme.css`, `css/mineski-base.css` | Polaris's colors (light and dark) and the shared Mineski stylesheet: unedited copies of `design-ref/mineski-design-language/assets/themes/polaris.css` and `assets/mineski-base.css`. |
| `css/app.css` | Only what is Polaris's own: the workspace, the tables' columns and phone layout, the flow line, the audit and the date field. |
| `img/` | The Polaris icon (SVG, plus PNGs for the favicon, phones and the home screen). |
| `manifest.webmanifest` | Lets phones add Polaris to the home screen. |
| `js/config.js` | Table links and business rules (department, USD rate, VAT, statuses, the Universe view). |
| `js/sync.js` | The transfer rules as pure functions: cards, what gets written, the Universe view, read-back checks. |
| `js/ops.js` | Every Lark read and write: column check, full-table loads, pushes with re-check and read-back. |
| `js/net.js` | The connection service: waking it, retries, ad-blocker detection, error messages. |
| `js/auth.js` | Lark login (OAuth + PKCE) and the session clock. |
| `js/app.js` | Routes, header, loading, Settings, and what happens after a push. |
| `js/inbox.js` | The cards, the push sheet (with the BD picker) and Ignore / Undo. |
| `js/universe.js` | The Universe table. |
| `js/collections.js` | The Collections table and its invoice details sheet. |
| `js/icons.js`, `js/ui.js` | The shared Mineski icons and UI helpers: unedited copies of `design-ref/mineski-design-language/assets/`. Change them there, then copy them over. |
| `js/polaris-ui.js` | Polaris-only helpers on top of `ui.js`: Lark date-only days, the date field, copyable request numbers and project codes in a sentence. |
| `tests/` | Offline tests, the live read-only check and the end-to-end check. |

Polaris follows the Mineski design language (`.claude/skills/mineski-design-language/`).
One deliberate difference: it uses JavaScript modules instead of classic scripts, so the tests run the exact code the
page runs; an import map still gives every module a fresh URL on each visit.

---

## Known limits

- **Attachments.** The brief's attachments live in Lark Approval, which this app
  has no permission to read, so their files can't be copied. Add links by hand
  under *Add other links* if needed.
- **Client** isn't on the Project Brief, so it's typed in the sheet (or left for later).
- **Old PARs and invoices.** Nothing in those tables is marked IGNORE yet, so older
  ones for projects in the Universe show up once. Push or ignore them. Approved
  requests whose invoices were typed into Collections by hand with a slightly
  different amount can't be matched safely; their cards say so, so pick the row
  in the sheet or ignore the card.
- **Tranches.** A won project gets one For Invoicing row for its whole amount.
  Split it into tranche rows by hand if it's billed in parts; requests then find
  the right tranche by amount.
- **Lark API formats.** Read-backs use `records/batch_get` (the single-record GET
  returns numbers as text). Text columns only accept plain text; Lark still shows
  URLs in them as clickable links.
