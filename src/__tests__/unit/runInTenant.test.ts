import { describe, expect, it, vi } from 'vitest';
import { runInTenant } from '@/lib/database/runInTenant';
import type { DatabaseProvider } from '@/lib/database/provider.interface';

describe('runInTenant', () => {
  it('binds fn through runWithTenant when the provider has it', async () => {
    const runWithTenant = vi.fn(async (_name: string, cb: () => unknown) => cb());
    const switchToTenant = vi.fn();
    const db = { runWithTenant, switchToTenant } as unknown as DatabaseProvider;
    const result = await runInTenant(db, 'tenant_a', async (d) => (d === db ? 'same-db' : 'other'));
    expect(result).toBe('same-db');
    expect(runWithTenant).toHaveBeenCalledWith('tenant_a', expect.any(Function));
    expect(switchToTenant).not.toHaveBeenCalled();
  });

  it('falls back to switchToTenant for providers without runWithTenant', async () => {
    const switchToTenant = vi.fn(async () => undefined);
    const db = { switchToTenant } as unknown as DatabaseProvider;
    const result = await runInTenant(db, 'tenant_b', () => 42);
    expect(result).toBe(42);
    expect(switchToTenant).toHaveBeenCalledWith('tenant_b');
  });
});
