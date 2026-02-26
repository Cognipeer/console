import { NextRequest, NextResponse } from 'next/server';
import Mustache from 'mustache';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { resolvePromptForEnvironment, type PromptEnvironment } from '@/lib/services/prompts';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('client-prompts');

export const runtime = 'nodejs';

function handleError(error: unknown, scope: string) {
	if (error instanceof ApiTokenAuthError) {
		return NextResponse.json({ error: error.message }, { status: error.status });
	}

	logger.error(`${scope} error`, { error });
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
		const { searchParams } = new URL(request.url);
		const rawEnvironment = searchParams.get('environment');
		const environment = rawEnvironment as PromptEnvironment | null;
		const versionParam = searchParams.get('version');
		const version = versionParam !== null ? Number.parseInt(versionParam, 10) : undefined;

		if (!key) {
			return NextResponse.json({ error: 'Prompt key is required' }, { status: 400 });
		}

		if (environment && !['dev', 'staging', 'prod'].includes(environment)) {
			return NextResponse.json({ error: 'Invalid environment' }, { status: 400 });
		}

		if (versionParam !== null && (!Number.isFinite(version) || (version as number) <= 0)) {
			return NextResponse.json({ error: 'Invalid version' }, { status: 400 });
		}

		const resolved = await resolvePromptForEnvironment(
			tenantDbName,
			projectId,
			key,
			environment ?? undefined,
			version,
		);

		if (!resolved) {
			return NextResponse.json({ error: 'Prompt not found' }, { status: 404 });
		}

		const body = await request.json().catch(() => ({} as Record<string, unknown>));
		const rawData = (body && typeof body === 'object' && 'data' in body)
			? (body as { data?: Record<string, unknown> }).data
			: body;

		const data = rawData && typeof rawData === 'object' ? rawData : {};

		const rendered = Mustache.render(resolved.prompt.template, data as Record<string, unknown>);

		return NextResponse.json({
			rendered,
			prompt: {
				key: resolved.prompt.key,
				name: resolved.prompt.name,
				version: resolved.prompt.currentVersion ?? 1,
				environment: environment ?? null,
			},
		}, { status: 200 });
	} catch (error) {
		return handleError(error, 'Client render prompt');
	}
}
