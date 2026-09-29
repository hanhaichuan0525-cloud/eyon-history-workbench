import type { RuinGenerationInput } from '../schemas/ruin.ts';

type PeriodType = RuinGenerationInput['materials'][number]['periodType'];

interface DiceEntry {
  min: number;
  max: number;
  key: string;
  label: string;
  directions: string;
}

export function createRuinMaterialsFromRules(
  diceRules: string,
  candidateCount: 3 | 4 | 5,
  random: () => number = Math.random,
): RuinGenerationInput['materials'] {
  const tables = {
    stable: parseTable(diceRules, 'table_2_stable'),
    transition: parseTable(diceRules, 'table_3_transition'),
    turbulent: parseTable(diceRules, 'table_4_turbulent'),
  };
  const periods = periodSequence(candidateCount, random);
  return periods.map((periodType, index) => ({
    candidateKey: `candidate-${index + 1}`,
    periodType,
    background: serializeMaterial(roll(tables.stable, random)),
    conflict: serializeMaterial(roll(tables.turbulent, random)),
    trigger: serializeMaterial(roll(tables.transition, random)),
  }));
}

export function waveForCandidateCount(
  candidateCount: 3 | 4 | 5,
): RuinGenerationInput['wave'] {
  return {
    candidateCount,
    level: candidateCount === 3
      ? 'ripple'
      : candidateCount === 4
      ? 'surge'
      : 'howl',
  };
}

function periodSequence(
  candidateCount: 3 | 4 | 5,
  random: () => number,
): PeriodType[] {
  const base: PeriodType[] = ['stable', 'transition', 'turbulent'];
  while (base.length < candidateCount) {
    const choices = (['stable', 'transition', 'turbulent'] as PeriodType[])
      .filter(value => value !== base.at(-1));
    const next = choices[Math.floor(normalizeRandom(random()) * choices.length)];
    base.push(next);
  }
  return shuffle(base, random);
}

function parseTable(diceRules: string, name: string): DiceEntry[] {
  const section = diceRules.match(
    new RegExp(`# ${name}\\s*([\\s\\S]*?)(?=\\n# |$)`, 'u'),
  )?.[1] ?? '';
  const entries = section
    .split(/\r?\n/u)
    .map(line => line.trim())
    .flatMap(line => {
      const match = line.match(
        /^(\d{2})-(\d{2,3})\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*(.+)$/u,
      );
      if (!match) return [];
      return [{
        min: Number(match[1]),
        max: Number(match[2]),
        key: match[3].trim(),
        label: match[4].trim(),
        directions: match[5].trim(),
      }];
    });
  if (!entries.length) throw new Error(`Dice table ${name} is unavailable`);
  return entries;
}

function roll(entries: DiceEntry[], random: () => number): DiceEntry {
  const value = Math.floor(normalizeRandom(random()) * 100) + 1;
  const entry = entries.find(item => value >= item.min && value <= item.max);
  if (!entry) throw new Error(`Dice value ${value} did not match a material`);
  return entry;
}

function serializeMaterial(entry: DiceEntry): string {
  return `${entry.key}｜${entry.label}｜${entry.directions}`;
}

function shuffle<T>(values: T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(normalizeRandom(random()) * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function normalizeRandom(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.999999999, Math.max(0, value));
}
