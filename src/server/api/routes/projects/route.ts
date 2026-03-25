import { NextResponse, type NextRequest } from '@/server/api/http';
import { getDatabase } from '@/lib/database';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import {
    ensureDefaultProject,
    generateUniqueProjectKey,
    listAccessibleProjects,
    DEFAULT_PROJECT_KEY,
} from '@/lib/services/projects/projectService';

const logger = createLogger('projects');

function ensureTenantContext(request: NextRequest) {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');
    const userRole = request.headers.get('x-user-role');
    const tenantSlug = request.headers.get('x-tenant-slug');

    if (!tenantDbName || !tenantId || !userId || !userRole) {
        return { error: { message: 'Unauthorized' } } as const;
    }

    return { tenantDbName, tenantId, userId, userRole, tenantSlug } as const;
}

export async function GET(request: NextRequest) {
    try {
        const ctx = ensureTenantContext(request);
        if ('error' in ctx) {
            return NextResponse.json(ctx.error, { status: 401 });
        }

        const db = await getDatabase();
        await db.switchToTenant(ctx.tenantDbName);

        const user = await db.findUserById(ctx.userId);
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        await ensureDefaultProject(ctx.tenantDbName, ctx.tenantId, ctx.userId);

        const projects = await listAccessibleProjects(ctx.tenantDbName, ctx.tenantId, {
            role: user.role,
            projectIds: user.projectIds,
        });

        const activeCookie = request.cookies.get('active_project_id')?.value;
        const cookieIsValid =
            activeCookie && projects.some((p) => String(p._id) === String(activeCookie));

        const cookieProject = cookieIsValid
            ? projects.find((p) => String(p._id) === String(activeCookie))
            : undefined;
        const hasNonDefaultProjects = projects.some((p) => p.key !== DEFAULT_PROJECT_KEY);
        const cookieIsDefault = Boolean(
            cookieProject?.key === DEFAULT_PROJECT_KEY && hasNonDefaultProjects,
        );

        const preferredProject = cookieIsValid && !cookieIsDefault
            ? projects.find((p) => String(p._id) === String(activeCookie))
            : (projects.find((p) => p.key !== DEFAULT_PROJECT_KEY) ?? projects[0]);

        const activeProjectId = preferredProject?._id
            ? String(preferredProject._id)
            : undefined;

        const response = NextResponse.json(
            {
                projects,
                activeProjectId,
            },
            { status: 200 },
        );

        if ((activeCookie && !cookieIsValid) || cookieIsDefault) {
            const isProduction = getConfig().nodeEnv === 'production';
            if (activeProjectId) {
                response.cookies.set('active_project_id', activeProjectId, {
                    httpOnly: false,
                    secure: isProduction,
                    sameSite: 'lax',
                    maxAge: 60 * 60 * 24 * 30,
                    path: '/',
                });
            } else {
                response.cookies.set('active_project_id', '', {
                    httpOnly: false,
                    secure: isProduction,
                    sameSite: 'lax',
                    maxAge: 0,
                    path: '/',
                });
            }
        }

        return response;
    } catch (error) {
        logger.error('List projects error', { error });
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const ctx = ensureTenantContext(request);
        if ('error' in ctx) {
            return NextResponse.json(ctx.error, { status: 401 });
        }
        if (ctx.userRole !== 'owner' && ctx.userRole !== 'admin') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const body = (await request.json()) as {
            name?: string;
            key?: string;
            description?: string;
        };

        if (!body?.name || typeof body.name !== 'string' || body.name.trim().length < 2) {
            return NextResponse.json({ error: 'name is required' }, { status: 400 });
        }

        const projectKey = await generateUniqueProjectKey(
            ctx.tenantDbName,
            ctx.tenantId,
            body.key || body.name,
        );

        const db = await getDatabase();
        await db.switchToTenant(ctx.tenantDbName);

        const project = await db.createProject({
            tenantId: ctx.tenantId,
            key: projectKey,
            name: body.name.trim(),
            description: body.description,
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
        });

        return NextResponse.json({ project }, { status: 201 });
    } catch (error) {
        logger.error('Create project error', { error });
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
