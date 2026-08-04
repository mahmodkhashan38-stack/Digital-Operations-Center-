# Digital Operations Center

Digital Operations Center is a full-stack web application for managing organizational incidents, requests, and operational tasks.

This repository is a Node.js/Express/MongoDB backend and a React/Vite frontend implementing multi-organization user management and a full Request lifecycle across four roles: System Admin, Organization Manager, Employee, and Operator.

See `backend/README.md` and `frontend/README.md` for the full, per-ticket implementation history and technical detail.

## Main Features

- JWT-based registration, login, logout, and protected/role-based routes; bcrypt password hashing
- Multi-organization support with Company Code registration and full organizationId tenant isolation
- Four roles: System Admin, Organization Manager, Employee, Operator
- Organization management (create/update/activate/deactivate/delete) and Manager assignment/replacement
- Organization user management: role changes (Employee ↔ Operator), profile edits, activate/deactivate, operator specialties
- Service Categories (organization-scoped, create/list/edit/activate/deactivate)
- Requests: create, view, edit, cancel, status workflow, comments, image attachments
- Manager assigns a suitable Operator to a Request; Operator manages their assigned Requests
- Role-specific dashboards for all four roles

## Team Members

- Mahmood Khashan
- Amir Arabi
- Kamal Dalasha

## Project Status

Sprints 1-3 implemented and working locally (backend module load and frontend production build both verified). Nothing in this repository has been committed, pushed, or marked Done in Jira as part of ongoing development sessions - that remains a deliberate manual step for the team.
