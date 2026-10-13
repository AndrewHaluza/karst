# Shared helper: run the spike image with the ro auth file over a writable data volume.
AUTH="${OC_AUTH:-$HOME/.local/share/opencode/auth.json}"
ocrun() { docker run --rm "$@"; }
OCBASE=(-v oc-data:/home/node/.local/share/opencode -v "$AUTH":/home/node/.local/share/opencode/auth.json:ro)
strip() { sed 's/\x1b\[[0-9;]*[A-Za-z]//g'; }
