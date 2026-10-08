#!/bin/sh
# YouTube breaks extractors every few weeks and yt-dlp ships fixes within days.
# Updating on start means a pod restart picks them up, no new image needed
yt-dlp -U || echo "yt-dlp self-update failed, keeping $(yt-dlp --version)"
exec node /app/server.js
