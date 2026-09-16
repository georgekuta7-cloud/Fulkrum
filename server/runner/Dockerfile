# Execution image for Fulkrum.
#
# Commands requested by an agent run inside this image, never on the host. The
# container is the security boundary: the agent gets no network, a read-only root
# filesystem, no capabilities, a non-root user, and only the workspace mounted
# writable. Nothing here is trusted to be safe on its own.
#
# The base is pinned by manifest digest, not by tag: a tag can be moved, and this
# image is part of the boundary. To update it deliberately, read the current digest
# with `docker buildx imagetools inspect node:24-bookworm-slim` and replace it here.
FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553

# git and a shell are the only real tools: enough to inspect and build a
# repository offline. Network clients are deliberately absent, so an enabled
# network would still not hand the agent a ready-made exfiltration tool.
RUN apt-get update \
  && apt-get install --no-install-recommends --yes git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# A hooks directory that is empty and unwritable by the runner, so a repository
# cannot install a hook that fires during an agent command. /home/fulkrum is the
# mount point for the tmpfs HOME the runtime supplies.
RUN mkdir -p /opt/fulkrum/empty-hooks /home/fulkrum && chmod 0555 /opt/fulkrum/empty-hooks

# HOME lives on a tmpfs mounted with exec allowed, because the root filesystem is
# read-only and /tmp cannot execute anything: npm, pip, and cargo all install into
# the home directory and would otherwise fail in a way that looks like the
# command's fault rather than the sandbox's. The runtime passes --user, and the
# tmpfs is mode 1777, so that user can write to it.
ENV HOME=/home/fulkrum \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_SYSTEM=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_PAGER=cat \
    GIT_EXTERNAL_DIFF= \
    GIT_TERMINAL_PROMPT=0 \
    GIT_OPTIONAL_LOCKS=0 \
    GIT_CONFIG_COUNT=3 \
    GIT_CONFIG_KEY_0=core.hooksPath \
    GIT_CONFIG_VALUE_0=/opt/fulkrum/empty-hooks \
    GIT_CONFIG_KEY_1=core.fsmonitor \
    GIT_CONFIG_VALUE_1=false \
    GIT_CONFIG_KEY_2=safe.directory \
    GIT_CONFIG_VALUE_2=*

USER node
WORKDIR /workspace

# The base image ships an entrypoint that rewrites the first argument (it runs
# `node <arg>` when the argument is not an existing binary), which turns a missing
# command into a confusing Node module error. The argv here is the command, so the
# entrypoint is cleared and exec receives it directly.
ENTRYPOINT []

# There is no default command: this image is only used with an explicit argv.
# Use `docker inspect --format='{{index .RepoDigests 0}}'` after building and pin
# that digest in FULKRUM_RUNNER_IMAGE for reproducibility.
CMD ["/bin/true"]
