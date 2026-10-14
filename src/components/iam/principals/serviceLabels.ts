'use client';

import { useMemo } from 'react';
import { RBAC_SERVICE_DEFINITIONS } from '@/lib/security/rbac';
import { isDeprecatedService } from '../catalogModel';
import { useIamCatalog } from '../useIamCatalog';
import { useIamLabels } from '../useIamLabels';

export interface ServiceOption {
  value: string;
  label: string;
}

/**
 * Display names of the RBAC services for the Principals and Audit tabs, from
 * the IAM center's shared catalog and label resolver (one cached catalog per
 * page load, the same wording as every other tab). The catalog is optional:
 * until it has loaded, or when it cannot be loaded, the labels and the service
 * filter come from the built-in service list.
 */
export function useServiceLabels(): { labelOf: (serviceId: string) => string; options: ServiceOption[] } {
  const { catalog, index } = useIamCatalog();
  const labels = useIamLabels(catalog);

  const options = useMemo<ServiceOption[]>(() => {
    const ids = index
      ? index.services.map((s) => s.id)
      : RBAC_SERVICE_DEFINITIONS.filter((d) => !isDeprecatedService(d.id)).map((d) => d.id as string);
    return [...new Set(ids)]
      .map((id) => ({ value: id, label: labels.service(id) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [index, labels]);

  return { labelOf: labels.service, options };
}
