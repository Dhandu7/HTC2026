// Client for the optional LLM proxy (server/llm.ts). Every call has a hard
// timeout so a slow network can never stall typing — local predictions show first.

const base = () => ((window as unknown as { gazetype?: unknown }).gazetype ? "http://localhost:8787" : "");

let available: boolean | null = null;

export async function llmAvailable(): Promise<boolean> {
  if (available !== null) return available;
  try {
    const r = await fetch(`${base()}/api/health`, { signal: AbortSignal.timeout(1500) });
    available = r.ok && !!(await r.json()).ok;
  } catch {
    available = false;
  }
  return available;
}

export async function llmPredict(body: {
  task: "continue" | "expand";
  text?: string;
  slots?: string[];
  history?: string[];
  n?: number;
}): Promise<string[]> {
  if (!(await llmAvailable())) return [];
  try {
    const r = await fetch(`${base()}/api/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return [];
    return (await r.json()).suggestions ?? [];
  } catch {
    return [];
  }
}
