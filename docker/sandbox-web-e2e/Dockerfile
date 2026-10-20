# Cognipeer Sandbox — web app + browser testing image.
#
# The base image plus Playwright, Chromium and ffmpeg: run an app in the
# sandbox, drive it with Playwright, then look at screenshots / videos with the
# agent's read tool. Repos that pin a different Playwright version download
# their own browser build on first run. Launch Chromium with
# `--disable-dev-shm-usage` (the sandbox /dev/shm is only 64 MB).
#
# Build:  docker build -t cognipeer/sandbox-web-e2e:latest docker/sandbox-web-e2e
#   (or:  bash scripts/build-sandbox-web-e2e.sh)

ARG BASE_IMAGE=cognipeer/sandbox-base:latest
FROM ${BASE_IMAGE}

ARG PLAYWRIGHT_VERSION=1.59.1

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_PATH=/usr/local/lib/node_modules

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && npm install -g --no-fund --no-audit \
      @playwright/test@${PLAYWRIGHT_VERSION} \
      playwright@${PLAYWRIGHT_VERSION} \
      wait-on@9.5.1 \
    && playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm
