# Host Onboarding

GPU makinelerini console'a bağlamanın iki yolu var:

1. **Fleet token** (önerilen, 1+ makine için): tek bir tenant-genelinde token, her makineye install command olarak gider. Agent kurulunca `pending_claim` durumunda console'a düşer; admin claim eder.
2. **Tek-seferlik registration token** (legacy): UI'dan tek host yarat → tek-kullanımlık token al → kur. 16 makine için pratik değil.

Bu rehber **fleet token** akışını anlatır.

## Önkoşullar (host tarafında)

| Bileşen | Gerekli mi? | Not |
|---|---|---|
| NVIDIA Driver | Linux + NVIDIA için **evet** | Azure NCasv3/NCv4 image'larında zaten kurulu. `nvidia-smi` çalışmalı. |
| CUDA | Driver ile birlikte gelir | vLLM/TGI/Whisper-CUDA image'ları runtime'da getirir. |
| Docker | **Evet** | Engine 24+. |
| nvidia-container-toolkit | NVIDIA host'larda **evet** | `nvidia-ctk` PATH'de olmalı. |
| Root yetkisi | İlk kurulumda **evet** | Agent systemd unit olarak kurulur. |

Apple Silicon host: sadece Docker Desktop yeterli. CPU-only host: sadece Docker.

## Adım 1 — Fleet token üret

UI: `GPU Fleet → Onboarding` → platform seç (linux-x64, darwin-arm64, …) → **Generate**.

::: tip
Token tek seferlik görüntülenir; sadece SHA-256 hash'i DB'ye yazılır. Rotate edilince eski
token derhal geçersizdir. Üretilen install command'ı bir password manager'da sakla.
:::

UI sana şuna benzer bir komut verir:

```bash
curl -fsSL https://console.example.com/api/gpu-fleet/installer.sh | sudo bash -s -- \
  --console-url https://console.example.com \
  --tenant-slug acme \
  --fleet-token gpuflt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  --asset-url https://console.example.com/api/gpu-fleet/agent-bundle/linux-x64.tar.gz
```

## Adım 2 — Host'a kur

Komutu host üzerinde `root` olarak çalıştır:

```bash
ssh root@gpu-01.your-network
# install.sh prereq kontrolü yapar:
#   ✓ nvidia-smi
#   ✓ docker
#   ✓ nvidia-container-toolkit
# eksikse fail eder. Sonra:
# /opt/cognipeer-gpu-agent/cognipeer-gpu-agent → systemd service
# /etc/cognipeer-gpu-agent.env → COGNIPEER_* env vars
```

Başarı çıktısı:

```
==> Installed. Tail logs with:
      journalctl -u cognipeer-gpu-agent -f
```

`journalctl -u cognipeer-gpu-agent -f` ile log'u izleyebilirsin. Agent başlar başlamaz:

1. Platform adapter'ı seçer (linux-nvidia / macos-apple-silicon / cpu-only).
2. `nvidia-smi --query-gpu` ve `nvidia-smi -L` ile GPU/MIG envanteri çıkarır.
3. Console'a `POST /api/gpu/agent/<tenantSlug>/fleet-handshake` çağrısı atar.
4. Console **agent token** üretir, host `pending_claim` olarak kaydedilir.
5. Agent token persisted (`/var/lib/cognipeer-gpu-agent/agent-token`); reboot sonrası tekrar handshake gerekmez.

## Adım 3 — UI'dan claim et

`GPU Fleet → Onboarding` sayfası 5 saniyede bir refresh olur. Yeni gelen host'lar
**Pending claim** bölümünde toolchain rozetleriyle (driver / cuda / docker / ctk)
listelenir.

Her satırda:

- **Display name** — host'u UI'da nasıl çağırmak istersen (örn. `gpu-prod-istanbul-01`).
- **Service address** — agent'ın önerdiği IP (ilk non-loopback NIC). Pool proxy bu adrese
  HTTP isteği atacak; NAT/farklı network ise admin override edebilir.
- **Terminal access** — opt-in switch. Açmazsan UI'da terminal butonu disabled olur.

**Claim** → host **online**'a geçer. **Reject** → DB'den silinir; agent çalışmaya devam eder
ama bir daha pending_claim'e düşer (tekrar gelir). Agent'ı durdurmak istersen
makine üzerinde `systemctl stop cognipeer-gpu-agent`.

## Bulk claim

16 makineyi tek tek dönmek istemiyorsan: hepsini tek seferde seç (`Shift+Click`),
adlandırma şablonu `gpu-{n}` gir → hepsi tek seferde claim olur. Label'lar
sonradan host detayından düzenlenebilir.

## Heartbeat ve offline tespiti

- Agent her **15 saniyede** bir `POST /heartbeat` atar.
- Console **60 saniye** boyunca heartbeat alamadığı host'u `offline` işaretler.
- `offline → online` geçişi yeni heartbeat geldiği an otomatik olur.

## Rotate / revoke

Fleet token'ı sızdığı şüphesiyle iptal etmek: `Settings → Rotate fleet token`.
Eski token derhal reddedilir; mevcut paired agent'lar etkilenmez (kendi
agent token'larıyla devam ederler). Yeni makine ekleyemezsin → yeni token üretilince
yeniden mümkün.

Tek bir host'un agent token'ını revoke etmek: host detayında **Delete host**.
Agent bir sonraki heartbeat'te 401 alır ve durur; admin makineyi temizlemek için
`sudo systemctl stop cognipeer-gpu-agent && sudo rm -rf /var/lib/cognipeer-gpu-agent`.

## Sonraki adım

→ [Deploying Models](./deploying-models) — kataloglandan model deploy et.
