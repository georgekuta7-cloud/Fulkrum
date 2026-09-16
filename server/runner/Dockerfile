# Execution image for Fulkrum.
#
# Commands requested by an agent run inside this image, never on the host. The
# container is the security boundary: the agent gets no network, a read-only root
# filesystem, no capabilities, a non-root user, and only the workspace mounted
# writable. Nothing here is trusted to be safe on its own.
FROM node:24-bookworm-slim

# git and a shell are the only real tools: enough to inspect and build a
# repository offline. Network clients are deliberately absent, so an enabled
# network would still not hand the agent a ready-made exfiltration tool.
RUN apt-get update \
  && apt-get install --no-install-recommends --yes git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The runtime passes --user 1000:1000, and the base image already owns that id as
# the `node` user, so nothing is created here. HOME points at the tmpfs because the
# rest of the filesystem is read-only.

# A hooks directory that is empty and unwritable by the runner, so a repository
# cannot install a hook that fires during an agent command.
RUN mkdir -p /opt/fulkrum/empty-hooks && chmod 0555 /opt/fulkrum/empty-hooks

ENV HOME=/tmp \
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
