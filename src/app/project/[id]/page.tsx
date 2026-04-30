'use client';

import { useProjectStore } from '@/stores/project-store';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Music, Subtitles, Download, Film, Layers, Smartphone, Archive } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatFileSize } from '@/lib/utils';
import { StoragePanel } from '@/components/project/storage-panel';
import Link from 'next/link';
import { useParams } from 'next/navigation';

export default function ProjectOverviewPage() {
  const { currentProject } = useProjectStore();
  const params = useParams();
  const projectId = params.id as string;

  if (!currentProject) return null;

  const modules = [
    {
      href: `/project/${projectId}/audio-prep`,
      icon: Music,
      title: 'Audio',
      description: 'Extract, subtract, detect laughter, sync & mix',
      status: currentProject.sync.status === 'done' || currentProject.audio.extractedTracks.length > 0 ? 'done' : 'pending',
    },
    {
      href: `/project/${projectId}/transcription`,
      icon: Subtitles,
      title: 'Transcription',
      description: 'Transcribe, refine with AI, auto-split',
      status: currentProject.transcription.segments.length > 0 ? 'done' : 'pending',
    },
    {
      href: `/project/${projectId}/compose`,
      icon: Layers,
      title: 'Compose (YouTube)',
      description: 'Timeline, cutaways, subtitle styling (16:9)',
      status: currentProject.composition.clips.length > 0 ? 'done' : 'pending',
    },
    {
      href: `/project/${projectId}/reels`,
      icon: Smartphone,
      title: 'Reels (9:16)',
      description: 'Create reels with crop, timeline & subtitles',
      status: currentProject.reels.length > 0 ? 'done' : 'pending',
    },
    {
      href: `/project/${projectId}/export`,
      icon: Download,
      title: 'Export',
      description: 'Render YouTube + individual reels',
      status: currentProject.exports.some((e) => e.status === 'done') ? 'done' : 'pending',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{currentProject.name}</h2>
          <p className="text-sm text-muted-foreground">
            {currentProject.sources.length} source files
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            window.open(`/api/projects/${projectId}/backup`, '_blank');
          }}
          title="Descargar backup del proyecto (sin videos fuente)"
        >
          <Archive className="mr-1.5 h-4 w-4" />
          Backup
        </Button>
      </div>

      {/* Source files summary */}
      {currentProject.sources.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Source Files</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {currentProject.sources.map((src) => (
                <div
                  key={src.id}
                  className="flex items-center gap-3 text-sm"
                >
                  <Film className="h-4 w-4 text-muted-foreground" />
                  <span className="flex-1 truncate">{src.originalName}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatFileSize(src.size)}
                  </span>
                  <span className="rounded bg-secondary px-2 py-0.5 text-xs">
                    {src.role}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Module cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {modules.map((mod) => (
          <Link key={mod.href} href={mod.href}>
            <Card className="transition-colors hover:border-primary/30">
              <CardContent className="flex items-start gap-4 pt-6">
                <div
                  className={`rounded-lg p-2 ${
                    mod.status === 'done'
                      ? 'bg-green-500/10 text-green-500'
                      : 'bg-secondary text-muted-foreground'
                  }`}
                >
                  <mod.icon className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-medium">{mod.title}</h3>
                  <p className="text-sm text-muted-foreground">
                    {mod.description}
                  </p>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {/* Storage / intermediate files */}
      <StoragePanel projectId={projectId} />
    </div>
  );
}
