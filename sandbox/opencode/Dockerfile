# karst opencode sandbox image (arch:AC-32, docker backend). Built locally by
# karst with the versions pinned in src/agent/docker/dockerImage.ts passed as
# build args; never pulled. The defaults below only serve a manual build.
FROM node:22-bookworm-slim
ARG OC1=1.19.0
ARG OC2=2.0.27
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates procps \
  && rm -rf /var/lib/apt/lists/*
# v1 and v2 both ship a launcher named `opencode`: separate prefixes, distinct names.
RUN npm i -g --prefix /opt/oc1 "opencode-ai@${OC1}" && npm i -g --prefix /opt/oc2 "@opencode/cli@${OC2}" \
  && ln -s /opt/oc1/bin/opencode /usr/local/bin/opencode1 \
  && ln -s /opt/oc2/bin/opencode /usr/local/bin/opencode2
# Data dirs exist and belong to `node` before any mount lands on them: a single
# file mounted into a missing dir creates root-owned parents (ST2B blocker 3).
RUN mkdir -p /home/node/.local/share/opencode /home/node/.local/state /home/node/.config \
    /home/node/.cache /work \
  && chown -R node:node /home/node /work
USER node
WORKDIR /work
