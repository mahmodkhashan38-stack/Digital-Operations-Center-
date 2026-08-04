// DOC-53 - "Dashboard Statistics". A small, shared, dependency-free
// horizontal-bar list used for every "Requests by X" grouped section
// (Status/Priority/Category) across the Manager and Operator Dashboards -
// task spec: "Simple cards and basic CSS charts are enough" / "Do not add
// a chart library unless clearly necessary." Bar width is relative to the
// largest count in THIS list only (not a global maximum), so a single
// section always fills its own space sensibly regardless of how large or
// small its own numbers are.
function StatBreakdownList({ title, items, emptyMessage }) {
  const maxCount = items.reduce((max, item) => Math.max(max, item.count), 0) || 1;

  return (
    <div className="card admin-panel stat-breakdown">
      <h3 className="stat-breakdown-title">{title}</h3>
      {items.length === 0 ? (
        <p className="auth-subtitle">{emptyMessage || 'No data yet.'}</p>
      ) : (
        <ul className="stat-breakdown-list">
          {items.map((item) => (
            <li key={item.label} className="stat-breakdown-row">
              <span className="stat-breakdown-label">{item.label}</span>
              <div className="stat-breakdown-bar-track">
                <div
                  className="stat-breakdown-bar-fill"
                  style={{ width: `${Math.max(2, (item.count / maxCount) * 100)}%` }}
                />
              </div>
              <span className="stat-breakdown-count">{item.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default StatBreakdownList;
