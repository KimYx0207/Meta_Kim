#!/usr/bin/env bash
# Meta_Kim 元技能依赖安装脚本
# 将 7 个放大 agent 能力的元技能安装到全局 ~/.claude/skills/

set -e

SKILLS_DIR="$HOME/.claude/skills"
PROXY="${HTTPS_PROXY:-${HTTP_PROXY:-}}"
GIT_PROXY_FLAGS=""

if [ -n "$PROXY" ]; then
  GIT_PROXY_FLAGS="-c http.proxy=$PROXY -c https.proxy=$PROXY"
  echo "Using proxy: $PROXY"
fi

mkdir -p "$SKILLS_DIR"

install_skill() {
  local name="$1"
  local repo="$2"
  local target="$SKILLS_DIR/$name"

  if [ -d "$target" ]; then
    echo "  [SKIP] $name — already installed at $target"
    return
  fi

  echo "  [INSTALL] $name from $repo"
  git $GIT_PROXY_FLAGS clone --depth 1 "https://github.com/$repo.git" "$target" 2>/dev/null
  echo "  [OK] $name installed"
}

install_skill_from_subdir() {
  local name="$1"
  local repo="$2"
  local subdir="$3"
  local target="$SKILLS_DIR/$name"

  if [ -d "$target" ]; then
    echo "  [SKIP] $name — already installed at $target"
    return
  fi

  echo "  [INSTALL] $name from $repo (subdir: $subdir)"
  local tmpdir
  tmpdir=$(mktemp -d)
  git $GIT_PROXY_FLAGS clone --depth 1 --filter=blob:none --sparse \
    "https://github.com/$repo.git" "$tmpdir" 2>/dev/null
  (cd "$tmpdir" && git sparse-checkout set "$subdir" 2>/dev/null)
  cp -r "$tmpdir/$subdir" "$target"
  rm -rf "$tmpdir"
  echo "  [OK] $name installed"
}

echo ""
echo "========================================="
echo "  Meta_Kim 元技能依赖安装"
echo "========================================="
echo ""

echo "--- 你自己的项目 (KimYx0207) ---"
install_skill "agent-teams-playbook" "KimYx0207/agent-teams-playbook"
install_skill "findskill"            "KimYx0207/findskill"

echo ""
echo "--- 社区高星项目 ---"
install_skill "superpowers"            "obra/superpowers"
install_skill "everything-claude-code" "affaan-m/everything-claude-code"
install_skill "planning-with-files"    "OthmanAdi/planning-with-files"
install_skill "cli-anything"           "HKUDS/CLI-Anything"

echo ""
echo "--- Anthropic 官方 ---"
install_skill_from_subdir "skill-creator" "anthropics/skills" "skills/skill-creator"

echo ""
echo "========================================="
echo "  Done! 7 meta-skills installed to $SKILLS_DIR"
echo "========================================="
echo ""
echo "Installed skills:"
ls -d "$SKILLS_DIR"/agent-teams-playbook "$SKILLS_DIR"/findskill \
      "$SKILLS_DIR"/superpowers "$SKILLS_DIR"/everything-claude-code \
      "$SKILLS_DIR"/planning-with-files "$SKILLS_DIR"/cli-anything \
      "$SKILLS_DIR"/skill-creator 2>/dev/null || true
