'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Center, Loader } from '@mantine/core';

export default function Home() {
  const router = useRouter();
  const [checkingAuth, setCheckingAuth] = useState(true);

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
      } catch (error) {
        router.push('/dashboard');
      } finally {
        router.push('/dashboard');
      }
    };

    checkAuth();
  }, [router]);

  // Show loading state while checking authentication
  if (checkingAuth) {
    return (
      <Center style={{ height: '100vh', width: '100vw' }}>
        <Loader size="lg" />
      </Center>
    );
  }

  return null;
}
