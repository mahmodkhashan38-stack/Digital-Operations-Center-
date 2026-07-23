// DOC-42: reusable summary card used across every dashboard's stats row
// (.stat-card, already styled in index.css). Supports two modes:
//   - real data:        <StatCard label="Employees" value={employees.length} />
//   - not-yet-available: <StatCard label="Open Requests" placeholder="Available when Request Management is enabled" />
// `placeholder` exists specifically so a page can show a stat SLOT for a
// future Ticket-derived number without ever inventing a fake one (spec:
// "Never hardcode fake statistics" / "Only show real counts if real data
// exists"). When `placeholder` is provided, `value` is ignored - a card is
// either a real, currently-known number, or an honest "not available yet"
// message, never both and never a guess.
function StatCard({ label, value, placeholder }) {
  return (
    <div className={`stat-card${placeholder ? ' stat-card-placeholder' : ''}`}>
      <span className="stat-label">{label}</span>
      {placeholder ? (
        <span className="stat-value stat-value-placeholder">{placeholder}</span>
      ) : (
        <span className="stat-value">{value}</span>
      )}
    </div>
  );
}

export default StatCard;
