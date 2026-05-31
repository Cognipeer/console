# FAQ

## Genel

### GPU Fleet ne için var?

Kendi GPU makinelerini bir SaaS gibi yönetebilesin diye. Onboarding, deployment,
load-balancing, MIG, terminal — hepsi tek UI.

### On-premise mi cloud mu?

İkisi de. Console + agent self-hosted çalışır. Agent'lar console'a outbound HTTP/HTTPS
ile bağlanır → firewall arkası fine, NAT fine.

### Multi-tenant mı?

Console multi-tenant. Her tenant'ın kendi host'ları, pool'ları, model'leri var.
Cross-tenant istek geçmez.

### Hangi GPU'ları destekler?

- **NVIDIA** (tam destek) — Turing+ (T4, V100, A10, A100, H100, L4, vs.). MIG sadece A100/H100/H200/B100.
- **Apple Silicon** (kısmi destek) — M1/M2/M3/M4, Ollama / llama.cpp ile. vLLM/TGI çalışmaz.
- **AMD ROCm** — placeholder, henüz adapter yok.
- **CPU-only** — küçük modeller için (llama.cpp), test/dev.

### Hangi runtime'lar?

Curated:
- **vLLM** — büyük modeller, tool calling, streaming.
- **TGI** (HuggingFace) — alternatif LLM runtime.
- **Ollama** — Apple Silicon + dev için.
- **TEI** (Text Embeddings Inference) — embedding modelleri.
- **faster-whisper-server** — STT.
- **XTTS / EasyOCR** — özel runtime'lar.

Custom runtime kullanmak için: model library JSON'ına yeni entry ekle veya host detail'de **Custom** runtime seç.

## Lisans & maliyet

### Agent kaynak kodu açık mı?

Evet, AGPL-3.0. `packages/gpu-agent/` altında.

### Cloud egress maliyeti?

Agent ↔ console arası heartbeat (15s'de bir, ~1KB) + pool proxy trafiği. On-prem'de
internal network. Cloud'da: aynı region'da host'lar olursa ücretsiz; cross-region
egress sayılır.

## Onboarding

### Tek seferde 50 makineyi onboard edebilir miyim?

Evet. Fleet token bir kez üret, cloud-init template'ine `install.sh` komutunu
embed et, hepsi paralel bağlanır. UI'da bulk claim. Test edilmiş üst sınır: 64
host/single tenant.

### Agent reboot sonrası tekrar handshake yapar mı?

Hayır. Agent token `/var/lib/cognipeer-gpu-agent/agent-token` dosyasında persisted.
Reboot sonrası direkt heartbeat'e başlar.

### Network değişirse?

`serviceAddress` agent'ın preferred IP'sini önerir. Host detail → Edit ile değiştirebilirsin.
Pool proxy bu adresi kullanır — yanlış IP = pool 502 hataları.

## Modeller

### "Custom model" deploy nasıl?

İki yol:

1. **Library'ye ekle** — `src/config/gpu-model-library.json`'a entry ekle, console restart, UI'da görünür.
2. **Tek seferlik custom deploy** — host detail'de Deploy formu, runtime = `custom`, image + args manuel.

### HF private repo çekiyor mu?

Deployment env'ine `HUGGING_FACE_HUB_TOKEN=hf_...` koy. vLLM container'ı kullanır.

### Quantize (AWQ/GPTQ) destekli mi?

vLLM image'ı destekliyor → library entry'inde `quantization` array'inde belirt
+ args'a `--quantization awq` ekle.

### Embedding/STT/TTS modelleri vLLM ile çalışır mı?

Hayır. Embedding için **TEI**, STT için **faster-whisper-server**, TTS için **XTTS**.
Her birinin kendi runtime adapter'ı var.

## Pool

### Bir deployment iki pool'da olabilir mi?

Evet. Aynı model için "production" + "canary" pool'ları kurarsan, bir deployment'ı
ikisinde de bulundurabilirsin.

### Pool member'ı drain etmeden çıkarsam ne olur?

Container çalışmaya devam eder. Pool ona artık trafik göndermez. UI'da görünmez
ama `Inference Monitoring`'de yine metric çeker. Stop'lamak istersen deployment'ı stop et.

### Sticky session var mı?

Phase 1 yok. Her istek bağımsız routed. Roadmap: `X-Session-Id` header → consistent
hashing.

### Pool delete ettim, deployment'lar gidiyor mu?

Hayır. Pool kaydı silinir, deployment'lar bağımsız çalışmaya devam eder. Onları da
silmek istersen tek tek `Stop` + `Delete`.

## MIG

### Reconfigure ne kadar sürer?

5-30 saniye. In-flight istek koruması yok (Phase 1) — drain ve yeniden yarat.

### MIG'i devre dışı bırakma destekli mi?

Evet, "Disable MIG (full GPU)" preset'i. Bound deployment'lar drain edilir, MIG
mode kapanır, GPU tekrar tek slice olarak görünür.

### Aynı GPU'da farklı MIG profilleri olabilir mi?

Hayır. NVIDIA driver tek bir GPU'da homojen profil ister. Farklı boyut için ayrı
GPU'lar kullan. (Library'de bunu açıklayan UI hint planlı.)

## Terminal

### vim / htop çalışıyor mu?

Phase 1: hayır (no PTY). Roadmap: node-pty + xterm.js.

### Audit kayıt komut bazında mı?

Şu an session-açılışı bazında. Her keystroke audit'e yazılmıyor. Roadmap: line-by-line
audit.

### Terminal kapanırken container ne olur?

Sandbox modu:
- `host` — sh process ölür, sistem etkilenmez.
- `docker-debug` — ephemeral container --rm ile kalkar, çıkışta silinir.
- `deployment-exec` — exec session ölür, target container çalışmaya devam eder.

## Console / API

### Pool endpoint Bearer token nereden gelir?

Yukarıdaki gibi — pool publish edildiğinde otomatik mint edilir, Provider'a yazılır.
Veya `Tokens` sayfasından elle tenant API token üret.

### REST endpoint dokümanı nerede?

`docs/api/gpu-fleet.md` (gelecek versiyonda). Şimdilik: OpenAPI dosyasında `gpu-fleet`
prefix'li path'lere bak.

### Webhook desteği?

Yok. `Alerts` modülü ile pool/deployment unhealthy olduğunda webhook'a notify edilebilir.

## Veri & migration

### Tüm fleet'i başka bir tenant'a taşımak mümkün mü?

Hayır. Host'lar tenant-scoped. Reissue + reclaim yapman gerekir.

### Console'u upgrade ederken agent'lar etkilenir mi?

Hayır, agent ↔ console wire protocol versiyonludur (`GPU_FLEET_PROTOCOL_VERSION`).
Eski agent çalışmaya devam eder; yeni feature'lar (yeni command kind'ları) yeni
agent gerektirir.

### Tenant silmek host'ları temizler mi?

Evet, cascade. Pool/deployment/host kayıtları DB'den silinir. Ama remote agent
hâlâ koşar — manuel `systemctl stop cognipeer-gpu-agent`.
