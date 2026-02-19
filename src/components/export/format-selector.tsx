'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

interface FormatSelectorProps {
  width: number;
  height: number;
  fps: number;
  crf: number;
  onWidthChange: (v: number) => void;
  onHeightChange: (v: number) => void;
  onFpsChange: (v: number) => void;
  onCrfChange: (v: number) => void;
}

export function FormatSelector({
  width,
  height,
  fps,
  crf,
  onWidthChange,
  onHeightChange,
  onFpsChange,
  onCrfChange,
}: FormatSelectorProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Custom Settings</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label className="text-xs">Width</Label>
            <Input
              type="number"
              value={width}
              onChange={(e) => onWidthChange(parseInt(e.target.value) || 0)}
              className="h-8 text-sm"
            />
          </div>
          <div>
            <Label className="text-xs">Height</Label>
            <Input
              type="number"
              value={height}
              onChange={(e) => onHeightChange(parseInt(e.target.value) || 0)}
              className="h-8 text-sm"
            />
          </div>
          <div>
            <Label className="text-xs">FPS</Label>
            <Input
              type="number"
              value={fps}
              onChange={(e) => onFpsChange(parseInt(e.target.value) || 0)}
              className="h-8 text-sm"
            />
          </div>
          <div>
            <Label className="text-xs">CRF (Quality)</Label>
            <div className="space-y-1">
              <Input
                type="number"
                value={crf}
                min={0}
                max={51}
                onChange={(e) => onCrfChange(parseInt(e.target.value) || 0)}
                className="h-8 text-sm"
              />
              <p className="text-[10px] text-muted-foreground">
                Lower = higher quality. 18-23 recommended.
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
