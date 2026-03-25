# Getting Started

## Quick Installation (Zero Dependencies)

The fastest way to run Cognipeer Console — no external services needed:

```bash
git clone https://github.com/Cognipeer/cognipeer-console.git
cd cognipeer-console
npm install
```

Create a minimal `.env.local`:

```bash
JWT_SECRET=your-secret-key-must-be-at-least-32-characters-long
```

Start the server:

```bash
npm run dev
```

That's it! The gateway starts with **SQLite** as the database (default), storing data in the `./data` directory. No MongoDB, no Redis, no external vector database required.

> **Tip:** For production with higher concurrency, consider switching to MongoDB. See [Full Configuration](#configuration) below.

### Quick Docker Run

```bash
docker build -t cognipeer-console .
docker run -p 3000:3000 \
  -e JWT_SECRET=your-secret-key-must-be-at-least-32-characters-long \
  -v console-data:/app/data \
  cognipeer-console
```

The `-v console-data:/app/data` volume persists your SQLite databases and local files across container restarts.

---

## Prerequisites

- **Node.js** 20 or later
- **npm** 10+
- **MongoDB** 6.0+ *(optional — only needed when `DB_PROVIDER=mongodb`)*

## Installation

```bash
git clone https://github.com/Cognipeer/cognipeer-console.git
cd cognipeer-console
npm install
```

## Configuration

Copy the example environment file and fill in the required values:

```bash
cp .env.example .env.local
```

At minimum you need:

| Variable | Description |
|----------|-------------|
| `JWT_SECRET` | Secret for JWT signing (min 32 chars) |

Optional (only when using MongoDB):

| Variable | Description |
|----------|-------------|
| `MONGODB_URI` | MongoDB connection string |
| `DB_PROVIDER` | Database backend: `sqlite` (default) or `mongodb` |

See [Configuration](/guide/configuration) for the complete reference.

## Running

### Development

```bash
npm run dev
```

The server starts at `http://localhost:3000` with Turbopack hot reload.

### Production

```bash
npm run build
npm start
```

### Docker

```bash
docker build -t cognipeer-console .

# SQLite mode (default, zero dependencies)
docker run -p 3000:3000 -v console-data:/app/data --env-file .env.local cognipeer-console

# MongoDB mode
docker run -p 3000:3000 --env-file .env.local cognipeer-console
```

## First Steps

1. **Register** — Navigate to `/register` to create your company and admin account
2. **Login** — Go to `/login` with your company slug, email, and password
3. **Dashboard** — Access the management dashboard at `/dashboard`
4. **Create an API Token** — Go to Settings → API Tokens
5. **Make your first request**:

```bash
curl http://localhost:3000/api/client/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-model-key",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Project Structure

```
src/
├── app/                    # Next.js App Router
│   ├── api/
│   │   ├── auth/           # Login, register, password
│   │   ├── client/v1/      # Client-facing API (API token auth)
│   │   ├── dashboard/      # Dashboard internal APIs
│   │   └── health/         # Health check endpoints
│   ├── dashboard/          # Dashboard UI pages
│   ├── login/              # Login page
│   └── register/           # Registration page
├── components/             # React components (Mantine UI)
├── config/                 # Feature policies, plan limits
├── lib/
│   ├── api/                # Route helpers (withRequestContext)
│   ├── core/               # Infrastructure modules
│   ├── database/           # Database abstraction layer
│   ├── license/            # License & JWT management
│   ├── providers/          # Provider contracts & registry
│   ├── quota/              # Quota enforcement
│   ├── services/           # Domain services
│   └── utils/              # Shared utilities
├── middleware.ts            # Global auth & CORS middleware
└── instrumentation.ts       # Startup bootstrap
```

## Useful Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with Turbopack |
| `npm run build` | Production build |
| `npm run lint` | ESLint check |
| `npm test` | Run all tests (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run docs:dev` | Start documentation dev server |
