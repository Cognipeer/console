'use client';

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import { Group, Loader } from '@mantine/core';
import PrincipalDetailPage from '@/components/iam/principals/PrincipalDetailPage';
import { useIamCapabilities } from '@/components/iam/useIamCapabilities';

/** A person, a group or a token of the IAM center, on a page of its own. */
function Body() {
  const params = useParams<{ type: string; id: string }>();
  const { canManage, ready } = useIamCapabilities();
  if (!ready) {
    return (
      <Group justify="center" py="xl">
        <Loader size="sm" />
      </Group>
    );
  }
  return <PrincipalDetailPage type={params.type} id={decodeURIComponent(params.id)} canManage={canManage} />;
}

export default function IamPrincipalPage() {
  return (
    <Suspense
      fallback={
        <Group justify="center" py="xl">
          <Loader size="sm" />
        </Group>
      }
    >
      <Body />
    </Suspense>
  );
}
