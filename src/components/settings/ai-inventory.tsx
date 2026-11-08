'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { FilePlus, Loader2, Package, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { useTranslations } from 'next-intl';

type Mode = 'replace' | 'merge';

interface Summary {
  rows: number;
  imported_at: string | null;
  fabrics: Record<string, number>;
}

export function AiInventoryCard({
  accountId,
  canEdit,
}: {
  accountId: string | null;
  canEdit: boolean;
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<Mode | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const modeRef = useRef<Mode>('replace');
  const loadedAccountIdRef = useRef<string | null>(null);
  const t = useTranslations('Settings.aiInventory');

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/inventory');
      const data = await res.json();
      if (res.ok) setSummary(data);
      else toast.error(t('loadFailed'));
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchSummary();
  }, [accountId, fetchSummary]);

  const errorMessage = (code: string | undefined) => {
    if (!code) return t('uploadFailed');
    if (code.startsWith('missing_columns:')) {
      return t('missingColumns', { columns: code.split(':')[1] ?? '' });
    }
    if (code === 'empty' || code === 'no_valid_rows') return t('emptyFile');
    if (code === 'too_many_rows') return t('tooManyRows');
    if (code === 'file_required') return t('fileRequired');
    return t('uploadFailed');
  };

  const pick = (mode: Mode) => {
    if (mode === 'replace' && summary && summary.rows > 0 && !window.confirm(t('confirmReplace'))) {
      return;
    }
    modeRef.current = mode;
    fileRef.current?.click();
  };

  const upload = async (file: File) => {
    const mode = modeRef.current;
    setUploading(mode);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('mode', mode);
      const res = await fetch('/api/ai/inventory', { method: 'POST', body: form });
      const data = await res.json();
      if (res.ok) {
        const skipped: number[] = Array.isArray(data.skipped) ? data.skipped : [];
        if (skipped.length > 0) {
          toast.warning(
            t('uploadedWithSkipped', {
              count: data.imported,
              skipped: skipped.length,
              lines: skipped.slice(0, 10).join(', '),
            }),
          );
        } else {
          toast.success(
            t(mode === 'merge' ? 'merged' : 'uploaded', { count: data.imported }),
          );
        }
        await fetchSummary();
      } else {
        toast.error(errorMessage(data.error));
      }
    } catch {
      toast.error(t('uploadFailed'));
    } finally {
      setUploading(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const fabrics = summary ? Object.entries(summary.fabrics).sort() : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Package className="h-4 w-4 text-primary" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center py-2 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
          </div>
        ) : summary && summary.rows > 0 ? (
          <div className="space-y-1 text-sm">
            <p className="text-foreground">
              {t('status', {
                count: summary.rows,
                date: summary.imported_at
                  ? new Date(summary.imported_at).toLocaleString()
                  : '—',
              })}
            </p>
            {fabrics.length > 0 && (
              <p className="text-muted-foreground">
                {t('fabrics', {
                  list: fabrics.map(([code, n]) => `${code} (${n})`).join(', '),
                })}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        )}

        <p className="text-xs text-muted-foreground">{t('format')}</p>

        {canEdit && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => pick('replace')}
                  disabled={uploading !== null}
                >
                  {uploading === 'replace' ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="mr-2 h-4 w-4" />
                  )}
                  {t('uploadReplace')}
                </Button>
                <p className="text-xs text-muted-foreground">{t('uploadReplaceHint')}</p>
              </div>
              <div className="space-y-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => pick('merge')}
                  disabled={uploading !== null}
                >
                  {uploading === 'merge' ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <FilePlus className="mr-2 h-4 w-4" />
                  )}
                  {t('uploadMerge')}
                </Button>
                <p className="text-xs text-muted-foreground">{t('uploadMergeHint')}</p>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
