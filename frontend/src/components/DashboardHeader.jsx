// DOC-42: the "welcome" banner block at the top of every role dashboard
// (Admin/Manager/Operator/Employee) was the same hand-written markup/CSS
// classes (.dashboard-welcome / h1 / p) copy-pasted in each page. Extracted
// here once both to remove that duplication and to guarantee the four
// dashboards stay visually consistent (spec: "all four dashboards should
// look like parts of the SAME product") without anyone needing to
// remember to keep four separate copies in sync.
function DashboardHeader({ title, subtitle }) {
  return (
    <div className="dashboard-welcome">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </div>
  );
}

export default DashboardHeader;
