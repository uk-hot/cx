export const ANSI = {
  cyan: "\u001b[36m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  reset: "\u001b[0m"
};

/** @typedef {(index: number, cell: string) => string | null} CellColor */

// Only `cx status` colors its output, and only on a terminal.
export function colorEnabled() {
  return Boolean(process.stdout.isTTY);
}

/**
 * @param {string} text
 * @param {string | null} color
 * @param {boolean} [enabled]
 */
export function colorize(text, color, enabled = colorEnabled()) {
  if (!enabled || !color) {
    return text;
  }
  return `${color}${text}${ANSI.reset}`;
}

/**
 * @param {string[]} headers
 * @param {string[][]} rows
 * @param {{ cellColor?: CellColor }} [options]
 */
export function buildTable(headers, rows, options = {}) {
  const enabled = colorEnabled();
  const widths = headers.map((header) => header.length);
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index], cell.length);
    });
  }

  const border = colorize(`+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`, ANSI.dim, enabled);
  /**
   * @param {string[]} cells
   * @param {CellColor} [styleFn]
   */
  const renderRow = (cells, styleFn) => {
    const rendered = cells.map((cell, index) => {
      const padded = cell.padEnd(widths[index]);
      return styleFn ? colorize(padded, styleFn(index, cell), enabled) : padded;
    });
    return `| ${rendered.join(" | ")} |`;
  };

  return [
    border,
    colorize(renderRow(headers), ANSI.dim, enabled),
    border,
    ...rows.map((row) => renderRow(row, options.cellColor)),
    border
  ].join("\n");
}

/**
 * Identifiers are typed into a shell, and an alias may contain spaces.
 * @param {string} value
 */
export function shellArgument(value) {
  return /^[\w@.+:=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
