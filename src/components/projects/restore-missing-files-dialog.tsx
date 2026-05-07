'use client';

import { useState } from 'react';
import { Copy, Check, AlertTriangle, Info, Wrench } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export interface CopyTarget {
  role: string;
  fileName: string;
  originalName?: string;
  size?: number;
  relativePath: string;
  originalPath?: string;
  destinationPath: string;
  tier: 'required' | 'recommended' | 'regenerable';
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string;
  projectId: string;
  projectDir?: string;
  requiredFiles: CopyTarget[];
  recommendedFiles: CopyTarget[];
  regenerableFiles: CopyTarget[];
  onContinue?: () => void;
}

function formatSize(bytes?: number): string {
  if (bytes === undefined) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function CopyableField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };
  return (
    <div className="flex items-start gap-2 text-[11px]">
      <span className="text-muted-foreground w-16 flex-shrink-0 pt-0.5">{label}</span>
      <code className="flex-1 break-all bg-muted/40 px-1.5 py-0.5 rounded font-mono text-foreground/90">
        {value}
      </code>
      <button
        onClick={copy}
        className="flex-shrink-0 p-1 text-muted-foreground hover:text-foreground rounded hover:bg-muted/40"
        title="Copiar al portapapeles"
        aria-label="Copy"
      >
        {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}

function FileGroup({
  title,
  description,
  files,
  icon,
  tone,
}: {
  title: string;
  description: string;
  files: CopyTarget[];
  icon: React.ReactNode;
  tone: 'required' | 'recommended' | 'regenerable';
}) {
  if (files.length === 0) return null;
  const toneClass =
    tone === 'required' ? 'border-red-500/40 bg-red-500/5'
    : tone === 'recommended' ? 'border-yellow-500/40 bg-yellow-500/5'
    : 'border-blue-500/40 bg-blue-500/5';

  return (
    <div className={`rounded-lg border ${toneClass} p-3 space-y-2`}>
      <div className="flex items-start gap-2">
        {icon}
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium">{title} <span className="text-muted-foreground font-normal">({files.length})</span></h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">{description}</p>
        </div>
      </div>

      <div className="space-y-3 pl-6">
        {files.map((f, i) => (
          <div key={`${f.fileName}-${i}`} className="space-y-1 border-t border-border/50 first:border-t-0 first:pt-0 pt-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-medium truncate">
                {f.originalName || f.fileName}
                <span className="text-muted-foreground font-normal ml-2">({f.role}, {formatSize(f.size)})</span>
              </div>
            </div>
            {f.originalPath && (
              <CopyableField label="Origen" value={f.originalPath} />
            )}
            <CopyableField label="Destino" value={f.destinationPath} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function RestoreMissingFilesDialog({
  open,
  onOpenChange,
  projectName,
  projectId,
  projectDir,
  requiredFiles,
  recommendedFiles,
  regenerableFiles,
  onContinue,
}: Props) {
  const total = requiredFiles.length + recommendedFiles.length + regenerableFiles.length;

  // Build a one-shot bash script the user can copy and run on the new machine
  // (assuming both machines are mounted under the same user, which is common
  // for the user's setup with external drives / file sharing).
  const bashScript = [
    `# Restored project: ${projectName}`,
    `# Project directory on this machine: ${projectDir ?? '(unknown)'}`,
    '',
    '# Required files (project will not work without these):',
    ...requiredFiles.map((f) => `cp "${f.originalPath ?? f.fileName}" "${f.destinationPath}"`),
    '',
    '# Recommended files (skip re-running audio prep):',
    ...recommendedFiles.map((f) => `cp "${f.originalPath ?? f.fileName}" "${f.destinationPath}"`),
    '',
    '# Regenerable files (the muxed video — re-run Sync & Mix → Mux instead if you prefer):',
    ...regenerableFiles.map((f) => `cp "${f.originalPath ?? f.fileName}" "${f.destinationPath}"`),
  ].join('\n');

  const [scriptCopied, setScriptCopied] = useState(false);
  const copyScript = async () => {
    try {
      await navigator.clipboard.writeText(bashScript);
      setScriptCopied(true);
      setTimeout(() => setScriptCopied(false), 1500);
    } catch { /* ignore */ }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Proyecto restaurado: {projectName}</DialogTitle>
          <DialogDescription>
            {total === 0
              ? 'Restauración completa. No faltan archivos.'
              : 'project.json y los archivos pequeños se han restaurado. Para terminar, copia los archivos de media desde la máquina origen a las rutas que se indican abajo.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <FileGroup
            title="Imprescindibles"
            description="El proyecto no abrirá correctamente sin estos archivos. Cópialos antes de empezar a editar."
            files={requiredFiles}
            tone="required"
            icon={<AlertTriangle className="h-4 w-4 text-red-400 mt-0.5 flex-shrink-0" />}
          />

          <FileGroup
            title="Recomendados"
            description="Audio de trabajo (extracted, aligned, mix, amplified). Si no los copias, tendrás que volver a ejecutar los pasos de audio en la pestaña Audio Prep (5–15 min)."
            files={recommendedFiles}
            tone="recommended"
            icon={<Info className="h-4 w-4 text-yellow-400 mt-0.5 flex-shrink-0" />}
          />

          <FileGroup
            title="Regenerables"
            description="Vídeo muxado. Si no lo copias, regenéralo con Sync & Mix → Mux (~30 s)."
            files={regenerableFiles}
            tone="regenerable"
            icon={<Wrench className="h-4 w-4 text-blue-400 mt-0.5 flex-shrink-0" />}
          />

          {total > 0 && (
            <div className="rounded-lg border border-border bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <h3 className="text-sm font-medium">Script bash para copiar todo</h3>
                <Button size="sm" variant="outline" onClick={copyScript}>
                  {scriptCopied ? <Check className="h-3 w-3 mr-1 text-green-500" /> : <Copy className="h-3 w-3 mr-1" />}
                  Copiar script
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground mb-2">
                Si la máquina origen es accesible (montaje, disco externo, ssh con rutas idénticas), pega esto en una terminal en la máquina destino:
              </p>
              <pre className="text-[10px] font-mono bg-background/50 border border-border rounded p-2 overflow-x-auto max-h-40">
                {bashScript}
              </pre>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cerrar
          </Button>
          <Button onClick={() => { onOpenChange(false); onContinue?.(); }}>
            Abrir proyecto
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Re-export the project ID consumer for use by callers
export type { Props as RestoreMissingFilesDialogProps };
