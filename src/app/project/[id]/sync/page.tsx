'use client';

import { useParams } from 'next/navigation';
import { PartsFlow } from '@/components/parts/parts-flow';

/**
 * Sync & Mix — the parts pipeline (align → level voice → mix → mux → join),
 * for one camera+board pair (a single part) or several. The previous
 * single-pair mixer lives on at /sync-legacy, linked below the header.
 */
export default function SyncPage() {
  const params = useParams();
  const projectId = params.id as string;

  return (
    <PartsFlow
      title="Sync & Mix"
      description="Une cada vídeo con su audio de mesa: alinear → nivelar la voz → mezclar con el ambiente → mux. Con un solo par cámara+mesa crea una única parte; con varias grabaciones, una parte por trozo y se unen al final en el orden definido."
      legacyHref={`/project/${projectId}/sync-legacy`}
    />
  );
}
