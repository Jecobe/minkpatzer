import { Chess } from 'chess.js';
import type { ChatMessage } from './llm.js';
import { systemPrompt } from './locales.js';
import { explainCoaching, moveReasons } from './coaching.js';
import { moveMotifs } from './tactics.js';
import { sanToNatural } from './moves.js';
import { boardPiecesNatural } from './facts-utils.js';
import { LANG_NAME, streamAnswer, type ChatTurn } from './chat.js';
import type { Audience, Classification, Language } from '../types.js';

// Chat about a Lab position: "why does the engine want this move?", "why
// not that one?". The Lab's engine run is the ground truth — the candidate
// moves, their evals and lines — and for the move being asked about the
// coach works out what it does and what the opponent's best answer is
// (coaching.ts), so the model connects facts instead of inventing them.

export interface LabLine {
  san: string;
  pv_san: string[];
  /** Centipawns from the side to move's point of view, as the Lab shows them. */
  cp: number | null;
  mate: number | null;
}

export interface PositionChatArgs {
  fen: string;
  lines: LabLine[];
  /** Index into `lines` of the move being asked about; null = the position. */
  focus: number | null;
  /** Moves played on the Lab board to reach this position, if any. */
  history: string[];
  userId: number;
  language: Language;
  audience: Audience;
  messages: ChatTurn[];
  onChunk: (t: string) => void | Promise<void>;
  signal?: AbortSignal;
}

const score = (l: LabLine) => (l.mate != null ? (l.mate > 0 ? 100000 - l.mate : -100000 - l.mate) : (l.cp ?? 0));

function evalText(l: LabLine): string {
  if (l.mate != null) return l.mate > 0 ? `mate in ${l.mate}` : `gets mated in ${-l.mate}`;
  if (l.cp == null) return '?';
  const p = l.cp / 100;
  return `${p >= 0 ? '+' : ''}${p.toFixed(2)}`;
}

/** How far a candidate falls short of the engine's first choice, as a verdict. */
function classify(gap: number): Classification {
  if (gap <= 0) return 'best';
  if (gap <= 20) return 'excellent';
  if (gap <= 50) return 'good';
  if (gap <= 100) return 'inaccuracy';
  if (gap <= 250) return 'mistake';
  return 'blunder';
}

/** SAN with move numbers from `fen`, e.g. "12. Nf3 Nc6 13. Bb5". */
function numbered(fen: string, sans: string[]): string {
  const parts = fen.split(' ');
  let n = Number(parts[5]) || 1;
  let white = parts[1] === 'w';
  const out: string[] = [];
  sans.forEach((s, i) => {
    if (white) out.push(`${n}. ${s}`);
    else { out.push(i === 0 ? `${n}... ${s}` : s); n++; }
    white = !white;
  });
  return out.join(' ');
}

function inWords(fen: string, sans: string[], max: number, lang: Language, aud: Audience): string[] {
  const out: string[] = [];
  const c = new Chess(fen);
  for (const s of sans.slice(0, max)) {
    const before = c.fen();
    try { c.move(s); } catch { break; }
    out.push(sanToNatural(s, before, lang, aud));
  }
  return out;
}

export async function positionFacts(args: Omit<PositionChatArgs, 'messages' | 'onChunk' | 'signal'>) {
  const { fen, lines, language: lang, audience: aud } = args;
  const toMove = fen.split(' ')[1] === 'w' ? 'White' : 'Black';
  const top = lines[0] ? score(lines[0]) : 0;
  const board = boardPiecesNatural(fen, 'white', lang, aud);

  const candidates = lines.map((l, i) => {
    const m = moveMotifs(fen, l.san);
    return {
      rank: i + 1,
      move: l.san,
      in_words: sanToNatural(l.san, fen, lang, aud),
      eval_for_side_to_move: evalText(l),
      behind_best_cp: i === 0 ? 0 : Math.max(0, top - score(l)),
      what_the_move_does: m ? moveReasons(m, lang, aud) : [],
      engine_line: numbered(fen, l.pv_san),
      engine_line_in_words: inWords(fen, l.pv_san, 4, lang, aud),
    };
  });

  let focus: Record<string, unknown> | null = null;
  const f = args.focus != null ? lines[args.focus] : undefined;
  if (f) {
    const gap = args.focus === 0 ? 0 : Math.max(0, top - score(f));
    focus = { move: f.san, rank: args.focus! + 1, of: lines.length };
    // What the move does, what it allows, the best answer and the better
    // move — the same facts a game explanation gets. They cost an engine
    // run; the candidate list above still answers without them.
    try {
      const coaching = await explainCoaching({
        fen,
        played_san: f.san,
        best_san: lines[0]?.san ?? null,
        classification: classify(gap),
        userId: args.userId,
        ownMove: false,
      }, lang, aud);
      // No verdict or tone: nobody has played the move, it's a candidate.
      const { takeaway: _t, player_history: _h, verdict: _v, tone: _o, ...facts } = coaching.facts;
      focus.coach_facts = facts;
    } catch (err) {
      console.warn('[lab-chat] coaching facts failed:', err instanceof Error ? err.message : err);
    }
  }

  return {
    side_to_move: toMove,
    fen,
    moves_played_on_board: args.history.length ? args.history.join(' ') : null,
    white_pieces: board.player,
    black_pieces: board.opponent,
    engine_candidates: candidates,
    focus_move: focus,
  };
}

function rules(language: Language, toMove: string): string {
  return `=== LAB CHAT ===
The player set up a position on the analysis board (the Lab) and ran Stockfish on it. They want to understand the engine's choices. The rules above were written for one-shot move explanations; in this chat these replace R2, R6 and R7:
- Nothing has been played yet: the candidates are moves ${toMove} COULD play. Never say "you played", "you made" or "your move was"; say "the engine's top choice", "Nf6 would…", "after Bc5…". Don't praise or grade a candidate beyond how far it is behind the best one.
- It is ${toMove} to move. The candidates are the engine's top moves for ${toMove}, best first; evals are from ${toMove}'s side (+ is good for ${toMove}).
- You MAY write moves in notation (e.g. "Nf3", "14...Qxd4") so the player can match them to the engine lines; explain them in plain words too.
- To say WHY the engine picks a move: what it does (what_the_move_does), what the engine line shows happening next, and how it compares with the other candidates (behind_best_cp, their lines). When FOCUS MOVE has coach_facts, use why, opponent_reply and better_move from there.
- Everything must come from POSITION DATA below. Never invent moves, lines, threats or evaluations. If a question needs a move that isn't among the candidates or their lines, say the engine didn't show it in its top lines and suggest playing it on the board and pressing Analyze again.
- Name a tactic (pin, fork, discovered attack, skewer…) only if the data names it; otherwise use the data's own words ("attacks a loose pawn on e4").
- "This move" means the FOCUS MOVE when one is given.
- Answer the question asked, at the length it needs: usually one or two short paragraphs. Plain text; **bold** is fine.
- Reply in ${LANG_NAME[language]}.`;
}

export async function positionChat(args: PositionChatArgs): Promise<void> {
  const facts = await positionFacts(args);
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `${systemPrompt(args.audience, args.language)}\n\n${rules(args.language, facts.side_to_move)}\n\n=== POSITION DATA ===\n${JSON.stringify(facts, null, 1)}`,
    },
    ...args.messages.slice(-12),
  ];
  await streamAnswer(messages, args.onChunk, args.signal);
}
