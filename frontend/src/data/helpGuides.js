// DOC-76 - "User Help & Quick Guides".
// -----------------------------------------------------------------------
// THE ONE CENTRALIZED SOURCE OF GUIDE METADATA (task spec section 19 -
// "No duplicated hardcoded guide configuration across components"). Both
// pages/Help.jsx (the list) and pages/HelpGuideDetail.jsx (the detail
// view) import from here - neither one hardcodes a guide's title,
// description, role list, or content anywhere else.
//
// FRONTEND-ONLY, NO DATABASE (task spec sections 2/31 - the read-only
// audit found no security or scale reason to justify a backend/DB for
// 2-5 short, non-sensitive product-usage guides; this is a plain static
// JS module, exactly the recommended architecture).
//
// TWO GUIDE TYPES (task spec section 27 - "clearly distinguish Quick
// Guide vs PDF Guide, do not pretend they are PDFs"):
//   'quickGuide' - short, numbered in-app steps rendered by
//     HelpGuideDetail.jsx as ordinary text (never
//     dangerouslySetInnerHTML). Used for both guides in this ticket today
//     because no PDF files exist anywhere in this repository (task spec
//     section 26: "Do NOT fabricate binary PDFs... implement Help Center
//     infrastructure, create clearly named placeholders" - a Quick Guide
//     IS that placeholder, honestly labeled, not a fake PDF).
//   'pdf' - a real, already-existing static file under
//     frontend/public/guides/ (task spec section 14's exact naming
//     convention: lowercase-with-hyphens, no spaces). `Open Guide` opens
//     `file` in a new browser tab (`target="_blank"`) - no in-app PDF
//     rendering library is used anywhere in this project (task spec
//     section 11: "browser-native PDF support is acceptable"). See this
//     file's own bottom comment for the exact shape a future PDF guide
//     entry would take once a real file is supplied - none is fabricated
//     here.
//
// MISSING-FILE SAFETY (task spec section 20): this array intentionally
// contains ONLY guides this project can actually render TODAY (a
// 'quickGuide' with real step content, or - if one is ever added - a
// 'pdf' guide whose file has actually been placed under
// frontend/public/guides/ first). It is NOT pre-populated with
// speculative entries for Manager/System Admin guides that do not exist
// yet (task spec: "Do NOT invent PDF files that do not actually exist.
// Only expose files that are present.") - see backend/README.md's (no -
// see frontend/README.md's) own "How to add a new guide" section for the
// documented, low-risk extension path task spec section 4/18 asks this
// architecture to support without a code redesign.
export const GUIDE_TYPES = {
  QUICK_GUIDE: 'quickGuide',
  PDF: 'pdf',
};

// Task spec section 16 - Employee guide content, grounded in the ACTUAL
// audited UI (frontend/src/pages/Dashboard.jsx and
// frontend/src/components/RequestRow.jsx) rather than invented button
// names - every quoted label below ("Open New Request", "Service
// Category", "Confirm Resolved", "Problem Still Exists", "Before
// Images", ...) is copied verbatim from that real UI, confirmed during
// this ticket's own read-only audit phase.
const EMPLOYEE_CREATE_REQUEST_STEPS = [
  'Log in with your email and password.',
  'You will land on your Employee Dashboard automatically.',
  'In the "New Request" panel, click "Open New Request".',
  'Enter a clear Title and Description for your request.',
  'Select a Service Category that best matches your issue.',
  'Select a Priority, if your organization has priority options enabled for you.',
  'Add Before Images if a photo would help explain the issue (optional).',
  'Click Submit to send your request.',
  'Your new request appears in "My Requests" with its own Request Number (e.g. REQ-000123) - use this number if you ever need to reference it.',
  'Track its status as it moves from Open to In Progress to Resolved.',
  'Open the request to add comments or follow its Activity Timeline at any time.',
  'Once an Operator marks your request Resolved, review the work described in the request details.',
  'Click "Confirm Resolved" if the issue is fixed, or "Problem Still Exists" if it is not - this reopens the request for the Operator.',
  'After your request is Closed, you can submit a satisfaction rating from the request\'s details.',
];

// Task spec section 17 - Operator guide content, same audited-UI-first
// discipline as the Employee guide above.
const OPERATOR_HANDLE_REQUEST_STEPS = [
  'Log in with your email and password.',
  'You will land on your Operator Dashboard automatically.',
  'Find requests assigned to you in the Assigned Requests list.',
  'Open a request to review its full details.',
  'Review the Description, Category, and Priority the Employee provided.',
  'Review any Before Images and Comments already left on the request.',
  'Move the request through the workflow: click "Start Work" to begin (Open to In Progress).',
  'Add a comment if you need more information from the Employee or want to share an update.',
  'When your work is finished, add Completion Images to show the result, then click "Mark Resolved" (In Progress to Resolved).',
  'The Employee reviews your completed work next - they will either confirm it (the request is Closed) or report that the problem still exists (the request is Reopened).',
  'If a request is Reopened, click "Resume Work" to continue working on it.',
  'Check back on the request afterward to confirm it reaches Closed.',
];

export const HELP_GUIDES = [
  {
    id: 'employee-create-request',
    title: 'How to Create a Request',
    description: 'Step-by-step guide for creating and tracking a request.',
    allowedRoles: ['employee'],
    type: GUIDE_TYPES.QUICK_GUIDE,
    steps: EMPLOYEE_CREATE_REQUEST_STEPS,
  },
  {
    id: 'operator-handle-request',
    title: 'How to Handle a Request',
    description: 'Step-by-step guide for reviewing, working on, and completing an assigned request.',
    allowedRoles: ['operator'],
    type: GUIDE_TYPES.QUICK_GUIDE,
    steps: OPERATOR_HANDLE_REQUEST_STEPS,
  },
];

// Task spec section 7 - "Help page reads current user role and displays
// only guides whose allowedRoles include that role... Filter at
// application logic level" (never CSS). A guide with more than one role
// in `allowedRoles` (a future "shared" guide - task spec section 8: "not
// unless intentionally shared") would simply appear for every role listed
// - this function does not special-case that at all, it is already the
// natural behavior of a plain `.includes()` check.
export function getGuidesForRole(role) {
  return HELP_GUIDES.filter((guide) => guide.allowedRoles.includes(role));
}

export function getGuideById(guideId) {
  return HELP_GUIDES.find((guide) => guide.id === guideId) || null;
}

// -----------------------------------------------------------------------
// HOW TO ADD A FUTURE GUIDE (task spec sections 4/18 - "prepare metadata
// structure for future guides... Architecture must allow adding them
// later without code redesign"):
//
// A future Quick Guide (no PDF yet) - add another object to HELP_GUIDES
// above with the same shape as the two already there:
//   { id, title, description, allowedRoles: ['manager'], type: GUIDE_TYPES.QUICK_GUIDE, steps: [...] }
//
// A future PDF guide - ONLY once the real file has actually been placed
// at frontend/public/guides/<file-name>.pdf (task spec section 14's
// naming convention: lowercase, hyphens, no spaces, e.g.
// "manager-manage-users.pdf"):
//   {
//     id: 'manager-manage-users',
//     title: 'How to Manage Users',
//     description: 'Guide for adding, editing, and deactivating Organization users.',
//     allowedRoles: ['manager'],
//     type: GUIDE_TYPES.PDF,
//     file: '/guides/manager-manage-users.pdf',
//   }
// Never add a 'pdf'-type entry before the file itself exists under
// frontend/public/guides/ - see this file's own top comment on
// missing-file safety.
