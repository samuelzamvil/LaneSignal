#!/usr/bin/env bash
# Publishes the Android APK that CI just built to the repository's Releases page.
#   - a version tag (v1.2.3): a release named after the tag
#   - main: the "latest" pre-release, replaced on every merge
# Needs GH_TOKEN (contents: write) and LANESIGNAL_VERSION_NAME; APK_DIR is where the APKs are
# (CI downloads the build's artifact there).
set -euo pipefail

outputs=${APK_DIR:-web/android/app/build/outputs/apk}
# The artifact's layout depends on which APKs it holds, so look anywhere under it.
release_apk=$(find "$outputs" -name '*-release.apk' | head -n1)
debug_apk=$(find "$outputs" -name 'app-debug.apk' | head -n1)
if [ -n "$release_apk" ]; then apk=$release_apk; signed=true; else apk=$debug_apk; signed=false; fi
[ -n "$apk" ] || { echo "No APK under $outputs"; exit 1; }
asset="lanesignal-${LANESIGNAL_VERSION_NAME}.apk"
cp "$apk" "$asset"

notes=$(mktemp)
if [ "$signed" = true ]; then
  cat > "$notes" <<EOF
## Android app

\`$asset\` is signed with this project's release key. It isn't on the Play Store, so Android installs it by **sideloading**:

1. Open this page on the phone and download \`$asset\`.
2. Open it. When Android asks, allow installs from your browser (or Files app).
3. Play Protect may warn that the app is from an unknown developer: choose **Install anyway**.

**Updating:** newer builds install over this one. Uninstall first only when coming from an older, unsigned build, or when going back from a newer build to an older one (e.g. from the latest main build to an earlier tagged release).
EOF
else
  cat > "$notes" <<EOF
## Android app: unsigned build, sideload only

\`$asset\` is **unsigned**: it isn't signed with a release key (only with a throwaway debug key, which Android needs to install anything) and it isn't on the Play Store, so it installs only by **sideloading**:

1. Open this page on the phone and download \`$asset\`.
2. Open it. When Android asks, allow installs from your browser (or Files app).
3. Play Protect may warn that the app is from an unknown developer: choose **Install anyway**.

**Updating:** each build is signed with a throwaway debug key, so Android refuses to install it over a previous one ("App not installed" or "package conflicts"). Uninstall the old version first, then sign in again.
EOF
fi
cat >> "$notes" <<EOF

Push notifications through Firebase are only built in when the repository has the \`GOOGLE_SERVICES_JSON\` secret; ntfy works either way. See [Android app and push notifications](https://github.com/${GITHUB_REPOSITORY}/blob/${GITHUB_SHA}/docs/android.md).

Built from \`${GITHUB_SHA:0:7}\`.
<!-- run:${GITHUB_RUN_NUMBER} -->
EOF

if [[ "$GITHUB_REF" == refs/tags/v* ]]; then
  if gh release view "$GITHUB_REF_NAME" >/dev/null 2>&1; then
    # A re-run (or a manual run, e.g. once signing is set up): refresh the APK and its notes.
    gh release upload "$GITHUB_REF_NAME" "$asset" --clobber
    gh release edit "$GITHUB_REF_NAME" --notes-file "$notes"
  else
    pre=(); [[ "$GITHUB_REF_NAME" == *-* ]] && pre=(--prerelease)   # v1.0.0-rc1
    gh release create "$GITHUB_REF_NAME" "$asset" --verify-tag "${pre[@]}" --title "LaneSignal $GITHUB_REF_NAME" --notes-file "$notes"
  fi
else
  # Runs can finish out of order: only the build of main's current head becomes "latest".
  head=$(gh api "repos/$GITHUB_REPOSITORY/commits/main" --jq .sha)
  if [ "$head" != "$GITHUB_SHA" ]; then echo "main has moved on to ${head:0:7}; not publishing ${GITHUB_SHA:0:7}"; exit 0; fi
  # A push run and a manual run can build the same commit: never replace a newer build (a higher
  # versionCode, which phones would refuse to go back from) with an older one.
  current=$(gh release view latest --json body --jq .body 2>/dev/null | sed -n 's/.*<!-- run:\([0-9]*\) -->.*/\1/p' || true)
  if [ -n "$current" ] && [ "$current" -ge "$GITHUB_RUN_NUMBER" ]; then
    echo "latest is already run $current; not replacing it with run $GITHUB_RUN_NUMBER"; exit 0
  fi
  # One rolling pre-release for main: replace it, and its tag, so it points at this commit.
  gh release delete latest --yes --cleanup-tag 2>/dev/null || true
  gh api -X DELETE "repos/$GITHUB_REPOSITORY/git/refs/tags/latest" >/dev/null 2>&1 || true
  gh release create latest "$asset" --target "$GITHUB_SHA" --prerelease \
    --title "Latest build (main, ${GITHUB_SHA:0:7})" --notes-file "$notes"
fi
