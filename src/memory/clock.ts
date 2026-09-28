let evaluationTime: Date | null = null;

export function memoryNow(): Date {
  return evaluationTime ? new Date(evaluationTime) : new Date();
}

export function setMemoryClockForEvaluation(time: Date | null): void {
  if (process.env.ARCHIE_MEMORY_EVAL_REPLAY !== 'true') throw new Error('memory evaluation clock is unavailable outside isolated replay');
  if (time && !Number.isFinite(time.getTime())) throw new Error('invalid memory evaluation time');
  evaluationTime = time ? new Date(time) : null;
}
