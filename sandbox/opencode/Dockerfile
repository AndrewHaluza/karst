# karst opencode sandbox image (arch:AC-32, docker backend). Built locally by
# karst with the versions pinned in src/agent/docker/dockerImage.ts passed as
# build args; never pulled. The defaults below only serve a manual build.
#
# The image also carries what a REPOSITORY'S OWN GATES need (arch:GATE-CAPABILITY):
#   - a C++ toolchain and Python, so a native addon with no published prebuild
#     (better-sqlite3 has none for linux-arm64) can be BUILT here instead of
#     missing; and
#   - the pinned Playwright browser together with the fonts and fontconfig rules
#     of the environment the visual baselines were recorded in, so a sweep run
#     here renders the same pixels the baselines hold.
#
# The base image tag and the browser below come from ONE argument (PW), so the
# rendering environment and the browser cannot drift apart.
ARG PW=1.63.0
FROM mcr.microsoft.com/playwright:v${PW}-noble AS baseline
FROM node:22-bookworm-slim
ARG PW
ARG OC1=1.19.0
ARG OC2=2.0.27
# `lsof` is not optional: the port-conflict / server-identity path uses it to
# name the process LISTENING on a port (src/runtime/portConflict.ts), and
# `procps` alone cannot answer that. Without it every reclaim refuses and the
# repo's own server suites read "no listener".
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates procps lsof \
    build-essential python3 fontconfig \
    && rm -rf /var/lib/apt/lists/*
# A commit must work in ANY repository here, not only in the ticket clone (which
# gets the host's identity from `git clone --config user.name=…`): a gate that
# builds a scratch repo in /tmp, or an agent committing its own work, otherwise
# fails with "Please tell me who you are".
RUN git config --system user.name 'karst sandbox' \
    && git config --system user.email 'sandbox@karst.invalid'
# The browser build the pinned image ships (same Playwright release), plus the
# shared libraries it needs. Only chromium: the postinstall of the package
# would fetch every browser, and the install step below fetches the one the
# sweep uses.
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i -g "playwright@${PW}" \
    && playwright install --with-deps chromium \
    && mv /root/.cache/ms-playwright /ms-playwright \
    && chown -R node:node /ms-playwright
# The faces and the fontconfig rules of the environment the baselines were
# recorded in: a sweep here must pick the SAME face for the same stack, or the
# diff is the font and not the page. This COPY MUST COME AFTER the browser
# install: `playwright install --with-deps` apt-installs THIS distro's font
# packages (fonts-liberation 1.07 on bookworm, against noble's 2.1.5, plus
# fontconfig-config), which overwrite the copied trees and change every glyph
# advance — the sweep then fails on every page, including pages the change never
# touched. Wipe first: COPY merges, so a distro-only face would survive beside
# the baseline's and win fontconfig's default for its family.
RUN rm -rf /usr/share/fonts /usr/share/fontconfig /etc/fonts
COPY --from=baseline /usr/share/fonts /usr/share/fonts
COPY --from=baseline /usr/share/fontconfig /usr/share/fontconfig
COPY --from=baseline /etc/fonts /etc/fonts
RUN fc-cache -f
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# The marker that tells a repository's gate scripts that THIS container is the
# rendering environment the baselines belong to (scripts/dockerGate.mjs): with
# it, a sweep that cannot use docker runs here and still means something.
RUN mkdir -p /opt/karst && printf 'playwright %s\n' "${PW}" > /opt/karst/visual-baseline-env
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
