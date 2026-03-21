'use client';

import { useEffect, useState, useCallback } from 'react';
import { useReelStore } from '@/stores/reel-store';
import { useProjectStore } from '@/stores/project-store';
import { ReelSetupView } from './reel-setup-view';
import { ReelTimelineView } from './reel-timeline-view';
import { ReelRightPanel } from './reel-right-panel';
import { BitsSuggestionPanel } from './bits-suggestion-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Save, Plus, Copy, Trash2, ArrowRight, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';

interface ReelLayoutProps {
  projectId: string;
  videoSrc?: string;
  audioSrc?: string;
  onSave: () => Promise<void>;
}

export function ReelLayout({ projectId, videoSrc, audioSrc, onSave }: ReelLayoutProps) {
  const router = useRouter();
  const reels = useReelStore((s) => s.reels);
  const activeReelId = useReelStore((s) => s.activeReelId);
  const dirty = useReelStore((s) => s.dirty);
  const selectReel = useReelStore((s) => s.selectReel);
  const createReel = useReelStore((s) => s.createReel);
  const deleteReel = useReelStore((s) => s.deleteReel);
  const duplicateReel = useReelStore((s) => s.duplicateReel);
  const updateReel = useReelStore((s) => s.updateReel);
  const baseDurationMs = useReelStore((s) => s.baseDurationMs);
  const phase = useReelStore((s) => s.phase);

  const currentProject = useProjectStore((s) => s.currentProject);
  const bits = currentProject?.bits ?? [];
  const compositionClips = currentProject?.composition?.clips ?? [];

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [contextMenuId, setContextMenuId] = useState<string | null>(null);
  const [showBitsPanel, setShowBitsPanel] = useState(false);

  const handleCreate = useCallback(() => {
    const name = `Reel ${reels.length + 1}`;
    const endMs = Math.min(baseDurationMs, 60000);
    createReel(name, 0, endMs);
  }, [reels.length, baseDurationMs, createReel]);

  const handleStartRename = (id: string, currentName: string) => {
    setEditingTabId(id);
    setEditName(currentName);
  };

  const handleFinishRename = (id: string) => {
    if (editName.trim()) {
      updateReel(id, { name: editName.trim() });
    }
    setEditingTabId(null);
  };

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenuId) return;
    const handler = () => setContextMenuId(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenuId]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === ' ') {
        e.preventDefault();
        const store = useReelStore.getState();
        store.setIsPlaying(!store.isPlaying);
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        onSave();
      }

      // Undo/Redo (Ctrl+Z / Ctrl+Shift+Z)
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        const s = useReelStore.getState();
        if (s.activeReelId) {
          if (e.shiftKey) s.redo(s.activeReelId);
          else s.undo(s.activeReelId);
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        const s = useReelStore.getState();
        if (s.activeReelId) s.redo(s.activeReelId);
      }

      // Timeline-phase shortcuts
      const store = useReelStore.getState();
      if (store.phase === 'timeline' && store.activeReelId) {
        const rid = store.activeReelId;

        // Delete: Shift = ripple delete, plain = normal delete
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          if (e.shiftKey && store.selectedClipIds.length > 0) {
            store.rippleDeleteSelected(rid);
          } else {
            store.deleteSelected(rid);
          }
        }

        // S = split selected clip, Shift+S = split all tracks
        if (e.key === 's' && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          if (e.shiftKey) {
            store.splitAllAtPlayhead(rid);
          } else {
            store.splitClipAtPlayhead(rid);
          }
        }

        // Q = trim in-point of selected clip to playhead
        if (e.key === 'q' && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          const firstClip = store.selectedClipIds[0];
          if (firstClip) {
            store.trimClip(rid, firstClip, 'in', store.currentTimeMs);
          }
        }

        // W = trim out-point of selected clip to playhead
        if (e.key === 'w' && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          const firstClip = store.selectedClipIds[0];
          if (firstClip) {
            store.trimClip(rid, firstClip, 'out', store.currentTimeMs);
          }
        }

        // G = collapse gap at playhead, Shift+G = close gap for selected
        if ((e.key === 'g' || e.key === 'G') && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          if (e.shiftKey && store.selectedClipIds.length > 1) {
            store.closeGapForSelected(rid);
          } else {
            store.collapseGapAtPlayhead(rid);
          }
        }

        // Left/Right arrow = seek +-1s (Shift = +-0.1s)
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          const delta = e.shiftKey ? 100 : 1000;
          store.setCurrentTime(Math.max(0, store.currentTimeMs - delta));
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          const reel = store.reels.find((r) => r.id === rid);
          const maxMs = reel ? reel.endMs - reel.startMs : Infinity;
          const delta = e.shiftKey ? 100 : 1000;
          store.setCurrentTime(Math.min(maxMs, store.currentTimeMs + delta));
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onSave]);

  return (
    <div className="flex h-full flex-col">
      {/* Header with tabs */}
      <div className="flex items-center border-b border-border px-2 py-0 min-h-[40px]">
        <span className="text-sm font-semibold mr-3 px-2">Reels</span>

        {/* Tabs */}
        <div className="flex items-center gap-0 flex-1 min-w-0 overflow-x-auto">
          {reels.map((reel) => (
            <div key={reel.id} className="relative flex items-center">
              <button
                className={`flex items-center gap-1 px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors border-b-2 ${
                  reel.id === activeReelId
                    ? 'border-primary text-foreground bg-muted/50'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/30'
                }`}
                onClick={() => selectReel(reel.id)}
                onDoubleClick={() => handleStartRename(reel.id, reel.name)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenuId(reel.id);
                }}
              >
                {editingTabId === reel.id ? (
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={() => handleFinishRename(reel.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleFinishRename(reel.id);
                      if (e.key === 'Escape') setEditingTabId(null);
                    }}
                    className="h-5 w-24 text-xs px-1"
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span>{reel.name}</span>
                )}
                {/* No X button on tabs — delete only via right-click context menu with confirmation */}
              </button>

              {/* Context menu */}
              {contextMenuId === reel.id && (
                <div className="absolute top-full left-0 z-50 bg-popover border border-border rounded-md shadow-md py-1 min-w-[120px]">
                  <button
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-muted text-left"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleStartRename(reel.id, reel.name);
                      setContextMenuId(null);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-muted text-left"
                    onClick={(e) => {
                      e.stopPropagation();
                      duplicateReel(reel.id);
                      setContextMenuId(null);
                    }}
                  >
                    <Copy className="h-3 w-3" /> Duplicate
                  </button>
                  <button
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-muted text-left text-red-400"
                    onClick={async (e) => {
                      e.stopPropagation();
                      setContextMenuId(null);
                      if (window.confirm(`Delete reel "${reel.name}"? This cannot be undone.`)) {
                        deleteReel(reel.id);
                        // Immediate save so deletion persists even if user closes the page
                        await onSave();
                      }
                    }}
                  >
                    <Trash2 className="h-3 w-3" /> Delete
                  </button>
                </div>
              )}
            </div>
          ))}

          {/* New reel button */}
          <button
            className="flex items-center gap-1 px-2 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={handleCreate}
          >
            <Plus className="h-3 w-3" />
          </button>

          {/* Bits toggle */}
          {bits.length > 0 && (
            <button
              className={`flex items-center gap-1 px-2 py-2 text-xs font-medium transition-colors ml-1 ${
                showBitsPanel
                  ? 'text-purple-400'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setShowBitsPanel(!showBitsPanel)}
            >
              <Sparkles className="h-3 w-3" />
              Bits
              <span className="text-[9px] bg-muted px-1 rounded">{bits.length}</span>
            </button>
          )}
        </div>

        {/* Save status + buttons */}
        <div className="flex items-center gap-1.5 ml-2">
          {dirty ? (
            <span className="text-[10px] text-yellow-500 mr-1">unsaved</span>
          ) : (
            <span className="text-[10px] text-green-500 mr-1">saved</span>
          )}
          <Button size="sm" onClick={onSave} disabled={!dirty} variant={dirty ? 'default' : 'outline'}>
            <Save className="mr-1 h-3 w-3" />
            Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              if (dirty) await onSave();
              router.push(`/project/${projectId}/export`);
            }}
          >
            Export
            <ArrowRight className="ml-1 h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Main content */}
      {!activeReelId ? (
        <div className="flex flex-1 min-h-0">
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Create a reel to start editing
          </div>
          {showBitsPanel && bits.length > 0 && (
            <div className="w-[320px] flex-shrink-0 border-l border-border overflow-y-auto">
              <BitsSuggestionPanel
                bits={bits}
                compositionClips={compositionClips}
                onCreateReel={(label, startMs, endMs) => {
                  createReel(label, startMs, endMs);
                  setShowBitsPanel(false);
                }}
              />
            </div>
          )}
        </div>
      ) : phase === 'timeline' ? (
        <ReelTimelineView
          reelId={activeReelId}
          videoSrc={videoSrc}
          audioSrc={audioSrc}
        />
      ) : (
        <div className="flex flex-1 min-h-0">
          {/* Left: setup (scrollable) */}
          <div className="flex-1 min-w-0 overflow-y-auto">
            <ReelSetupView
              reelId={activeReelId}
              videoSrc={videoSrc}
              audioSrc={audioSrc}
            />
          </div>

          {/* Right: preview + style + constraints OR bits panel */}
          <div className="w-[320px] flex-shrink-0 border-l border-border overflow-y-auto">
            {showBitsPanel && bits.length > 0 ? (
              <BitsSuggestionPanel
                bits={bits}
                compositionClips={compositionClips}
                onCreateReel={(label, startMs, endMs) => {
                  createReel(label, startMs, endMs);
                  setShowBitsPanel(false);
                }}
              />
            ) : (
              <ReelRightPanel reelId={activeReelId} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
