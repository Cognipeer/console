# Cognipeer Sandbox — single common base image.
#
# One image that covers the bulk of agent workloads: code (Python + Node),
# fetch & process data, build sites, use git. Users who need more create their
# own template pointing at a custom image.
#
# Build:  docker build -t cognipeer/sandbox-base:latest docker/sandbox-base
#   (or:  bash scripts/build-sandbox-base.sh)

FROM nikolaik/python-nodejs:python3.12-nodejs22-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=development

# Common CLI + build toolchain. git is the headline addition.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      curl \
      wget \
      ca-certificates \
      openssh-client \
      unzip \
      zip \
      jq \
      less \
      nano \
      vim-tiny \
      procps \
      ripgrep \
      tini \
      build-essential \
      pkg-config \
    && rm -rf /var/lib/apt/lists/*

# A few ubiquitous Python libs so simple data tasks work out of the box,
# plus the office/document stack agents use to generate xlsx/pptx/docx and
# parse PDFs (replaces the old node-execution office libraries).
RUN pip install --no-cache-dir \
      requests \
      rich \
      pandas \
      openpyxl \
      python-pptx \
      python-docx \
      pdfplumber

# Common global npm helpers (kept light).
RUN npm install -g --no-fund --no-audit tsx typescript 2>/dev/null || true

WORKDIR /workspace

# Keep the container alive; the runner overrides this with its own entrypoint
# when it creates the sandbox, but this makes the image usable standalone too.
ENTRYPOINT ["tini", "--"]
CMD ["sleep", "infinity"]
