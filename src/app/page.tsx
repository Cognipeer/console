'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Center, Loader } from '@mantine/core';

export default function Home() {
  const router = useRouter();
  // Check if user is already authenticated
  useEffect(() => {
    const checkAuth = async () => {
      try {
        // Try to access a protected endpoint to check if user is authenticated
        const response = await fetch('/api/tokens', {
          method: 'GET',
          credentials: 'include', // Include cookies
        });

        if (response.ok) {
          // User is authenticated, redirect to dashboard
          router.push('/dashboard');
          return;
        }
      } catch {
        router.push('/dashboard');
      } finally {
        router.push('/dashboard');
      }
    };

    checkAuth();
  }, [router]);

  return (
    <Center style={{ height: '100vh', width: '100vw' }}>
      <Loader size="lg" />
    </Center>
  );
}
