import Link from 'next/link';

/**
 * Community stub for the portal chooser. The enterprise overlay replaces this page
 * with the list of portals open to the signed-in person; here it only explains why
 * there is nothing to choose from. Kept free of enterprise imports.
 */
export default function PortalIndexUnavailablePage() {
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
        Portals are a feature of the Enterprise edition that is not available in this installation.
      </p>
      <Link href="/dashboard" style={{ fontWeight: 600 }}>
        Go to the console
      </Link>
    </div>
  );
}
