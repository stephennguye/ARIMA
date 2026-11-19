# The image a sandboxed role run uses (WP-190, ADR-0006). Build once:
#   docker build -t arima-sandbox:1 plugins/arima/templates/sandbox
# It holds Node, git and the Claude Code CLI. It holds no credentials: they are passed per run.
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code \
 && git config --system user.name "ARIMA role" \
 && git config --system user.email "role@arima.invalid" \
 && git config --system --add safe.directory /work
USER node
WORKDIR /work
