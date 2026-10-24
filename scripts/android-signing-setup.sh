#!/usr/bin/env bash
# One-time setup of the Android signing key, run on your own machine so the private key never
# leaves it except into GitHub's encrypted secrets.
#
#   scripts/android-signing-setup.sh [--yes] [owner/repo]
#
# Or without a computer: the "Android signing setup" workflow (Actions tab) runs this in a runner.
#
# - Creates a self-signed release key (RSA 4096, valid ~27 years), or reuses the one from an earlier
#   run kept in ~/.lanesignal-signing/.
# - Creates the GitHub environment "android-signing", usable only from main and v* tags, and stores
#   the keystore and its passwords there as secrets. CI signs every APK on the Releases page with it,
#   so each build installs over the last.
# - Keep ~/.lanesignal-signing/ (keystore + password) somewhere safe: without it, a lost key means
#   uninstalling the app once more.
#
# Safe to re-run after a failure: it reuses the saved key and finishes the upload.
# Needs: a JDK (keytool), openssl, and the GitHub CLI signed in with admin rights on the repo.
set -euo pipefail

yes=false
if [ "${1:-}" = --yes ]; then yes=true; shift; fi
for tool in keytool openssl gh; do command -v "$tool" >/dev/null || { echo "Needs $tool"; exit 1; }; done
repo=${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}
env=android-signing
alias=lanesignal
dir="$HOME/.lanesignal-signing"
keystore="$dir/lanesignal-release.jks"
secrets=(ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD ANDROID_KEYSTORE_PASSWORD ANDROID_KEYSTORE_BASE64)

if [ "$yes" != true ]; then
  read -r -p "Set up Android signing for $repo? [y/N] " ok
  [[ "$ok" == [yY]* ]] || exit 1
fi

# The keystore secret is uploaded last, so its presence means a finished setup.
if gh secret list --env "$env" --repo "$repo" 2>/dev/null | awk '$1 == "ANDROID_KEYSTORE_BASE64" { found = 1 } END { exit !found }'; then
  echo "$repo already has a signing key in the \"$env\" environment. Replacing it means one more uninstall"
  echo "on every phone; to do that anyway, delete the environment's secrets first."
  exit 1
fi

mkdir -p "$dir" && chmod 700 "$dir"
if [ -e "$keystore" ]; then
  # A key from an earlier run (e.g. one that failed while uploading): upload that one.
  password=$(sed -n 's/^password: //p' "$dir/passwords.txt" 2>/dev/null || true)
  [ -n "$password" ] || { echo "$keystore exists but $dir/passwords.txt has no password; move the keystore away to start over."; exit 1; }
  echo "Reusing the key in $keystore."
else
  password=$(openssl rand -base64 30 | tr -d '/+=\n')
  # PKCS12 keystores use one password for the store and the key. Passed in the environment, not argv.
  if ! KS_PASS="$password" keytool -genkeypair -keystore "$keystore" -storetype PKCS12 -alias "$alias" \
    -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=LaneSignal" \
    -storepass:env KS_PASS -keypass:env KS_PASS; then
    echo "keytool failed: install a JDK (e.g. Temurin) and run this again."
    exit 1
  fi
  chmod 600 "$keystore"
  printf 'keystore: %s\nalias: %s\npassword: %s\n' "$keystore" "$alias" "$password" > "$dir/passwords.txt"
  chmod 600 "$dir/passwords.txt"
fi

# The environment, limited to main and version tags, so pull request builds never see the key.
echo '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' |
  gh api -X PUT "repos/$repo/environments/$env" --input - >/dev/null
policies=$(gh api "repos/$repo/environments/$env/deployment-branch-policies" --jq '.branch_policies[] | "\(.type):\(.name)"')
for p in branch:main 'tag:v*'; do
  grep -qx "$p" <<<"$policies" ||
    gh api -X POST "repos/$repo/environments/$env/deployment-branch-policies" -f name="${p#*:}" -f type="${p%%:*}" >/dev/null
done
policies=$(gh api "repos/$repo/environments/$env/deployment-branch-policies" --jq '.branch_policies[] | "\(.type):\(.name)"')
grep -qx 'branch:main' <<<"$policies" && grep -qx 'tag:v\*' <<<"$policies" ||
  { echo "Couldn't limit $env to main and v* tags; check Settings → Environments → $env."; exit 1; }

# Values on stdin, not the command line. The keystore goes last (see above).
printf '%s' "$alias" | gh secret set ANDROID_KEY_ALIAS --env "$env" --repo "$repo"
printf '%s' "$password" | gh secret set ANDROID_KEY_PASSWORD --env "$env" --repo "$repo"
printf '%s' "$password" | gh secret set ANDROID_KEYSTORE_PASSWORD --env "$env" --repo "$repo"
base64 < "$keystore" | tr -d '\n' | gh secret set ANDROID_KEYSTORE_BASE64 --env "$env" --repo "$repo"

# Repository-level secrets with the same names would still reach builds outside the environment.
old=$(gh secret list --repo "$repo" 2>/dev/null | awk '{print $1}' | grep -xE "$(IFS='|'; echo "${secrets[*]}")" || true)
if [ -n "$old" ]; then
  echo
  echo "Warning: these repository secrets also exist, and pull request builds can read them:"
  echo "$old" | sed 's/^/  /'
  echo "Delete them (gh secret delete NAME --repo $repo) so only the environment holds the key."
fi

echo
echo "Done. The next build of main (or a v* tag) publishes a signed APK."
if [ "${GITHUB_ACTIONS:-}" = true ]; then
  echo "The key exists only in the environment's secrets (no backup). If they're ever deleted, phones uninstall once."
else
  echo "Backup: $dir (keystore and password). Keep a copy somewhere safe, e.g. a password manager."
fi
