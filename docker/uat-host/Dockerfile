FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb xauth git ca-certificates python3 make g++ \
    libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxkbfile1 libsecret-1-0 libdrm2 libxkbcommon0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work
ENV UAT_VSCODE_CACHE=/vscode-cache
# Source and node_modules are mounted/built at run time (see docker.mjs); the image holds only the OS layer.
ENTRYPOINT ["bash", "-lc", "npm ci && npm run -s build && KARST_TARGET_APP_BINARY=\"$(npm run -s uat:host -- --print-vscode | tail -1)\" npm run -s rebuild:electron && xvfb-run -a --server-args='-screen 0 1280x800x24' npm run -s uat:host -- \"$@\"", "--"]
