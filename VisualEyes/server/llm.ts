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
//
// Voice: with ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID set, POST /api/speak returns the
// sentence in the user's cloned voice (see docs/ELEVENLABS_VOICE.md). Otherwise the app
// uses the system voice.
import { createServer } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { fileURLToPath } from "node:url";
import { elevenModel, elevenSpeak, voiceConfigured } from "./elevenlabs";
import { containsSlur, stripSlurs } from "../src/safety/slurs";

// Load VisualEyes/.env (ANTHROPIC_API_KEY etc.). Variables already set in the shell win.
try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  /* no .env file: fall back to the shell environment */
}
if (!process.env.ANTHROPIC_API_KEY) console.warn("[gazetype-llm] ANTHROPIC_API_KEY is not set. Add it to VisualEyes/.env.");

const PORT = Number(process.env.LLM_PORT ?? 8787);
const MODEL = process.env.GAZETYPE_MODEL ?? "claude-opus-5-5";
const FAST_MODEL = process.env.GAZETYPE_FAST_MODEL ?? "claude-haiku-5-5";
// Created on first use, so the server (and the voice) still starts without an Anthropic key.
let anthropic: Anthropic | null = null;
const client = () => (anthropic ??= new Anthropic());

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

const SYSTEM = `You predict how a person will finish the sentence they are typing with an eye-gaze keyboard (for example, someone with ALS or locked-in syndrome). Each selection costs them several seconds of effort, so a good prediction saves real time; a wrong or odd one costs a glance.
Rules:
- Write in the first person, as the user, in their voice: match their spelling, capitalisation, punctuation, slang and sentence length exactly as their writing samples show.
- Use the writing samples for HOW they write, not WHAT to say. Do not repeat a sample sentence; the keyboard already offers those. Predict what this person is most likely saying now, given the words already typed.
- Continue the typed words naturally and grammatically. Keep each continuation short: usually 2 to 8 words, never more than 12.
- Order suggestions from most to least likely, and make them clearly different from each other.
- Fit the person's life as described (who they live with, what they can do, what they care about). Use only the names you are given; never invent people.
- Return only the suggestions, no commentary.`;

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
  const hist = r.history.length ? `What the user said most recently (newest first):\n${r.history.map((h) => `- ${h}`).join("\n")}\n\n` : "";
  if (r.task === "continue") {
    return `${hist}The user has typed: "${r.text}"\nSuggest ${r.n + EXTRA} different likely ways to finish this sentence, most likely first. Each suggestion must be the complete sentence, starting with exactly the words already typed.`;
  }
  const pattern = r.slots.map((s, i) => `word ${i + 1} starts with one of: ${s.split("").join(" ")}`).join("\n");
  return `${hist}The user typed an abbreviation: one key per word, where each key stands for a group of letters.\n${pattern}\nSuggest ${r.n} different likely sentences with exactly ${r.slots.length} words that fit this pattern${r.text ? `, continuing after: "${r.text}"` : ""}.`;
}

/** Ask for a few spare suggestions, so dropping repeats of things the keyboard already offers still leaves n. */
const EXTRA = 2;
/** A continuation longer than this is not a quick suggestion any more. */
const MAX_CONTINUATION_WORDS = 12;
/** GAZETYPE_AI_REPEATS=drop removes suggestions that repeat a writing sample or recent sentence word for word. */
const DROP_REPEATS = (process.env.GAZETYPE_AI_REPEATS ?? "allow") === "drop";
const norm = (s: string) => (s.toLowerCase().match(/[a-z0-9']+/g) ?? []).join(" ");

const initialsFit = (s: string, slots: string[]) => {
  const words = s.toLowerCase().match(/[a-z']+/g) ?? [];
  return words.length === slots.length && words.every((w, i) => slots[i].includes(w[0]));
};

async function predict(r: z.infer<typeof Request>): Promise<{ suggestions: string[]; model: string; cachedTokens: number }> {
  const model = r.task === "continue" ? FAST_MODEL : MODEL;
  const fast = model.startsWith("claude-haiku");
  // Slurs are blocked: never sent to the model as context, never returned as a suggestion.
  if (containsSlur(r.text)) return { suggestions: [], model, cachedTokens: 0 };
  r = {
    ...r,
    history: r.history.filter((h) => !containsSlur(h)),
    profile: r.profile && {
      ...r.profile,
      about: stripSlurs(r.profile.about),
      people: r.profile.people.filter((p) => !containsSlur(p)),
      samples: r.profile.samples.filter((s) => !containsSlur(s)),
    },
  };
  const pb = r.profile ? profileBlock(r.profile) : "";
  const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: SYSTEM }];
  // Cache the whole system prefix (instructions + profile). Short prefixes simply don't cache.
  if (pb) system.push({ type: "text", text: pb, cache_control: { type: "ephemeral" } });

  const response = await client().beta.messages.parse({
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
  // The keyboard's phrase chips already offer the user's own past sentences, so an AI chip that only
  // repeats one wastes the slot: keep new sentences only.
  const known = new Set([...(r.profile?.samples ?? []), ...r.history].map(norm));
  const typed = r.text.trim().toLowerCase();
  const clean = out.filter((s) => !containsSlur(s));
  const valid =
    r.task === "expand"
      ? clean.filter((s) => initialsFit(s, r.slots))
      : clean.filter((s) => {
          if (!s.toLowerCase().startsWith(typed)) return false;
          const rest = norm(s.slice(typed.length));
          return rest.length > 0 && rest.split(" ").length <= MAX_CONTINUATION_WORDS && !(DROP_REPEATS && known.has(norm(s)));
        });
  return { suggestions: [...new Set(valid)].slice(0, r.n), model, cachedTokens };
}

const SpeakRequest = z.object({ text: z.string().min(1).max(1000) });

createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  // The Electron overlay calls http://localhost:8787 directly (a different origin from the page).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method === "GET" && req.url === "/api/health") {
    res.end(
      JSON.stringify({ ok: true, keySet: !!process.env.ANTHROPIC_API_KEY, model: MODEL, fastModel: FAST_MODEL, voice: voiceConfigured() }),
    );
    return;
  }
  if (req.method === "GET" && req.url === "/api/voice/health") {
    res.end(JSON.stringify({ ok: voiceConfigured(), model: elevenModel() }));
    return;
  }
  if (req.method === "POST" && req.url === "/api/speak") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const started = Date.now();
    try {
      const { text } = SpeakRequest.parse(JSON.parse(body || "{}"));
      // Checked first, so slurs are refused whatever the voice configuration.
      if (containsSlur(text)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "blocked: the text contains a slur" }));
        return;
      }
      if (!voiceConfigured()) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in VisualEyes/.env" }));
        return;
      }
      const audio = Buffer.from(await elevenSpeak(text));
      console.log(`[gazetype-llm] speak ${text.length} chars ${Date.now() - started} ms`);
      res.setHeader("Content-Type", "audio/mpeg");
      res.end(audio);
    } catch (err) {
      const bad = err instanceof z.ZodError || err instanceof SyntaxError;
      if (!bad) console.error("[gazetype-llm] speak failed:", err);
      res.statusCode = bad ? 400 : 502;
      res.end(JSON.stringify({ error: bad ? "bad request" : String(err) }));
    }
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
}).listen(PORT, () => {
  console.log(`[gazetype-llm] http://localhost:${PORT} model=${MODEL} fast=${FAST_MODEL}`);
  console.log(`[gazetype-llm] voice: ${voiceConfigured() ? `ElevenLabs (${elevenModel()})` : "system voice (set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID for the cloned voice)"}`);
});
