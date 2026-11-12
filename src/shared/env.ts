export function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got ${raw}`);
  return n;
}

/** Shared secrets must be long enough that guessing them is not an option. */
export function secret(name: string): string {
  const value = env(name);
  if (value.length < 32) throw new Error(`${name} must be at least 32 characters`);
  return value;
}
