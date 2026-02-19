import { NextResponse } from 'next/server';
import { getSystemStatus } from '@/server/system-check';

export async function GET() {
  try {
    const status = await getSystemStatus();
    return NextResponse.json(status);
  } catch {
    return NextResponse.json(
      { error: 'Failed to check system status' },
      { status: 500 }
    );
  }
}
