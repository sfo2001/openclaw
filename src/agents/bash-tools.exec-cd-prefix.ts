import { splitShellArgs } from "../utils/shell-argv.js";

/**
 * Detect `cd <literal-path> && <rest>` or `cd <literal-path>; <rest>` patterns
 * and extract the path into a workdir value, returning the remainder as the
 * rewritten command.
 *
 * Returns null when no rewriting should occur:
 * - explicit workdir already provided by the model
 * - no `&&` or `;` separator after the cd
 * - path contains shell variables ($, ~, backticks) that cannot be resolved
 *
 * Design choice: paths with variable references are left untouched because
 * workdir is passed as cwd (no shell expansion). See spec for rationale.
 */
export function extractCdPrefix(
  command: string,
  explicitWorkdir: string | undefined,
): { command: string; workdir: string } | null {
  if (explicitWorkdir) {
    return null;
  }

  const trimmed = command.trim();
  if (!trimmed.startsWith("cd ") && trimmed !== "cd") {
    return null;
  }

  // Find the first unquoted && or ; separator.
  let separatorIdx = -1;
  let separatorLen = 0;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) {
      continue;
    }
    if (ch === "&" && trimmed[i + 1] === "&") {
      separatorIdx = i;
      separatorLen = 2;
      break;
    }
    if (ch === ";") {
      separatorIdx = i;
      separatorLen = 1;
      break;
    }
    // Bail on pipe or or-chain — different semantics.
    if (ch === "|") {
      return null;
    }
  }

  if (separatorIdx === -1) {
    // No separator found — bare `cd /path` or `cd` alone.
    return null;
  }

  const cdPortion = trimmed.slice(0, separatorIdx).trim();
  const remainder = trimmed.slice(separatorIdx + separatorLen).trim();

  if (!remainder) {
    // Nothing after the separator.
    return null;
  }

  // Tokenize the cd portion to extract the path.
  const tokens = splitShellArgs(cdPortion);
  if (!tokens || tokens.length !== 2 || tokens[0] !== "cd") {
    return null;
  }

  const cdPath = tokens[1];

  // `cd -` means "previous directory" in the shell — not a real path.
  if (cdPath === "-") {
    return null;
  }

  // Design choice: do not rewrite when path contains shell variables,
  // tilde, backticks, or command substitution. These cannot be safely
  // resolved because workdir is passed as cwd without shell expansion.
  if (/[$`~]/.test(cdPath)) {
    return null;
  }

  return { command: remainder, workdir: cdPath };
}
