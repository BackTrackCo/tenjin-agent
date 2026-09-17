export enum Level {
  Low = 'low',
  High = 'high',
}

export function levelOf(score: number): Level {
  return score >= 50 ? Level.High : Level.Low;
}
