/* Polaris: which Lark tables it reads and writes, and the business rules it applies.

   These links point at the TEST COPIES. To go live, replace them with the
   production links. On every load the page re-checks each field it uses (name,
   type and the select options it writes) and refuses to push if anything is
   missing, so a renamed column fails loudly instead of writing bad data. */

export const ENV_LABEL = "";   // shown in the header; set to "" for production

export const TABLE_LINKS = {
  universe:    "https://mineskiglobal.larksuite.com/base/NP7TbjwHNaTyLOsWafelN9wNgEd?table=tblEmWYOXoAF70uf&view=vewFlJYfpR",
  collections: "https://mineskiglobal.larksuite.com/base/NP7TbjwHNaTyLOsWafelN9wNgEd?table=tbln7I51ONseeG55&view=vewZ7gtj5w",
  brief:       "https://mineskiglobal.larksuite.com/base/NP7TbjwHNaTyLOsWafelN9wNgEd?table=tblu5GcPn9RoCcev&view=vewL6Eydfw",
  par:         "https://mineskiglobal.larksuite.com/base/NP7TbjwHNaTyLOsWafelN9wNgEd?table=tblFrfsaJZrLLpLQ&view=vewH1nekbn",
  invoice:     "https://mineskiglobal.larksuite.com/base/NP7TbjwHNaTyLOsWafelN9wNgEd?table=tblnZyLzHXfzrzQt&view=vewO7Hk4IE",
  // ANDON (Project Management), test copy. Only users can open this Base (the
  // Lark app itself can't), so the Node checks skip it. Don't use the "ANDON 2026"
  // table in the base above: it's a synced, read-only mirror.
  andon:       "https://mineskiglobal.larksuite.com/base/DOoobrd5IaEIwjshAnuuuDFasjg?table=tblS77AM8iHOWd0s&view=vewxixKUQf",
};

export const RULES = {
  // Only briefs and invoice requests filed by this department become Universe cards.
  // ANDON takes briefs from every department.
  department: "Account Managers",

  // Amount (VAT-Ex.) (PHP) = filed value × (usdRate if USD) ÷ (vatDivisor if 12% VAT).
  usdRate: 57,          // internal rate, not the BSP rate
  vatDivisor: 1.12,

  // A pushed brief starts the Universe pipeline here.
  newProjectStatus: "For CE/Pitch Creation",
  newProjectMancomPhase: "1. Client Brief Kickoff",

  // Approval outcomes that mean the request is dead. These never become cards.
  voidStatuses: ["Rejected", "Recalled", "Canceled", "Deleted", "Terminated"],

  // Collections.Status for a new row, by the invoice request's approval status.
  collectionStatus: { Approved: "For Invoicing" },
  collectionStatusPending: "Pending Invoice Request Approval",

  // Date-only fields (RFP Received Date) are stored as midnight in this offset.
  utcOffsetHours: 8,    // Asia/Manila

  // Show "looks similar to…" on a brief card at or above this name similarity (0 to 1).
  similarityHint: 0.5,
};

/* The Universe view: grouped by Status (in the column's own option order),
   filtered to one Year (this year by default), sorted by RFP Received Date. */
export const UNIVERSE_VIEW = {
  hiddenStatuses: ["Lost", "Stalled", "Archived"],
  defaultSort: "desc",          // newest RFP first, so a just-pushed brief is at the top of its group
};
