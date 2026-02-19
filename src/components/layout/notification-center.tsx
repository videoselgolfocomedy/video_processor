'use client';

import { useEffect, useRef } from 'react';
import { useJobStore } from '@/stores/job-store';
import { useToast } from '@/hooks/use-toast';

/**
 * Background component that monitors job completions and shows toast notifications.
 * Place in a layout to auto-notify users of completed background processes.
 */
export function NotificationCenter() {
  const { jobs } = useJobStore();
  const { toast } = useToast();
  const notifiedRef = useRef(new Set<string>());

  useEffect(() => {
    jobs.forEach((job) => {
      if (notifiedRef.current.has(job.id)) return;

      if (job.status === 'done') {
        notifiedRef.current.add(job.id);
        toast({
          title: `${job.type} completed`,
          description: job.message || 'Process finished successfully',
        });
      } else if (job.status === 'error') {
        notifiedRef.current.add(job.id);
        toast({
          title: `${job.type} failed`,
          description: job.error || 'An error occurred',
          variant: 'destructive',
        });
      }
    });
  }, [jobs, toast]);

  return null;
}
