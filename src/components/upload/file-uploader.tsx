'use client';

import { useCallback, useRef, useState } from 'react';
import { Upload, FileVideo, FileAudio, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn, formatFileSize } from '@/lib/utils';
import { SUPPORTED_EXTENSIONS } from '@/lib/constants';

interface FileUploaderProps {
  onUpload: (files: File[], role: 'camera' | 'board' | 'other') => Promise<boolean>;
  uploading: boolean;
  progress: number;
  error: string | null;
}

export function FileUploader({ onUpload, uploading, progress, error }: FileUploaderProps) {
  const [dragOver, setDragOver] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [role, setRole] = useState<'camera' | 'board' | 'other'>('camera');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => {
      const ext = '.' + f.name.split('.').pop()?.toLowerCase();
      return SUPPORTED_EXTENSIONS.includes(ext);
    });
    setSelectedFiles((prev) => [...prev, ...files]);
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setSelectedFiles((prev) => [...prev, ...Array.from(e.target.files!)]);
    }
  }, []);

  const removeFile = useCallback((index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleUpload = useCallback(async () => {
    if (selectedFiles.length === 0) return;
    const success = await onUpload(selectedFiles, role);
    if (success) setSelectedFiles([]);
  }, [selectedFiles, role, onUpload]);

  const isVideo = (name: string) => {
    const ext = '.' + name.split('.').pop()?.toLowerCase();
    return ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext);
  };

  return (
    <div className="space-y-4">
      {/* Drop zone */}
      <div
        className={cn(
          'flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors',
          dragOver
            ? 'border-primary bg-primary/5'
            : 'border-border hover:border-muted-foreground/50'
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="mb-3 h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Arrastra archivos aquí o haz clic para buscar
        </p>
        <p className="text-xs text-muted-foreground/70">
          Video: MP4, MOV, AVI, MKV | Audio: WAV, MP3, AAC, FLAC
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={SUPPORTED_EXTENSIONS.join(',')}
          onChange={handleFileSelect}
          className="hidden"
        />
      </div>

      {/* Role selector */}
      {selectedFiles.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Rol:</span>
          {(['camera', 'board', 'other'] as const).map((r) => (
            <Button
              key={r}
              variant={role === r ? 'default' : 'outline'}
              size="sm"
              onClick={() => setRole(r)}
            >
              {r === 'camera' ? 'Cámara' : r === 'board' ? 'Mesa' : 'Otro'}
            </Button>
          ))}
        </div>
      )}

      {/* File list */}
      {selectedFiles.length > 0 && (
        <div className="space-y-2">
          {selectedFiles.map((file, i) => (
            <div
              key={`${file.name}-${i}`}
              className="flex items-center gap-3 rounded-md bg-secondary p-2 text-sm"
            >
              {isVideo(file.name) ? (
                <FileVideo className="h-4 w-4 text-blue-400" />
              ) : (
                <FileAudio className="h-4 w-4 text-green-400" />
              )}
              <span className="flex-1 truncate">{file.name}</span>
              <span className="text-xs text-muted-foreground">
                {formatFileSize(file.size)}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => removeFile(i)}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Upload button and progress */}
      {selectedFiles.length > 0 && (
        <div className="space-y-2">
          {uploading && <Progress value={progress} className="h-2" />}
          <Button
            onClick={handleUpload}
            disabled={uploading || selectedFiles.length === 0}
            className="w-full"
          >
            {uploading
              ? `Subiendo... ${Math.round(progress)}%`
              : `Subir ${selectedFiles.length} archivo${selectedFiles.length > 1 ? 's' : ''}`}
          </Button>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
