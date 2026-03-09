'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

/** Redirect old /subtitles route to new /transcription route */
export default function SubtitlesRedirect() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  useEffect(() => {
    router.replace(`/project/${projectId}/transcription`);
  }, [projectId, router]);

  return null;
}
