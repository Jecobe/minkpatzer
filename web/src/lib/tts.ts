// Wrapper around the browser Web Speech API. On Edge/Chrome/Windows this uses
// installed Windows SAPI voices; on macOS uses system voices; on Android Chrome
// uses Android voices. Always sets utterance.lang explicitly so the OS picks an
// appropriate voice when our preferred one isn't available.

import { stripMarkdown, stripReasoning } from './markdown';

import { bcp47For, type Language } from './languages';

export function getVoices(): SpeechSynthesisVoice[] {
  if (typeof speechSynthesis === 'undefined') return [];
  return speechSynthesis.getVoices();
}

export function onVoicesReady(cb: () => void): () => void {
  if (typeof speechSynthesis === 'undefined') return () => {};
  if (speechSynthesis.getVoices().length > 0) { cb(); return () => {}; }
  const handler = () => cb();
  speechSynthesis.addEventListener('voiceschanged', handler);
  return () => speechSynthesis.removeEventListener('voiceschanged', handler);
}

export function voicesForLang(lang: Language): SpeechSynthesisVoice[] {
  const prefix = lang;
  return getVoices().filter((v) => v.lang.toLowerCase().startsWith(prefix));
}

export interface SpeakOpts { voice?: string | null; rate?: number; pitch?: number; lang?: Language }

/** What speak() hands back: set `onend` to hear when the speech finishes. */
export interface SpeakHandle { onend: (() => void) | null }

// A profile voice of `custom:<id>` is a cloned voice served by the local
// voice engine (server/src/routes/voices.ts) rather than a browser voice.
export const CUSTOM_PREFIX = 'custom:';
export const customVoiceId = (voice: string | null | undefined): number | null =>
  voice?.startsWith(CUSTOM_PREFIX) ? Number(voice.slice(CUSTOM_PREFIX.length)) || null : null;

function pickVoice(opts: SpeakOpts): SpeechSynthesisVoice | undefined {
  const voices = getVoices();
  if (opts.voice) {
    const explicit = voices.find((v) => v.voiceURI === opts.voice || v.name === opts.voice);
    if (explicit) return explicit;
    // Stored voice no longer exists (different machine, removed pack); fall through
  }
  if (opts.lang) {
    const langVoices = voicesForLang(opts.lang);
    if (langVoices.length === 0) return undefined;
    // Prefer non-network voices (faster, more reliable on Windows)
    const local = langVoices.find((v) => v.localService);
    return local ?? langVoices[0];
  }
  return undefined;
}

// Bumped by cancel(). Both deferred paths in speak() check it before actually
// talking, so a cancel that lands *after* speak() was called but *before* the
// utterance starts still wins. Without this, muting the coach in that window
// was simply ignored and it carried on reading the line out.
let generation = 0;

export function speak(text: string, opts: SpeakOpts = {}): SpeakHandle | null {
  const customId = customVoiceId(opts.voice);
  if (customId !== null) return speakCustom(text, customId, opts);
  if (typeof speechSynthesis === 'undefined') return null;
  const clean = stripMarkdown(stripReasoning(text));
  if (!clean) return null;

  // Voices may not be ready yet on Windows; wait briefly then retry.
  if (getVoices().length === 0) {
    const queuedAt = generation;
    const off = onVoicesReady(() => {
      off();
      if (queuedAt !== generation) return; // cancelled while we waited
      speak(text, opts);
    });
    return null;
  }

  speechSynthesis.cancel();
  stopCustom();

  const u = new SpeechSynthesisUtterance(clean);
  const handle: SpeakHandle = { onend: null };
  u.onend = () => handle.onend?.();
  u.rate = opts.rate ?? 1;
  u.pitch = opts.pitch ?? 1;

  // ALWAYS set lang to a BCP-47 code so the OS can pick an appropriate voice
  // when our preferred one is absent. Without this, Chrome on Windows defaults
  // to en-US and reads Cyrillic text as gibberish.
  if (opts.lang) u.lang = bcp47For(opts.lang);

  const voice = pickVoice(opts);
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang; // make sure lang matches the picked voice
  }

  // Surface failures in the console so we can debug if TTS goes silent.
  u.onerror = (ev) => console.warn('[tts] error', ev.error, { text: clean.slice(0, 60), lang: u.lang, voice: u.voice?.name });

  // Chrome bug: cancel() then immediate speak() can be ignored. Defer one tick.
  const startedAt = generation;
  setTimeout(() => {
    if (startedAt !== generation) return; // cancelled inside the deferral
    speechSynthesis.speak(u);
  }, 0);
  return handle;
}

export function cancel() {
  generation++;
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  stopCustom();
}

// ---- Custom (cloned) voices ----

let customAudio: HTMLAudioElement | null = null;
let customAbort: AbortController | null = null;

function stopCustom() {
  customAbort?.abort();
  customAbort = null;
  if (customAudio) {
    customAudio.pause();
    URL.revokeObjectURL(customAudio.src);
    customAudio = null;
  }
}

/** Sentence-sized pieces: the engine is quickest on short text, and the first
 *  sentence can play while the rest are still being generated. */
export function chunkText(text: string, max = 280): string[] {
  const sentences = text.replace(/\s+/g, ' ').match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)/g) ?? [text];
  const chunks: string[] = [];
  let cur = '';
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (cur && (cur.length + s.length + 1 > max || cur.length >= 60)) { chunks.push(cur); cur = ''; }
    if (s.length > max) {
      // A run-on sentence: split at commas, then hard-wrap as a last resort.
      for (const part of s.match(new RegExp(`.{1,${max}}(?:[,;:]\\s|\\s|$)`, 'g')) ?? [s]) chunks.push(part.trim());
      continue;
    }
    cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) chunks.push(cur);
  return chunks.filter(Boolean);
}

async function fetchCustom(id: number, text: string, signal: AbortSignal): Promise<Blob> {
  const res = await fetch(`/api/voices/${id}/speak`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'patzer' },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok) throw new Error(`tts ${res.status}`);
  return res.blob();
}

function speakCustom(text: string, id: number, opts: SpeakOpts): SpeakHandle | null {
  const clean = stripMarkdown(stripReasoning(text));
  if (!clean) return null;
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  stopCustom();

  const handle: SpeakHandle = { onend: null };
  const myGen = ++generation;
  const abort = new AbortController();
  customAbort = abort;
  const chunks = chunkText(clean);

  void (async () => {
    try {
      // Generate one ahead: chunk i+1 is being made while chunk i plays.
      let next = fetchCustom(id, chunks[0]!, abort.signal);
      for (let i = 0; i < chunks.length; i++) {
        const blob = await next;
        if (i + 1 < chunks.length) next = fetchCustom(id, chunks[i + 1]!, abort.signal);
        if (myGen !== generation) return;
        const audio = new Audio(URL.createObjectURL(blob));
        audio.playbackRate = opts.rate ?? 1;
        audio.preservesPitch = true;
        customAudio = audio;
        await new Promise<void>((resolve, reject) => {
          audio.onended = () => resolve();
          audio.onerror = () => reject(new Error('playback failed'));
          audio.play().catch(reject);
        });
        URL.revokeObjectURL(audio.src);
        if (myGen !== generation) return;
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') console.warn('[tts] custom voice failed', err);
    }
    if (myGen === generation) {
      customAudio = null;
      handle.onend?.();
    }
  })();
  return handle;
}
