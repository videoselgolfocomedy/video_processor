'use client';

import { useState, useCallback } from 'react';

interface UploadState {
  uploading: boolean;
  progress: number;
  error: string | null;
}

export function useUpload(projectId: string) {
  const [state, setState] = useState<UploadState>({
    uploading: false,
    progress: 0,
    error: null,
  });

  const upload = useCallback(
    async (
      files: File[],
      role: 'camera' | 'board' | 'other' = 'other'
    ): Promise<boolean> => {
      setState({ uploading: true, progress: 0, error: null });

      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const formData = new FormData();
          formData.append('file', file);
          formData.append('role', role);

          const xhr = new XMLHttpRequest();

          await new Promise<void>((resolve, reject) => {
            xhr.upload.addEventListener('progress', (e) => {
              if (e.lengthComputable) {
                const fileProgress = (e.loaded / e.total) * 100;
                const overallProgress =
                  ((i + fileProgress / 100) / files.length) * 100;
                setState((s) => ({ ...s, progress: overallProgress }));
              }
            });

            xhr.addEventListener('load', () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                resolve();
              } else {
                // Read the actual error message from the JSON response body
                let msg = xhr.statusText;
                try {
                  const body = JSON.parse(xhr.responseText);
                  if (body.error) msg = body.error;
                } catch { /* use statusText fallback */ }
                reject(new Error(`Upload failed: ${msg}`));
              }
            });

            xhr.addEventListener('error', () =>
              reject(new Error('Upload failed'))
            );

            xhr.open('POST', `/api/projects/${projectId}/upload`);
            xhr.send(formData);
          });
        }

        setState({ uploading: false, progress: 100, error: null });
        return true;
      } catch (err) {
        setState({
          uploading: false,
          progress: 0,
          error: (err as Error).message,
        });
        return false;
      }
    },
    [projectId]
  );

  return { ...state, upload };
}
