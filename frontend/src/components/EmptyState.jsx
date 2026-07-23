// DOC-42: shared "nothing here yet" block. Used both for genuine empty
// lists (an Operator with no assigned requests yet) and for whole sections
// that are structurally ready but have no backend to call yet (Organization
// Requests / Assigned Requests / My Requests - all of which depend on a
// future Ticket API that DOC-42 explicitly must NOT build). Reusing one
// component keeps every "coming next" surface in the product looking and
// reading the same way instead of four hand-written variants.
function EmptyState({ title, message }) {
  return (
    <div className="card admin-panel empty-state">
      {title && <h3 className="empty-state-title">{title}</h3>}
      <p className="auth-subtitle empty-state-message">{message}</p>
    </div>
  );
}

export default EmptyState;
