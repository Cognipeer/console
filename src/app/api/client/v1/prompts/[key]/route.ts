import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { resolvePromptForEnvironment, type PromptEnvironment } from '@/lib/services/prompts';

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

export async function GET(
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

		return NextResponse.json({
			prompt: resolved.prompt,
			resolvedVersion: resolved.resolvedVersion
				? {
					id: resolved.resolvedVersion.id,
					version: resolved.resolvedVersion.version,
					name: resolved.resolvedVersion.name,
					description: resolved.resolvedVersion.description,
					isLatest: resolved.resolvedVersion.isLatest,
				}
				: null,
		}, { status: 200 });
	} catch (error) {
		return handleError(error, 'Client get prompt');
	}
}
