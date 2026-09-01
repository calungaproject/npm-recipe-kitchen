#!/usr/bin/env bash
# Default recipe directory inside the fullsend sandbox target-repo mount.
# Keep in sync with env.sandbox.RECIPE_PACKAGES_DIR in ../harness/npm-recipe-draft.yaml
# and agent docs that use ${RECIPE_PACKAGES_DIR:-/sandbox/workspace/target-repo/packages}.
RECIPE_PACKAGES_DIR="${RECIPE_PACKAGES_DIR:-/sandbox/workspace/target-repo/packages}"
