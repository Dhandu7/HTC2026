// Optional LLM proxy. The browser/Electron app never holds the API key; it calls
// POST /api/predict here. Only text context is sent — never video or images.
//
//   ANTHROPIC_API_KEY=... npm run llm
//
// Two tasks:
//   - "continue": suggest full continuations of the sentence typed so far
//   - "expand":   SpeakFaster-style abbreviation expansion. The user types one
//                 letter-group per word (e.g. [ghi][jkl][mno]); we ask for sentences
//                 whose word initials fit, then re-validate locally.
import { createServer } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";

const PORT = Number(process.env.LLM_PORT ?? 8787);
const MODEL = process.env.GAZETYPE_MODEL ?? "claude-opus-5-5";
const client = new Anthropic();

const Suggestions = z.object({ suggestions: z.array(z.string()) });

const Request = z.object({
  task: z.enum(["continue", "expand"]),
  text: z.string().max(2000).default(""),
  /** For "expand": allowed letters for each word's first letter. */
  slots: z.array(z.string().max(26)).max(20).default([]),
  /** Recent sentences the user said — personal style/context. */
  history: z.array(z.string().max(300)).max(20).default([]),
  n: z.number().int().min(1).max(8).default(4),
});

const SYSTEM = `You help a person who communicates with an eye-gaze keyboard (for example, someone with ALS or locked-in syndrome). Each selection costs them several seconds of effort, so good suggestions save real time.
Write in the first person, as the user, in their voice. Prefer short, plain, everyday sentences people really say to carers, family and friends. Use the user's recent sentences as a guide to their vocabulary and concerns. Never add commentary; return only the suggestions.`;

function prompt(r: z.infer<typeof Request>): string {
  const hist = r.history.length ? `Recent things the user said:\n${r.history.map((h) => `- ${h}`).join("\n")}\n\n` : "";
  if (r.task === "continue") {
    return `${hist}The user has typed: "${r.text}"\nSuggest ${r.n} different likely ways to finish this sentence. Each suggestion must be the complete sentence, starting with exactly the words already typed.`;
  }
  const pattern = r.slots.map((s, i) => `word ${i + 1} starts with one of: ${s.split("").join(" ")}`).join("\n");
  return `${hist}The user typed an abbreviation: one key per word, where each key stands for a group of letters.\n${pattern}\nSuggest ${r.n} different likely sentences with exactly ${r.slots.length} words that fit this pattern${r.text ? `, continuing after: "${r.text}"` : ""}.`;
}

const initialsFit = (s: string, slots: string[]) => {
  const words = s.toLowerCase().match(/[a-z']+/g) ?? [];
  return words.length === slots.length && words.every((w, i) => slots[i].includes(w[0]));
};

async function predict(r: z.infer<typeof Request>): Promise<string[]> {
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    // Server-side refusal fallback: if a safety classifier declines, the API re-routes in the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // Low effort: this is a latency-sensitive autocomplete route.
    output_config: { effort: "low", format: betaZodOutputFormat(Suggestions) },
    system: SYSTEM,
    messages: [{ role: "user", content: prompt(r) }],
  });
  if (response.stop_reason === "refusal") return [];
  const out = response.parsed_output?.suggestions ?? [];
  const valid =
    r.task === "expand"
      ? out.filter((s) => initialsFit(s, r.slots))
      : out.filter((s) => s.toLowerCase().startsWith(r.text.trim().toLowerCase()));
  return [...new Set(valid)].slice(0, r.n);
}

createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.method === "GET" && req.url === "/api/health") {
    res.end(JSON.stringify({ ok: true, model: MODEL }));
    return;
  }
  if (req.method !== "POST" || req.url !== "/api/predict") {
    res.statusCode = 404;
    res.end("{}");
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const started = Date.now();
  try {
    const parsed = Request.parse(JSON.parse(body || "{}"));
    const suggestions = await predict(parsed);
    res.end(JSON.stringify({ suggestions, ms: Date.now() - started, model: MODEL }));
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      res.statusCode = err.status && err.status >= 400 && err.status < 600 ? 502 : 500;
      res.end(JSON.stringify({ error: `anthropic ${err.status}: ${err.message}` }));
    } else if (err instanceof z.ZodError || err instanceof SyntaxError) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "bad request" }));
    } else {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  }
}).listen(PORT, () => console.log(`[gazetype-llm] http://localhost:${PORT} model=${MODEL}`));
