import type { EngineInterface } from 'claude-code';
type Dollar = EngineInterface;
type Json = Record<string, unknown>;

export function textOf(output: unknown): string | undefined {
  if (typeof output === 'string') return output;
  const blocks = Array.isArray(output) ? output : asRecord(output)?.content;
  if (!Array.isArray(blocks)) return undefined;
  const text = blocks
    .map((block) => asRecord(block))
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block!.text as string)
    .join('');
  return text || undefined;
}

export async function tenjinDataDir($: Dollar): Promise<string | null> {
  const override = await $.env.get('TENJIN_DATA_DIR');
  if (override !== undefined && override.length > 0) return override;
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'));
  return home !== undefined && home.length > 0 ? `${home}/.tenjin` : null;
}

export async function readJson($: Dollar, path: string): Promise<Json | null> {
  try {
    return asRecord(parseJson(await $.fs.read(path))) ?? null;
  } catch {
    return null;
  }
}

export function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function asRecord(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

export async function subagentsEnabled($: Dollar): Promise<boolean> {
  if ((await $.env.get('TENJIN_MODEL_WORKER')) === '1') return false;
  const dir = await tenjinDataDir($);
  return (
    dir !== null && asRecord((await readJson($, dir + '/config.json'))?.router)?.subagents === true
  );
}
