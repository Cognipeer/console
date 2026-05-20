# Managed Agents Entegrasyon Planı

> **Durum:** Araştırma + Tasarım taslağı
> **Branch:** `claude/research-managed-agents-UqCwP`
> **Kapsam:** Anthropic Claude Managed Agents + Google Vertex AI Agent Engine (Gemini Enterprise Agent Platform) için Cognipeer Console içinde "Managed Agent Runtime" desteği

---

## 1. Bağlam ve Motivasyon

Bugün console'da agent çalıştırması `executeAgentChatLocal` (`src/lib/services/agents/agentService.ts`) içinde **in-process** olarak yapılıyor:

- Model `buildModelRuntime` ile LangChain üzerinden yaratılıyor.
- `@cognipeer/agent-sdk` (`createSmartAgent`) ile agent loop, tool execution, summarization, tracing tek bir Node.js sürecinde dönüyor.
- Tools (`tool` / `mcp` / `system:browser_use`) `buildBoundTools` ile bridge ediliyor.
- Conversation state DB'de, tool çalıştırma her turda Node tarafında yapılıyor.

2026'da iki büyük sağlayıcı bu agent loop'u **kendi tarafında yöneten** (managed) bir runtime sundu:

- **Anthropic Claude Managed Agents** (Beta, `managed-agents-2026-04-01`): Anthropic'in barındırdığı container içinde Claude bash/file/web/MCP tool'larıyla otonom çalışıyor. Faturalandırma token + session-saat ($0.08/sa).
- **Google Vertex AI Agent Engine** (Gemini Enterprise Agent Platform, Next '26'da yeniden markalandı): ADK / LangChain / LangGraph agent'ını `reasoningEngines` resource'u olarak deploy edip `:query` / `:streamQuery` ile çağırıyor. Memory Bank, Agent Gateway, A2A protokolü ile geliyor. Faturalandırma vCPU-saat + GB-saat + session/event.

Console'un mevcut "self-hosted in-process agent" modelinin yanına bu **managed runtime'ları üçüncü bir agent execution backend'i** olarak eklemek istiyoruz; ki tenant'lar uzun süren, dayanıklı, sandbox'lı görevleri (multi-day workflow, code execution, web browsing) gateway üzerinden çalıştırabilsin.

---

## 2. Sağlayıcı Araştırma Özeti

### 2.1 Anthropic Claude Managed Agents

| Konsept | Açıklama |
|---|---|
| **Agent** | Model + system prompt + tools + MCP servers + skills tanımı. Versiyonlanır, ID ile referanslanır. |
| **Environment** | Sandbox config: `cloud` (Anthropic-managed container) veya `self-hosted` sandbox. Networking kuralları (`unrestricted` / kısıtlı) burada. |
| **Session** | Bir agent + environment'ın canlı instance'ı. Persistent FS + conversation history. Idle olunca `session.status_idle` event'i atıyor. |
| **Events** | SSE üstünden akan typed event stream: `user.message`, `agent.message`, `agent.tool_use`, `session.status_idle`, vs. |

**Endpoint'ler** (tümünde `anthropic-beta: managed-agents-2026-04-01` zorunlu):

| Method | Path | Amaç |
|---|---|---|
| POST | `/v1/agents` | Agent tanımı oluştur |
| POST | `/v1/environments` | Environment oluştur (cloud / self-hosted) |
| POST | `/v1/sessions` | Agent + environment ile session başlat |
| POST | `/v1/sessions/{id}/events` | User event/turn gönder |
| GET (SSE) | `/v1/sessions/{id}/stream` | Event stream'ini aç |
| GET | `/v1/sessions/{id}` | Session durum/state retrieve |

**Built-in tools**: bash, file ops (read/write/edit/glob/grep), web search & fetch, MCP servers. `agent_toolset_20260401` ile tek tip atanır.

**Pricing**: standart Claude token tarifesi + $0.08 / session-saat (ms hassasiyetli).

**Rate limit**: create 300 rpm, read 600 rpm (organization).

**Modeller**: `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5` (managed agent'ta tipik olarak Opus / Sonnet kullanılır).

### 2.2 Google Vertex AI Agent Engine (Gemini Enterprise Agent Platform)

| Konsept | Açıklama |
|---|---|
| **ReasoningEngine** | API resource'u — deploy edilmiş agent kodu (ADK / LangChain / LangGraph wrapper). |
| **Session** | ReasoningEngine altında conversation/state container'ı. CRUD'u REST ile yapılır. |
| **Memory Bank** | Persistent long-term context. Oturumlar arası kalıcı, semantik recall. |
| **Agent Gateway** | Tüm agent ↔ tool trafiğini policy + observability ile yöneten katman. |
| **A2A Protocol** | Agent-to-agent iletişim, Next '26'da resmileşti. |

**Endpoint'ler** (taban: `https://{LOCATION}-aiplatform.googleapis.com/v1beta1/projects/{PROJECT}/locations/{LOCATION}`):

| Method | Path | Amaç |
|---|---|---|
| POST | `/reasoningEngines` | ReasoningEngine deploy et (staging bucket + agent spec) |
| GET | `/reasoningEngines/{id}` | Detay |
| POST | `/reasoningEngines/{id}:query` | Sync invoke (örn. `class_method=create_session`, `query`) |
| POST | `/reasoningEngines/{id}:streamQuery` | Streaming invoke |
| POST | `/reasoningEngines/{id}/sessions` | Session aç |
| GET | `/reasoningEngines/{id}/sessions/{sid}` | Session detay |
| DELETE | `/reasoningEngines/{id}/sessions/{sid}` | Session kapat |
| `/memoryBank/...` | Memory Bank CRUD |

**Auth**: Service Account JWT → OAuth2 token (mevcut `VertexModelProviderContract` ile aynı pattern).

**Pricing**: $0.0864 / vCPU-saat + $0.0090 / GB-saat + $0.25 / 1.000 session/memory event.

**Sınır**: Bugün native deploy yalnızca Python ADK için resmi. LangChain/LangGraph adapter'ları var; TypeScript runtime resmi değil (gateway'den REST tüketmek serbest).

### 2.3 İki Sağlayıcının Console Açısından Ortak Soyutu

| Boyut | Anthropic | Google |
|---|---|---|
| Agent tanımı kalıcılığı | Sağlayıcı tarafında (`agent.id` + version) | Sağlayıcı tarafında (`reasoningEngines/{id}`) |
| Sandbox | Anthropic cloud container veya self-hosted | Vertex managed runtime + Memory Bank |
| Tool tarafı | Built-in toolset + MCP | Function calling + MCP + Agent Gateway tools |
| Streaming | SSE `/sessions/{id}/stream` | `:streamQuery` |
| Konuşma state'i | Session (server-side persisted) | Session (server-side persisted) |
| Faturalandırma | token + session-saat | vCPU-saat + GB-saat + event |

İki sağlayıcı da aynı şemaya soyutlanabilir: **`Agent (spec) → Environment/Runtime (sandbox config) → Session (canlı çalışan instance) → Event stream`**. Console'un soyutlamasını bu dört nesne üstüne kurabiliriz.

---

## 3. Console İçindeki Mevcut Yapıyla Eşleştirme

### 3.1 Bugünkü Akış

```
IAgent (config: modelKey, systemPrompt, toolBindings, ...)
   │
   ├─ executeAgentChat / executePlaygroundChat
   │     ├─ buildModelRuntime → LangChain chat model
   │     ├─ buildBoundTools     → ToolInterface[]
   │     └─ createSmartAgent(...).invoke(state)  ← in-process loop
   │
   └─ IAgentConversation (messages)
```

### 3.2 Hedef Akış

`IAgent.config` içine `runtime` alanı ekliyoruz:

```
config.runtime = 
  | { type: "inprocess" }                         // bugünkü davranış (default)
  | { type: "anthropic_managed",
      providerKey: "anthropic-managed",
      remoteAgentId, remoteEnvironmentId,
      networking, autoCreate }
  | { type: "vertex_agent_engine",
      providerKey: "vertex-agent-engine",
      reasoningEngineId, location, projectId,
      memoryBankId? }
```

`executeAgentChat*` artık bir **runtime dispatcher** olur:

```
dispatchAgentRuntime(config.runtime).runChat(request)
   ├── inprocess          → mevcut createSmartAgent path
   ├── anthropic_managed  → ensureRemoteAgent + ensureRemoteEnv + createSession + send + stream
   └── vertex             → ensureReasoningEngine + createSession + streamQuery
```

Tracing, guardrails, conversation persistence, quota — bu üç yolda da **aynı** dış katmandan geçer. Yani managed runtime'lar Claude'u doğrudan müşteriye sunmuyor; console'un kendi auth/quota/guardrail/tracing katmanlarının arkasında çalışıyor.

---

## 4. Önerilen Mimari

### 4.1 Provider Contract Katmanına Yeni Domain: `agent-runtime`

`src/lib/providers/domains/` altına yeni bir domain ekliyoruz:

**`src/lib/providers/domains/agentRuntime.ts`**

```ts
export interface AgentRuntimeProvider {
  ensureAgent(spec: ManagedAgentSpec): Promise<RemoteAgentRef>;       // upsert remote agent
  ensureEnvironment(cfg: ManagedEnvConfig): Promise<RemoteEnvRef>;    // upsert env / reasoningEngine
  createSession(input: ManagedSessionInput): Promise<RemoteSessionRef>;
  sendUserEvent(sessionId: string, event: ManagedUserEvent): Promise<void>;
  streamEvents(sessionId: string, onEvent: (e: ManagedEvent) => void, signal?: AbortSignal): Promise<ManagedRunResult>;
  interrupt?(sessionId: string): Promise<void>;
  getSession(sessionId: string): Promise<ManagedSessionState>;
  deleteSession(sessionId: string): Promise<void>;
}
```

Normalized event tipi (her iki sağlayıcının olayları buraya map edilir):

```ts
type ManagedEvent =
  | { type: 'agent.text';      text: string }
  | { type: 'agent.tool_call'; name: string; args: unknown; id: string }
  | { type: 'tool.result';     id: string; output: unknown; isError?: boolean }
  | { type: 'status';          status: 'running' | 'idle' | 'failed'; error?: string }
  | { type: 'usage';           inputTokens?: number; outputTokens?: number; sessionDurationMs?: number };
```

### 4.2 Yeni Contract Dosyaları

`src/lib/providers/contracts/agentRuntimeContracts.ts`:

- `AnthropicManagedAgentRuntimeContract`
  - Credentials: `apiKey`
  - Settings: `betaHeader` (default `managed-agents-2026-04-01`), `defaultModel`, `defaultNetworking`
  - Capabilities: `agent.builtin_toolset`, `agent.mcp`, `agent.session_persistence`, `agent.streaming`
- `VertexAgentEngineRuntimeContract`
  - Credentials: `serviceAccountKey` (mevcut Vertex contract'ı ile uyumlu)
  - Settings: `projectId`, `location`, `stagingBucket`, `defaultMemoryBankId?`
  - Capabilities: `agent.memory_bank`, `agent.streaming`, `agent.python_adk_only` (info flag)

Her ikisi de `domains: ['agent-runtime']`. `CORE_PROVIDER_CONTRACTS` listesine eklenir.

### 4.3 Servis Katmanı: `src/lib/services/agents/runtime/`

```
runtime/
├── dispatcher.ts        # config.runtime.type → impl
├── inprocess.ts         # mevcut path'i sarmalar (refactor, davranış aynı)
├── anthropicManaged.ts  # AnthropicManagedAgentRuntime
├── vertexAgent.ts       # VertexAgentEngineRuntime
├── normalize.ts         # provider event → ManagedEvent
└── types.ts
```

**`dispatcher.ts`** in/out kontratı:

```ts
export async function runManagedAgentChat(
  ctx: AgentExecutionContext,    // tenant, project, agent, conversation, guardrails, tracing sink
  input: AgentChatInput,
): Promise<AgentChatResult>;
```

Hem playground hem persistent chat aynı dispatcher'ı çağırır; `agentService.ts` ince bir orkestratöre indirgenir.

### 4.4 State Mapping

| Console | Anthropic | Vertex |
|---|---|---|
| `IAgentConfig` (DB) | `agent.id` + version (remote) — cache'lenir | `reasoningEngineId` (remote) — cache'lenir |
| `IAgentConversation` mesajları | `session.id` + events | `session.id` + events |
| Tool bindings | `agent_toolset_20260401` + MCP server URL'leri | function declarations + MCP / Agent Gateway |
| Tracing | mevcut `customSink` | aynı sink — managed event'lerden normalize edilmiş tool calls / usage |

**Senkronizasyon:**

- `IAgent` kaydedildiğinde / publish edildiğinde, `runtime.type !== 'inprocess'` ise `ensureAgent` çağrılır ve `remoteAgentId`, `remoteEnvironmentId` `IAgent.metadata.runtime` altına yazılır.
- `IAgentConversation` yeni açıldığında `createSession` çağrılır, `remoteSessionId` conversation metadata'sına eklenir.
- Conversation devamında aynı `remoteSessionId` ile event gönderilir; managed runtime kendi event history'sini tutar, console yalnızca özet mesajları (user text + assistant final text) DB'ye yazmaya devam eder. Tool call detayları **tracing** event'lerine düşer.

### 4.5 Tool Köprüsü

İki sağlayıcı için iki yol var:

1. **Built-in (sağlayıcı kendi tool'u)**: bash, file ops, web — özellikle Anthropic'in `agent_toolset_20260401`'i. Console UI'da bu, "Sandbox tools" seçeneği olarak gösterilir; tenant'ın MCP/custom tool seçimini engellemez.
2. **Köprü (console tool → managed)**:
   - **Anthropic**: console'da tanımlı `tool` veya `mcp` binding'leri "remote MCP server URL"'i olarak managed agent'a verilir. Console kendi `/api/client/v1/mcp/...` endpoint'leri zaten MCP üretiyor; managed agent dışarıdan o URL'i + API token'ı çağırır.
   - **Vertex**: function declarations'a çevrilir; çağrıyı Vertex tarafı yapamadığında (custom tool) "tool call gerekli" event'i normalize edilir ve console içinde execute edilip `tool.result` event'i geri postlanır (eğer Vertex'in callback / function calling proxy modunu destekliyorsa).

İlk fazda yalnızca **MCP üzerinden gerçek workflow** önerilir; custom HTTP tool execution proxy V2'ye bırakılabilir.

### 4.6 Guardrail / Quota / Tracing

- **Input guardrail**: `runManagedAgentChat`'in başında çalışmaya devam eder (managed sağlayıcıya **göndermeden önce**).
- **Output guardrail**: stream sırasında biriken final assistant text üstünde tetiklenir; block edilirse session interrupt edilir.
- **Quota**: token cinsinden değil, session-saat / vCPU-saat cinsinden de izlenmeli. `quota` servisine yeni dimension: `managed_session_seconds`. Faturalandırmaya `usage` event'lerinden gelen değer beslenir.
- **Tracing**: normalize edilmiş event'ler `createInternalTracingSink` ile mevcut event şemasına yazılır (`agent.tool_use` → `actor.scope='tool'`, vb.). Böylece tracing dashboard tek yer kalır.

---

## 5. Veri Modeli Değişiklikleri

### 5.1 `IAgentConfig` (yeni alan)

```ts
export interface IAgentConfig {
  // ... mevcut alanlar
  runtime?:
    | { type: 'inprocess' }
    | { type: 'anthropic_managed';
        providerKey: string;                      // contract id
        networking?: 'unrestricted' | 'restricted';
        builtinToolset?: boolean;                 // default true
        defaultModel?: string;
      }
    | { type: 'vertex_agent_engine';
        providerKey: string;
        location: string;
        memoryBankId?: string;
      };
}
```

`runtime` alanı **opsiyonel**; eski kayıtlar `inprocess` davranışına düşer (backward compatible).

### 5.2 `IAgent.metadata.runtime` (cache)

```ts
metadata: {
  runtime?: {
    providerKey: string;
    remoteAgentId?: string;        // Anthropic agent.id / Vertex reasoningEngineId
    remoteAgentVersion?: number;
    remoteEnvironmentId?: string;  // Anthropic environment.id (Vertex'te yok, location kullanılır)
    lastSyncedAt?: string;
    contentHash?: string;          // spec hash — değişince yeniden ensure
  };
}
```

### 5.3 `IAgentConversation.metadata.runtime`

```ts
metadata: {
  runtime?: {
    providerKey: string;
    remoteSessionId?: string;
    startedAt?: string;
    endedAt?: string;
    sessionDurationMs?: number;
  };
}
```

### 5.4 Yeni Koleksiyon Önerisi: `managed_agent_sessions` (opsiyonel)

Operasyonel görünürlük için: hangi tenant'ın hangi sağlayıcıda kaç aktif session'ı var, idle olmadan ne kadar süre geçti, vs. İlk fazda atlanabilir — `IAgentConversation.metadata` yeterli.

---

## 6. API Yüzeyi

### 6.1 Dashboard API (`src/server/api/plugins/agents.ts`)

Mevcut endpoint'ler değişmiyor. Eklemeler:

- `POST /api/agents/:id/runtime/sync` — DB'deki spec'i remote'a push'la (idempotent ensure).
- `GET /api/agents/:id/runtime/status` — `metadata.runtime` özeti + sağlayıcı health.
- `POST /api/agents/:id/runtime/sessions/:sessionId/interrupt` — managed session interrupt.

### 6.2 Client API (`src/server/api/plugins/client-agents.ts`)

OpenAI Responses uyumlu cevap formatı **korunur**. Managed runtime'da streaming için yeni endpoint:

- `POST /client/v1/agents/{key}/responses?stream=true` — SSE; runtime'a göre normalize edilmiş `ManagedEvent`'ler "OpenAI Responses streaming chunk"'larına map edilir.
- `previous_response_id` ↔ `remoteSessionId` mapping'i tutulur (mevcut conversation persistence katmanı bunu zaten yapıyor; sadece managed session ID'sini eşleştireceğiz).

Geriye uyumluluk: stream=false aynı response shape'i.

### 6.3 Policies

`src/config/policies.json`'a:

```json
"MANAGED_AGENT_RUNTIME": {
  "name": "Managed Agent Runtimes",
  "description": "Use Anthropic/Vertex managed agent runtimes as agent backends",
  "endpoints": [
    "/api/agents/*/runtime/*",
    "/api/client/v1/agents/*/responses"
  ]
}
```

Lisans kapısı: enterprise plan flag'i.

---

## 7. UI Değişiklikleri

`src/app/dashboard/agents/[key]/page.tsx`:

- "Runtime" sekmesi eklenir.
- Form alanları:
  - Runtime type: `In-process (default)` | `Anthropic Managed` | `Vertex Agent Engine`
  - Anthropic seçildiyse: provider connection seçici (provider catalog'dan), networking radio, "Enable built-in toolset" switch.
  - Vertex seçildiyse: provider seçici, location, memoryBankId (opsiyonel).
  - "Sync to remote" butonu → `POST /api/agents/:id/runtime/sync`.
- Status göstergesi: son sync, remote agent id, conn health.

Conversation sayfası:
- Aktif managed session varsa session ID + elapsed time chip.
- "Interrupt" butonu.

Provider catalog (`src/app/dashboard/providers`):
- İki yeni contract listede görünür ("Anthropic Managed Agents", "Google Vertex Agent Engine").

---

## 8. Faz Faz Yol Haritası

### Faz 0 — Hazırlık (1–2 gün)
- [ ] Bu dokümanı revize et, AGENTS.md'ye runtime modülü için kısa giriş ekle.
- [ ] `IAgentConfig.runtime` + `metadata.runtime` migration planı (SQLite + MongoDB — sadece optional alan, migration gerekmez ama type'lar güncellenir).

### Faz 1 — Soyutlama Refactor (in-process davranış aynı kalır) (2–3 gün)
- [ ] `src/lib/services/agents/runtime/` iskeleti.
- [ ] `dispatcher.ts` + `inprocess.ts` yaz; `executeAgentChatLocal` çağrısı dispatcher'a taşınır, davranış aynı.
- [ ] Unit testler: in-process path yeşil.

### Faz 2 — Anthropic Managed (5–7 gün)
- [ ] `AnthropicManagedAgentRuntimeContract` + provider domain.
- [ ] `anthropicManaged.ts`: `ensureAgent` (idempotent — content hash), `createSession`, `sendUserEvent`, `streamEvents` (SSE).
- [ ] Event normalize: Anthropic `agent.message` / `agent.tool_use` / `session.status_idle` → `ManagedEvent`.
- [ ] MCP tool köprüsü: console'un kendi MCP endpoint URL'i + scoped token üret, managed agent spec'ine ekle.
- [ ] Dashboard UI: runtime sekmesi + sync.
- [ ] Tracing entegrasyonu doğrulama.
- [ ] Quota: `managed_session_seconds` dimension'ı.
- [ ] Smoke: playground chat managed runtime'da çalışıyor.

### Faz 3 — Vertex Agent Engine (5–7 gün)
- [ ] `VertexAgentEngineRuntimeContract`.
- [ ] `vertexAgent.ts`: `ensureReasoningEngine` (deploy yalnızca console-managed bir minimal ADK Python paketi için **ilk versiyonda dışarda tutulabilir** — kullanıcının önceden deploy ettiği reasoningEngineId verilmesi yeterli).
- [ ] `:query` / `:streamQuery` integration; session CRUD.
- [ ] Memory Bank attach opsiyonu.
- [ ] Pricing telemetry (vCPU/GB cinsinden gelmiyorsa süre + flat assumption).

### Faz 4 — Üretim Sertleştirme (3–4 gün)
- [ ] Resilience: `withResilience('agent-runtime:<provider>', ...)` ile sarmala.
- [ ] Circuit breaker: managed sağlayıcı düştüğünde graceful fallback (in-process'e değil — explicit error; kullanıcı yapılandırması).
- [ ] Lifecycle: shutdown sırasında açık managed session'ları interrupt et veya detach et.
- [ ] Audit log: `agent.runtime.sync`, `agent.runtime.session.start`, `...interrupt`.
- [ ] Health check contributor: managed runtime credential reachability.
- [ ] Dokümantasyon: `docs/guide/managed-agents.md` (kullanım), API reference güncelle.

### Faz 5 — İleri Özellikler (opsiyonel)
- [ ] Custom tool callback proxy (Vertex function calling round-trip).
- [ ] Anthropic self-hosted sandbox desteği (env config type: `self-hosted`).
- [ ] Anthropic outcomes/multiagent beta'ları.
- [ ] Vertex A2A protokolü (agent-to-agent invoke).

---

## 9. Riskler ve Açık Sorular

| Risk | Etki | Yaklaşım |
|---|---|---|
| Anthropic beta header'ı değişebilir | Faz 2'yi kırar | Header'ı settings'ten okutuyoruz, sabit gömmüyoruz |
| Vertex ADK Python-only deploy | Console TS sürecinden direkt deploy edemeyebiliriz | İlk versiyonda kullanıcı kendi reasoningEngine'ini deploy eder, console sadece tüketir |
| MCP URL'inin managed agent'tan erişilebilir olması (Anthropic cloud → console) | Self-hosted console kapalı ağda ise tool köprüsü çalışmaz | Tenant ayarında "MCP egress required" uyarısı; alternatif olarak self-hosted sandbox |
| Quota muhasebesi (saniye bazlı) | Mevcut token-bazlı quota'ya yabancı | Yeni quota dimension'ı; faturalandırma raporlarına ek kolon |
| Multi-tenancy: bir tenant'ın session sayısı org rate-limit'ini doldurabilir | Diğer tenant'ları etkiler | Tenant başına concurrent session cap; gerekirse tenant başına ayrı API key |
| Tracing event hacmi (uzun session) | Storage şişer | Mevcut summarization patternini kullan; yalnızca rolled-up event sakla |
| Cost transparansı | Müşteri faturayı anlayamaz | Conversation detail sayfasında "managed runtime cost estimate" göster |

**Açık sorular** (kullanıcıya / ürün tarafına):
1. Managed runtime feature'ı **community edition**'da mı, yalnızca **enterprise**'da mı olacak? (Pricing pass-through enterprise gerektirir — öneri: enterprise-only başla.)
2. Vertex'te kullanıcının kendi ADK paketini yüklemesini bekliyor muyuz, yoksa console standart bir "passthrough ADK agent" yayınlasın mı?
3. Anthropic'in built-in toolset'ini default açık mı kapalı mı sunalım? (Güvenlik açısından default kapalı + per-agent opt-in mantıklı.)
4. Tek bir IAgent için runtime hot-switch (inprocess → managed) gerekli mi? — gerekiyorsa migration UX'i ayrı tasarlanmalı.

---

## 10. Kaynaklar

- [Claude Managed Agents overview — Claude API Docs](https://platform.claude.com/docs/en/managed-agents/overview)
- [Claude Managed Agents quickstart](https://platform.claude.com/docs/en/managed-agents/quickstart)
- [Anthropic Managed Agents: A Hosted Runtime for Claude + MCP (MindStudio)](https://www.mindstudio.ai/blog/what-is-anthropic-managed-agents)
- [Anthropic Introduces Managed Agents to Simplify AI Agent Deployment (InfoQ)](https://www.infoq.com/news/2026/04/anthropic-managed-agents/)
- [Gemini Enterprise Agent Platform (formerly Vertex AI)](https://cloud.google.com/products/gemini-enterprise-agent-platform)
- [Manage sessions using direct API calls — Vertex AI Agent Builder](https://cloud.google.com/agent-builder/agent-engine/sessions/manage-sessions-api)
- [REST Resource: projects.locations.reasoningEngines](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1/projects.locations.reasoningEngines)
- [Standard deployment — Agent Development Kit (ADK)](https://adk.dev/deploy/agent-engine/deploy/)
- [Vertex AI Agent Builder: 2026 guide (UI Bakery)](https://uibakery.io/blog/vertex-ai-agent-builder)
