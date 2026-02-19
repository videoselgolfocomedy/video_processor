'use client';

import { useState, useCallback, useRef } from 'react';
import { Film, ImageIcon, Music, Trash2, Upload, GripVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useComposeStore } from '@/stores/compose-store';
import { formatDuration } from '@/lib/utils';
import type { MediaBinAsset } from '@/types/project';

interface MediaBinProps {
  projectId: string;
}

type FilterTab = 'all' | 'video' | 'audio' | 'image';

export function MediaBin({ projectId }: MediaBinProps) {
  const mediaBin = useComposeStore((s) => s.mediaBin);
  const removeFromBin = useComposeStore((s) => s.removeFromBin);
  const addToBin = useComposeStore((s) => s.addToBin);
  const addClip = useComposeStore((s) => s.addClip);
  const tracks = useComposeStore((s) => s.tracks);
  const currentTimeMs = useComposeStore((s) => s.currentTimeMs);

  const [filter, setFilter] = useState<FilterTab>('all');
  const [uploading, setUploading] = useState(false);
  const [dragAssetId, setDragAssetId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const filtered = filter === 'all' ? mediaBin : mediaBin.filter((a) => a.type === filter);

  const handleUpload = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setUploading(true);

      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append('file', file);

        try {
          const res = await fetch(`/api/projects/${projectId}/compose/upload`, {
            method: 'POST',
            body: formData,
          });
          if (res.ok) {
            const asset: MediaBinAsset = await res.json();
            addToBin(asset);
          }
        } catch (err) {
          console.error('Upload error:', err);
        }
      }

      setUploading(false);
    },
    [projectId, addToBin]
  );

  const handleAddToTimeline = useCallback(
    (asset: MediaBinAsset) => {
      // Find appropriate track
      const trackId =
        asset.type === 'audio'
          ? tracks.find((t) => t.type === 'audio' && !t.locked)?.id || 'a2'
          : tracks.find((t) => t.type === 'video' && !t.locked)?.id || 'v2';

      const clipDuration = asset.duration || 5000; // 5s default for images
      const startMs = currentTimeMs;

      addClip({
        type: asset.type,
        fileName: asset.fileName,
        originalName: asset.originalName,
        trackId,
        timelineStartMs: startMs,
        timelineEndMs: startMs + clipDuration,
        sourceInMs: 0,
        sourceOutMs: clipDuration,
        mode: asset.type === 'audio' ? undefined : 'cutaway',
        volume: asset.type === 'audio' ? 1 : undefined,
        opacity: asset.type !== 'audio' ? 1 : undefined,
      });
    },
    [tracks, currentTimeMs, addClip]
  );

  const handleDragStart = useCallback(
    (e: React.DragEvent, asset: MediaBinAsset) => {
      setDragAssetId(asset.id);
      e.dataTransfer.setData('application/compose-asset', JSON.stringify(asset));
      e.dataTransfer.effectAllowed = 'copy';
    },
    []
  );

  const getIcon = (type: string) => {
    if (type === 'video') return <Film className="h-3.5 w-3.5 text-blue-400" />;
    if (type === 'image') return <ImageIcon className="h-3.5 w-3.5 text-teal-400" />;
    return <Music className="h-3.5 w-3.5 text-green-400" />;
  };

  const tabs: { key: FilterTab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'video', label: 'Video' },
    { key: 'audio', label: 'Audio' },
    { key: 'image', label: 'Image' },
  ];

  return (
    <div className="flex flex-col h-full border-r border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-foreground">Media Bin</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[10px]"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          <Upload className="h-3 w-3" />
          {uploading ? 'Uploading...' : 'Add'}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/*,audio/*,image/*"
          className="hidden"
          onChange={(e) => handleUpload(e.target.files)}
        />
      </div>

      {/* Filter tabs */}
      <div className="flex border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={cn(
              'flex-1 px-2 py-1 text-[10px] transition-colors',
              filter === tab.key
                ? 'bg-primary/10 text-primary border-b-2 border-primary'
                : 'text-muted-foreground hover:text-foreground'
            )}
            onClick={() => setFilter(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Asset list */}
      <div className="flex-1 overflow-auto p-1">
        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-20 text-muted-foreground">
            <p className="text-[10px]">No assets</p>
            <p className="text-[9px]">Upload files to add them here</p>
          </div>
        )}

        {filtered.map((asset) => (
          <div
            key={asset.id}
            draggable
            onDragStart={(e) => handleDragStart(e, asset)}
            onDragEnd={() => setDragAssetId(null)}
            className={cn(
              'flex items-center gap-1.5 rounded px-1.5 py-1 text-[10px] cursor-grab',
              'hover:bg-secondary/50 group',
              dragAssetId === asset.id && 'opacity-50'
            )}
          >
            <GripVertical className="h-3 w-3 text-muted-foreground/50 flex-shrink-0" />
            {getIcon(asset.type)}
            <div className="flex-1 min-w-0">
              <div className="truncate text-foreground">{asset.originalName}</div>
              {asset.duration && (
                <div className="text-muted-foreground text-[9px]">
                  {formatDuration(asset.duration)}
                </div>
              )}
            </div>
            <div className="flex gap-0.5 opacity-0 group-hover:opacity-100">
              <button
                className="p-0.5 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  handleAddToTimeline(asset);
                }}
                title="Add to timeline at playhead"
              >
                +
              </button>
              <button
                className="p-0.5 text-muted-foreground hover:text-red-400"
                onClick={(e) => {
                  e.stopPropagation();
                  removeFromBin(asset.id);
                }}
                title="Remove from bin"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
