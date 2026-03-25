'use client';

import { useState, useCallback } from 'react';
import { notifications } from '@mantine/notifications';
import type { IQuotaPolicy } from '@/lib/database/provider.interface';
import type { QuotaDomain, QuotaPolicy } from '@/lib/quota/types';
import type { QuotaPolicyFormData } from '@/components/quota/QuotaPolicyModal';

interface UseQuotaPoliciesOptions {
  domain?: QuotaDomain;
}

export function useQuotaPolicies(options: UseQuotaPoliciesOptions = {}) {
  const [policies, setPolicies] = useState<QuotaPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchPolicies = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      const params = new URLSearchParams();
      if (options.domain) {
        params.set('domain', options.domain);
      }
      
      const response = await fetch(`/api/quota/policies?${params.toString()}`);
      if (!response.ok) {
        throw new Error('Politikalar yüklenemedi');
      }
      
      const data = await response.json();
      setPolicies(data.policies || []);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Bir hata oluştu';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [options.domain]);

  const createPolicy = useCallback(async (formData: QuotaPolicyFormData): Promise<boolean> => {
    try {
      setSaving(true);
      
      const response = await fetch('/api/quota/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Politika oluşturulamadı');
      }

      notifications.show({
        title: 'Başarılı',
        message: 'Quota politikası oluşturuldu',
        color: 'green',
      });

      await fetchPolicies();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Bir hata oluştu';
      notifications.show({
        title: 'Hata',
        message,
        color: 'red',
      });
      return false;
    } finally {
      setSaving(false);
    }
  }, [fetchPolicies]);

  const updatePolicy = useCallback(async (id: string, formData: QuotaPolicyFormData): Promise<boolean> => {
    try {
      setSaving(true);
      
      const response = await fetch(`/api/quota/policies/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Politika güncellenemedi');
      }

      notifications.show({
        title: 'Başarılı',
        message: 'Quota politikası güncellendi',
        color: 'green',
      });

      await fetchPolicies();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Bir hata oluştu';
      notifications.show({
        title: 'Hata',
        message,
        color: 'red',
      });
      return false;
    } finally {
      setSaving(false);
    }
  }, [fetchPolicies]);

  const deletePolicy = useCallback(async (policy: IQuotaPolicy): Promise<boolean> => {
    try {
      setSaving(true);
      const id = policy._id?.toString();
      if (!id) return false;
      
      const response = await fetch(`/api/quota/policies/${id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Politika silinemedi');
      }

      notifications.show({
        title: 'Başarılı',
        message: 'Quota politikası silindi',
        color: 'green',
      });

      await fetchPolicies();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Bir hata oluştu';
      notifications.show({
        title: 'Hata',
        message,
        color: 'red',
      });
      return false;
    } finally {
      setSaving(false);
    }
  }, [fetchPolicies]);

  return {
    policies,
    loading,
    error,
    saving,
    fetchPolicies,
    createPolicy,
    updatePolicy,
    deletePolicy,
  };
}
