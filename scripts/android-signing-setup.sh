#!/usr/bin/env bash
# One-time setup of the Android signing key, run on your own machine so the private key never
# leaves it except into GitHub's encrypted secrets.
#
#   scripts/android-signing-setup.sh [owner/repo]
#
# - Creates a self-signed release key (RSA 4096, valid ~27 years) in a new keystore.
# - Creates the GitHub environment "android-signing", usable only from main and v* tags, and stores
#   the keystore and its passwords there as secrets. CI signs every APK on the Releases page with it,
#   so each build installs over the last.
# - Keeps a backup in ~/.lanesignal-signing/ (keystore + passwords). Keep it somewhere safe: without
#   it, a lost key means uninstalling the app once more.
#
# Needs: keytool (any JDK), openssl, and the GitHub CLI signed in with admin rights on the repo.
set -euo pipefail

repo=${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}
env=android-signing
alias=lanesignal
dir="$HOME/.lanesignal-signing"

for tool in keytool openssl gh; do command -v "$tool" >/dev/null || { echo "Needs $tool"; exit 1; }; done
if gh secret list --env "$env" --repo "$repo" 2>/dev/null | grep -q '^ANDROID_KEYSTORE_BASE64'; then
  echo "$repo already has a signing key in the \"$env\" environment. Replacing it means one more uninstall"
  echo "on every phone; to do that anyway, delete the environment's secrets first."
  exit 1
fi

mkdir -p "$dir" && chmod 700 "$dir"
keystore="$dir/lanesignal-release.jks"
[ -e "$keystore" ] && { echo "$keystore exists: upload that one instead of making a new key, or move it away."; exit 1; }
password=$(openssl rand -base64 30 | tr -d '/+=')

# PKCS12 keystores use one password for the store and the key.
keytool -genkeypair -keystore "$keystore" -storetype PKCS12 -alias "$alias" \
  -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=LaneSignal" \
  -storepass "$password" -keypass "$password" >/dev/null 2>&1
chmod 600 "$keystore"
printf 'keystore: %s\nalias: %s\npassword: %s\n' "$keystore" "$alias" "$password" > "$dir/passwords.txt"
chmod 600 "$dir/passwords.txt"

# The environment, limited to main and version tags, so pull request builds never see the key.
echo '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' |
  gh api -X PUT "repos/$repo/environments/$env" --input - >/dev/null
gh api -X POST "repos/$repo/environments/$env/deployment-branch-policies" -f name=main -f type=branch >/dev/null 2>&1 || true
gh api -X POST "repos/$repo/environments/$env/deployment-branch-policies" -f name='v*' -f type=tag >/dev/null 2>&1 || true

base64 < "$keystore" | tr -d '\n' | gh secret set ANDROID_KEYSTORE_BASE64 --env "$env" --repo "$repo"
gh secret set ANDROID_KEYSTORE_PASSWORD --env "$env" --repo "$repo" --body "$password"
gh secret set ANDROID_KEY_ALIAS --env "$env" --repo "$repo" --body "$alias"
gh secret set ANDROID_KEY_PASSWORD --env "$env" --repo "$repo" --body "$password"

echo "Done. The next build of main (or a v* tag) publishes a signed APK."
echo "Backup: $dir (keystore and passwords). Keep a copy somewhere safe, e.g. a password manager."
