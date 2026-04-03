export const ANSI = {
  cyan: "\u001b[36m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
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
