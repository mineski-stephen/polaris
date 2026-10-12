# Polaris

Polaris keeps the **🌌 Universe** and **💸 Collections** Lark tables in step with
what gets filed. New Project Briefs, PARs and Invoice Requests show up as cards;
**Push** moves one across, **Ignore** hides it for good (with Undo). It works on a
phone and on a PC, and every change is made as you, with your own Lark login.

| Source | Becomes |
| ------ | ------- |
| **Project Brief** (by Account Managers) | a new **Universe** row |
| **Project Approval (PAR)** | the request number in the project's Universe **PAR** column |
| **Invoice Request** (by Account Managers) | a new **Collections** row |
| **Project Brief** (any department) | a new **ANDON** row (Project Management's board) |

> **Connected to the TEST COPIES.** The header shows a yellow *Test copy* badge.
> See [Going live](#going-live).

---

## Contents

- [Using Polaris](#using-polaris)
- [What shows up as a card](#what-shows-up-as-a-card)
- [What gets written](#what-gets-written)
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
2. **Briefs / PARs / Invoices** tabs list what isn't in the Universe or Collections
   yet, newest first. Search narrows the list.
3. **Push** opens a sheet that shows exactly what will be written:
   - *Brief:* type the **Client**, pick the **BD** (blank unless you pick someone;
     frequent BDs are listed first), choose **VAT** (the amount updates as you
     switch), and optionally **Add other links** (blank by default).
   - *PAR:* shows the PAR cell before and after. If several Universe rows share
     the code, you choose the row.
   - *Invoice:* edit the **AR Name** if you like (for example add "Downpayment").
4. **Ignore** hides a card by ticking the source row's IGNORE box. **Undo** in the
   message brings it back.
5. On a wide screen the **Universe** table sits beside the cards, so you can watch
   a pushed brief land (it glows briefly). On a phone, open the **Universe** tab
   or tap **View** in the message after a push.
6. **Settings** (the gear beside your picture): your login, Light / Dark / System
   theme, and connection status.

---

## What shows up as a card

All five tables are read **in full**, never through a view (the Universe view in
the link shows only part of the table; reading through it would make projects
look missing and get them added twice).

**Project Briefs:** `Initiator department` is *Account Managers*, `IGNORE` isn't
ticked, the `Project Code` isn't in any Universe row, and the status isn't
Rejected, Recalled, Canceled, Deleted or Terminated. (The department was called
*Sales* before Oct 2025; those older briefs are out of scope.) Codes are compared
in canonical form, so `"2025TEG-P0313 "` with a trailing space still counts.
A card says *Note: looks like "…" (code), already in the Universe* when a Universe
project has a very similar name: usually a re-filed brief to ignore.

**PARs:** the request number isn't anywhere in the Universe's PAR column, and the
project is in the Universe. A PAR whose brief is still waiting shows as *Push
this project's brief first.* with a link to that brief. The project is found
through the PAR's `Associated Project Brief` (more reliable than its hand-typed
code); any disagreement is shown as a note.

**Invoices:** by Account Managers, not ignored, not void, and no Collections row
carries its request number. A project can have many invoices. If an older
Collections row (from before request numbers were recorded) has the same amount,
the card says it's likely already recorded.

Under each list: *Not shown: 233 already in the Universe · 24 ignored · …*

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

### Invoice Request → new Collections row

AR Name (editable), Project Code, Invoice Amount, Currency, Invoice Request (the
request number), Status (`For Invoicing` if approved, else `Pending Invoice
Request Approval`) and Business Unit when Collections has a matching option.
Select values are only ever written with an option that already exists.

All rules are in [`js/config.js`](js/config.js) and [`js/sync.js`](js/sync.js).

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

## Safety checks

- **Every column is checked on load** (name, type, and the select options Polaris
  writes). If anything doesn't match, pushing is switched off and the problem is listed.
- **The destination is re-read just before every push.** If it's already there
  (someone else pushed it), nothing is written and the list refreshes.
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
   the production tables and set `ENV_LABEL = ""`.
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
PAR and one invoice, ignores and restores one brief, re-pushes each (expecting
*already done*), and requires the before/after difference to be exactly those
writes. It refuses to run unless `ENV_LABEL` is `"Test copy"`.

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

---

## Files

| File | Purpose |
| ---- | ------- |
| `index.html`, `css/app.css` | The page and its styles (light and dark themes). |
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
| `js/icons.js`, `js/ui.js` | Icons (the same style as Fetch) and small UI helpers. |
| `tests/` | Offline tests, the live read-only check and the end-to-end check. |

Polaris follows the Fetch design principles. One deliberate difference: it uses
JavaScript modules instead of classic scripts, so the tests run the exact code the
page runs; an import map still gives every module a fresh URL on each visit.

---

## Known limits

- **Attachments.** The brief's attachments live in Lark Approval, which this app
  has no permission to read, so their files can't be copied. Add links by hand
  under *Add other links* if needed.
- **Client** isn't on the Project Brief, so it's typed in the sheet (or left for later).
- **Old PARs and invoices.** Nothing in those tables is marked IGNORE yet, so older
  ones for projects in the Universe show up once. Push or ignore them.
- **Lark API formats.** Read-backs use `records/batch_get` (the single-record GET
  returns numbers as text). Text columns only accept plain text; Lark still shows
  URLs in them as clickable links.
