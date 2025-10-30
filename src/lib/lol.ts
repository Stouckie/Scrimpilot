import { QueueLevel, LolRank } from './store';

export const rankToSkillRating: Record<LolRank, number> = {
  iron: 0,
  bronze: 1,
  silver: 2,
  gold: 3,
  platinum: 4,
  emerald: 5,
  diamond: 6,
  master: 7,
  grandmaster: 8,
  challenger: 9.5,
};

export const getSkillRatingForRank = (rank: LolRank): number => rankToSkillRating[rank];

export function computeTeamSRTrimmed(membersSR: number[]): number {
  if (membersSR.length === 0) {
    return 0;
  }

  const sorted = [...membersSR].sort((a, b) => a - b);
  const values = sorted.length <= 2 ? sorted : sorted.slice(1, sorted.length - 1);
  const average = values.reduce((total, value) => total + value, 0) / values.length;
  return Math.round(average * 10) / 10;
}

export interface RosterValidationOptions {
  coherenceWindow?: number;
  requiredAlignedPlayers?: number;
  maxSpread?: number;
}

export interface RosterValidationResult {
  teamSR: number;
  spread: number;
  alignedCount: number;
  practiceRequired: boolean;
  reasons: string[];
}

const DEFAULT_OPTIONS: Required<RosterValidationOptions> = {
  coherenceWindow: 1,
  requiredAlignedPlayers: 3,
  maxSpread: 4,
};

export function validateRosterBalance(
  membersSR: number[],
  options: RosterValidationOptions = {},
): RosterValidationResult {
  const resolved = { ...DEFAULT_OPTIONS, ...options };

  if (membersSR.length === 0) {
    return {
      teamSR: 0,
      spread: 0,
      alignedCount: 0,
      practiceRequired: true,
      reasons: ['Aucun joueur déclaré pour le match.'],
    };
  }

  const teamSR = computeTeamSRTrimmed(membersSR);
  const spread = membersSR.length > 0 ? Math.max(...membersSR) - Math.min(...membersSR) : 0;
  const [lowerBound, upperBound] = [teamSR - resolved.coherenceWindow, teamSR + resolved.coherenceWindow];
  const alignedCount = membersSR.filter((sr) => sr >= lowerBound && sr <= upperBound).length;

  const reasons: string[] = [];
  let practiceRequired = false;

  if (spread > resolved.maxSpread) {
    practiceRequired = true;
    reasons.push(`Écart interne trop élevé (spread ${spread.toFixed(1)} > ${resolved.maxSpread}).`);
  }

  if (alignedCount < resolved.requiredAlignedPlayers) {
    practiceRequired = true;
    reasons.push(
      `Cohérence insuffisante : seulement ${alignedCount} joueur(s) dans ±${resolved.coherenceWindow.toFixed(1)} SR (min ${resolved.requiredAlignedPlayers}).`,
    );
  }

  return {
    teamSR,
    spread: Math.round(spread * 10) / 10,
    alignedCount,
    practiceRequired,
    reasons,
  };
}

const LEVEL_TOLERANCE: Record<QueueLevel, number> = {
  Open: 1,
  Academy: 0.5,
  Pro: 0.3,
};

export const getQueueTolerance = (level: QueueLevel): number => LEVEL_TOLERANCE[level] ?? 1;

export function isMatchupBalanced(
  homeTeamSr: number,
  awayTeamSr: number,
  level: QueueLevel,
  customTolerance?: number,
): { balanced: boolean; delta: number; tolerance: number } {
  const tolerance = customTolerance ?? getQueueTolerance(level);
  const delta = Math.abs(homeTeamSr - awayTeamSr);

  return {
    balanced: delta <= tolerance,
    delta: Math.round(delta * 10) / 10,
    tolerance,
  };
}
