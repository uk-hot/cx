export const ANSI = {
  cyan: "\u001b[36m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  reset: "\u001b[0m"
};

export function colorEnabled() {
  return Boolean(process.stdout.isTTY);
}

export function colorize(text, color, enabled = colorEnabled()) {
  if (!enabled || !color) {
    return text;
  }
  return `${color}${text}${ANSI.reset}`;
}

export function padCell(value, width) {
  return `${value}${" ".repeat(Math.max(0, width - value.length))}`;
}

export function buildTable(headers, rows, options = {}) {
  const enabled = colorEnabled();
  const widths = headers.map((header) => header.length);

  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index], String(cell).length);
    });
  }

  const border = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
  const renderRow = (cells, styleFn = null) => {
    const rendered = cells.map((cell, index) => {
      const raw = padCell(String(cell), widths[index]);
      return styleFn ? colorize(raw, styleFn(index, String(cell)), enabled) : raw;
    });
    return `| ${rendered.join(" | ")} |`;
  };

  const lines = [
    colorize(border, ANSI.dim, enabled),
    colorize(renderRow(headers), ANSI.dim, enabled),
    colorize(border, ANSI.dim, enabled)
  ];

  for (const row of rows) {
    lines.push(renderRow(row, options.cellColor));
  }
  lines.push(colorize(border, ANSI.dim, enabled));
  return lines.join("\n");
}

// Identifiers are typed into a shell, and an alias may contain spaces.
export function shellArgument(value) {
  return /^[\w@.+:=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
