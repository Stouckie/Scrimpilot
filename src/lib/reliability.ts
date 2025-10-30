import { ladderStore, teamStore, type Team } from './store.js';

interface ReliabilityOptions {
  teamId: string;
  delta: number;
  cooldownUntil?: string | null;
  timestamp?: string;
}

export interface ReliabilityResult {
  previous: number;
  next: number;
}

export async function applyReliabilityChange(
  options: ReliabilityOptions,
): Promise<ReliabilityResult | undefined> {
  const { teamId, delta, cooldownUntil, timestamp = new Date().toISOString() } = options;
  const teams = await teamStore.read();
  const team = teams.find((entry) => entry.id === teamId);
  if (!team) return undefined;

  const previous = Number.isFinite(team.reliability) ? team.reliability : 100;
  const next = Math.max(0, Math.min(100, previous + delta));
  const updatedTeam: Team = {
    ...team,
    reliability: next,
    scrimCooldownUntil:
      cooldownUntil === null
        ? undefined
        : cooldownUntil ?? team.scrimCooldownUntil,
    updatedAt: timestamp,
  };

  await teamStore.update((collection) =>
    collection.map((entry) => (entry.id === teamId ? updatedTeam : entry)),
  );

  await ladderStore.update((collection) =>
    collection.map((ladder) => {
      let changed = false;
      const entries = ladder.entries.map((entry) => {
        if (entry.teamId !== teamId) return entry;
        changed = true;
        return { ...entry, reliability: next };
      });
      return changed ? { ...ladder, entries, updatedAt: timestamp } : ladder;
    }),
  );

  return { previous, next };
}

export const isTeamOnCooldown = (team: Team, reference = new Date()): boolean => {
  if (!team.scrimCooldownUntil) return false;
  const until = new Date(team.scrimCooldownUntil).getTime();
  if (Number.isNaN(until)) return false;
  return until > reference.getTime();
};

export const formatCooldown = (team: Team): string | undefined => {
  if (!team.scrimCooldownUntil) return undefined;
  const until = new Date(team.scrimCooldownUntil).getTime();
  if (Number.isNaN(until)) return undefined;
  return `<t:${Math.floor(until / 1000)}:F>`;
};
