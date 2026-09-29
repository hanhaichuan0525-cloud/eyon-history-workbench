export type BiographyPeriodType = 'stable' | 'transition' | 'turbulent';

interface DiceEntry {
  min: number;
  max: number;
  key: string;
  label: string;
  directions: string;
}

export interface BiographyStagePlanEntry {
  id: string;
  type: BiographyPeriodType;
  diceMaterial: string;
}

export interface BiographyStagePlan {
  count: number;
  stages: BiographyStagePlanEntry[];
}

export function createBiographyStagePlanFromRules(
  diceRules: string,
  random: () => number = Math.random,
): BiographyStagePlan {
  const count = rollStageCount(diceRules, random);
  const sequence = rollValidSequence(count, random);
  const tables = {
    stable: parseMaterialTable(diceRules, 'table_2_stable'),
    transition: parseMaterialTable(diceRules, 'table_3_transition'),
    turbulent: parseMaterialTable(diceRules, 'table_4_turbulent'),
  };
  return {
    count,
    stages: sequence.map((type, index) => ({
      id: `stage-${index + 1}`,
      type,
      diceMaterial: serializeMaterial(rollMaterial(tables[type], random)),
    })),
  };
}

function rollStageCount(diceRules: string, random: () => number): number {
  const section = tableSection(diceRules, 'table_1_stage_count');
  const entries = section
    .split(/\r?\n/u)
    .map(line => line.trim())
    .flatMap(line => {
      const match = line.match(/^(\d{2})-(\d{2,3})\s*:\s*([5-8])$/u);
      return match
        ? [{ min: Number(match[1]), max: Number(match[2]), count: Number(match[3]) }]
        : [];
    });
  if (!entries.length) throw new Error('Biography stage count table is unavailable');
  const value = rollD100(random);
  return entries.find(entry => value >= entry.min && value <= entry.max)?.count ?? 6;
}

function rollValidSequence(
  count: number,
  random: () => number,
): BiographyPeriodType[] {
  const types: BiographyPeriodType[] = ['stable', 'transition', 'turbulent'];
  const candidates: BiographyPeriodType[][] = [];

  const visit = (sequence: BiographyPeriodType[]) => {
    if (sequence.length === count) {
      if (sequence.at(-1) !== 'turbulent' && new Set(sequence).size === types.length) {
        candidates.push(sequence);
      }
      return;
    }
    const previous = sequence.at(-1);
    const choices = previous === 'turbulent'
      ? ['transition'] as BiographyPeriodType[]
      : types.filter(type => type !== previous);
    for (const type of choices) visit([...sequence, type]);
  };

  visit([]);
  if (!candidates.length) throw new Error(`Unable to create a valid ${count}-stage biography plan`);
  return candidates[Math.floor(normalizeRandom(random()) * candidates.length)];
}

function parseMaterialTable(diceRules: string, name: string): DiceEntry[] {
  const entries = tableSection(diceRules, name)
    .split(/\r?\n/u)
    .map(line => line.trim())
    .flatMap(line => {
      const match = line.match(
        /^(\d{2})-(\d{2,3})\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*(.+)$/u,
      );
      return match
        ? [{
          min: Number(match[1]),
          max: Number(match[2]),
          key: match[3].trim(),
          label: match[4].trim(),
          directions: match[5].trim(),
        }]
        : [];
    });
  if (!entries.length) throw new Error(`Dice table ${name} is unavailable`);
  return entries;
}

function tableSection(diceRules: string, name: string): string {
  return diceRules.match(
    new RegExp(`# ${name}\\s*([\\s\\S]*?)(?=\\n# |$)`, 'u'),
  )?.[1] ?? '';
}

function rollMaterial(entries: DiceEntry[], random: () => number): DiceEntry {
  const value = rollD100(random);
  const entry = entries.find(item => value >= item.min && value <= item.max);
  if (!entry) throw new Error(`Dice value ${value} did not match a biography material`);
  return entry;
}

function rollD100(random: () => number): number {
  return Math.floor(normalizeRandom(random()) * 100) + 1;
}

function serializeMaterial(entry: DiceEntry): string {
  return `${entry.key}｜${entry.label}｜${entry.directions}`;
}

function normalizeRandom(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.999999999, Math.max(0, value));
}
