FROM node:22-bookworm-slim
ARG OC1=1.19.0
ARG OC2=2.0.27
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl procps && rm -rf /var/lib/apt/lists/*
RUN npm i -g --prefix /opt/oc1 opencode-ai@${OC1} && npm i -g --prefix /opt/oc2 @opencode/cli@${OC2}
RUN ln -s /opt/oc1/bin/opencode /usr/local/bin/opencode1 && ln -s /opt/oc2/bin/opencode /usr/local/bin/opencode2
RUN mkdir -p /home/node/.local/share/opencode /home/node/.local/state /home/node/.config /home/node/.cache /work && chown -R node:node /home/node /work
USER node
WORKDIR /work
