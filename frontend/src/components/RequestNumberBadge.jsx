// DOC-16 - "Request Number / Human-Friendly ID". A small sibling to
// RequestStatusBadge.jsx/RequestSlaBadge.jsx, following the exact same
// "own its own tiny display concern" pattern - reused everywhere a Request
// identity is shown to a user (RequestRow.jsx, ManagerRequestRow.jsx, the
// DOC-58 duplicate-request confirm dialog on Dashboard.jsx) instead of
// three separate copies of the same conditional markup.
//
// Renders NOTHING (`null`) for a historical, pre-DOC-16 Request that has
// not been migrated yet (`requestNumber` is `null` in that case - see
// sanitizeRequest's own comment in request.controller.js) - the caller's
// own title text is always shown regardless, so a missing badge here is a
// harmless, expected fallback, never a broken-looking gap (task spec
// section 14: "Do NOT display raw _id unless needed for debugging").
function RequestNumberBadge({ requestNumber }) {
  if (!requestNumber) return null;
  return <span className="request-number-badge">{requestNumber}</span>;
}

export default RequestNumberBadge;
