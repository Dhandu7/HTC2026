// Which recordings and files can be added to a voice. The only rules are about size and count: the type of a file is
// never checked here, because the service decides what it can read (MP3, M4A, WAV, WebM, FLAC, OGG, video files with
// sound, and anything else ffmpeg understands) and says why when it cannot.

export const MAX_FILES = 40;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
/** A recording made here stops by itself after this long, so a forgotten one cannot grow without limit. */
export const MAX_RECORDING_SECONDS = 180;

export interface Candidate {
  name: string;
  size: number;
}

export interface InputCheck {
  /** Indexes into the incoming list that may be added. */
  accepted: number[];
  /** Plain-language reasons for anything that was left out. */
  problems: string[];
}

export const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export const formatSeconds = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Decide which of `incoming` can be added to `existing`. Never looks at the file's type. */
export function checkInputs(existing: Candidate[], incoming: Candidate[]): InputCheck {
  const accepted: number[] = [];
  const problems: string[] = [];
  let count = existing.length;
  let total = existing.reduce((n, f) => n + f.size, 0);
  incoming.forEach((f, i) => {
    if (f.size === 0) problems.push(`${f.name} is empty.`);
    else if (f.size > MAX_FILE_BYTES) problems.push(`${f.name} is ${formatSize(f.size)}, over the ${formatSize(MAX_FILE_BYTES)} limit for one file. Use a shorter excerpt.`);
    else if (count >= MAX_FILES) problems.push(`${f.name} was not added: at most ${MAX_FILES} files.`);
    else if (total + f.size > MAX_TOTAL_BYTES) problems.push(`${f.name} was not added: that would go over ${formatSize(MAX_TOTAL_BYTES)} in total.`);
    else {
      accepted.push(i);
      count++;
      total += f.size;
    }
  });
  return { accepted, problems };
}
