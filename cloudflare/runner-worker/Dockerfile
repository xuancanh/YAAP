# Sandbox container image: the Cloudflare sandbox base plus python3, so both
# run_js and run_python have an interpreter. Nothing else is installed —
# package installs would need egress, and egress is denied (allowedHosts = []).
FROM docker.io/cloudflare/sandbox:0.8.9

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 coreutils \
  && rm -rf /var/lib/apt/lists/*

EXPOSE 3000
