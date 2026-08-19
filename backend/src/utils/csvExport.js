// DOC-67 - "Request Reports & CSV Export". A small, generic, reusable CSV
// building helper - deliberately NOT Request-specific (no Request/User/
// Category knowledge lives here at all) so it could be reused by a later,
// different export without duplicating escaping/injection-protection logic
// a second time. Hand-built rather than pulling in a third-party CSV
// library (no CSV library was already a project dependency - see
// backend/package.json - and RFC 4180 escaping is a handful of well-known,
// easily-verified rules; adding a new dependency for this would be more
// risk than it removes for a project this size).
//
// CSV INJECTION / SPREADSHEET FORMULA PROTECTION (task spec section 13):
// Excel/Sheets/LibreOffice all treat a cell whose TEXT begins with certain
// characters as a formula, regardless of the column's actual data type -
// this is a well-documented spreadsheet-application behavior (OWASP calls
// it "CSV Injection"), not a CSV-format issue in itself. Any value that
// ultimately came from user input (Request title/description, a
// reassignment reason, a cancellation reason, a User's own fullName, a
// Category name, etc.) could contain a value crafted to start with one of
// these characters. This project's chosen mitigation: prefix the cell with
// a leading apostrophe (`'`) when it begins with one of the characters a
// spreadsheet application would otherwise interpret as "this cell starts a
// formula" - `=`, `+`, `-`, `@`, a literal tab, or a literal carriage
// return. The task spec's own minimum list is `=`/`+`/`@`; `-` and the two
// whitespace control characters are additionally included here because
// they are also part of the standard, widely-cited OWASP CSV Injection
// mitigation list, at zero extra cost or behavior change for any ordinary
// value. A leading apostrophe is the same safe, widely-recommended
// strategy the task spec itself suggests ("prefix dangerous formula-like
// cells with an apostrophe") - it renders as plain, unmodified visible
// text in every spreadsheet application (the apostrophe itself is not
// shown), so a legitimate value that happens to start with one of these
// characters is still fully readable, just no longer executable as a
// formula.
const FORMULA_TRIGGER_PATTERN = /^[=+\-@\t\r]/;

function sanitizeCsvCell(rawValue) {
  if (rawValue === null || rawValue === undefined) {
    return '';
  }
  const text = String(rawValue);
  return FORMULA_TRIGGER_PATTERN.test(text) ? `'${text}` : text;
}

// RFC 4180 field escaping: a field containing a comma, a double quote, or
// any newline (CR and/or LF) must be wrapped in double quotes, with every
// literal double quote inside it doubled. Applied AFTER formula-injection
// sanitization above, so the leading apostrophe (if any) is itself
// correctly escaped/quoted like any other character - order matters here
// (task spec section 12: "commas, double quotes, newlines... must not
// corrupt CSV structure").
function escapeCsvField(rawValue) {
  const sanitized = sanitizeCsvCell(rawValue);
  if (/[",\r\n]/.test(sanitized)) {
    return `"${sanitized.replace(/"/g, '""')}"`;
  }
  return sanitized;
}

// buildCsv(headers, rows) -> a complete CSV document as a single string.
// `headers` - array of column-title strings. `rows` - array of arrays,
// each inner array in the exact same order as `headers`. Uses CRLF line
// endings throughout (`\r\n`) - the RFC 4180 standard line ending, and
// what every mainstream spreadsheet application expects; a bare `\n` is
// also universally readable, but CRLF is the more broadly compatible
// choice for a CSV meant to be opened in Excel (task spec: "Document that
// frontend/users may open it in Excel/Sheets."). Deliberately does not add
// its own UTF-8 BOM - callers that need one (Excel-oriented exports)
// prepend `﻿` themselves, since not every future consumer of this
// helper necessarily wants a BOM.
function buildCsv(headers, rows) {
  const lines = [headers.map(escapeCsvField).join(',')];
  rows.forEach((row) => {
    lines.push(row.map(escapeCsvField).join(','));
  });
  return lines.join('\r\n');
}

module.exports = {
  sanitizeCsvCell,
  escapeCsvField,
  buildCsv,
};
