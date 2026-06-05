# Troubleshooting

## Host kaydı

### Host pending_claim'de görünmüyor

**Olası sebep**: Agent console'a ulaşamıyor.

Çözüm:

```bash
# Agent log'una bak
sudo journalctl -u cognipeer-gpu-agent -n 100

# console URL'ine network bağlantısı var mı?
curl -v https://console.example.com/api/health/live

# Env dosyası
sudo cat /etc/cognipeer-gpu-agent.env
```

Tipik hatalar:

- `EAI_AGAIN` / `getaddrinfo` — DNS sorunları.
- `ETIMEDOUT` — firewall outbound 443 kapalı.
- `Invalid fleet token` — token rotate edilmiş, install komutunu yenile.

### Pending_claim aynı host'tan tekrar tekrar geliyor

Reject ettiğin halde geri geliyor → agent hâlâ koşuyor. `sudo systemctl stop cognipeer-gpu-agent`
veya host'u önce claim edip sonra delete et.

### Toolchain badge'leri kırmızı

- **driver ✗** — `nvidia-smi` PATH'de değil veya driver yüklü değil. Image güncel mi?
- **cuda ✗** — `nvidia-smi` çıktısında `CUDA Version: X.Y` yok. Eski driver?
- **docker ✗** — `docker version` başarısız. `sudo systemctl status docker`.
- **nvidia-ctk ✗** — toolkit kurulu değil. Hâlâ çalışır ama container GPU göremez.

## Deployment

### Deployment `pulling` durumunda takılı kaldı

Büyük image (10GB+) zaman alır. 10 dakikadan uzunsa:

```bash
# Host'ta:
docker pull <image>
# manuel yaparak progress'i izle
```

Disk dolu? `df -h` ile kontrol et. Image cache `/var/lib/docker` altında.

### `unhealthy` flapping

Container kalkıyor, `/health` 200 verirken döngüye giriyor:

1. Container log: terminal modal → `deployment-exec` → `cat /tmp/...log`.
2. vLLM `--gpu-memory-utilization` çok yüksek → OOM → restart.
3. Disk model dosyalarını dolduruyor (HF cache) → `df -h /` kontrol et.

### `CUDA out of memory`

Model boyutu vs available VRAM:

- Library'deki `minVramGiB` değeri quantize edilmemiş referans. AWQ/GPTQ-INT4 ile 4× azalır.
- Multi-GPU `--tensor-parallel-size` parametresi sayısı host'taki GPU sayısıyla
  eşleşmeli.
- MIG slice kullanıyorsan: o slice'a görünen VRAM = profile (3g.40gb = 40GB).

### Health probe 404

vLLM `/health` endpoint'i v0.5.x+'da `/health`, eski versiyonlarda `/v1/models`.
Custom deployment'larda `healthPath` field'ını doğru ayarla.

## Pool

### `503 Pool has no healthy members`

Hiçbir üye `actualState=healthy` değil. Pool detail → member listesinde kim
unhealthy/failed işaretli? Onların log'una bak.

Çözüm: en azından bir üyenin healthy'e gelmesini bekle veya yeni deployment ekle.

### Pool round-robin'de cluster'da uniform değil

Multi-node console'da per-process cursor. Önemli ölçek için `least-busy`'ye geç
(DB-shared karar).

### Publish yaptım, Model Hub'da gözükmüyor

Provider/Model kayıtları `Providers` ve `Models` sekmelerinde çıkmalı. Yoksa:

```
GET /api/providers
GET /api/models
```

API'den gör. Hâlâ yoksa publish başarısız olmuş — pool detail'inde "Published" badge
var mı kontrol et, yoksa tekrar dene.

### Pool endpoint 401 dönüyor

Bearer token yanlış. Pool publish edildiğinde mint edilen token sadece tek seferlik
gösterildi. Kaybettiysen:

- `Tokens` sayfasından `gpu-pool/<key>` label'lı token'ı revoke et.
- Provider'ı sil + pool'u tekrar publish et.

## MIG

### `apply-mig-profile` agent error

Tipik:

- `nvidia-smi: command not found` — host NVIDIA değil (UI bu host'a MIG göstermemeli).
- `Unable to enable MIG mode: Insufficient permissions` — agent root değil.
- `MIG mode setting requires a GPU reset` — process'ler GPU'yu tutuyor. Tekrar dene.

### Reconfigure sonrası deployment'ları bulamıyorum

MIG değiştiğinde eski slice UUID'leri kaybolur. Eski deployment'lar `stopped`'da
kalır. Yeni slice'lara yeni deployment yarat.

## Terminal

### "terminal access not enabled" hatası

Host kaydında `terminalEnabled = false`. Host detail'de claim formunda veya
sonradan toggle aç.

### Komut yazıyorum, çıktı gelmiyor

Phase 1 PTY-less. Bazı komutlar `stdin` line-buffered yerine raw bekleyebilir.
Workaround: `<command> < /dev/null` veya komutu agent log üzerinden çalıştır.

### WS bağlantısı kapanıyor

- TTL doldu (default 30dk).
- Agent restart oldu.
- Network blip — sekmeyi kapat, yeniden aç.

## Genel

### Agent token persisted dosyası bozuldu

```bash
sudo systemctl stop cognipeer-gpu-agent
sudo rm /var/lib/cognipeer-gpu-agent/agent-token
# install command'ı yeniden çalıştır (fleet veya registration token ile)
sudo systemctl start cognipeer-gpu-agent
```

### Console'dan host silindi, agent hâlâ ne yapar?

Heartbeat'lerde 401 alır, log'a uyarı düşer ama çalışmaya devam eder. Tamamen
durdurmak için host'ta:

```bash
sudo systemctl stop cognipeer-gpu-agent
sudo systemctl disable cognipeer-gpu-agent
```

### Bundle eski, agent'ı upgrade et

```bash
sudo curl -fsSL <new-asset-url> -o /tmp/agent.tar.gz
sudo tar -xzf /tmp/agent.tar.gz -C /opt/cognipeer-gpu-agent
sudo systemctl restart cognipeer-gpu-agent
```

Mevcut agent token korunur (state dir dokunulmaz).

## Hâlâ takıldıysan

1. `journalctl -u cognipeer-gpu-agent --since "10 minutes ago"` çıktısını topla.
2. `Audit Log` sayfasında ilgili `gpu-fleet.*` event'lerini filtrele.
3. Pool sorunuysa: `Inference Monitoring` sayfasında üyelerin metric'i geliyor mu?

→ [FAQ](./faq) — sıkça sorulan sorular.
