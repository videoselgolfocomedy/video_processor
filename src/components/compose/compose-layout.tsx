'use client';

import { useCallback, useState, useEffect } from 'react';
import { useComposeStore } from '@/stores/compose-store';
import { MediaBin } from './media-bin';
import { ComposePreview } from './compose-preview';
import { ClipProperties } from './clip-properties';
import { MultiTrackTimeline } from './multi-track-timeline';
import type { SubtitleStyle } from '@/types/project';

interface ComposeLayoutProps {
  projectId: string;
  videoSrc?: string;
  audioSrc?: string;
  subtitleStyle: SubtitleStyle;
}

export function ComposeLayout({
  projectId,
  videoSrc,
  audioSrc,
  subtitleStyle,
}: ComposeLayoutProps) {
  const [saving, setSaving] = useState(false);
  const getCompositionState = useComposeStore((s) => s.getCompositionState);
  const subtitleSegments = useComposeStore((s) => s.subtitleSegments);
  const markClean = useComposeStore((s) => s.markClean);
  const selectedClipId = useComposeStore((s) => s.selectedClipId);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const compositionState = getCompositionState();
      await fetch(`/api/projects/${projectId}/compose`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(compositionState),
      });

      // Also save subtitle changes back to the project
      await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcription: { segments: subtitleSegments },
        }),
      });

      markClean();
    } catch (err) {
      console.error('Save error:', err);
    } finally {
      setSaving(false);
    }
  }, [projectId, getCompositionState, subtitleSegments, markClean]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      if (e.key === ' ') {
        e.preventDefault();
        const store = useComposeStore.getState();
        store.setIsPlaying(!store.isPlaying);
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        const store = useComposeStore.getState();
        if (store.selectedClipId) {
          store.removeClip(store.selectedClipId);
        }
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        useComposeStore.getState().undo();
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        useComposeStore.getState().redo();
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave]);

  return (
    <div className="flex h-full flex-col">
      {/* Top section: Media Bin + Preview + Properties */}
      <div className="flex flex-1 min-h-0">
        {/* Media Bin */}
        <div className="w-56 flex-shrink-0">
          <MediaBin projectId={projectId} />
        </div>

        {/* Preview */}
        <div className="flex-1 flex flex-col min-w-0">
          <ComposePreview
            projectId={projectId}
            videoSrc={videoSrc}
            audioSrc={audioSrc}
            subtitleStyle={subtitleStyle}
          />
        </div>

        {/* Clip Properties */}
        {selectedClipId && (
          <div className="w-56 flex-shrink-0 border-l border-border bg-card overflow-auto">
            <ClipProperties />
          </div>
        )}
      </div>

      {/* Bottom section: Timeline */}
      <div className="flex-shrink-0">
        <MultiTrackTimeline onSave={handleSave} saving={saving} />
      </div>
    </div>
  );
}
