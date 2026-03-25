# Contributing

Thank you for your interest in contributing to Cognipeer Console.

For full development guidelines, code style rules, and PR checklist, please see the [Contributing Guide](docs/contributing.md).

## Quick Start

```bash
git clone https://github.com/Cognipeer/cognipeer-console.git
cd cognipeer-console
npm install
cp .env.example .env.local
# Edit .env.local — set JWT_SECRET at minimum
npm run dev
```

## Validation

```bash
npm run lint
npm run build
npm run test
```
