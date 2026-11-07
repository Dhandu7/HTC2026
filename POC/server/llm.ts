// Optional LLM proxy. The browser/Electron app never holds the API key; it calls
// POST /api/predict here. Only text context is sent — never video or images.
//
//   ANTHROPIC_API_KEY=... npm run llm
//
// Two tasks:
//   - "continue": suggest full continuations of the sentence typed so far. Shown live
//                 while typing, so it uses a fast model (GAZETYPE_FAST_MODEL).
//   - "expand":   SpeakFaster-style abbreviation expansion. The user types one
//                 letter-group per word (e.g. [ghi][jkl][mno]); we ask for sentences
//                 whose word initials fit, then re-validate locally. The user opens a
//                 panel and waits for this, so it uses the stronger model (GAZETYPE_MODEL).
//
// The user's profile (about, people, sample sentences) goes in a cached system block,
// so suggestions sound like them and repeat requests reuse the cached prompt.
import { createServer } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { fileURLToPath } from "node:url";

// Load POC/.env (ANTHROPIC_API_KEY etc.). Variables already set in the shell win.
try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  /* no .env file: fall back to the shell environment */
}
if (!process.env.ANTHROPIC_API_KEY) console.warn("[gazetype-llm] ANTHROPIC_API_KEY is not set. Add it to POC/.env.");

const PORT = Number(process.env.LLM_PORT ?? 8787);
const MODEL = process.env.GAZETYPE_MODEL ?? "claude-opus-5-5";
const FAST_MODEL = process.env.GAZETYPE_FAST_MODEL ?? "claude-haiku-5-5";
const client = new Anthropic();

const Suggestions = z.object({ suggestions: z.array(z.string()) });

const Profile = z.object({
  name: z.string().max(80).default(""),
  about: z.string().max(2000).default(""),
  people: z.array(z.string().max(80)).max(40).default([]),
  samples: z.array(z.string().max(300)).max(40).default([]),
});

const Request = z.object({
  task: z.enum(["continue", "expand"]),
  text: z.string().max(2000).default(""),
  /** For "expand": allowed letters for each word's first letter. */
  slots: z.array(z.string().max(26)).max(20).default([]),
  /** Recent sentences the user said — personal style/context. */
  history: z.array(z.string().max(300)).max(20).default([]),
  n: z.number().int().min(1).max(8).default(4),
  profile: Profile.optional(),
});

const SYSTEM = `You help a person who communicates with an eye-gaze keyboard (for example, someone with ALS or locked-in syndrome). Each selection costs them several seconds of effort, so good suggestions save real time.
Write in the first person, as the user, in their voice. Prefer short, plain, everyday sentences people really say to carers, family and friends. Use the user's recent sentences as a guide to their vocabulary and concerns. Never add commentary; return only the suggestions.`;

/**
 * Profile block. It must be byte-identical between requests for the same profile, or the
 * prompt cache misses, so it holds only fields that change when the profile is edited.
 * Anything that changes per sentence (recent history) goes in the user message instead.
 */
function profileBlock(p: z.infer<typeof Profile>): string {
  const parts: string[] = [];
  if (p.name) parts.push(`The user's name is ${p.name}.`);
  if (p.about.trim()) parts.push(`About the user, in their or their carer's words:\n${p.about.trim()}`);
  if (p.people.length) parts.push(`People in the user's life (use these exact names): ${p.people.join(", ")}`);
  if (p.samples.length)
    parts.push(
      `Things the user has written before. Match their word choice, tone, spelling habits and sentence length:\n${p.samples.map((s) => `- ${s}`).join("\n")}`,
    );
  return parts.join("\n\n");
}

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

async function predict(r: z.infer<typeof Request>): Promise<{ suggestions: string[]; model: string; cachedTokens: number }> {
  const model = r.task === "continue" ? FAST_MODEL : MODEL;
  const fast = model.startsWith("claude-haiku");
  const pb = r.profile ? profileBlock(r.profile) : "";
  const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: SYSTEM }];
  // Cache the whole system prefix (instructions + profile). Short prefixes simply don't cache.
  if (pb) system.push({ type: "text", text: pb, cache_control: { type: "ephemeral" } });

  const response = await client.beta.messages.parse({
    model,
    max_tokens: fast ? 400 : 2000,
    // Haiku: no thinking for the lowest latency (allowed at effort "low").
    // Opus: server-side refusal fallback — if a safety classifier declines, the API re-routes in the same call.
    ...(fast
      ? { thinking: { type: "disabled" as const } }
      : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
    output_config: { effort: "low", format: betaZodOutputFormat(Suggestions) },
    system,
    messages: [{ role: "user", content: prompt(r) }],
  });
  const cachedTokens = response.usage.cache_read_input_tokens ?? 0;
  if (response.stop_reason === "refusal") return { suggestions: [], model, cachedTokens };
  const out = response.parsed_output?.suggestions ?? [];
  const valid =
    r.task === "expand"
      ? out.filter((s) => initialsFit(s, r.slots))
      : out.filter((s) => s.toLowerCase().startsWith(r.text.trim().toLowerCase()));
  return { suggestions: [...new Set(valid)].slice(0, r.n), model, cachedTokens };
}

createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.method === "GET" && req.url === "/api/health") {
    res.end(JSON.stringify({ ok: true, keySet: !!process.env.ANTHROPIC_API_KEY, model: MODEL, fastModel: FAST_MODEL }));
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
    const out = await predict(parsed);
    const ms = Date.now() - started;
    console.log(`[gazetype-llm] ${parsed.task} ${out.model} ${ms} ms, cached ${out.cachedTokens} tokens`);
    res.end(JSON.stringify({ ...out, ms }));
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
}).listen(PORT, () => console.log(`[gazetype-llm] http://localhost:${PORT} model=${MODEL} fast=${FAST_MODEL}`));
