// Engine check — paste a Chess.com / Lichess link or a PGN and see how
// engine-like each side played. The server runs Stockfish over the game and
// scores each player against human baselines for their rating
// (server/src/chess/fairplay.ts). One game is a small sample: the page says
// so up front, and the score is framed as a signal, not a verdict.

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlert, Loader2, Search, Info, Clock } from 'lucide-react';
import { parseSseBlock } from '../components/CoachPanel';

type Verdict = 'insufficient' | 'human' | 'some' | 'strong' | 'very_strong';

interface SideReport {
  color: 'white' | 'black';
  name: string;
  rating: number | null;
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

interface Report {
  white: SideReport;
  black: SideReport;
  headers: Record<string, string | undefined>;
  source: 'chesscom' | 'lichess' | 'pgn';
  depth: number;
  plies: number;
  has_clocks: boolean;
}

type Progress = { stage: 'fetching' } | { stage: 'analysing'; done: number; total: number };

const VERDICT: Record<Verdict, { label: string; tone: string; bar: string }> = {
  insufficient: { label: 'Not enough moves to judge', tone: 'text-chesscom-500', bar: 'bg-chesscom-300' },
  human: { label: 'Consistent with human play', tone: 'text-green-600 dark:text-green-400', bar: 'bg-green-500' },
  some: { label: 'Some engine-like signals', tone: 'text-amber-600 dark:text-amber-400', bar: 'bg-amber-500' },
  strong: { label: 'Strongly engine-like', tone: 'text-orange-600 dark:text-orange-400', bar: 'bg-orange-500' },
  very_strong: { label: 'Very strongly engine-like', tone: 'text-bad', bar: 'bg-bad' },
};

export default function EngineCheck() {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [depth, setDepth] = useState(16);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function run() {
    if (!input.trim() || busy) return;
    abortRef.current?.abort();
    const ac = new AbortController(); abortRef.current = ac;
    setBusy(true); setError(null); setReport(null); setProgress({ stage: 'fetching' });
    try {
      const res = await fetch('/api/fairplay/check', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'patzer' },
        body: JSON.stringify({ input, depth }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null) as { message?: string } | null;
        throw new Error(body?.message ?? `HTTP ${res.status}`);
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
          const { event, data } = parseSseBlock(buf.slice(0, nl));
          buf = buf.slice(nl + 2);
          if (event === 'progress') setProgress(JSON.parse(data) as Progress);
          else if (event === 'done') setReport((JSON.parse(data) as { report: Report }).report);
          else if (event === 'error') setError(data);
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      setBusy(false); setProgress(null);
    }
  }

  const pct = progress?.stage === 'analysing' && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <ShieldAlert className="h-6 w-6 text-gold-500" />
          {t('engineCheck.title', { defaultValue: 'Engine check' })}
        </h1>
        <p className="mt-1 text-sm text-chesscom-500">
          {t('engineCheck.intro', { defaultValue: 'Paste a Chess.com or Lichess game link, or a PGN. Stockfish analyses every move and each player is compared with what a human of their rating usually plays.' })}
        </p>
      </div>

      <div className="card flex flex-col gap-3 p-4">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={input.includes('\n') ? 8 : 3}
          placeholder={'https://www.chess.com/game/live/123456789\nhttps://lichess.org/abcd1234\n…or paste a PGN'}
          className="input resize-y font-mono text-xs"
        />
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-chesscom-500">
            {t('engineCheck.depth', { defaultValue: 'Depth' })}
            <select className="input w-auto py-1 text-xs" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
              <option value={14}>14 · fast</option>
              <option value={16}>16 · standard</option>
              <option value={18}>18 · thorough</option>
              <option value={20}>20 · slow</option>
            </select>
          </label>
          <button onClick={run} disabled={busy || !input.trim()} className="btn-primary ml-auto">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            {t('engineCheck.run', { defaultValue: 'Check game' })}
          </button>
        </div>
        {progress && (
          <div className="flex flex-col gap-1.5">
            <div className="h-2 overflow-hidden rounded-full bg-chesscom-100 dark:bg-chesscom-800">
              <div className="h-full bg-gold-500 transition-all duration-200" style={{ width: progress.stage === 'fetching' ? '3%' : `${pct}%` }} />
            </div>
            <div className="text-xs text-chesscom-500">
              {progress.stage === 'fetching'
                ? t('engineCheck.fetching', { defaultValue: 'Fetching the game…' })
                : t('engineCheck.analysing', { defaultValue: 'Analysing move {{done}} of {{total}}…', done: progress.done, total: progress.total })}
            </div>
          </div>
        )}
        {error && <div className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>}
      </div>

      {report && (
        <>
          <div className="text-sm text-chesscom-500">
            <span className="font-semibold text-chesscom-800 dark:text-chesscom-100">{report.headers.White ?? 'White'} – {report.headers.Black ?? 'Black'}</span>
            {report.headers.Result && <span className="ml-2 font-mono">{report.headers.Result}</span>}
            {report.headers.TimeControl && <span className="ml-2">· {report.headers.TimeControl}</span>}
            {report.headers.Date && <span className="ml-2">· {report.headers.Date}</span>}
            <span className="ml-2">· {Math.ceil(report.plies / 2)} moves · depth {report.depth}</span>
            {!report.has_clocks && <span className="ml-2">· no clock data</span>}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <SideCard side={report.white} />
            <SideCard side={report.black} />
          </div>
        </>
      )}

      <div className="flex gap-2 rounded-lg border border-chesscom-200 bg-chesscom-50/60 p-3 text-xs leading-relaxed text-chesscom-600 dark:border-chesscom-700 dark:bg-chesscom-900/40 dark:text-chesscom-300">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <b>{t('engineCheck.caveatTitle', { defaultValue: 'This is a signal, not proof.' })}</b>{' '}
          {t('engineCheck.caveat', { defaultValue: 'One game is a small sample. Strong players, short or forcing games, opponents who blunder early and well-prepared openings can all look engine-like, and a cheater who uses an engine for a few key moves can look human. Book moves, forced replies and positions that were already decided (±5 pawns) are left out of the score. The rating baselines are rough. Chess.com and Lichess make their calls from many games plus data this page can\'t see — report a player to the site rather than accusing them.' })}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, expected }: { label: string; value: string; expected?: string }) {
  return (
    <div className="rounded-md bg-chesscom-50 px-2.5 py-1.5 dark:bg-chesscom-900/40">
      <div className="text-[11px] text-chesscom-500">{label}</div>
      <div className="font-mono text-sm font-semibold tabular-nums">{value}</div>
      {expected && <div className="text-[10px] text-chesscom-400">typical {expected}</div>}
    </div>
  );
}

function SideCard({ side }: { side: SideReport }) {
  const v = VERDICT[side.verdict];
  const skipped = side.skipped.book + side.skipped.forced + side.skipped.decided;
  return (
    <div className="card flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <span className={`h-4 w-4 shrink-0 rounded-sm border border-chesscom-400 ${side.color === 'white' ? 'bg-white' : 'bg-chesscom-900'}`} />
        <span className="truncate font-semibold">{side.name}</span>
        {side.rating != null && <span className="font-mono text-sm text-chesscom-500">({side.rating})</span>}
      </div>

      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className={`text-sm font-semibold ${v.tone}`}>{v.label}</span>
          <span className="font-mono text-2xl font-bold tabular-nums">{side.score == null ? '–' : side.score}<span className="text-sm text-chesscom-400">/100</span></span>
        </div>
        <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-chesscom-100 dark:bg-chesscom-800">
          <div className={`h-full ${v.bar}`} style={{ width: `${side.score ?? 0}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-chesscom-400">
          <span>human</span><span>engine-like</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="Top engine move" value={side.t1_match == null ? '–' : `${side.t1_match}%`} expected={`${side.expected.t1}%`} />
        <Stat label="Avg loss (ACPL)" value={side.acpl == null ? '–' : String(side.acpl)} expected={String(side.expected.acpl)} />
        <Stat label="Within 15cp of best" value={side.near_best == null ? '–' : `${side.near_best}%`} />
        <Stat label="Accuracy" value={`${side.accuracy}%`} />
        <Stat label="Errors" value={String(side.errors)} />
        <Stat label="Top-move streak" value={String(side.longest_top_streak)} />
        {side.time && (
          <Stat label="Avg time / move" value={`${side.time.avg_seconds}s`} expected={side.time.cv != null ? `variation ${side.time.cv}` : undefined} />
        )}
      </div>

      <ul className="ml-4 list-disc space-y-1 text-xs leading-relaxed text-chesscom-700 dark:text-chesscom-200">
        {side.signals.map((s) => <li key={s}>{s}</li>)}
      </ul>

      <div className="flex items-center gap-1 text-[11px] text-chesscom-400">
        <Clock className="h-3 w-3" />
        {side.considered} moves scored · {skipped} left out ({side.skipped.book} book, {side.skipped.forced} forced, {side.skipped.decided} decided)
        {!side.expected.rating_known && ' · rating unknown, compared with 1500'}
      </div>
    </div>
  );
}
