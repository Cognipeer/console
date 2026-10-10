'use client';

/**
 * Who is looking at the page — `GET /api/auth/session`, asked once per page
 * load and shared by everything that needs it. Only used to say beforehand what
 * the server would refuse anyway (`answerRestriction`), so a failed lookup is
 * simply "unknown", never an error.
 */

import { useEffect, useState } from 'react';

export interface Viewer {
    userId?: string;
    /** The tenant role (`owner`, `admin`, `project_admin`, `user`). */
    role?: string;
}

let lookup: Promise<Viewer> | null = null;

function loadViewer(): Promise<Viewer> {
    if (!lookup) {
        lookup = fetch('/api/auth/session', { cache: 'no-store' })
            .then((res) => (res.ok ? res.json() : {}))
            .then((data: { userId?: unknown; role?: unknown }) => ({
                ...(typeof data.userId === 'string' ? { userId: data.userId } : {}),
                ...(typeof data.role === 'string' ? { role: data.role } : {}),
            }))
            .catch(() => {
                // Ask again next time rather than remembering the failure.
                lookup = null;
                return {};
            });
    }
    return lookup;
}

/** Forgets the lookup, so the next `useViewer` asks again (a different person signed in; a test). */
export function resetViewer(): void {
    lookup = null;
}

export function useViewer(): Viewer {
    const [viewer, setViewer] = useState<Viewer>({});
    useEffect(() => {
        let active = true;
        void loadViewer().then((found) => { if (active) setViewer(found); });
        return () => { active = false; };
    }, []);
    return viewer;
}
