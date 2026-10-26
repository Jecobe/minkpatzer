import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Mic, Square, Upload, Trash2, Volume2, Check, X } from 'lucide-react';
import { api } from '../api';
import { speak, CUSTOM_PREFIX } from '../lib/tts';
import { cn } from '../lib/utils';

export interface CustomVoice { id: number; name: string; duration: number | null; created_at: string }
export interface VoicesResponse {
  engine: { up: boolean; ready: boolean; error: string | null };
  voices: CustomVoice[];
}

const MAX_SECONDS = 30;

interface Props {
  data: VoicesResponse | undefined;
  selected: string | null;
  onSelect: (voice: string | null) => void;
  rate: number;
}

export default function CustomVoices({ data, selected, onSelect, rate }: Props) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [clip, setClip] = useState<{ blob: Blob; url: string; seconds: number | null } | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => {
    recorderRef.current?.stream.getTracks().forEach((tr) => tr.stop());
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  function setClipFrom(blob: Blob) {
    if (clip) URL.revokeObjectURL(clip.url);
    const url = URL.createObjectURL(blob);
    setClip({ blob, url, seconds: null });
    // Read the length for display; the engine trims anything past 30 s.
    const a = new Audio(url);
    a.onloadedmetadata = () => {
      if (Number.isFinite(a.duration)) setClip((c) => (c && c.url === url ? { ...c, seconds: Math.round(a.duration) } : c));
    };
  }

  async function startRecording() {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) { setError(t('settings.customVoice.micDenied')); return; }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true } });
    } catch {
      setError(t('settings.customVoice.micDenied'));
      return;
    }
    const rec = new MediaRecorder(stream);
    const parts: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    rec.onstop = () => {
      stream.getTracks().forEach((tr) => tr.stop());
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setRecording(false);
      setClipFrom(new Blob(parts, { type: rec.mimeType }));
    };
    recorderRef.current = rec;
    rec.start();
    setRecording(true);
    setElapsed(0);
    const started = Date.now();
    timerRef.current = window.setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setElapsed(s);
      if (s >= MAX_SECONDS) rec.stop();
    }, 250);
  }

  function discard() {
    if (clip) URL.revokeObjectURL(clip.url);
    setClip(null);
  }

  const save = useMutation({
    mutationFn: async () => {
      const fd = new FormData();
      fd.set('name', name.trim());
      fd.set('audio', clip!.blob, 'sample');
      const res = await fetch('/api/voices', {
        method: 'POST', body: fd, credentials: 'same-origin',
        headers: { 'X-Requested-With': 'patzer' },
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      return j as { voice: CustomVoice };
    },
    onSuccess: ({ voice }) => {
      discard();
      setName('');
      qc.invalidateQueries({ queryKey: ['voices'] });
      onSelect(`${CUSTOM_PREFIX}${voice.id}`);
    },
    onError: (e) => {
      const code = (e as Error).message;
      setError(code === 'too_short' ? t('settings.customVoice.tooShort') : t('settings.customVoice.error', { code }));
    },
  });

  const del = useMutation({
    mutationFn: (id: number) => api.del(`/api/voices/${id}`),
    onSuccess: (_r, id) => {
      if (selected === `${CUSTOM_PREFIX}${id}`) onSelect(null);
      qc.invalidateQueries({ queryKey: ['voices'] });
    },
  });

  if (!data) return null;
  const { engine, voices } = data;

  return (
    <div className="space-y-3 rounded-xl border border-ink-200 p-4 dark:border-ink-700">
      <div>
        <div className="text-sm font-semibold">{t('settings.customVoice.title')}</div>
        <p className="mt-0.5 text-xs text-ink-400">{t('settings.customVoice.desc')}</p>
      </div>

      {!engine.up && <p className="text-xs text-bad">{t('settings.customVoice.engineDown')}</p>}
      {engine.up && !engine.ready && (
        <p className="text-xs text-ink-500">{engine.error ? t('settings.customVoice.error', { code: engine.error }) : t('settings.customVoice.engineLoading')}</p>
      )}

      {voices.length > 0 && (
        <ul className="divide-y divide-ink-100 rounded-lg border border-ink-100 dark:divide-ink-700 dark:border-ink-700">
          {voices.map((v) => {
            const value = `${CUSTOM_PREFIX}${v.id}`;
            const active = selected === value;
            return (
              <li key={v.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium">{v.name}</span>
                {v.duration != null && <span className="text-xs text-ink-400">{Math.round(v.duration)}s</span>}
                <button
                  type="button"
                  disabled={!engine.ready}
                  onClick={() => speak(t('settings.ttsPreviewText'), { voice: value, rate })}
                  className="rounded-md p-1.5 text-ink-500 hover:bg-ink-100 disabled:opacity-40 dark:hover:bg-ink-700"
                  title={t('settings.customVoice.preview')}
                  aria-label={t('settings.customVoice.preview')}
                >
                  <Volume2 className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onSelect(active ? null : value)}
                  className={cn('rounded-md px-2 py-1 text-xs font-medium',
                    active ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400' : 'text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-700')}
                >
                  {active ? <span className="inline-flex items-center gap-1"><Check className="h-3 w-3" />{t('settings.customVoice.inUse')}</span> : t('settings.customVoice.use')}
                </button>
                <button
                  type="button"
                  onClick={() => { if (confirm(t('settings.customVoice.deleteConfirm', { name: v.name }))) del.mutate(v.id); }}
                  className="rounded-md p-1.5 text-ink-400 hover:bg-bad/10 hover:text-bad"
                  title={t('settings.customVoice.delete')}
                  aria-label={t('settings.customVoice.delete')}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {engine.up && (
        <div className="space-y-2">
          {recording && (
            <div className="rounded-lg bg-ink-50 p-3 text-sm dark:bg-ink-800">
              <div className="mb-1 text-xs text-ink-400">{t('settings.customVoice.readThis')}</div>
              <p className="leading-relaxed">{t('settings.customVoice.script')}</p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {recording ? (
              <button type="button" onClick={() => recorderRef.current?.stop()} className="btn-secondary text-sm text-bad">
                <Square className="h-4 w-4 fill-current" /> {t('settings.customVoice.stop', { s: elapsed })}
              </button>
            ) : (
              <>
                <button type="button" onClick={startRecording} className="btn-secondary text-sm">
                  <Mic className="h-4 w-4" /> {t('settings.customVoice.record')}
                </button>
                <button type="button" onClick={() => fileRef.current?.click()} className="btn-secondary text-sm">
                  <Upload className="h-4 w-4" /> {t('settings.customVoice.upload')}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="audio/*,video/webm"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (!f) return;
                    setError(null);
                    setClipFrom(f);
                    if (!name) setName(f.name.replace(/\.[^.]+$/, '').slice(0, 60));
                  }}
                />
              </>
            )}
          </div>

          {clip && !recording && (
            <div className="space-y-2 rounded-lg bg-ink-50 p-3 dark:bg-ink-800">
              <div className="flex items-center justify-between text-xs text-ink-500">
                <span>{t('settings.customVoice.clipReady', { s: clip.seconds ?? '?' })}</span>
                <button type="button" onClick={discard} className="inline-flex items-center gap-1 hover:text-bad">
                  <X className="h-3 w-3" /> {t('settings.customVoice.discard')}
                </button>
              </div>
              <audio controls src={clip.url} className="h-8 w-full" />
              <div className="flex flex-wrap gap-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={60}
                  placeholder={t('settings.customVoice.namePlaceholder')}
                  aria-label={t('settings.customVoice.name')}
                  className="input min-w-0 flex-1 text-sm"
                />
                <button
                  type="button"
                  disabled={!name.trim() || save.isPending}
                  onClick={() => { setError(null); save.mutate(); }}
                  className="btn-primary text-sm"
                >
                  {save.isPending ? t('settings.customVoice.saving') : t('settings.customVoice.save')}
                </button>
              </div>
            </div>
          )}
          <p className="text-[11px] text-ink-400">{t('settings.customVoice.consent')}</p>
        </div>
      )}

      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}
