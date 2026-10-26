import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../auth/middleware.js';

// Custom TTS voices, cloned from a short clip by the local voice-tts engine
// (Chatterbox, running on the host GPU). Patzer keeps the list per user; the
// engine keeps the audio. A profile's tts_voice of `custom:<id>` picks one.

const router = new Hono();
router.use('*', requireAuth);

interface VoiceRow { id: number; name: string; duration: number | null; created_at: string }

const engineKey = (userId: number, voiceId: number) => `u${userId}-v${voiceId}`;

async function engine(path: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<Response> {
  return fetch(`${config.voiceTtsUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/** `ready`: model loaded. `up` but not ready: still loading weights. */
async function engineStatus(): Promise<{ up: boolean; ready: boolean; error: string | null }> {
  try {
    const r = await engine('/health', {}, 2000);
    const j = await r.json() as { ready: boolean; error: string | null };
    return { up: true, ready: j.ready, error: j.error };
  } catch {
    return { up: false, ready: false, error: null };
  }
}

function ownVoice(userId: number, id: number): VoiceRow | undefined {
  return db.prepare('SELECT id, name, duration, created_at FROM custom_voices WHERE id = ? AND user_id = ?')
    .get(id, userId) as VoiceRow | undefined;
}

router.get('/', async (c) => {
  const user = c.get('user');
  const voices = db.prepare('SELECT id, name, duration, created_at FROM custom_voices WHERE user_id = ? ORDER BY id')
    .all(user.id) as VoiceRow[];
  return c.json({ engine: await engineStatus(), voices });
});

const MAX_UPLOAD = 15 * 1024 * 1024;

router.post('/', async (c) => {
  const user = c.get('user');
  const form = await c.req.formData().catch(() => null);
  const name = String(form?.get('name') ?? '').trim().slice(0, 60);
  const file = form?.get('audio');
  if (!name || !(file instanceof File)) return c.json({ error: 'invalid_input' }, 400);
  if (file.size > MAX_UPLOAD) return c.json({ error: 'too_large' }, 413);

  const id = Number(db.prepare('INSERT INTO custom_voices (user_id, name) VALUES (?, ?)').run(user.id, name).lastInsertRowid);
  let res: Response;
  try {
    res = await engine(`/voices/${engineKey(user.id, id)}`, { method: 'PUT', body: await file.arrayBuffer() });
  } catch {
    db.prepare('DELETE FROM custom_voices WHERE id = ?').run(id);
    return c.json({ error: 'engine_unavailable' }, 502);
  }
  if (!res.ok) {
    db.prepare('DELETE FROM custom_voices WHERE id = ?').run(id);
    const detail = (await res.json().catch(() => null) as { detail?: string } | null)?.detail;
    return c.json({ error: detail ?? 'engine_error' }, 400);
  }
  const { duration } = await res.json() as { duration: number };
  db.prepare('UPDATE custom_voices SET duration = ? WHERE id = ?').run(duration, id);
  return c.json({ voice: ownVoice(user.id, id) });
});

router.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  if (!ownVoice(user.id, id)) return c.json({ error: 'not_found' }, 404);
  db.prepare('DELETE FROM custom_voices WHERE id = ?').run(id);
  // Anyone still pointing at it falls back to the browser voice.
  db.prepare('UPDATE profiles SET tts_voice = NULL WHERE user_id = ? AND tts_voice = ?').run(user.id, `custom:${id}`);
  await engine(`/voices/${engineKey(user.id, id)}`, { method: 'DELETE' }, 5000).catch(() => { /* orphaned file is harmless */ });
  return c.json({ ok: true });
});

const speakSchema = z.object({
  text: z.string().trim().min(1).max(800),
  exaggeration: z.number().min(0.25).max(2).optional(),
});

router.post('/:id/speak', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  if (!ownVoice(user.id, id)) return c.json({ error: 'not_found' }, 404);
  const parsed = speakSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);

  let res: Response;
  try {
    res = await engine('/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice: engineKey(user.id, id), ...parsed.data }),
    });
  } catch {
    return c.json({ error: 'engine_unavailable' }, 502);
  }
  if (!res.ok) return c.json({ error: res.status === 503 ? 'engine_loading' : 'engine_error' }, 502);
  return new Response(res.body, { headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' } });
});

export default router;
