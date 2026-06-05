# Terminal Access

GPU Fleet, console üzerinden host'a uzak shell açmana izin verir. Diagnostik için
ana kullanım — `nvidia-smi`, `docker ps`, `journalctl` gibi komutları çalıştır.

## Güvenlik

Terminal **iki-faktörlü** gate'lidir:

1. Kullanıcının RBAC izninde **`gpu-fleet`** servis erişimi (admin) olmalı.
2. Host kaydında **`terminalEnabled` = true** olmalı (claim sırasında veya sonra UI'dan).

Her terminal oturumu:

- Bir **TTL** ile sınırlı (varsayılan 30 dakika, `Settings → terminalSessionTtlSeconds` ile değiştirilebilir).
- **Audit log**'a yazılır (`gpu-fleet.terminal.open` event).
- Browser veya agent bağlantısı koparsa derhal kapanır.

## Sandbox modları

UI'da 3 mod var:

### `docker-debug` (varsayılan, önerilen)

`docker run --rm -i --network host -v /var/run/docker.sock:/var/run/docker.sock cognipeer/debug-shell:latest /bin/sh -i`

- Ephemeral container içinde shell.
- Docker socket'i mount edilmiş → `docker ps`, `docker logs <...>` çalışır.
- `--network host` ile pool/inference endpoint'lerine erişebilir.
- Host file system'e sınırlı erişim (sadece `/host:ro` mount'lu — şu an image hazır değilse fail eder).

### `host`

`/bin/sh -i` doğrudan agent process'inin namespace'inde, root yetkisinde.

- Tam yetki — `apt install`, `systemctl restart`, vs.
- Yanlış komut tüm makineyi etkiler. Dikkatli ol.
- Audit log her oturum açılışını yazar; komut bazında log şu an kapsamaz.

### `deployment-exec`

`docker exec -i <containerName> /bin/sh -i`

- Belirli bir deployment'ın container'ına gir.
- vLLM/TGI container'ı debug, log inceleme, GPU testi.
- Container shell yoksa (`debian-slim` image gibi) fail eder.

## Kullanım

Host detail → **Open terminal**:

1. Sandbox seç.
2. `deployment-exec` ise deployment id'yi yapıştır (host detay sayfasında listelenir).
3. **Open session** → console:
   - Bir sessionId üretir.
   - Agent'a `open-terminal-session` komutu basar.
   - WS endpoint URL'ini browser'a döner.
4. Browser, WebSocket bağlantısı açar.
5. Agent komutu görür, kendi WS'sini console'a açar, shell process spawn eder.
6. UI'da `[awaiting agent…]` → birkaç saniye sonra prompt görünür.

::: tip Şu an Phase 1
PTY (terminal emülasyonu) yok. Düz pipe → `vim`, `htop`, `less` çalışmaz. Komut +
çıktı OK. PTY upgrade'i sonraki phase'de (node-pty + xterm.js).
:::

## Komut çalıştırma örnekleri

```sh
# GPU envanteri
nvidia-smi
nvidia-smi -L
nvidia-smi mig -lgi

# Agent log
journalctl -u cognipeer-gpu-agent -n 100

# Docker
docker ps
docker logs cognipeer-llm-<deploymentId>
docker stats --no-stream

# Disk + memory
df -h
free -h
```

## Komut TTL ve cleanup

- Oturum TTL dolarsa: console + agent her ikisi de derhal kapatır, container/shell
  SIGTERM yer.
- Browser sekmesini kapatırsan: WS close → console session manager temizler →
  agent shell'ini öldürür.
- Agent yeniden başlarsa: tüm açık oturumlar düşer.

## Audit

Her oturum:

```
service: gpu-fleet
action: admin
event: gpu-fleet.terminal.open
resourceType: gpu-host
resourceId: <hostId>
metadata: { sandbox, sessionId }
```

`Audit Log` sayfasında filtrele.

## Sonraki adım

→ [Troubleshooting](./troubleshooting) — yaygın sorunlar.
