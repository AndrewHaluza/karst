# Pinned set: multi-swe-bench-ts-v1

File: `multi-swe-bench-ts-v1.jsonl` (18 instances, one upstream row per line, **byte-exact**: no field edited).
Set version for the D293 report: **`multi-swe-bench-ts-v1`**. Compare results only within one version.

## Source

- Dataset: `ByteDance-Seed/Multi-SWE-bench` on Hugging Face, files under `ts/`, revision `56ff018c04a38e27ada1e9d0a6d5839a51f88f0d`.
- Harness: `multi-swe-bench/multi-swe-bench` at commit `24f493f8a103e72312ded4f6b9c89f081d69cb09` (pinned in `scripts/evalSetupHarness.sh`).
- Images: prebuilt `mswebench/<org>_m_<repo>:pr-<n>` (linux/amd64, emulated on arm64).
- Human-validated label: every selected instance is in the harness `images_verified.txt` list.

## Selection rule

1. TS repos only: vuejs/core, mui/material-ui, darkreader/darkreader (all TS instances of the dataset).
2. Verified list only (see above).
3. Size by gold `fix_patch` line count: S < 50, M 50–150, L 151–300. Quotas per repo: vue core 3 S / 3 M / 2 L, mui 3 S / 3 M / 2 L, darkreader (only 2 instances exist) 1 S / 1 M.
4. Rows over 3 MB skipped (dataset rows embed the builder's run logs).
5. Candidates tried in ascending PR number. Each got one gold run as a screen, then 3 gold runs; accepted only if the gold patch was `resolved` 3/3.
6. Skipped: dependency install needing more than the package registry would be dropped; none needed it (images ship deps preinstalled; see README caveat on offline).

Rejected on the gold check (kept out of the set):

| instance | result |
|---|---|
| vuejs/core:pr-8365 | unresolved: image lacks vitest |
| vuejs/core:pr-8538 | unresolved |
| vuejs/core:pr-8381 | unresolved |
| vuejs/core:pr-8535 | harness error |

## Instances

| instance | size | gold patch lines | F2P | P2P | row sha256 (16) |
|---|---|---|---|---|---|
| vuejs/core:pr-8470 | S | 21 | 1 | 2748 | 12ecd69ba02a654f |
| vuejs/core:pr-8785 | S | 18 | 2 | 2782 | 1254b2a6fc3b7fa5 |
| vuejs/core:pr-8824 | S | 48 | 3 | 2781 | fa30c39b54638410 |
| vuejs/core:pr-9213 | M | 58 | 2 | 3008 | 33cf80551117259f |
| vuejs/core:pr-9442 | M | 79 | 1 | 2733 | e6a37ea80d98fbeb |
| vuejs/core:pr-9507 | M | 52 | 9 | 2774 | 5f57c41d3f03d8a5 |
| vuejs/core:pr-8511 | L | 217 | 6 | 2793 | b9a6c3743115eae9 |
| vuejs/core:pr-11517 | L | 224 | 2 | 3142 | 91d196f2f7ef3503 |
| mui/material-ui:pr-23778 | S | 12 | 1 | 3385 | 6d6558217594cf5f |
| mui/material-ui:pr-23786 | S | 16 | 1 | 3386 | daf1563e86a9d960 |
| mui/material-ui:pr-24010 | S | 18 | 1 | 3405 | 460717468b1f3e4a |
| mui/material-ui:pr-23487 | M | 88 | 1 | 3385 | a84146305ed78d54 |
| mui/material-ui:pr-23806 | M | 70 | 1 | 3387 | 941e113f8fec4299 |
| mui/material-ui:pr-23884 | M | 51 | 1 | 3385 | 31f796096ec6279d |
| mui/material-ui:pr-23073 | L | 266 | 2 | 3401 | fd401642fe1e8c1b |
| mui/material-ui:pr-24621 | L | 212 | 3 | 3588 | 3f5119d513c8f8a4 |
| darkreader/darkreader:pr-7241 | S | 13 | 2 | 45 | 59429966137979bb |
| darkreader/darkreader:pr-6747 | M | 65 | 5 | 37 | f57fed18787db159 |

`row sha256` is the first 16 hex chars of the SHA-256 of the jsonl line (without newline), to detect accidental edits.

## Deviations from upstream

None. Problem statements, tests and patches are unchanged.

## Known risks

- Contamination: PRs up to 2024 may be in model training data. A SWE-bench-Live TS slice can be added as a later version.
- arm64 hosts run amd64 images emulated: slow and noisy wall clock.
- The test run is not enforced offline; only the package registry is needed.
