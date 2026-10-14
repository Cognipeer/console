import Link from 'next/link';

/**
 * Community stub. The enterprise overlay replaces this page with the real
 * portal chat; here the route only exists so a shared /p/<key> link lands on an
 * explanation instead of a bare 404. Kept free of enterprise imports.
 */
export default function PortalUnavailablePage() {
  return (
    <div
      style={{
        alignItems: 'center',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        justifyContent: 'center',
        minHeight: '100vh',
        padding: 32,
        textAlign: 'center',
      }}
    >
      <h2 style={{ margin: 0 }}>Portals require the Enterprise edition</h2>
      <p style={{ maxWidth: 480, opacity: 0.75 }}>
        This link points to a Cognipeer Console portal, a feature of the Enterprise edition that
        is not available in this installation.
      </p>
      <Link href="/dashboard" style={{ fontWeight: 600 }}>
        Go to the console
      </Link>
    </div>
  );
}
