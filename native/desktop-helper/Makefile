# pv-helper build. Requires Go 1.27 (a supported release; see go.mod) and Xcode command line tools (clang, lipo).
#
#   make build       host-arch binary          -> bin/pv-helper
#   make universal   arm64 + amd64, lipo'd     -> bin/pv-helper-universal
#   make test        go test -race ./...
#   make vet         go vet ./...
#   make sign IDENTITY="Developer ID Application: ..." TEAM_ID=ABCDE12345

GO        ?= go
VERSION   ?= 0.1.0-dev
MIN_MACOS ?= 14.0
BIN       := bin
PKG       := ./cmd/pv-helper

# Never silently download a different toolchain.
export GOTOOLCHAIN := local
export MACOSX_DEPLOYMENT_TARGET := $(MIN_MACOS)

CGO_FLAGS := -O2 -g -mmacosx-version-min=$(MIN_MACOS)
LDFLAGS   := -s -w -X main.version=$(VERSION)
GOFLAGS_BUILD := -trimpath -ldflags "$(LDFLAGS)"

.PHONY: build universal arm64 amd64 test vet clean sign verify

build:
	CGO_ENABLED=1 CGO_CFLAGS="$(CGO_FLAGS)" CGO_LDFLAGS="-mmacosx-version-min=$(MIN_MACOS)" \
		$(GO) build $(GOFLAGS_BUILD) -o $(BIN)/pv-helper $(PKG)
	@file $(BIN)/pv-helper

arm64:
	CGO_ENABLED=1 GOOS=darwin GOARCH=arm64 CC="clang -arch arm64" \
		CGO_CFLAGS="$(CGO_FLAGS)" CGO_LDFLAGS="-mmacosx-version-min=$(MIN_MACOS)" \
		$(GO) build $(GOFLAGS_BUILD) -o $(BIN)/pv-helper-arm64 $(PKG)

amd64:
	CGO_ENABLED=1 GOOS=darwin GOARCH=amd64 CC="clang -arch x86_64" \
		CGO_CFLAGS="$(CGO_FLAGS)" CGO_LDFLAGS="-mmacosx-version-min=$(MIN_MACOS)" \
		$(GO) build $(GOFLAGS_BUILD) -o $(BIN)/pv-helper-amd64 $(PKG)

universal: arm64 amd64
	lipo -create -output $(BIN)/pv-helper-universal $(BIN)/pv-helper-arm64 $(BIN)/pv-helper-amd64
	$(MAKE) --no-print-directory verify

verify:
	lipo -info $(BIN)/pv-helper-universal
	file $(BIN)/pv-helper-universal
	@for a in arm64 x86_64; do \
		printf '%s minos: ' $$a; \
		otool -arch $$a -l $(BIN)/pv-helper-universal | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print $$2; exit}'; \
	done

test:
	$(GO) test -race -count=1 ./...

vet:
	$(GO) vet ./...

# Signed build: hardened runtime + keychain entitlement (see docs/DESKTOP_HELPER.md
# for packaging requirements of the data-protection keychain).
sign: universal
	@test -n "$(IDENTITY)" || (echo "IDENTITY is required" && exit 1)
	@test -n "$(TEAM_ID)" || (echo "TEAM_ID is required" && exit 1)
	sed 's/$$(TEAM_ID)/$(TEAM_ID)/g' entitlements.plist > $(BIN)/entitlements.resolved.plist
	codesign --force --timestamp --options runtime \
		--identifier io.passvault.helper \
		--entitlements $(BIN)/entitlements.resolved.plist \
		--sign "$(IDENTITY)" $(BIN)/pv-helper-universal
	codesign --verify --strict --verbose=2 $(BIN)/pv-helper-universal
	codesign -d --entitlements - $(BIN)/pv-helper-universal

clean:
	rm -rf $(BIN)
