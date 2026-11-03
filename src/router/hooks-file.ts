import { lstat, readFile, realpath } from 'node:fs/promises';

/**
 * Claude Code's settings file, read once with every refusal decided here, for
 * the removal of the settings-based install (`legacy-install.ts`), which goes
 * with it on or after 2026-12-01.
 */

/** Why a settings file is left alone. */
export type HooksFileRefusalReason =
  'unresolvable' | 'unreadable' | 'unparsable' | 'unexpected-shape';

export interface HooksInspection {
  path: string;
  /** The exact bytes read, so a commit can prove nothing changed underneath it. */
  raw: string | null;
  settings: Record<string, unknown>;
  /** Every event's entries, already known to be a list: {@link inspectHooksFile}
   *  refuses the file rather than hand a writer a shape it would skip. */
  hooks: Record<string, unknown[]>;
}

/** Why a settings file cannot be written. */
export interface HooksRefusal {
  reason: HooksFileRefusalReason;
  message: string;
  path: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve and read a settings file. Symlinks are resolved before any write:
 * committing with a rename over a dotfiles-managed link would sever it.
 */
export async function inspectHooksFile(
  declaredPath: string,
): Promise<HooksInspection | { refusal: HooksRefusal }> {
  const entry = await lstat(declaredPath).catch(() => null);
  let path = declaredPath;
  if (entry !== null) {
    try {
      path = await realpath(declaredPath);
    } catch (err) {
      return {
        refusal: {
          reason: 'unresolvable',
          path: declaredPath,
          message: `${declaredPath} could not be resolved (${(err as Error).message}); its "hooks" key was left exactly as it is.`,
        },
      };
    }
  }

  let settings: Record<string, unknown> = {};
  let raw: string | null = null;
  if (entry !== null) {
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      return {
        refusal: {
          reason: 'unreadable',
          path,
          message: `${path} could not be read (${(err as Error).message}); no hooks were registered.`,
        },
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        refusal: {
          reason: 'unparsable',
          path,
          message: `${path} is not valid JSON (${(err as Error).message}); its "hooks" key was left exactly as it is.`,
        },
      };
    }
    if (!isPlainObject(parsed)) {
      return {
        refusal: {
          reason: 'unexpected-shape',
          path,
          message: `${path} is not a JSON object; its "hooks" key was left exactly as it is.`,
        },
      };
    }
    settings = parsed;
  }

  const hooksValue = settings.hooks;
  if (hooksValue !== undefined && !isPlainObject(hooksValue)) {
    return {
      refusal: {
        reason: 'unexpected-shape',
        path,
        message: `${path} has a "hooks" key that is not an object; its "hooks" key was left exactly as it is.`,
      },
    };
  }
  // An event whose value is not a list is refused for the same reason a
  // non-object `hooks` is: a writer would copy it through untouched and
  // silently drop this event's share of the plan while the receipt still
  // counted it. A file we do not understand is left alone and reported.
  const hooks: Record<string, unknown[]> = {};
  for (const [event, list] of Object.entries(hooksValue ?? {})) {
    if (!Array.isArray(list)) {
      return {
        refusal: {
          reason: 'unexpected-shape',
          path,
          message: `${path} has a "hooks.${event}" that is not an array of entries; its "hooks" key was left exactly as it is.`,
        },
      };
    }
    hooks[event] = list;
  }
  return { path, raw, settings, hooks };
}
