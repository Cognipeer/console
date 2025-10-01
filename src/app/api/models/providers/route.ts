import { NextResponse } from 'next/server';
import { getProviderDefinitions } from '@/lib/services/models/modelService';

export const runtime = 'nodejs';

export async function GET() {
    console.log('Fetching model provider definitions');
    return NextResponse.json({ providers: await getProviderDefinitions() });
}
