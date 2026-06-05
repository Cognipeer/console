import { NextResponse, type NextRequest } from '@/server/api/http';
import { listPrompts } from '@/lib/services/prompts';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { getDatabase } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('prompts-stats');

export async function GET(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const projectContext = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const prompts = await listPrompts(tenantDbName, projectContext.projectId, {});

    // Fetch all versions for each prompt concurrently
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const versionCounts = await Promise.all(
      prompts.map((p) =>
        db
          .listPromptVersions(p.id, projectContext.projectId)
          .then((versions) => versions.length)
          .catch(() => 0),
      ),
    );

    const totalVersions = versionCounts.reduce((sum, c) => sum + c, 0);
    const totalVariablePrompts = prompts.filter((p) => /{{\s*\w+\s*}}/.test(p.template)).length;

    const recentlyUpdated = [...prompts]
      .sort((a, b) => {
        const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return tb - ta;
      })
      .slice(0, 6)
      .map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        currentVersion: p.currentVersion ?? 1,
        updatedAt: p.updatedAt,
        createdAt: p.createdAt,
      }));

    // Distribution by version count
    const versionDistribution = [
      { label: '1 version', count: versionCounts.filter((c) => c <= 1).length },
      { label: '2-5 versions', count: versionCounts.filter((c) => c >= 2 && c <= 5).length },
      { label: '6+ versions', count: versionCounts.filter((c) => c > 5).length },
    ];

    return NextResponse.json({
      overview: {
        totalPrompts: prompts.length,
        totalVersions,
        totalVariablePrompts,
        avgVersionsPerPrompt: prompts.length > 0 ? Math.round((totalVersions / prompts.length) * 10) / 10 : 0,
      },
      recentlyUpdated,
      versionDistribution,
    });
  } catch (error: unknown) {
    logger.error('Stats error', { error });
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
