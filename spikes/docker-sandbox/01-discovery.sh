#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
run uname -srm
run sw_vers
run docker --version
run which sbx
run sbx version
run sbx --help
run sbx ls
run sbx create --help
run sbx run --help
run sbx exec --help
run sbx ports --help
run sbx stop --help
run sbx rm --help
run sbx login --help
run docker info --format '{{.OperatingSystem}} {{.ServerVersion}}'
