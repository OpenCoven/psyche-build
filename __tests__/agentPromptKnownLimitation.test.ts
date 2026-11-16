import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_IDS,
  AGENT_REGISTRY,
  promptReachesAgentArgv,
} from '../src/utils/agentLaunch.js';

// #523: the macOS public beta ships with initial prompts in the argv of some
// agents, as a published known limitation. The publication is only honest
// while it names exactly the agents the registry exposes. These cases fail
// when an agent's transport changes and the published list does not, in
// either direction.

const read = (file: string): string => readFileSync(path.resolve(file), 'utf8');

const ANCHOR = 'AGENT-PROMPT-TRANSPORT.md#known-limitation-in-the-macos-public-beta';

function limitationSection(): string {
  const record = read('docs/AGENT-PROMPT-TRANSPORT.md');
  const section = record
    .split('\n## Known limitation in the macOS public beta\n')[1]
    ?.split('\n## ')[0];
  if (section === undefined) {
    throw new Error('docs/AGENT-PROMPT-TRANSPORT.md has no known-limitation section');
  }
  return section;
}

const backticked = (text: string): string[] =>
  [...text.matchAll(/`([a-z][a-z-]*)`/g)].map(([, name]) => name);

const exposed = AGENT_IDS.filter(promptReachesAgentArgv);
const notExposed = AGENT_IDS.filter((agent) => !promptReachesAgentArgv(agent));

describe('published prompt argv limitation', () => {
  it('lists exactly the agents whose registry transport puts the prompt in argv', () => {
    const rows = limitationSection()
      .split('\n')
      .filter((line) => /^\| `/.test(line))
      .map((line) => backticked(line.split('|')[1])[0]);

    expect(rows).toEqual(exposed);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('describes each exposed agent with the option the registry really uses', () => {
    const rows = limitationSection()
      .split('\n')
      .filter((line) => /^\| `/.test(line))
      .map((line) => line.split('|').map((cell) => cell.trim()));

    for (const [, agentCell, how] of rows) {
      const agent = backticked(agentCell)[0] as (typeof AGENT_IDS)[number];
      const entry = AGENT_REGISTRY[agent];
      expect(how, agent).toBe(
        entry.promptTransport === 'option'
          ? `\`${entry.promptOption}\` option`
          : 'positional argument',
      );
    }
  });

  it('names every other registry agent as not exposed, and no exposed one', () => {
    const paragraph = limitationSection()
      .split('\n\n')
      .find((block) => block.startsWith('**What is not exposed.**'));

    expect(paragraph).toBeDefined();
    const named = backticked(paragraph!).filter((name) =>
      (AGENT_IDS as readonly string[]).includes(name),
    );
    expect([...named].sort()).toEqual([...notExposed].sort());
  });

  it('says who can read the prompt, what to do, and whose decision it is', () => {
    const section = limitationSection();

    expect(section).toMatch(/Any process running as the same macOS user can read it/);
    expect(section).toContain('`ps`');
    expect(section).toMatch(/Do not put a secret[\s\S]{0,120}in the initial prompt/);
    expect(section).toContain('https://github.com/OpenCoven/psyche-build/issues/523');
    expect(section).toMatch(/The owner decided on \d{4}-\d{2}-\d{2}/);
    // It is a limitation, not a fix: nothing here may read as resolved.
    expect(section).not.toMatch(/\b(?:fixed|resolved|no longer exposed)\b/i);
  });

  it('names the MergePane agents only if both are still exposed', () => {
    const section = limitationSection();
    const mergePane = section.split('\n\n').find((block) => block.includes('MergePane'));

    expect(mergePane).toBeDefined();
    for (const agent of backticked(mergePane!)) {
      expect(exposed, agent).toContain(agent);
    }
  });

  it('is repeated, with the same agents, wherever a user is told what is supported', () => {
    const matrix = read('docs/SUPPORT-MATRIX.md')
      .split('\n## Current known limitations\n')[1]
      ?.split('\n## ')[0];
    const changelog = read('CHANGELOG.md')
      .split('\n## Unreleased\n')[1]
      ?.split('\n## [')[0];

    for (const [name, text] of [['support matrix', matrix], ['changelog', changelog]] as const) {
      expect(text, name).toBeDefined();
      expect(text, name).toContain(ANCHOR);
      const named = backticked(text!).filter((agent) =>
        (AGENT_IDS as readonly string[]).includes(agent),
      );
      expect(named, name).toEqual(exposed);
      expect(text, name).toMatch(/Do not put a\s+secret in an initial prompt/);
    }

    const readme = read('README.md');
    expect(readme).toContain(`docs/${ANCHOR}`);
    expect(readme).toContain(`For ${numberWord(exposed.length)} of them the initial prompt is visible`);
    expect(matrix).toContain(`for ${numberWord(exposed.length)} agents`);
  });

  it('keeps the registry reason for every exposed agent', () => {
    for (const agent of exposed) {
      expect(AGENT_REGISTRY[agent].promptArgvExposure?.trim(), agent).toBeTruthy();
    }
  });
});

function numberWord(count: number): string {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  return words[count] ?? String(count);
}
