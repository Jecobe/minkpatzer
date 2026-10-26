// A player's Chess.com / Lichess ratings, with each site's favicon. Which
// sites show is the player's own choice (Settings → "Show my ratings"); the
// server applies it, so nothing here can show a rating they hid.

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';

export type RatingDisplay = 'both' | 'chesscom' | 'lichess' | 'none';
type Site = 'chesscom' | 'lichess';

export interface SiteRatings {
  site: Site;
  username: string;
  url: string;
  ratings: Partial<Record<'bullet' | 'blitz' | 'rapid' | 'classical' | 'daily', number>>;
  headline: { time_class: string; rating: number } | null;
}

interface ExternalRatingsResponse { display: RatingDisplay; chesscom: SiteRatings | null; lichess: SiteRatings | null }

const SITE_NAME: Record<Site, string> = { chesscom: 'Chess.com', lichess: 'Lichess' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function useExternalRatings(userId: number | null | undefined) {
  return useQuery({
    queryKey: ['external-ratings', userId],
    queryFn: () => api.get<ExternalRatingsResponse>(`/api/players/${userId}/external-ratings`),
    enabled: !!userId,
    staleTime: 10 * 60 * 1000,
  });
}

export function SiteIcon({ site, className = 'h-3.5 w-3.5' }: { site: Site; className?: string }) {
  return (
    <img
      src={`/api/players/site-icons/${site}`}
      alt={SITE_NAME[site]}
      className={`${className} shrink-0 rounded-sm`}
      // A site that's unreachable just loses its icon, not the rating.
      onError={(e) => { e.currentTarget.style.display = 'none'; }}
    />
  );
}

function sites(data: ExternalRatingsResponse | undefined): SiteRatings[] {
  return [data?.chesscom, data?.lichess].filter((s): s is SiteRatings => !!s && !!s.headline);
}

/** Compact badges for a name strip: favicon + one rating per site. */
export function RatingBadges({ userId, className = '' }: { userId: number | null | undefined; className?: string }) {
  const { t } = useTranslation();
  const { data } = useExternalRatings(userId);
  const list = sites(data);
  if (list.length === 0) return null;
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      {list.map((s) => (
        <a
          key={s.site}
          href={s.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title={`${SITE_NAME[s.site]} · ${s.username} · ${t(`players.tc.${s.headline!.time_class}`, { defaultValue: cap(s.headline!.time_class) })}`}
          className="inline-flex items-center gap-1 font-mono text-xs font-semibold tabular-nums normal-case tracking-normal hover:underline"
        >
          <SiteIcon site={s.site} />
          {s.headline!.rating}
        </a>
      ))}
    </span>
  );
}

const TC_ORDER = ['bullet', 'blitz', 'rapid', 'classical', 'daily'] as const;

/** Full card for a profile page: every time class on each shown site. */
export function ExternalRatingsCard({ userId }: { userId: number }) {
  const { t } = useTranslation();
  const { data, isLoading } = useExternalRatings(userId);
  const list = [data?.chesscom, data?.lichess].filter((s): s is SiteRatings => !!s);
  if (isLoading || list.length === 0) return null;
  return (
    <div className="card p-4">
      <div className="mb-3 text-sm font-semibold">{t('ratings.elsewhere', { defaultValue: 'Ratings elsewhere' })}</div>
      <div className="grid gap-3 sm:grid-cols-2">
        {list.map((s) => (
          <a key={s.site} href={s.url} target="_blank" rel="noopener noreferrer"
            className="rounded-lg border border-chesscom-200 p-3 hover:border-gold-500/50 dark:border-chesscom-700">
            <div className="flex items-center gap-2">
              <SiteIcon site={s.site} className="h-5 w-5" />
              <span className="font-semibold">{SITE_NAME[s.site]}</span>
              <span className="truncate text-xs text-chesscom-500">{s.username}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {TC_ORDER.filter((tc) => s.ratings[tc] != null).map((tc) => (
                <div key={tc} className="text-xs">
                  <span className="text-chesscom-500">{t(`players.tc.${tc}`, { defaultValue: cap(tc) })} </span>
                  <span className="font-mono font-semibold tabular-nums">{s.ratings[tc]}</span>
                </div>
              ))}
              {Object.keys(s.ratings).length === 0 && (
                <span className="text-xs text-chesscom-500">{t('ratings.noneYet', { defaultValue: 'No rated games yet' })}</span>
              )}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
