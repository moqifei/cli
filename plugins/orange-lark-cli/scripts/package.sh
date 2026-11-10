#!/usr/bin/env bash
# Build a self-contained plugin package: plugin code + the lark-cli binary.
#
# The plugin now lives inside the lark-cli repo (`plugins/orange-lark-cli`), so
# the CLI is rebuilt from the same working tree on every run — a CLI change can
# never be silently left out of the package.
#
# 企业 / 国产化环境（Kylin V10 等）：
#   * 默认目标 GOOS=linux，且 CGO_ENABLED=0 纯静态编译。静态 ELF 不依赖宿主机
#     glibc，避免在 Kylin V10（glibc 2.28 / 2.17）上报 GLIBC_x.yz not found。
#   * 架构支持 amd64 / arm64（飞腾、鲲鹏）/ loong64（龙芯），别名自动归一化。
#   * 交叉编译产物写到独立 stage，不覆盖开发机上的 ./lark-cli。
#   * 打包前校验 ELF 架构与静态链接；异构目标跳过本机 --version 执行。
#   * sha256 校验同时兼容 Linux(sha256sum) 与 macOS(shasum)。
#   * 包内 BUILDINFO.json 记录 goos/goarch/cgo/Node 要求，便于运维核对。
#
#   ./scripts/package.sh                          # linux + 自动架构，单包
#   ./scripts/package.sh --target linux/arm64     # 指定目标
#   ./scripts/package.sh --arch aarch64           # 只给架构（x86_64/loongarch64 亦可）
#   ./scripts/package.sh --all-arch               # 一次出 amd64/arm64/loong64 三个包
#   ./scripts/package.sh --no-cli-build           # 复用已有二进制
#   ./scripts/package.sh --install [DIR]          # 装到本机（目标须与本机一致）
#   GOOS=darwin GOARCH=arm64 ./scripts/package.sh # 打本机 macOS 包（显式指定）
#   CLI_SRC=/path/to/lark-cli ./scripts/package.sh
#   TARGET_ARCHES="amd64 arm64" ./scripts/package.sh --all-arch
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_REPO="${CLI_REPO:-$(cd "$ROOT/../.." && pwd)}"

CLI_SRC_EXPLICIT=0
if [ -n "${CLI_SRC:-}" ]; then
  CLI_SRC_EXPLICIT=1
fi
CLI_SRC="${CLI_SRC:-$CLI_REPO/lark-cli}"

CLI_BUILD=1
INSTALL=0
ALL_ARCH=0
FORCE_INSTALL=0
INSTALL_DIR="${ORANGE_PLUGINS_DIR:-$HOME/.orange/plugins}"

# 关键默认值：企业部署目标是 Linux，而不是打包机自己的 GOOS。
# 在 macOS 上跑旧版脚本默认会产出 darwin 包，拿到 Kylin 上根本无法执行。
TARGET_GOOS="${GOOS:-linux}"
TARGET_ARCH_RAW="${GOARCH:-${TARGET_ARCH:-}}"
TARGET_LIST="${TARGET_ARCHES:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --install) INSTALL=1; shift; if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then INSTALL_DIR="$1"; shift; fi ;;
    --no-cli-build) CLI_BUILD=0; shift ;;
    --cli-build) CLI_BUILD=1; shift ;;
    --all-arch) ALL_ARCH=1; shift ;;
    --force-install) FORCE_INSTALL=1; shift ;;
    --arch) TARGET_ARCH_RAW="${2:?--arch needs a value}"; shift 2 ;;
    --target)
      target="${2:?--target needs a value}"
      case "$target" in
        */*) TARGET_GOOS="${target%%/*}"; TARGET_ARCH_RAW="${target##*/}" ;;
        *) TARGET_ARCH_RAW="$target" ;;
      esac
      shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

normalize_arch() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    x86_64|amd64|x64) printf 'amd64' ;;
    aarch64|arm64|armv8*) printf 'arm64' ;;
    loongarch64|loong64|loongarch) printf 'loong64' ;;
    riscv64) printf 'riscv64' ;;
    *) printf '%s' "$1" ;;
  esac
}

HOST_GOOS="$(go env GOOS 2>/dev/null || true)"
if [ -z "$HOST_GOOS" ]; then
  HOST_GOOS="$(uname -s | tr '[:upper:]' '[:lower:]')"
fi
HOST_GOARCH="$(go env GOARCH 2>/dev/null || true)"
if [ -z "$HOST_GOARCH" ]; then
  HOST_GOARCH="$(normalize_arch "$(uname -m)")"
fi

if [ "$ALL_ARCH" = 1 ]; then
  TARGET_LIST="${TARGET_ARCHES:-amd64 arm64 loong64}"
elif [ -n "$TARGET_ARCH_RAW" ]; then
  TARGET_LIST="$(normalize_arch "$TARGET_ARCH_RAW")"
elif [ "$HOST_GOOS" = linux ]; then
  TARGET_LIST="$(normalize_arch "$(uname -m)")"
else
  # 从 macOS / Windows 打包且未指定架构时，选企业环境最通用的 x86_64。
  TARGET_LIST="amd64"
fi

set -- $TARGET_LIST
if [ "$CLI_SRC_EXPLICIT" = 1 ] && [ $# -gt 1 ]; then
  echo "CLI_SRC 只能对应一个目标平台；多目标打包请去掉 CLI_SRC（从源码交叉编译）。" >&2
  exit 2
fi
if [ "$INSTALL" = 1 ]; then
  if [ $# -gt 1 ]; then
    echo "--install 只允许单目标打包；请用 --arch / --target 指定一个，或单独安装 tar.gz。" >&2
    exit 2
  fi
  first_arch="$(normalize_arch "$1")"
  if [ "$TARGET_GOOS/$first_arch" != "$HOST_GOOS/$HOST_GOARCH" ] && [ "$FORCE_INSTALL" != 1 ]; then
    echo "目标平台 $TARGET_GOOS/$first_arch 与本机 $HOST_GOOS/$HOST_GOARCH 不一致：" >&2
    echo "--install 会把无法在本机执行的二进制装进插件目录。" >&2
    echo "企业部署请把 tar.gz 传到目标机器，再执行包内 scripts/install.sh <plugins-dir>。" >&2
    echo "确需强制安装请加 --force-install。" >&2
    exit 2
  fi
fi

VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || true)"
if [ -z "$VERSION" ]; then
  VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
fi
GIT_REF="$(git -C "$CLI_REPO" describe --tags --always --dirty 2>/dev/null || echo dev)"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CGO_ENABLED="${CGO_ENABLED:-0}"
CLI_LDFLAGS="-s -w -X github.com/larksuite/cli/internal/build.Version=${VERSION}-${GIT_REF} -X github.com/larksuite/cli/internal/build.Date=${BUILD_DATE}"
CLI_VERSION="$("$CLI_REPO/lark-cli" --version 2>/dev/null | head -1 || true)"

echo "==> building plugin"
# NOTE: do not `rm -rf dist skills` here. Some IDE shells shim `rm` with a
# bulk-delete guard (~500 files per turn) and a full skills/ regeneration is
# ~520 files. build.mjs overwrites in place and prunes removed skills instead.
node "$ROOT/build.mjs"

echo "==> targets: $TARGET_GOOS / $TARGET_LIST (CGO_ENABLED=$CGO_ENABLED, static ELF)"
echo "    host   : $HOST_GOOS/$HOST_GOARCH"

GO_TOOLCHAIN_CHECKED=0

# 交叉编译 lark-cli 需要 Go >= 1.23.0（cli/go.mod 的 go 指令）。
# 企业内网机器常常只报 "go: command not found"，这里给出可直接照做的版本提示。
ensure_go_toolchain() {
  [ "$GO_TOOLCHAIN_CHECKED" = "1" ] && return 0
  if ! command -v go >/dev/null 2>&1; then
    cat >&2 <<'EOF'
error: 找不到 go 命令，无法编译 lark-cli。

需要 Go >= 1.23.0（cli/go.mod 声明；所有 golang.org/x 依赖同样要求 1.23.0）。
Kylin V10 / ARM64（飞腾、鲲鹏）可用官方静态工具链，例如：

  curl -LO https://go.dev/dl/go1.23.12.linux-arm64.tar.gz
  sudo rm -rf /usr/local/go
  sudo tar -C /usr/local -xzf go1.23.12.linux-arm64.tar.gz
  export PATH=/usr/local/go/bin:$PATH
  go version

注意：
  * 版本必须 >= 1.23.0；低于此版本会报 "go.mod requires go >= 1.23.0"，
    GOTOOLCHAIN=auto 还会尝试联网下载工具链（离线环境会失败）。
  * 离线环境先在有网机器 go mod download，再拷贝 $GOPATH/pkg/mod，
    或配置内网 GOPROXY；也可以直接在开发机交叉编译：
    ./scripts/package.sh --target linux/arm64（CGO_ENABLED=0 静态产物）
EOF
    exit 1
  fi
  local go_ver minor
  go_ver="$(go version 2>/dev/null | awk '{print $3}')"
  minor="$(printf '%s' "${go_ver#go1.}" | cut -d. -f1)"
  case "$minor" in
    ''|*[!0-9]*) ;;  # devel 等非标准版本号，交给 go build 自己判断
    *)
      if [ "$minor" -lt 23 ]; then
        echo "error: 交叉编译需要 Go >= 1.23.0，当前为 $go_ver" >&2
        echo "       请升级 Go，或改用开发机交叉编译后拷贝产物。" >&2
        exit 1
      fi
      ;;
  esac
  GO_TOOLCHAIN_CHECKED=1
}

build_cli() {
  local goos="$1" goarch="$2" out="$3"
  ensure_go_toolchain
  echo "    go build GOOS=$goos GOARCH=$goarch -> $out"
  ( cd "$CLI_REPO" && CGO_ENABLED="$CGO_ENABLED" GOOS="$goos" GOARCH="$goarch" \
      go build -trimpath -ldflags "$CLI_LDFLAGS" -o "$out" . )
}

verify_cli() {
  local bin="$1" goos="$2" goarch="$3"
  local desc="" expected=""
  if command -v file >/dev/null 2>&1; then
    desc="$(file -b "$bin" 2>/dev/null || true)"
    if [ "$goos" = linux ]; then
      case "$desc" in
        *"dynamically linked"*)
          echo "ERROR: $bin 是动态链接的，会在 Kylin V10 上因 glibc 版本失败。" >&2
          echo "       请用 CGO_ENABLED=0 重新打包（脚本默认已是 0）。" >&2
          return 1 ;;
        *"statically linked"*) : ;;
        *)
          echo "ERROR: $bin 不是 Linux 静态 ELF：$desc" >&2
          echo "       --no-cli-build / CLI_SRC 复用的二进制可能属于别的平台。" >&2
          return 1 ;;
      esac
      case "$goarch" in
        amd64) expected="x86-64" ;;
        arm64) expected="aarch64" ;;
        loong64) expected="LoongArch" ;;
        riscv64) expected="RISC-V" ;;
      esac
      if [ -n "$expected" ] && [[ "$desc" != *"$expected"* ]]; then
        echo "ERROR: 架构不符（期望 $goarch/$expected）：$desc" >&2
        return 1
      fi
    fi
  else
    echo "    WARN: 未找到 file 命令，跳过 ELF 静态/架构校验（CGO_ENABLED=$CGO_ENABLED 已显式设定）"
  fi
  if [ "$goos/$goarch" = "$HOST_GOOS/$HOST_GOARCH" ]; then
    "$bin" --version
  else
    echo "    verified: ${desc:-cross-compiled binary} (异构目标，跳过本机 --version)"
  fi
}

sha256_file() {
  local name="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$name"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$name"
  else
    echo "ERROR: need sha256sum (Linux) or shasum (macOS)" >&2
    return 1
  fi
}

LAST_STAGE=""
package_one() {
  local goos="$1" goarch="$2"
  local stage_root="$ROOT/dist-pkg/.stage-${goos}-${goarch}"
  local stage="$stage_root/orange-lark-cli"
  local archive="$ROOT/dist-pkg/orange-lark-cli-${VERSION}-${goos}-${goarch}.tar.gz"

  echo "==> staging $goos/$goarch -> $stage"
  # Merge-copy instead of `rm -rf` + copy: some IDE shells shim recursive deletes
  # with a ~500-files-per-turn guard, and a packaged plugin is right at that size.
  # 每个目标独立 stage，避免多架构打包时互相覆盖二进制。
  mkdir -p "$stage/bin" "$stage/scripts" "$stage/dist"
  cp -R "$ROOT/dist/." "$stage/dist/"
  if [ -d "$ROOT/skills" ]; then
    mkdir -p "$stage/skills"
    cp -R "$ROOT/skills/." "$stage/skills/"
  fi
  cp "$ROOT/openclaw.plugin.json" "$ROOT/package.json" "$ROOT/README.md" "$stage/"
  cp "$ROOT/scripts/setup-account.sh" "$ROOT/scripts/install.sh" "$stage/scripts/"
  chmod +x "$stage/scripts/"*.sh

  # 先写隐藏候选文件：校验不过时，stage 里已装好的二进制不会被坏文件覆盖。
  local candidate="$stage/bin/.lark-cli.candidate"
  if [ "$CLI_BUILD" = "1" ] && [ "$CLI_SRC_EXPLICIT" = "0" ]; then
    build_cli "$goos" "$goarch" "$candidate"
  else
    echo "==> reusing lark-cli binary: $CLI_SRC"
    [ -x "$CLI_SRC" ] || { echo "lark-cli binary not found: $CLI_SRC" >&2; exit 1; }
    cp "$CLI_SRC" "$candidate"
  fi
  chmod +x "$candidate"
  echo "    version: ${VERSION}-${GIT_REF}${CLI_VERSION:+ (repo binary: $CLI_VERSION)}"

  echo "==> verifying bundled binary"
  if ! verify_cli "$candidate" "$goos" "$goarch"; then
    rm -f "$candidate"
    return 1
  fi
  mv -f "$candidate" "$stage/bin/lark-cli"

  local linkage="static" glibc_required="false" note="静态 ELF，可直接在 Kylin V10 / 统信 UOS 等国产 Linux 上运行，无需匹配构建机 glibc"
  if [ "$goos" != linux ] || [ "$CGO_ENABLED" != "0" ]; then
    linkage="host-dependent"
    glibc_required="true"
    note="非 linux/静态目标，部署前需确认目标机 glibc 与架构"
  fi
  cat > "$stage/BUILDINFO.json" <<EOF
{
  "plugin_version": "$VERSION",
  "cli_ref": "$GIT_REF",
  "built_at": "$BUILD_DATE",
  "goos": "$goos",
  "goarch": "$goarch",
  "cgo_enabled": "$CGO_ENABLED",
  "linkage": "$linkage",
  "glibc_required": $glibc_required,
  "node_required": ">=22",
  "note": "$note"
}
EOF

  echo "==> archiving"
  mkdir -p "$ROOT/dist-pkg"
  tar -czf "$archive" -C "$stage_root" orange-lark-cli
  ( cd "$ROOT/dist-pkg" && sha256_file "$(basename "$archive")" > "$(basename "$archive").sha256" )

  echo "package : $archive"
  echo "size    : $(du -h "$archive" | cut -f1)"
  echo "sha256  : $(cut -d' ' -f1 "$archive.sha256")"
  echo
  LAST_STAGE="$stage_root"
}

set -- $TARGET_LIST
for target_arch_raw in "$@"; do
  package_one "$TARGET_GOOS" "$(normalize_arch "$target_arch_raw")"
done

if [ "$INSTALL" = 1 ]; then
  echo "==> installing into $INSTALL_DIR/orange-lark-cli"
  "$LAST_STAGE/orange-lark-cli/scripts/install.sh" "$INSTALL_DIR"

  # Orange 把 <plugin>/skills 同步进 agent workspace 时是 write-if-missing，
  # 只重装插件不会刷新已存在的旧副本，正在运行的会话会继续读旧技能。
  # 装完顺手把技能推到 workspace + 已有 sandbox，用 --no-build 复用上面刚生成的 skills/。
  if [ "$(basename "$INSTALL_DIR")" = "plugins" ]; then
    echo
    echo "==> syncing skills into workspace / sandboxes"
    ORANGE_HOME="$(cd "$INSTALL_DIR/.." && pwd)" "$ROOT/scripts/sync-skills.sh" --no-build --sandboxes
  else
    echo "    (技能同步已跳过：$INSTALL_DIR 不是 <orange_home>/plugins)"
  fi
fi
