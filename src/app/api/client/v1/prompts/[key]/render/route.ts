import { NextRequest, NextResponse } from 'next/server';
import Mustache from 'mustache';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { getPromptByKey } from '@/lib/services/prompts';

export const runtime = 'nodejs';

function handleError(error: unknown, scope: string) {
	if (error instanceof ApiTokenAuthError) {
		return NextResponse.json({ error: error.message }, { status: error.status });
	}

	console.error(`${scope} error`, error);
	return NextResponse.json(
		{ error: error instanceof Error ? error.message : 'Internal server error' },
		{ status: 500 },
	);
}

export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ key: string }> },
) {
	try {
		const { tenantDbName, projectId } = await requireApiToken(request);
		const { key } = await params;

		if (!key) {
			return NextResponse.json({ error: 'Prompt key is required' }, { status: 400 });
		}

		const prompt = await getPromptByKey(tenantDbName, projectId, key);
		if (!prompt) {
			return NextResponse.json({ error: 'Prompt not found' }, { status: 404 });
		}

		const body = await request.json().catch(() => ({} as Record<string, unknown>));
		const rawData = (body && typeof body === 'object' && 'data' in body)
			? (body as { data?: Record<string, unknown> }).data
			: body;

		const data = rawData && typeof rawData === 'object' ? rawData : {};

		const rendered = Mustache.render(prompt.template, data as Record<string, unknown>);

		return NextResponse.json({
			rendered,
			prompt: {
				key: prompt.key,
				name: prompt.name,
				version: prompt.currentVersion ?? 1,
			},
		}, { status: 200 });
	} catch (error) {
		return handleError(error, 'Client render prompt');
	}
}
