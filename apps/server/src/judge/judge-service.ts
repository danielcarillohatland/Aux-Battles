/** Judge entry/result shapes shared by the orchestrator and results store (types only). */
import type { JudgeConfidence, JudgingCategories, Track } from '@aux/shared';

export interface JudgeEntry {
  playerId: string;
  track: Track;
  chicken: boolean;
  /** Anonymous player-written defense of the pick (D-026). */
  defense?: string;
}

export interface JudgedEntry extends JudgeEntry {
  rank: number;
  score: number;
  explanation: string;
  judgeModel: string;
  categories?: JudgingCategories;
  totalScore?: number;
  verdict?: string;
  /** Bullet judgement (D-032). */
  reasons?: string[];
  defenseNote?: string;
  confidence?: JudgeConfidence;
}
