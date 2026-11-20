export function isModelWorkerProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TENJIN_MODEL_WORKER === '1';
}
