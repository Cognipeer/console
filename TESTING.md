# Testing Guide

Tek hedef: **uygulamanın her zaman stabil olduğundan emin olmak**. Bu rehber test katmanlarının ne olduğunu, hangi soruyu yanıtladığını, nasıl yazılacağını ve CI/CD'de nasıl koşacağını açıklar.

---

## Katmanlar

| # | Katman | Konum | Hız | Hedefi |
|---|---|---|---|---|
| L1 | Static | `eslint`, `tsc` | sn | Tip / lint hataları PR'a girmesin |
| L2 | Unit | `src/__tests__/unit/**` | sn | Saf servis & fonksiyon davranışı |
| L3 | API plugin | `src/__tests__/api/**` | sn | Fastify endpoint sözleşmesi (auth, validation, status code) |
| L4 | DB Parity | `src/__tests__/integration/db-parity.test.ts` | sn-dk | SQLite ↔ MongoDB aynı sözleşmeyi karşılıyor mu |
| L5 | Provider Contract | `src/__tests__/contracts/**` | sn | Vector/model/file driver şekil + form uyumu |
| L6 | E2E *(TBD)* | `tests/e2e/**` | dk | Playwright kritik user journey'leri |
| L7 | AI-driven | `src/__tests__/ai/**` | dk | LLM judge ile davranışsal regresyon (guardrail, agent, prompt kalite) |
| L8 | Smoke *(TBD)* | `scripts/smoke/**` | dk | `docker compose up` + sağlık + 1 kritik akış |

> `(TBD)` katmanları henüz yok ama mimari yer ayrıldı. İlk versiyon için L1-L5 ve L7 ayağa kaldırıldı.

---

## Komutlar

```bash
npm test                    # Tüm hızlı katmanlar (L1 hariç) — varsayılan PR koşusu
npm run test:watch          # Lokal geliştirme
npm run test:coverage       # Coverage raporu (lib/services, providers, license, server/api)
npm run test:ui             # Vitest UI
npm run test:endpoints      # Endpoint coverage gate (yeni endpoint için test var mı?)
npm run test:flake          # Tüm suite'i 3x koşar, flake yakalar (FLAKE_RUNS=5 ile değiştir)
npm run lint                # ESLint
```

CI'da nightly olarak ek:
```bash
PARITY_SKIP_MONGODB= MONGO_AVAILABLE=1 npm test    # MongoDB parity dahil
JUDGE_BACKEND=anthropic ANTHROPIC_API_KEY=... npm test  # AI-judged regresyon
npm run test:flake -- FLAKE_RUNS=5                  # Flake hunter
```

---

## Test yazarken

### 1. MockDb (Proxy-driven)

`DatabaseProvider` interface'i çok geniş (~150 metod). Elle mock yazmak driftin baş kaynağı oldu. Yeni mock factory **Proxy** kullanıyor:

```ts
import { createMockDb } from '../helpers/db.mock';

const db = createMockDb();
db.findUserById.mockResolvedValue(myUser);
// db.anyNewMethodYouAdd  → otomatik vi.fn() döner. İsim örüntüsü:
//   list*   → []      find*  → null   count*  → 0
//   exists* → false   delete* → true   diğer   → undefined
```

Yeni `DatabaseProvider` metodu eklenirse mock güncellemeye gerek YOK. Özel davranış istiyorsanız test bazında `db.metod.mockResolvedValue(...)` yeterli. Sık tekrarlayan default'lar `buildPrimers()` içine eklenir.

### 2. Fixture factory

`src/__tests__/factories/index.ts` içinde `tenantFixture`, `userFixture`, `projectFixture`, `apiTokenFixture`, `modelFixture`, `contextHeaders()` var. Aynı `{ _id, ... }` literalini iki testte tekrarlıyorsanız factory'e çevirin.

```ts
import { userFixture, contextHeaders } from '../factories';

const owner = userFixture({ role: 'owner', email: 'admin@acme.com' });
const res = await app.inject({
  method: 'GET',
  url: '/api/users',
  headers: contextHeaders({ 'x-user-id': owner._id }),
});
```

### 3. API plugin testi

`fastify-api.ts` helper'ı plugin'i tek başına monte eder, context header'larını otomatik yayar. Her endpoint için en az **`401/403`, `400/422`, mutlu yol** üç senaryosunu yazın.

### 4. DB parity testi (L4)

Yeni bir DB mixin metodu eklediğinizde `src/__tests__/integration/db-parity.test.ts` içine bir test ekleyin:

```ts
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('YourMixin behavior', (getDb) => {
  it('does the thing', async () => {
    const db = getDb();
    // ... aynı testte SQLite + MongoDB ikisi de çalışır
  });
});
```

Test otomatik iki kez koşar: `[sqlite]` ve `[mongodb]`. Davranış farklı dönerse iki suite'ten biri kırılır. MongoDB'yi açmak için: `npm install -D mongodb-memory-server`. Yoksa `[mongodb]` suite'i graceful skip.

### 5. AI-driven test (L7)

LLM judge ile davranışsal kontrol. Tipik kullanım: regex'in kaçırdığı, ya da "doğru cevap çoklu olabilen" senaryolar.

```ts
import { resolveJudgeBackend } from './judge';

const JUDGE = resolveJudgeBackend();

describe.skipIf(!JUDGE)('agent picks the right tool', () => {
  it('weather query → weather tool', async () => {
    const result = await runAgent('What is the weather in Istanbul?');
    const verdict = await JUDGE!.judge({
      testId: 'agent-weather',
      rubric: 'Pass if the agent invoked a weather-related tool. Fail otherwise.',
      candidate: JSON.stringify(result.toolCalls),
    });
    expect(verdict.score).toBeGreaterThanOrEqual(0.7);
  });
});
```

Backend env precedence:
1. `JUDGE_BACKEND=openai|anthropic` + API key
2. `JUDGE_BASE_URL` + `JUDGE_API_KEY` + `JUDGE_MODEL` (OpenAI uyumlu custom endpoint)
3. `OPENAI_API_KEY` veya `ANTHROPIC_API_KEY` (auto-detect)

Tek backend kuralı: **temperature=0, JSON-only output**. Aksi takdirde judge'ın kendisi flake olur.

---

## Endpoint coverage gate

`scripts/check-endpoint-coverage.ts` tüm `app.{get,post,...}` route'larını tarayıp `src/__tests__/api/**` içindeki referansları sayar. Şu an **216/348 endpoint** covered; geri kalan 132'si `scripts/endpoint-coverage.baseline.json` içinde dondurulmuş. **Yeni eklenen** bir endpoint baseline'da olmadan testsiz girerse CI fail.

Baseline'dan satır kaldırmak için:
1. Endpoint için bir test ekleyin (`src/__tests__/api/<area>.test.ts`).
2. `npm run test:endpoints` çalıştırın; kapatılan satır listelenir.
3. Baseline JSON'dan o satırı silin.

Bir route'u kasıtlı atlamak istiyorsanız route üstüne `// @test-skip: <reason>` koyun.

---

## Flake hunter

`scripts/flake-hunter.ts` testleri N kere koşup tutarsız olanları raporlar. `--retry` ile aynı şey değil — flake'i gizlemek yerine **görünür** kılıyoruz. CI nightly job için:

```yaml
- name: Flake hunt
  run: FLAKE_RUNS=5 npm run test:flake
```

Bir test flake çıkarsa ya determinizmi düzeltin (sabit saat / sıra) ya da `it.skip` ile **gerekçe yazarak** geçici kapatın. `.skip` workaround değil; kök neden ticket'ı açın.

---

## CI/CD önerilen ardışıklık

```
1. Lint + typecheck                  (parallel)
2. npm test                          (L2 + L3 + L4-sqlite + L5)
3. npm run test:endpoints            (coverage gate)
4. (PR-only) Affected E2E            (L6, hazırlandığında)

Nightly (cron):
5. npm test                          (full suite, JUDGE_BACKEND=... ile L7 dahil)
6. PARITY_SKIP_MONGODB= npm test     (MongoDB parity)
7. npm run test:flake -- FLAKE_RUNS=5
8. Smoke compose up + critical journey (L8)
```

---

## "Bir bug bulundu, ne yapayım?"

1. **Önce regresyon testi yaz.** Hangi katman? — Saf logic → L2, endpoint davranışı → L3, DB diverjansı → L4, LLM davranışı → L7.
2. Test kırılırsa kodu düzelt.
3. Aynı test fix sonrası geçer.
4. PR açıklamasında "bu test bu bug için eklendi" yaz.

Bu sıra `// @test-skip` veya disabled test bırakmaktan çok daha güçlü çünkü bir sonraki kişi aynı bug'ı tekrar üretemez.
