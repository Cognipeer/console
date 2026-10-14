// Next types useParams, useSearchParams and usePathname as possibly null when the project also has a
// pages/ directory, and the enterprise edition adds one (its embeddable frame). This file applies the same
// types here, so code that compiles in this repository also compiles there. Under app/ the hooks never
// return null: assert it at the call (`useParams<{ id: string }>()!`).
/// <reference types="next/navigation-types/compat/navigation" />
