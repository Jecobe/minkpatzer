// Engine check: how engine-like each side's play was in one game.
//
// The signals are the classic ones — how often a player's move was the
// engine's top choice (T1 match), how much they lost per move on average
// (ACPL), how often they were within a hair of best, and, when the PGN has
// clocks, how evenly they spent their time. Each is compared against what a
// human of that rating typically does, and the gaps are folded into one
// 0–100 score.
//
// One game is a small sample. Strong players, short games, a forcing line
// or a well-prepared opening all look engine-like; the score is a pointer
// for a closer look, never proof, and the page says so.

import { Chess } from 'chess.js';
import type { AnalysisResult, AnalyzedMove } from '../types.js';

// ── Game input ──────────────────────────────────────────────────────────────

const UA = 'patzer/3.1 (+https://github.com/Jecobe/minkpatzer)';

export type GameSource = 'chesscom' | 'lichess' | 'pgn';

export class InputError extends Error {}

async function getText(url: string, accept = 'application/json'): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) throw new InputError('Game not found.');
  if (!res.ok) throw new InputError(`The site answered ${res.status}; try again or paste the PGN.`);
  return res.text();
}

/** A chess.com game's PGN: the game page's callback names the players and
 *  date, and the official monthly archive has the full PGN with clocks. */
async function chesscomPgn(kind: 'live' | 'daily', id: string): Promise<string> {
  const cb = JSON.parse(await getText(`https://www.chess.com/callback/${kind}/game/${id}`)) as
    { game?: { pgnHeaders?: Record<string, string | undefined> } };
  const h = cb.game?.pgnHeaders;
  if (!h?.White || !h.Date) throw new InputError('Chess.com did not return that game.');
  const [y, m] = h.Date.split('.').map(Number);
  if (!y || !m) throw new InputError('Chess.com returned a game without a date.');
  // A daily game can finish months after it started; look a few months on.
  for (const name of [h.White, h.Black].filter(Boolean) as string[]) {
    for (let k = 0; k < (kind === 'daily' ? 4 : 2); k++) {
      const d = new Date(Date.UTC(y, m - 1 + k, 1));
      const ym = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      let games: { url: string; pgn?: string }[] = [];
      try {
        games = (JSON.parse(await getText(`https://api.chess.com/pub/player/${encodeURIComponent(name.toLowerCase())}/games/${ym}`)) as { games?: typeof games }).games ?? [];
      } catch { continue; }
      const g = games.find((x) => x.url.endsWith(`/${id}`));
      if (g?.pgn) return g.pgn;
    }
  }
  throw new InputError('Could not find that game in the players\' Chess.com archives (it may still be in progress).');
}

/** Turn a pasted link or PGN into a PGN. */
export async function resolveGame(input: string): Promise<{ pgn: string; source: GameSource }> {
  const s = input.trim();
  const cc = s.match(/chess\.com\/(?:analysis\/)?(?:game\/)?(live|daily)(?:\/game)?\/(\d{5,})/i);
  if (cc) return { pgn: await chesscomPgn(cc[1]!.toLowerCase() as 'live' | 'daily', cc[2]!), source: 'chesscom' };
  const li = s.match(/lichess\.org\/([A-Za-z0-9]{8})(?:[A-Za-z0-9]{4})?\b/);
  if (li) {
    const pgn = await getText(`https://lichess.org/game/export/${li[1]}?clocks=true&evals=false&literate=false`, 'application/x-chess-pgn');
    return { pgn, source: 'lichess' };
  }
  if (/^https?:\/\//i.test(s)) throw new InputError('Paste a Chess.com or Lichess game link, or the game\'s PGN.');
  return { pgn: s, source: 'pgn' };
}

export interface ParsedGame {
  pgn: string;
  headers: Record<string, string>;
  plies: number;
  /** Seconds each ply took, when the PGN carries %clk; null otherwise. */
  moveTimes: (number | null)[] | null;
}

export function parseGame(pgn: string): ParsedGame {
  const chess = new Chess();
  try { chess.loadPgn(pgn, { strict: false }); } catch {
    throw new InputError('That isn\'t a readable PGN. Paste the full game (moves, not just a position).');
  }
  const plies = chess.history().length;
  if (plies < 2) throw new InputError('That game has no moves to check.');
  const headers = chess.getHeaders() as Record<string, string>;
  return { pgn, headers, plies, moveTimes: moveTimes(pgn, plies, headers.TimeControl) };
}

function clkSeconds(c: string): number {
  const [h, m, sec] = c.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(sec);
}

/** Time spent per ply from the %clk comments (clock after the move). */
export function moveTimes(pgn: string, plies: number, timeControl?: string): (number | null)[] | null {
  const clocks = [...pgn.matchAll(/\[%clk\s+(\d+:\d{1,2}:\d{1,2}(?:\.\d+)?)\]/g)].map((m) => clkSeconds(m[1]!));
  if (clocks.length !== plies) return null;
  const tc = timeControl?.match(/^(\d+)(?:\+(\d+(?:\.\d+)?))?$/);
  if (!tc) return null; // daily games ("1/259200") have no clock to read
  const base = Number(tc[1]);
  const inc = Number(tc[2] ?? 0);
  return clocks.map((c, i) => {
    const prev = i >= 2 ? clocks[i - 2]! : base;
    const spent = prev - c + inc;
    return spent >= 0 ? Math.round(spent * 10) / 10 : null;
  });
}

// ── Scoring ─────────────────────────────────────────────────────────────────

/** Rough human baselines at depth ~16 on non-trivial moves, by rating. Not a
 *  fitted model: interpolated from published engine-match studies, wide on
 *  purpose so ordinary good games don't score high. */
const BASELINE: { rating: number; t1: number; acpl: number }[] = [
  { rating: 600, t1: 0.30, acpl: 115 },
  { rating: 1000, t1: 0.36, acpl: 80 },
  { rating: 1500, t1: 0.43, acpl: 55 },
  { rating: 2000, t1: 0.50, acpl: 38 },
  { rating: 2500, t1: 0.58, acpl: 24 },
  { rating: 2900, t1: 0.64, acpl: 16 },
];

function baselineFor(rating: number): { t1: number; acpl: number } {
  const b = BASELINE;
  if (rating <= b[0]!.rating) return b[0]!;
  for (let i = 1; i < b.length; i++) {
    const hi = b[i]!, lo = b[i - 1]!;
    if (rating <= hi.rating) {
      const f = (rating - lo.rating) / (hi.rating - lo.rating);
      return { t1: lo.t1 + f * (hi.t1 - lo.t1), acpl: lo.acpl + f * (hi.acpl - lo.acpl) };
    }
  }
  return b[b.length - 1]!;
}

export type Verdict = 'insufficient' | 'human' | 'some' | 'strong' | 'very_strong';

export interface SideReport {
  color: 'white' | 'black';
  name: string;
  rating: number | null;
  /** 0–100; null when there were too few moves to say anything. */
  score: number | null;
  verdict: Verdict;
  considered: number;
  skipped: { book: number; forced: number; decided: number };
  t1_match: number | null;
  near_best: number | null;
  acpl: number | null;
  accuracy: number;
  errors: number;
  only_moves_found: number;
  longest_top_streak: number;
  expected: { rating_used: number; t1: number; acpl: number; rating_known: boolean };
  time: { avg_seconds: number; cv: number | null } | null;
  signals: string[];
}

export interface FairplayReport {
  white: SideReport;
  black: SideReport;
  headers: { White?: string; Black?: string; WhiteElo?: string; BlackElo?: string; Date?: string; Result?: string; TimeControl?: string; Event?: string; Site?: string; Link?: string };
  source: GameSource;
  depth: number;
  plies: number;
  has_clocks: boolean;
}

const MIN_MOVES = 10;
const DECIDED_CP = 500;
const ERRORS = new Set(['inaccuracy', 'mistake', 'blunder', 'miss']);

function moverCp(m: AnalyzedMove): number | null {
  if (m.mate_before != null) return null;
  if (m.eval_before_cp == null) return null;
  return m.ply % 2 === 1 ? m.eval_before_cp : -m.eval_before_cp;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const pct = (x: number) => Math.round(x * 1000) / 10;

export function scoreSide(
  color: 'white' | 'black',
  analysis: AnalysisResult,
  game: ParsedGame,
): SideReport {
  const h = game.headers;
  const name = (color === 'white' ? h.White : h.Black) || (color === 'white' ? 'White' : 'Black');
  const eloRaw = Number(color === 'white' ? h.WhiteElo : h.BlackElo);
  const rating = Number.isFinite(eloRaw) && eloRaw > 0 ? eloRaw : null;
  const ratingUsed = rating ?? 1500;
  const base = baselineFor(ratingUsed);

  const mine = analysis.moves.filter((m) => (m.ply % 2 === 1) === (color === 'white'));
  const skipped = { book: 0, forced: 0, decided: 0 };
  const considered: AnalyzedMove[] = [];
  for (const m of mine) {
    if (m.classification === 'book') { skipped.book++; continue; }
    if (m.classification === 'forced') { skipped.forced++; continue; }
    const cp = moverCp(m);
    if (cp == null || Math.abs(cp) > DECIDED_CP) { skipped.decided++; continue; }
    considered.push(m);
  }

  const n = considered.length;
  const accuracy = color === 'white' ? analysis.accuracy_white : analysis.accuracy_black;
  const isTop = (m: AnalyzedMove) => !!m.best_move_uci && m.uci === m.best_move_uci;
  let streak = 0, longest = 0;
  for (const m of mine) {
    if (m.classification === 'book' || m.classification === 'forced') continue;
    streak = isTop(m) ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }

  // Time use on the moves that count.
  let time: SideReport['time'] = null;
  if (game.moveTimes) {
    const ts = considered.map((m) => game.moveTimes![m.ply - 1]).filter((t): t is number => t != null);
    if (ts.length >= 5) {
      const avg = ts.reduce((a, b) => a + b, 0) / ts.length;
      const sd = Math.sqrt(ts.reduce((a, b) => a + (b - avg) ** 2, 0) / ts.length);
      time = { avg_seconds: Math.round(avg * 10) / 10, cv: avg > 0.3 ? Math.round((sd / avg) * 100) / 100 : null };
    }
  }

  const report: SideReport = {
    color, name, rating, score: null, verdict: 'insufficient', considered: n, skipped,
    t1_match: null, near_best: null, acpl: null, accuracy: Math.round(accuracy * 10) / 10,
    errors: considered.filter((m) => ERRORS.has(m.classification)).length,
    only_moves_found: considered.filter((m) => m.classification === 'great' || m.classification === 'brilliant').length,
    longest_top_streak: longest,
    expected: { rating_used: Math.round(ratingUsed), t1: pct(base.t1), acpl: Math.round(base.acpl), rating_known: rating != null },
    time, signals: [],
  };
  if (n < MIN_MOVES) {
    report.signals.push(`Only ${n} moves outside book, forced replies and decided positions — too few to judge.`);
    return report;
  }

  const t1 = considered.filter(isTop).length / n;
  const near = considered.filter((m) => m.centipawn_loss <= 15).length / n;
  const acpl = considered.reduce((a, m) => a + Math.min(m.centipawn_loss, 500), 0) / n;
  report.t1_match = pct(t1);
  report.near_best = pct(near);
  report.acpl = Math.round(acpl * 10) / 10;

  // How far above the human baseline. The spread is the per-game sampling
  // error plus the game-to-game swing every player has.
  const sdT1 = Math.sqrt(base.t1 * (1 - base.t1) / n + 0.07 ** 2);
  const zT1 = (t1 - base.t1) / sdT1;
  // ACPL is skewed; compare on a log scale (an ACPL of 5 vs 40 is a big gap).
  const zAcpl = (Math.log(base.acpl + 5) - Math.log(acpl + 5)) / Math.sqrt(0.45 ** 2 + 1.2 / n);
  // Near-zero loss over many moves is the stronger tell: top-move match
  // depends on depth and on ties between equal moves, loss doesn't.
  let z = 0.45 * zT1 + 0.55 * zAcpl;
  // Error-free play over many moves is a signal of its own.
  if (report.errors === 0 && n >= 20) z += 0.3;
  // Very even time per move with high accuracy is typical of relaying moves.
  if (time?.cv != null && time.cv < 0.45 && t1 > base.t1) z += 0.4;
  // Shrink toward "nothing to see" on short samples.
  z *= n / (n + 4);

  const score = Math.round(100 * sigmoid(1.7 * (z - 1.8)));
  report.score = score;
  report.verdict = score < 25 ? 'human' : score < 60 ? 'some' : score < 85 ? 'strong' : 'very_strong';

  // Plain-language reasons.
  const s = report.signals;
  s.push(`Matched the engine's top move on ${pct(t1)}% of ${n} non-trivial moves; a typical ${Math.round(ratingUsed)} plays about ${pct(base.t1)}%.`);
  s.push(`Average loss ${report.acpl} centipawns per move; typical at that rating is about ${Math.round(base.acpl)}.`);
  if (report.errors === 0) s.push('No inaccuracies, mistakes or blunders in the moves checked.');
  else s.push(`${report.errors} inaccurac${report.errors === 1 ? 'y' : 'ies'} or worse in the moves checked.`);
  if (report.only_moves_found > 0) s.push(`Found ${report.only_moves_found} "only move"${report.only_moves_found === 1 ? '' : 's'} (the single move that held).`);
  if (longest >= 8) s.push(`Played ${longest} engine-top moves in a row at one point.`);
  if (time?.cv != null) {
    s.push(time.cv < 0.45
      ? `Spent very even time per move (variation ${time.cv}); humans usually speed up on easy moves and slow down on hard ones.`
      : `Time per move varied normally (variation ${time.cv}).`);
  }
  if (rating == null) s.push('No rating in the game, so it was compared with a 1500 player.');
  return report;
}

export function fairplayReport(analysis: AnalysisResult, game: ParsedGame, source: GameSource, depth: number): FairplayReport {
  const h = game.headers;
  return {
    white: scoreSide('white', analysis, game),
    black: scoreSide('black', analysis, game),
    headers: {
      White: h.White, Black: h.Black, WhiteElo: h.WhiteElo, BlackElo: h.BlackElo, Date: h.Date,
      Result: h.Result, TimeControl: h.TimeControl, Event: h.Event, Site: h.Site, Link: h.Link,
    },
    source, depth, plies: game.plies, has_clocks: !!game.moveTimes,
  };
}
