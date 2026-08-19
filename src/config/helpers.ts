// Two pure primitives, shared because every consuming agent needs exactly
// this env-var-reading pattern. Deliberately NOT a shared config schema/
// singleton — each agent's .env shape is genuinely different, and a schema
// DSL flexible enough to cover more than one shape today is speculative
// machinery with no current payoff. Each agent keeps its own frozen config
// object built from these.

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}
