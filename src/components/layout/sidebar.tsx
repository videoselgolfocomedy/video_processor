'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Music,
  Subtitles,
  Download,
  LayoutDashboard,
  FolderInput,
  Layers,
  Smartphone,
  Menu,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface SidebarProps {
  projectId: string;
}

const navItems = [
  { href: '', label: 'Overview', icon: LayoutDashboard },
  { href: '/import', label: 'Importar', icon: FolderInput },
  { href: '/audio-prep', label: 'Audio', icon: Music },
  { href: '/transcription', label: 'Transcription', icon: Subtitles },
  { href: '/compose', label: 'Compose', icon: Layers },
  { href: '/reels', label: 'Reels', icon: Smartphone },
  { href: '/export', label: 'Export', icon: Download },
];

export function Sidebar({ projectId }: SidebarProps) {
  const pathname = usePathname();
  const basePath = `/project/${projectId}`;
  const [mobileOpen, setMobileOpen] = useState(false);

  const navContent = (
    <nav className="flex flex-1 flex-col gap-1 p-2">
      {navItems.map((item) => {
        const href = `${basePath}${item.href}`;
        const isActive =
          item.href === ''
            ? pathname === basePath
            : pathname.startsWith(href);

        return (
          <Link
            key={item.href}
            href={href}
            onClick={() => setMobileOpen(false)}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
              isActive
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
            )}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <>
      {/* Mobile hamburger button */}
      <button
        className="fixed left-3 top-14 z-50 flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card lg:hidden"
        onClick={() => setMobileOpen(!mobileOpen)}
        aria-label="Toggle menu"
      >
        {mobileOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile sidebar */}
      <aside
        className={cn(
          'fixed left-0 top-12 z-40 h-[calc(100vh-3rem)] w-48 border-r border-border bg-card transition-transform lg:hidden',
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {navContent}
      </aside>

      {/* Desktop sidebar */}
      <aside className="hidden w-48 flex-col border-r border-border bg-card lg:flex">
        {navContent}
      </aside>
    </>
  );
}
