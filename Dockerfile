# Postcard Printer — editor server (remote deploy).
# NOTE: printing uses macOS `lp`/CUPS and only works on the local Mac.
# In a container the editor + PNG export work; the print button will error
# (no printer attached to the server) — that's expected.
FROM node:20-alpine

WORKDIR /app

# Zero runtime dependencies — just copy the source.
COPY . .

# Reverse proxy must reach the server, so bind all interfaces in the container.
ENV HOST=0.0.0.0
ENV PORT=8787

EXPOSE 8787

CMD ["node", "server.js"]
