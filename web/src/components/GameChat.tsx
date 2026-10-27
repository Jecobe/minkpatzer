// Chat with the coach about one analysed game — the whole game, or the move
// in focus. Used under the move explanation (follow-up questions about that
// move, seeded with the coach's explanation) and in Game Review's "Ask coach"
// tab (questions about the whole game). Streams from POST /api/games/:id/chat,
// or from another chat endpoint (the Lab's position chat) given `endpoint`.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, Square, RotateCcw } from 'lucide-react';
import { renderMarkdown, stripReasoning } from '../lib/markdown';
import { parseSseBlock } from './CoachPanel';
import { ThinkingDots } from './Spinner';

export interface ChatMsg { role: 'user' | 'assistant'; content: string }

interface Props {
  gameId?: number;
  /** The move the questions are about (1 = White's first move); null = the whole game. */
  ply?: number | null;
  /** Another chat endpoint, and what to send it besides the messages. */
  endpoint?: string;
  body?: Record<string, unknown>;
  /** Asks this question as soon as `n` changes (a "Why?" button elsewhere). */
  ask?: { text: string; n: number } | null;
  /** An answer the conversation picks up from (the coach's move explanation). */
  seed?: string;
  /** Clears the conversation when it changes (e.g. a different move). */
  resetKey?: string | number;
  /** Starter questions shown while the conversation is empty. */
  suggestions?: string[];
  placeholder?: string;
  /** Hide the message list until the first question (the seed is shown elsewhere). */
  inline?: boolean;
}

export default function GameChat({ gameId, ply = null, endpoint, body, ask, seed, resetKey, suggestions = [], placeholder, inline }: Props) {
  const { t } = useTranslation();
  const [messages, setMessagesState] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // The conversation as of now, for a question sent before React re-renders
  // (one asked from outside while an answer is being cut off).
  const messagesRef = useRef<ChatMsg[]>([]);
  const setMessages = (next: ChatMsg[] | ((ms: ChatMsg[]) => ChatMsg[])) => {
    messagesRef.current = typeof next === 'function' ? next(messagesRef.current) : next;
    setMessagesState(messagesRef.current);
  };
  // Which request owns the conversation; a superseded one leaves it alone.
  const reqRef = useRef(0);

  useEffect(() => {
    reqRef.current++;
    abortRef.current?.abort();
    setMessages([]); setInput(''); setError(null); setBusy(false);
  }, [resetKey, gameId]);
  useEffect(() => () => { abortRef.current?.abort(); }, []);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function send(text: string, force = false) {
    const q = text.trim();
    if (!q || (busy && !force)) return;
    // A forced question cuts off the answer in progress, keeping what it said.
    abortRef.current?.abort();
    const me = ++reqRef.current;
    const mine = () => reqRef.current === me;
    const ac = new AbortController(); abortRef.current = ac;
    const prior = messagesRef.current.filter((m) => m.content.trim());
    // The seed explanation goes first so "why?" and "what about instead…"
    // follow on from it.
    const history: ChatMsg[] = [...prior, { role: 'user', content: q }];
    const sent: ChatMsg[] = seed ? [{ role: 'assistant', content: seed }, ...history] : history;
    setMessages([...history, { role: 'assistant', content: '' }]);
    setInput(''); setBusy(true); setError(null);

    let acc = '';
    const update = (s: string) => setMessages((ms) => {
      const next = ms.slice();
      next[next.length - 1] = { role: 'assistant', content: s };
      return next;
    });
    try {
      const res = await fetch(endpoint ?? `/api/games/${gameId}/chat`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'patzer' },
        body: JSON.stringify(endpoint ? { ...body, messages: sent } : { messages: sent, ply }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error === 'llm_not_configured' ? t('coach.notConfigured') : `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const { event, data } = parseSseBlock(block);
          if (!mine()) continue;
          if (event === 'message') { acc += data; update(acc); }
          else if (event === 'error') setError(t('coach.error'));
        }
      }
      if (mine() && !acc.trim()) setMessages((ms) => ms.slice(0, -1));
    } catch (e) {
      if (!mine()) return;
      if ((e as Error).name === 'AbortError') {
        if (!acc.trim()) setMessages((ms) => ms.slice(0, -1));
      } else {
        setError((e as Error).message);
        setMessages((ms) => ms.slice(0, -1));
      }
    } finally {
      if (mine()) setBusy(false);
    }
  }

  // A question asked from outside the chat (a "Why?" button).
  const askedRef = useRef(ask?.n);
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    if (!ask || ask.n === askedRef.current) return;
    askedRef.current = ask.n;
    void sendRef.current(ask.text, true);
  }, [ask]);

  const empty = messages.length === 0;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {(!inline || !empty) && (
        <div ref={listRef} className="flex max-h-[420px] flex-col gap-2 overflow-y-auto">
          {messages.map((m, i) => m.role === 'user' ? (
            <div key={i} className="max-w-[85%] self-end whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-gold-500/15 px-3 py-1.5 text-sm text-chesscom-900 dark:text-chesscom-100">
              {m.content}
            </div>
          ) : (
            <div key={i} className="min-w-0 self-start text-sm text-chesscom-800 dark:text-chesscom-100">
              {m.content
                ? <div className="coach-md break-words" style={{ overflowWrap: 'anywhere' }}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(stripReasoning(m.content)) }} />
                : <ThinkingDots label={t('coach.thinking')} />}
            </div>
          ))}
        </div>
      )}

      {empty && suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button key={s} onClick={() => void send(s)} disabled={busy}
              className="rounded-full border border-chesscom-200 bg-white px-2.5 py-1 text-xs text-chesscom-700 hover:border-gold-500/50 hover:bg-gold-50/50 dark:border-chesscom-700 dark:bg-chesscom-800 dark:text-chesscom-200">
              {s}
            </button>
          ))}
        </div>
      )}

      {error && <div className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</div>}

      <form className="flex items-end gap-1.5" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter is a new line. Keep arrow keys from
            // stepping through the game while typing.
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); }
          }}
          rows={1}
          placeholder={placeholder ?? t('chat.placeholder', { defaultValue: 'Ask the coach anything about this game…' })}
          className="input min-h-[36px] flex-1 resize-none py-1.5 text-sm"
        />
        {busy ? (
          <button type="button" onClick={() => abortRef.current?.abort()} className="btn-secondary p-2" title={t('chat.stop', { defaultValue: 'Stop' })}>
            <Square className="h-4 w-4" />
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()} className="btn-primary p-2" title={t('chat.send', { defaultValue: 'Send' })}>
            <Send className="h-4 w-4" />
          </button>
        )}
        {!empty && !busy && (
          <button type="button" onClick={() => { setMessages([]); setError(null); }} className="btn-ghost p-2" title={t('chat.clear', { defaultValue: 'New conversation' })}>
            <RotateCcw className="h-4 w-4" />
          </button>
        )}
      </form>
    </div>
  );
}
