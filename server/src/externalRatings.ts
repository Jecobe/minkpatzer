// A player's ratings on Chess.com and Lichess, from the usernames on their
// profile (the same ones the game importer uses). Both sites have public,
// keyless APIs; answers are cached for an hour so a board full of badges
// doesn't hammer them, and a site that's down just shows no badge.

export type ExternalSite = 'chesscom' | 'lichess';
export type RatingDisplay = 'both' | 'chesscom' | 'lichess' | 'none';
export const RATING_DISPLAYS: readonly RatingDisplay[] = ['both', 'chesscom', 'lichess', 'none'];

export interface SiteRatings {
  site: ExternalSite;
  username: string;
  url: string;
  /** Rating per time class; absent = never played it there. */
  ratings: Partial<Record<'bullet' | 'blitz' | 'rapid' | 'classical' | 'daily', number>>;
  /** The one number to show next to a name: rapid, else the most-played pool. */
  headline: { time_class: string; rating: number } | null;
}

const TTL_MS = 60 * 60 * 1000;
const FAIL_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; ttl: number; value: Promise<SiteRatings | null> }>();

const UA = 'Patzer (self-hosted chess coach; github.com/Jecobe/minkpatzer)';

async function getJson(url: string): Promise<unknown | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function headline(ratings: SiteRatings['ratings'], games: Partial<Record<string, number>>): SiteRatings['headline'] {
  if (ratings.rapid != null) return { time_class: 'rapid', rating: ratings.rapid };
  const pools = (Object.keys(ratings) as (keyof SiteRatings['ratings'])[])
    .sort((a, b) => (games[b] ?? 0) - (games[a] ?? 0));
  const k = pools[0];
  return k ? { time_class: k, rating: ratings[k]! } : null;
}

interface ChesscomStat { last?: { rating?: number }; record?: { win?: number; loss?: number; draw?: number } }

async function fetchChesscom(username: string): Promise<SiteRatings | null> {
  const u = username.toLowerCase();
  const data = await getJson(`https://api.chess.com/pub/player/${encodeURIComponent(u)}/stats`) as Record<string, ChesscomStat> | null;
  if (!data) return null;
  const ratings: SiteRatings['ratings'] = {};
  const games: Record<string, number> = {};
  for (const [key, tc] of [['chess_bullet', 'bullet'], ['chess_blitz', 'blitz'], ['chess_rapid', 'rapid'], ['chess_daily', 'daily']] as const) {
    const s = data[key];
    if (typeof s?.last?.rating === 'number') {
      ratings[tc] = s.last.rating;
      games[tc] = (s.record?.win ?? 0) + (s.record?.loss ?? 0) + (s.record?.draw ?? 0);
    }
  }
  return { site: 'chesscom', username, url: `https://www.chess.com/member/${encodeURIComponent(u)}`, ratings, headline: headline(ratings, games) };
}

interface LichessPerf { rating?: number; games?: number; prov?: boolean }

async function fetchLichess(username: string): Promise<SiteRatings | null> {
  const data = await getJson(`https://lichess.org/api/user/${encodeURIComponent(username)}`) as
    { username?: string; perfs?: Record<string, LichessPerf>; disabled?: boolean } | null;
  if (!data?.perfs || data.disabled) return null;
  const ratings: SiteRatings['ratings'] = {};
  const games: Record<string, number> = {};
  for (const tc of ['bullet', 'blitz', 'rapid', 'classical', 'correspondence'] as const) {
    const p = data.perfs[tc];
    // A pool with no games is Lichess's 1500 placeholder, not a rating.
    if (typeof p?.rating === 'number' && (p.games ?? 0) > 0) {
      const key = tc === 'correspondence' ? 'daily' : tc;
      ratings[key] = p.rating;
      games[key] = p.games ?? 0;
    }
  }
  const name = data.username ?? username;
  return { site: 'lichess', username: name, url: `https://lichess.org/@/${encodeURIComponent(name)}`, ratings, headline: headline(ratings, games) };
}

function cached(site: ExternalSite, username: string): Promise<SiteRatings | null> {
  const key = `${site}:${username.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const value = (site === 'chesscom' ? fetchChesscom(username) : fetchLichess(username));
  const entry = { at: Date.now(), ttl: TTL_MS, value };
  cache.set(key, entry);
  // Failures are retried sooner than successes are refreshed.
  void value.then((v) => { if (!v) entry.ttl = FAIL_TTL_MS; });
  return value;
}

/** Ratings for a profile, filtered by what its owner chose to show. */
export async function externalRatings(profile: {
  chesscom_username: string | null;
  lichess_username: string | null;
  rating_display?: string | null;
}): Promise<{ display: RatingDisplay; chesscom: SiteRatings | null; lichess: SiteRatings | null }> {
  const display = (RATING_DISPLAYS as readonly string[]).includes(profile.rating_display ?? '')
    ? profile.rating_display as RatingDisplay : 'both';
  const want = (s: ExternalSite) => display === 'both' || display === s;
  const [chesscom, lichess] = await Promise.all([
    want('chesscom') && profile.chesscom_username ? cached('chesscom', profile.chesscom_username) : null,
    want('lichess') && profile.lichess_username ? cached('lichess', profile.lichess_username) : null,
  ]);
  return { display, chesscom, lichess };
}

// ── Site favicons ───────────────────────────────────────────────────────────
// Served from our own origin (the CSP allows only 'self' images), fetched
// from the sites on first use and kept in memory — not shipped in the repo.

const ICON_SOURCES: Record<ExternalSite, string[]> = {
  chesscom: ['https://www.chess.com/favicon.ico', 'https://www.chess.com/bundles/web/favicons/favicon-32x32.png'],
  lichess: ['https://lichess1.org/assets/logo/lichess-favicon-32.png', 'https://lichess.org/favicon.ico'],
};
const iconCache = new Map<ExternalSite, Promise<{ body: ArrayBuffer; type: string } | null>>();

async function fetchIcon(site: ExternalSite): Promise<{ body: ArrayBuffer; type: string } | null> {
  for (const url of ICON_SOURCES[site]) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
      const type = res.headers.get('content-type') ?? '';
      if (res.ok && type.startsWith('image/')) return { body: await res.arrayBuffer(), type };
    } catch { /* try the next one */ }
  }
  return null;
}

export function siteIcon(site: ExternalSite): Promise<{ body: ArrayBuffer; type: string } | null> {
  let p = iconCache.get(site);
  if (!p) {
    p = fetchIcon(site);
    iconCache.set(site, p);
    void p.then((v) => { if (!v) iconCache.delete(site); });
  }
  return p;
}
