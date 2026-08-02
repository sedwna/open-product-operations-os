export function stringifyCsv(rows) {
  return `${rows.map((row) => row.map(escapeCell).join(",")).join("\n")}\n`;
}

function escapeCell(value) {
  const text = protectSpreadsheetCell(value == null ? "" : String(value));
  if (!/[",\r\n]/.test(text)) {
    return text;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }

    if (character === '"') {
      if (cell.length > 0) {
        throw new Error("Unexpected quote in an unquoted CSV field.");
      }
      quoted = true;
    } else if (character === ",") {
      row.push(restoreSpreadsheetCell(cell));
      cell = "";
    } else if (character === "\n") {
      row.push(restoreSpreadsheetCell(cell.replace(/\r$/, "")));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  if (quoted) {
    throw new Error("Unterminated quoted CSV field.");
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(restoreSpreadsheetCell(cell.replace(/\r$/, "")));
    rows.push(row);
  }

  return rows.filter(
    (candidate, index) =>
      index === 0 || candidate.some((value) => value.trim().length > 0)
  );
}

const SPREADSHEET_FORMULA = /^[\t\r\n ]*[=+\-@]/;

function protectSpreadsheetCell(text) {
  const withoutApostrophes = text.replace(/^'+/, "");
  return SPREADSHEET_FORMULA.test(withoutApostrophes) ? `'${text}` : text;
}

function restoreSpreadsheetCell(text) {
  if (!text.startsWith("'")) return text;
  const encoded = text.slice(1);
  return SPREADSHEET_FORMULA.test(encoded.replace(/^'+/, "")) ? encoded : text;
}

export function rowsToObjects(rows) {
  if (rows.length === 0) {
    return { headers: [], records: [] };
  }

  const [headers, ...dataRows] = rows;
  const records = dataRows.map((values, rowIndex) => {
    if (values.length !== headers.length) {
      throw new Error(
        `CSV row ${rowIndex + 2} has ${values.length} cells; expected ${headers.length}.`
      );
    }
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });

  return { headers, records };
}
