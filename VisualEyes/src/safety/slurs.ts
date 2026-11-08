// Slur blocking. Swearing is allowed everywhere; slurs (insults aimed at a group of people) are not:
// they are never suggested, never learned, can't be committed as a word, and a message containing one
// can't be spoken, inserted or copied. Shared by the app and the Node server.
//
// The list is ROT13-encoded so the words don't appear in plain text when reading or searching the code.
// To read or edit it: decode with ROT13 (e.g. `node -e "console.log(require('./src/safety/slurs').slurList())"`
// from VisualEyes/, via tsx), change it, and encode again.
//
// Only unambiguous slurs are listed. Words that are also ordinary English are deliberately left out so
// normal sentences aren't blocked: e.g. "chink" (in the armour), "coon" (raccoon), "spade", "fairy",
// "queer" (widely reclaimed), "cripple", "spastic" (still a clinical term), "gyp". Add them here if the
// team decides otherwise; the tests in tests/slurs.test.ts show the trade-off.

const ENCODED = [
  "avttre", "avttn", "xvxr", "jrgonpx", "tbbx", "enturnq", "gbjryurnq", "ornare", "puvanzna", "cnxv", "mvccreurnq",
  "qnexvr", "cbepuzbaxrl", "whatyrohaal", "tbyyvjbt", "xnssve", "erqfxva", "fdhnj", "tlccb", "cvxrl", "urro",
  "ulzvr", "qntb", "jbc", "cbynpx", "fcvp", "snttbg", "snt", "qlxr", "genaal", "genaavr", "furznyr", "ergneq",
  "ergneqrq", "fcnm", "zbatbybvq",
];

const rot13 = (s: string) => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));

/** Look-alike characters people use to get around filters. */
const LEET: Record<string, string> = { "0": "o", "1": "i", "!": "i", "|": "i", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "+": "t", "8": "b", "9": "g" };

/** Lower-case, undo look-alikes, drop everything that isn't a letter. Punctuation at either end
 *  ("word!!", "(word)") is just punctuation, not a look-alike letter. */
function letters(s: string): string {
  let out = "";
  const core = s.toLowerCase().replace(/^[^a-z0-9@$]+|[^a-z0-9@$]+$/g, "");
  for (const ch of core) {
    const c = LEET[ch] ?? ch;
    if (c >= "a" && c <= "z") out += c;
  }
  return out;
}

/** "niiiggger" -> "niger": repeated letters collapsed, so stretched spellings still match. */
const squash = (s: string) => s.replace(/(.)\1+/g, "$1");

const SLURS = ENCODED.map(rot13);
const EXACT = new Set(SLURS);
const SQUASHED = new Set(SLURS.map(squash));
/** Endings that still make the same word: plurals and the like. */
const SUFFIXES = ["", "s", "es", "z", "zz"];

/** The decoded list, for reviewing it. */
export const slurList = (): string[] => [...SLURS];

/** Is this single word (with any look-alike characters, stretching or plural ending) a slur? */
export function isSlur(word: string): boolean {
  const w = letters(word);
  if (w.length < 3) return false;
  for (const suf of SUFFIXES) {
    if (suf && !w.endsWith(suf)) continue;
    const stem = w.slice(0, w.length - suf.length);
    if (EXACT.has(stem) || SQUASHED.has(squash(stem))) return true;
  }
  return false;
}

/**
 * The first slur in a piece of text, or null. Checks each word, and also runs of single letters
 * ("n i g g e r", "n.i.g.g.e.r") joined together.
 */
export function findSlur(text: string): string | null {
  const tokens = text.split(/[\s,;:!?()"]+/).filter(Boolean);
  for (const t of tokens) if (isSlur(t)) return t; // also "n.i.g.g.e.r": the dots are dropped
  // Runs of single letters ("n i g g e r"): try every stretch, since a real one-letter word
  // like "a" or "I" may sit right next to the spelled-out word.
  let run: string[] = [];
  const flush = () => {
    const ls = run.map(letters);
    run = [];
    for (let i = 0; i < ls.length; i++)
      for (let j = i + 3; j <= ls.length; j++) {
        const joined = ls.slice(i, j).join("");
        if (isSlur(joined)) return joined;
      }
    return null;
  };
  for (const t of tokens) {
    if (letters(t).length === 1) run.push(t);
    else {
      const hit = flush();
      if (hit) return hit;
    }
  }
  return flush();
}

export const containsSlur = (text: string): boolean => findSlur(text) !== null;

/** The text with any slur words removed (for free text like a profile description). */
export const stripSlurs = (text: string): string =>
  text
    .split(/(\s+)/)
    .filter((t) => !isSlur(t))
    .join("")
    .replace(/\s{2,}/g, " ")
    .trim();

/** What the user sees when something is blocked. Plain and non-judgemental. */
export const SLUR_NOTICE = "That word is blocked: VisualEyes doesn't allow slurs. Swearing is fine.";
