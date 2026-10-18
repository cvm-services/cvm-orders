// Writing and validating shell-sourceable env files.
//
// WHY THIS EXISTS
//   An NWC URL was written unquoted and sourcing it silently produced an EMPTY
//   variable: `NWC_URL=nostr+walletconnect://...?relay=...&secret=...` — the `&`
//   splits the line into extra shell commands and the assignment is lost. The
//   script then said "NWC_URL not set", which looks like a missing file rather
//   than a mangled one. Silent, and expensive to diagnose.
//
// THE RULE
//   Always single-quote values on write. Single quotes are literal in POSIX sh
//   (no expansion at all), so `&`, `?`, `=`, spaces, `#`, backslashes and double
//   quotes all survive. An embedded single quote is emitted as the standard
//   `'\''` dance.

/** Quote a value for POSIX shell assignment. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Render a key=value map as a shell-sourceable file. */
export function formatEnvFile(
  vars: Record<string, string>,
  opts: { header?: string } = {},
): string {
  const lines: string[] = [];
  if (opts.header) lines.push(opts.header.replace(/\n$/, ""));
  for (const [k, v] of Object.entries(vars)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      throw new Error(`invalid env key: ${k}`);
    }
    lines.push(`${k}=${shellQuote(v)}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Parse a file produced by formatEnvFile (also tolerates unquoted simple values
 * and comments). This is the round-trip check, not a general shell evaluator.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1);
    if (val.startsWith("'") && val.endsWith("'") && val.length >= 2) {
      val = val.slice(1, -1).replace(/'\\''/g, "'");
    } else if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Refuse a file whose values would be mangled by a shell. This is the check that
 * turns the silent truncation into a loud error.
 */
export function assertSourcable(text: string): true {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1);
    const quoted =
      (val.startsWith("'") && val.endsWith("'")) ||
      (val.startsWith('"') && val.endsWith('"'));
    if (!quoted && /[&?#\s$`\\]/.test(val)) {
      throw new Error(
        `unquoted ${key} contains shell metacharacters and would be silently ` +
          `truncated when sourced (this is the bug that lost an NWC URL). ` +
          `Quote the value: ${key}='...'`,
      );
    }
  }
  return true;
}
