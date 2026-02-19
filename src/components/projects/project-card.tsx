'use client';

import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import { Trash2, Film, Music, Subtitles } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { ProjectState } from '@/types/project';

interface ProjectCardProps {
  project: ProjectState;
  onDelete: (id: string) => void;
}

export function ProjectCard({ project, onDelete }: ProjectCardProps) {
  const sourceCount = project.sources.length;
  const hasAudio = project.audio.extractedTracks.length > 0;
  const hasTranscription = project.transcription.segments.length > 0;

  return (
    <Card className="group relative transition-colors hover:border-primary/30">
      <Link href={`/project/${project.id}`}>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{project.name}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {formatDistanceToNow(new Date(project.updatedAt), {
              addSuffix: true,
              locale: es,
            })}
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Film className="h-3 w-3" />
              {sourceCount} {sourceCount === 1 ? 'archivo' : 'archivos'}
            </span>
            {hasAudio && (
              <span className="flex items-center gap-1">
                <Music className="h-3 w-3 text-green-500" />
                Audio
              </span>
            )}
            {hasTranscription && (
              <span className="flex items-center gap-1">
                <Subtitles className="h-3 w-3 text-blue-500" />
                Subs
              </span>
            )}
          </div>
        </CardContent>
      </Link>
      <Button
        variant="ghost"
        size="icon"
        className="absolute right-2 top-2 h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDelete(project.id);
        }}
      >
        <Trash2 className="h-3.5 w-3.5 text-destructive" />
      </Button>
    </Card>
  );
}
