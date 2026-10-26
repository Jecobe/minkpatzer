import { Hono } from 'hono';
import { z } from 'zod';
import { streamSSE } from 'hono/streaming';
import { requireAuth } from '../auth/middleware.js';
import { analyzePgnFull } from './analyze.js';
import { InputError, fairplayReport, parseGame, resolveGame } from '../chess/fairplay.js';

// Engine check for any game: a Chess.com / Lichess link or a pasted PGN.
// Nothing is saved — the game is analysed, scored and sent back.

const router = new Hono();
router.use('*', requireAuth);

const schema = z.object({
  input: z.string().trim().min(1).max(200_000),
  depth: z.number().int().min(12).max(20).default(16),
});

// One check per user at a time: each one is a full Stockfish run.
const inflight = new Set<number>();

router.post('/check', async (c) => {
  const user = c.get('user');
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  if (inflight.has(user.id)) return c.json({ error: 'busy', message: 'A check is already running.' }, 429);
  inflight.add(user.id);

  return streamSSE(c, async (stream) => {
    try {
      await stream.writeSSE({ event: 'progress', data: JSON.stringify({ stage: 'fetching' }) });
      const { pgn, source } = await resolveGame(parsed.data.input);
      const game = parseGame(pgn);
      await stream.writeSSE({ event: 'progress', data: JSON.stringify({ stage: 'analysing', done: 0, total: game.plies }) });
      let last = 0;
      const analysis = await analyzePgnFull(pgn, parsed.data.depth, { score: null, userColor: 'white', opponentRating: null, opponentRd: null },
        async (done, total) => {
          if (done - last < 2 && done !== total) return;
          last = done;
          await stream.writeSSE({ event: 'progress', data: JSON.stringify({ stage: 'analysing', done, total }) }).catch(() => {});
        });
      const report = fairplayReport(analysis, game, source, parsed.data.depth);
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ report, pgn }) });
    } catch (err) {
      const message = err instanceof InputError ? err.message : 'The check failed. Try again, or paste the PGN instead.';
      if (!(err instanceof InputError)) console.error('[fairplay]', err);
      await stream.writeSSE({ event: 'error', data: message });
    } finally {
      inflight.delete(user.id);
    }
  });
});

export default router;
