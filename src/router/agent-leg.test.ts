import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_ROUTES_DIR,
  heldOut,
  recordAgentSpawn,
  type AgentSwitches,
  type AgentSpawnEvent,
} from './agent-leg';
import { runDelegationHook } from './hooks';
import { routerSettings } from './settings';

/**
 * THE AGENT LEG'S MODEL AND EFFORT DECISION, rules only, for the clearly safe
 * group. What breaks when these go red: a spawn outside the group routed, a
 * switch that turns the other dimension on, a model lowered more than a tier,
 * prompt text in a record, a project file raising a switch, or the leg's
 * reply or calls changed by routing.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-agent-leg-'));
  await mkdir(join(dir, '.git'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const BOTH: AgentSwitches = { model: 'apply', effort: 'apply' };
/** A call id the holdout does not hold, and one it does. */
const KEPT_IN = idWhere(false);
const HELD = idWhere(true);

function idWhere(held: boolean): string {
  for (let i = 0; ; i++) if (heldOut(`toolu_${i}`) === held) return `toolu_${i}`;
}

function spawn(input: Record<string, unknown>, extra: Partial<AgentSpawnEvent> = {}) {
  return {
    sessionId: 'sess-1',
    cwd: dir,
    toolUseId: KEPT_IN,
    toolInput: { description: 'find the loader', ...input },
    ...extra,
  };
}

const deps = () => ({ dataDir: dir, homeDir: dir, now: () => 1_000, env: {} });
const EXPLORE = {
  prompt: 'Explore where the config loader lives and how it is read.',
  subagent_type: 'Explore',
  model: 'opus',
  effort: 'xhigh',
};

async function transcript(rows: unknown[]): Promise<string> {
  const path = join(dir, 'session.jsonl');
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n'));
  return path;
}

describe('a delegated read-only search', () => {
  it('goes one tier down with a lower effort, each under its own switch', async () => {
    const record = await recordAgentSpawn(spawn(EXPLORE), BOTH, deps());
    expect(record).toMatchObject({
      group: 'safe',
      route: 'claude',
      model: { setting: 'apply', decided: 'sonnet', apply: true },
      effort: { setting: 'apply', decided: 'high', apply: true },
      holdout: false,
      reason: 'read-only search agent',
      saving: { model: 40, effort: 25, both: 55 },
    });
  });

  it.each([
    ['the model alone', { model: 'apply', effort: 'off' }, true, false],
    ['the effort alone', { model: 'off', effort: 'apply' }, false, true],
    ['nothing in shadow', { model: 'shadow', effort: 'shadow' }, false, false],
  ] as const)(
    'applies %s when only its switch says so',
    async (_label, switches, model, effort) => {
      const record = await recordAgentSpawn(spawn(EXPLORE), switches, deps());
      expect(record?.model).toEqual({ setting: switches.model, decided: 'sonnet', apply: model });
      expect(record?.effort).toEqual({
        setting: switches.effort,
        decided: 'high',
        apply: effort,
      });
    },
  );

  it('lowers a spawn at max exactly as one at xhigh, and keeps max outside the group', async () => {
    const at = async (effort: string, extra: Record<string, unknown> = {}) =>
      recordAgentSpawn(spawn({ ...EXPLORE, effort, ...extra }), BOTH, deps());
    const max = await at('max');
    const xhigh = await at('xhigh');
    expect(max?.runsOn.effort).toBe('max');
    expect(max?.effort).toEqual({ setting: 'apply', decided: 'high', apply: true });
    expect(max?.effort).toEqual(xhigh?.effort);
    expect(max?.saving).toEqual(xhigh?.saving);
    const named = await at('max', { name: 'scout' });
    expect(named).toMatchObject({ group: 'named', runsOn: { effort: 'max' } });
    expect(named?.effort).toEqual({ setting: 'apply', apply: false });
  });

  it('never goes more than one tier down: a Fable run goes to Opus', async () => {
    const record = await recordAgentSpawn(spawn({ ...EXPLORE, model: 'fable' }), BOTH, deps());
    expect(record?.model.decided).toBe('opus');
  });

  it("reads the parent's model and effort from its transcript when the call names none", async () => {
    const path = await transcript([
      { type: 'user', message: { content: 'where is the loader?' } },
      { type: 'assistant', message: { model: 'claude-opus-5-5', content: [] }, effort: 'xhigh' },
    ]);
    const unnamed = { prompt: EXPLORE.prompt, subagent_type: EXPLORE.subagent_type };
    const record = await recordAgentSpawn(spawn(unnamed, { transcriptPath: path }), BOTH, deps());
    expect(record).toMatchObject({
      parent: { model: 'claude-opus-5-5', effort: 'xhigh' },
      runsOn: { model: 'claude-opus-5-5', effort: 'xhigh' },
      model: { decided: 'sonnet' },
      effort: { decided: 'high' },
    });
  });

  it('holds out a share of spawns by the call id: decided, recorded, applied to none', async () => {
    const record = await recordAgentSpawn(spawn(EXPLORE, { toolUseId: HELD }), BOTH, deps());
    expect(record).toMatchObject({
      holdout: true,
      model: { decided: 'sonnet', apply: false },
      effort: { decided: 'high', apply: false },
    });
    expect(heldOut(HELD)).toBe(heldOut(HELD));
  });
});

describe('the shipped reading target is Sonnet at high', () => {
  it('leaves a read-only spawn already on Sonnet at high as it is', async () => {
    const record = await recordAgentSpawn(
      spawn({ ...EXPLORE, model: 'sonnet', effort: 'high' }),
      BOTH,
      deps(),
    );
    expect(record).toMatchObject({ group: 'safe', route: 'keep' });
    expect(record?.effort).toEqual({ setting: 'apply', apply: false });
  });

  it('keeps an Opus reading job at high when only its effort is routed, never low', async () => {
    const record = await recordAgentSpawn(
      spawn(EXPLORE),
      { model: 'off', effort: 'apply' },
      deps(),
    );
    expect(record?.effort).toEqual({ setting: 'apply', decided: 'high', apply: true });
  });
});

/** An operator's `agent-rules.json` in the data dir: these keyless rules in place of the shipped. */
async function operatorRules(rules: unknown[], keyless: Record<string, unknown> = {}) {
  await writeFile(
    join(dir, 'agent-rules.json'),
    JSON.stringify({ keyless: { ...keyless, rules } }),
  );
}

describe('low effort, an operator setting', () => {
  const LOW = [{ id: 'explore-agent', types: ['Explore'], model: 'sonnet', effort: 'low' }];
  const HIGH = spawn({ ...EXPLORE, effort: 'high' });

  it('refuses a rule that names low while router.effortFloor is medium, the default', async () => {
    await operatorRules(LOW);
    const record = await recordAgentSpawn(HIGH, BOTH, deps());
    expect(record?.effort).toEqual({ setting: 'apply', decided: 'medium', apply: true });
  });

  it('runs a rule that names low once router.effortFloor is low, asked and run both kept', async () => {
    await operatorRules(LOW);
    const record = await recordAgentSpawn(HIGH, { ...BOTH, effortFloor: 'low' }, deps());
    expect(record).toMatchObject({
      agentType: 'Explore',
      runsOn: { effort: 'high' },
      effort: { setting: 'apply', decided: 'low', apply: true },
    });
  });
});

describe('reading on Haiku, an operator rule', () => {
  const HAIKU = { id: 'explore-agent', types: ['Explore'], model: 'haiku', effort: 'high' };
  const RESEARCH = {
    prompt: 'Research how the config loader reads its file and report what you find.',
    subagent_type: 'general-purpose',
  };

  it('moves a read-only Explore spawn asked for Sonnet to Haiku, and Opus one tier only', async () => {
    await operatorRules([HAIKU]);
    const sonnet = await recordAgentSpawn(spawn({ ...EXPLORE, model: 'sonnet' }), BOTH, deps());
    expect(sonnet?.model).toEqual({ setting: 'apply', decided: 'haiku', apply: true });
    const opus = await recordAgentSpawn(spawn(EXPLORE), BOTH, deps());
    expect(opus?.model.decided).toBe('sonnet');
  });

  it('takes an Opus Explore spawn to Haiku only when the rule allows two tiers', async () => {
    await operatorRules([{ ...HAIKU, maxTiersDown: 2 }]);
    const opus = await recordAgentSpawn(spawn(EXPLORE), BOTH, deps());
    expect(opus?.model).toEqual({ setting: 'apply', decided: 'haiku', apply: true });
    await operatorRules([HAIKU], { maxTiersDown: 2 });
    expect((await recordAgentSpawn(spawn(EXPLORE), BOTH, deps()))?.model.decided).toBe('haiku');
  });

  it('never moves a spawn whose tools can change state to Haiku', async () => {
    await operatorRules([
      {
        id: 'research',
        kinds: ['research', 'explore'],
        model: 'haiku',
        effort: 'high',
        maxTiersDown: 2,
      },
    ]);
    const sonnet = await recordAgentSpawn(spawn({ ...RESEARCH, model: 'sonnet' }), BOTH, deps());
    expect(sonnet).toMatchObject({ group: 'safe', route: 'keep' });
    const opus = await recordAgentSpawn(spawn({ ...RESEARCH, model: 'opus' }), BOTH, deps());
    expect(opus?.model.decided).toBe('sonnet');
  });

  it('runs Haiku at high only: a rule naming another effort is refused, a spawn under high is not moved', async () => {
    await operatorRules([{ ...HAIKU, effort: 'medium' }]);
    const refused = await recordAgentSpawn(spawn({ ...EXPLORE, model: 'sonnet' }), BOTH, deps());
    expect(refused).toMatchObject({ route: 'keep', group: 'rules_unreadable' });
    await operatorRules([HAIKU]);
    const medium = { ...EXPLORE, model: 'sonnet', effort: 'medium' };
    expect(await recordAgentSpawn(spawn(medium), BOTH, deps())).toMatchObject({ route: 'keep' });
  });

  it('leaves the shipped rules on Sonnet: no Haiku without the operator rule', async () => {
    const record = await recordAgentSpawn(spawn({ ...EXPLORE, model: 'sonnet' }), BOTH, deps());
    expect(record?.model).toEqual({ setting: 'apply', apply: false });
  });
});

describe('a spawn outside the safe group, or a floor, runs as asked', () => {
  it.each([
    ['a named spawn', { ...EXPLORE, name: 'scout' }, 'named'],
    ['a background spawn', { ...EXPLORE, run_in_background: true }, 'background'],
    ['a teammate', { ...EXPLORE, team_name: 'crew' }, 'teammate'],
    ['an isolated spawn', { ...EXPLORE, isolation: 'worktree' }, 'isolation'],
    [
      'a review',
      { ...EXPLORE, prompt: 'Review the diff of PR #12 for correctness.' },
      'protected_job',
    ],
    [
      'a brief that edits, on an agent that can',
      {
        prompt: 'Research the loader, then fix the bug in it.',
        subagent_type: 'general-purpose',
        model: 'opus',
      },
      'changes',
    ],
  ])('%s', async (_label, input, why) => {
    const record = await recordAgentSpawn(spawn(input), BOTH, deps());
    expect(record).toMatchObject({ group: why, route: 'keep' });
    expect(record?.model.apply).toBe(false);
    expect(record?.effort.apply).toBe(false);
  });

  it('a model or effort the user named in their own latest words', async () => {
    const path = await transcript([
      { type: 'user', message: { content: 'look into the loader, on opus please' } },
      { type: 'assistant', message: { model: 'claude-opus-5-5', content: [] }, effort: 'high' },
    ]);
    const record = await recordAgentSpawn(spawn(EXPLORE, { transcriptPath: path }), BOTH, deps());
    expect(record).toMatchObject({ group: 'user_named', route: 'keep' });
  });

  it('a pinned definition where the rules file protects pins, and a fork', async () => {
    await mkdir(join(dir, '.claude', 'agents'), { recursive: true });
    await writeFile(
      join(dir, '.claude', 'agents', 'reader.md'),
      '---\nname: reader\ndescription: reads\neffort: low\ntools: Read, Grep\n---\n',
    );
    await writeFile(
      join(dir, 'agent-rules.json'),
      JSON.stringify({ definitionPin: { protects: 'both' } }),
    );
    const pinned = await recordAgentSpawn(
      spawn({ ...EXPLORE, subagent_type: 'reader' }),
      BOTH,
      deps(),
    );
    expect(pinned).toMatchObject({ route: 'keep', floors: ['definition-pin'] });
    const fork = await recordAgentSpawn(spawn({ ...EXPLORE, subagent_type: 'fork' }), BOTH, deps());
    expect(fork).toMatchObject({ route: 'keep', decider: { layer: 'skip', why: 'fork' } });
  });

  it('every spawn, when the rules file is unreadable', async () => {
    await writeFile(join(dir, 'agent-rules.json'), '{not json');
    const record = await recordAgentSpawn(spawn(EXPLORE), BOTH, {
      ...deps(),
      warn: () => undefined,
    });
    expect(record).toMatchObject({ group: 'rules_unreadable', route: 'keep' });
  });
});

describe('the record', () => {
  it("holds no prompt text, and is the user's alone", async () => {
    await recordAgentSpawn(
      spawn({
        ...EXPLORE,
        prompt: 'Explore BRIEF-MARKER-4417 in the repository.',
        description: 'DESC-MARKER-9921',
      }),
      BOTH,
      deps(),
    );
    const path = join(dir, AGENT_ROUTES_DIR, `${sha256(KEPT_IN)}.json`);
    const text = await readFile(path, 'utf8');
    expect(text).not.toContain('BRIEF-MARKER-4417');
    expect(text).not.toContain('DESC-MARKER-9921');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe('the switches', () => {
  it.each(['subagents', 'effort'] as const)(
    'router.%s is raised by the global file alone; a project file only lowers it',
    async (key) => {
      const project = join(dir, 'repo');
      await mkdir(join(project, '.git'), { recursive: true });
      await mkdir(join(project, '.tenjin'), { recursive: true });
      const set = async (global: string, local: string) => {
        await writeFile(join(dir, 'config.json'), JSON.stringify({ router: { [key]: global } }));
        await writeFile(
          join(project, '.tenjin', 'config.json'),
          JSON.stringify({ router: { [key]: local } }),
        );
        return (await routerSettings({ cwd: project, dataDir: dir }, { homeDir: dir }))[key].value;
      };
      expect(await set('off', 'apply')).toBe('off');
      expect(await set('shadow', 'apply')).toBe('shadow');
      expect(await set('apply', 'shadow')).toBe('shadow');
      expect(await set('apply', 'off')).toBe('off');
    },
  );
});

describe('the agent leg beside the paid leg', () => {
  const NATIVE = {
    schemaVersion: 1,
    routerVersion: 'v',
    decision: {
      action: 'native',
      reason: 'The host assistant and its own tools are enough.',
      diagnostics: {
        reasonCode: 'native_sufficient',
        stage: 'capability',
        missing: [],
        nextAction: 'x',
      },
    },
  };

  async function run(router: Record<string, unknown>) {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ router }));
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return new Response(JSON.stringify(NATIVE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const path = await transcript([
      { type: 'user', sessionId: 'sess-1', message: { content: 'go' } },
    ]);
    const out = await runDelegationHook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        cwd: dir,
        transcript_path: path,
        tool_name: 'Agent',
        tool_use_id: KEPT_IN,
        tool_input: EXPLORE,
      },
      {
        dataDir: dir,
        baseUrl: 'https://tenjin.sh',
        fetchImpl,
        homeDir: dir,
        warn: () => undefined,
      },
    );
    return {
      out,
      calls,
      recorded: existsSync(join(dir, AGENT_ROUTES_DIR, `${sha256(KEPT_IN)}.json`)),
    };
  }

  it('off records nothing; apply records the spawn with the same reply and the same calls', async () => {
    const off = await run({});
    const on = await run({ subagents: 'apply', effort: 'apply' });
    expect(off.recorded).toBe(false);
    expect(on.recorded).toBe(true);
    expect(on.out).toEqual(off.out);
    expect(on.calls).toEqual(off.calls);
    expect(on.calls.every((url) => url.startsWith('https://tenjin.sh/'))).toBe(true);
  });

  it('router.enabled false records nothing, whatever the switches say', async () => {
    const out = await run({ enabled: false, subagents: 'apply', effort: 'apply' });
    expect(out.recorded).toBe(false);
    expect(out.calls).toEqual([]);
  });

  // `router.subagents` is the switch. A file holding only the name it had
  // before it shipped, `agents`, carries an unknown key nothing reads.
  it('router.subagents apply turns model routing on; the old `agents` key alone leaves it off', async () => {
    expect((await run({ agents: 'apply' })).recorded).toBe(false);
    expect((await run({ subagents: 'apply' })).recorded).toBe(true);
    const record = JSON.parse(
      await readFile(join(dir, AGENT_ROUTES_DIR, `${sha256(KEPT_IN)}.json`), 'utf8'),
    ) as { model: unknown; effort: unknown };
    expect(record.model).toEqual({ setting: 'apply', decided: 'sonnet', apply: true });
    expect(record.effort).toEqual({ setting: 'off', decided: 'high', apply: false });
  });
});
