#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

SRC="${1:-${REPO_ROOT}/images/seep_75.png}"
OUT="${2:-${SCRIPT_DIR}/seep-icon-from-seep75.png}"

if [[ ! -f "${SRC}" ]]; then
  echo "source icon not found: ${SRC}" >&2
  exit 1
fi

if ! command -v magick >/dev/null 2>&1; then
  echo "ImageMagick 'magick' is required to generate icon: ${OUT}" >&2
  exit 1
fi

mkdir -p "$(dirname "${OUT}")"
magick "${SRC}" -resize 1024x1024 "${OUT}"

# Quick sanity output for CI/local logs.
sips -g pixelWidth -g pixelHeight "${OUT}" >/dev/null
echo "generated: ${OUT}"
