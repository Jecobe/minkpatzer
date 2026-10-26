import { chatStream, type ChatMessage } from './llm.js';
import { systemPrompt } from './locales.js';
import { summaryFacts } from './review.js';
import { explainCoaching } from './coaching.js';
import type { AnalysisResult, AnalyzedMove, Audience, Language } from '../types.js';

// Free-form chat about one analysed game. The other coach jobs take a fixed
// FACTS object and give one answer; here the player asks whatever they like
// ("where did I lose this?", "why not take on e5?") and follows up.
//
// The model still gets everything from the engine: the whole move list with
// each move's verdict, the best move and the eval after it, the game summary
// facts the written review is built from, and — when the player is looking at
// one move — that move's deterministic coaching facts. It's told to answer
// from those and to say so when the question goes beyond them.

export interface ChatTurn { role: 'user' | 'assistant'; content: string }

export interface GameChatArgs {
  pgn: string;
  analysis: AnalysisResult;
  userColor: 'white' | 'black';
  userId: number;
  language: Language;
  audience: Audience;
  /** The move the player has selected, if any (1 = White's first move). */
  ply: number | null;
  /** The written review's summary, when one was generated. */
  reviewSummary?: string | null;
  messages: ChatTurn[];
  onChunk: (t: string) => void | Promise<void>;
  signal?: AbortSignal;
}

const LANG_NAME: Record<Language, string> = { en: 'English', bg: 'Bulgarian', es: 'Spanish', de: 'German', ru: 'Russian' };

const sideOf = (ply: number): 'white' | 'black' => (ply % 2 === 1 ? 'white' : 'black');
const moveNo = (m: Pick<AnalyzedMove, 'ply' | 'san'>) =>
  `${Math.ceil(m.ply / 2)}${m.ply % 2 === 1 ? '.' : '...'} ${m.san}`;

/** White-perspective eval as the analysis board shows it: +1.3, -0.4, M3, -M2. */
function evalStr(cp: number | null, mate: number | null): string {
  if (mate != null) return mate >= 0 ? `M${mate}` : `-M${-mate}`;
  if (cp == null) return '?';
  const p = cp / 100;
  return `${p >= 0 ? '+' : ''}${p.toFixed(1)}`;
}

/** One line per move — compact enough that a 60-move game fits a small context. */
export function moveTable(analysis: AnalysisResult, userColor: 'white' | 'black'): string {
  return analysis.moves.map((m) => {
    const who = sideOf(m.ply) === userColor ? 'you' : 'opp';
    const parts = [`${moveNo(m)} (${who}) ${m.classification}`];
    if (m.centipawn_loss > 0) parts.push(`loss ${m.centipawn_loss}cp`);
    if (m.best_move_san && m.best_move_san !== m.san) parts.push(`best ${m.best_move_san}`);
    parts.push(`eval ${evalStr(m.eval_after_cp, m.mate_after)}`);
    return parts.join(' | ');
  }).join('\n');
}

async function focusFacts(args: GameChatArgs): Promise<Record<string, unknown> | null> {
  const m = args.ply != null ? args.analysis.moves.find((x) => x.ply === args.ply) : undefined;
  if (!m) return null;
  const base: Record<string, unknown> = {
    move: moveNo(m),
    played_by: sideOf(m.ply) === args.userColor ? 'the player (you)' : 'the opponent',
    fen_before: m.fen_before,
    classification: m.classification,
    centipawn_loss: m.centipawn_loss,
    eval_before: evalStr(m.eval_before_cp, m.mate_before),
    eval_after: evalStr(m.eval_after_cp, m.mate_after),
    best_move: m.best_move_san,
    engine_line_after_best: m.best_pv.slice(0, 8),
    game_continued: args.analysis.moves.filter((x) => x.ply > m.ply).slice(0, 6).map((x) => x.san),
  };
  // The coach's deterministic facts (what the move allowed, what the better
  // move does) are the best grounding there is, but they cost an engine run;
  // a chat answer without them still beats no answer.
  try {
    const coaching = await explainCoaching({
      fen: m.fen_before,
      played_san: m.san,
      best_san: m.best_move_san,
      classification: m.classification,
      userId: args.userId,
      ownMove: sideOf(m.ply) === args.userColor,
    }, args.language, args.audience);
    if (sideOf(m.ply) === args.userColor) base.coach_facts = coaching.facts;
    else {
      // Written from the mover's side: here "the opponent" is the player.
      const { opponent_reply, takeaway: _t, player_history: _h, ...rest } = coaching.facts;
      base.coach_facts = { ...rest, your_best_answer: opponent_reply ?? null, note: 'This was the opponent\'s move. In "why", "the opponent" means you, the player.' };
    }
  } catch (err) {
    console.warn('[coach-chat] coaching facts failed:', err instanceof Error ? err.message : err);
  }
  return base;
}

function chatRules(language: Language): string {
  return `=== CHAT MODE ===
This is a conversation about one finished game the player has had analysed by Stockfish. The rules above were written for one-shot move explanations; in this chat these replace R2, R6 and R7:
- You MAY name moves from the game in notation with their move number (e.g. "14...Nd4") so the player can find them in the move list. Outside of that, prefer plain words.
- Answer the question that was asked, at the length it needs: one or two short paragraphs usually, a short list when the player asks for several things. Plain text; **bold** is fine.
- Everything you say about the game must come from GAME DATA below: the move table (each move's verdict, centipawn loss, the engine's best move, the eval after it from White's side), the summary facts, and the FOCUS MOVE when present. Never invent moves, variations, threats or evaluations that aren't there.
- If the player asks something the data can't answer (a long hypothetical line, a position not in the game), say plainly that you can only speak to what the engine analysed, and point them to the analysis board to try it.
- "This move", "here", "this position" mean the FOCUS MOVE when one is given.
- The player is "you"; the other side is "your opponent". Moves marked (opp) were the opponent's.
- Reply in ${LANG_NAME[language]}.`;
}

export async function gameChat(args: GameChatArgs): Promise<void> {
  const { facts } = summaryFacts(args.analysis, args.pgn, args.userColor, args.language, args.audience);
  const focus = await focusFacts(args);

  const data = [
    `=== GAME DATA ===`,
    `The player had the ${args.userColor} pieces.`,
    `SUMMARY FACTS: ${JSON.stringify(facts)}`,
    args.reviewSummary ? `WRITTEN REVIEW SUMMARY: ${args.reviewSummary}` : '',
    `MOVE TABLE (move | who | verdict | loss | engine best | eval after, White's view):\n${moveTable(args.analysis, args.userColor)}`,
    focus ? `FOCUS MOVE (the move the player is looking at now): ${JSON.stringify(focus)}` : `No move is selected; the player is asking about the game as a whole.`,
  ].filter(Boolean).join('\n\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: `${systemPrompt(args.audience, args.language)}\n\n${chatRules(args.language)}\n\n${data}` },
    // Keep the recent conversation only; the game data above carries the rest.
    ...args.messages.slice(-12),
  ];

  let inThink = false;
  // Chunks are written in order: each write waits for the one before it.
  let pending: Promise<void> = Promise.resolve();
  await chatStream(messages, (t) => {
    // Reasoning models may still wrap thoughts in <think>…</think>; don't show them.
    let out = '';
    let s = t;
    while (s) {
      if (inThink) {
        const end = s.indexOf('</think>');
        if (end < 0) { s = ''; break; }
        inThink = false; s = s.slice(end + 8);
      } else {
        const start = s.indexOf('<think>');
        if (start < 0) { out += s; s = ''; break; }
        out += s.slice(0, start); inThink = true; s = s.slice(start + 7);
      }
    }
    if (out) pending = pending.then(() => args.onChunk(out));
  }, { temperature: 0.3, numPredict: 700, numCtx: 8192, signal: args.signal, hardTimeoutMs: 180_000 });
  await pending;
}
