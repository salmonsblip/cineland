#!/bin/sh
# Packs the plugin into a .ccx (a zip) next to this script.
cd "$(dirname "$0")" && rm -f legion-fill.ccx && zip -qr legion-fill.ccx manifest.json index.html main.js js && echo "legion-fill.ccx ready"
