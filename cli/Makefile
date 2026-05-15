BIN     := opale
LDFLAGS := -s -w

.PHONY: build test cover vet clean dev

build:
	GOOS=darwin  GOARCH=arm64 go build -ldflags="$(LDFLAGS)" -o dist/$(BIN)-darwin-arm64  .
	GOOS=darwin  GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o dist/$(BIN)-darwin-amd64  .
	GOOS=linux   GOARCH=arm64 go build -ldflags="$(LDFLAGS)" -o dist/$(BIN)-linux-arm64   .
	GOOS=linux   GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o dist/$(BIN)-linux-amd64   .

test:
	go test ./...

# Couverture agrégée — `make cover` puis ouvrir cover.html
cover:
	go test -coverprofile=cover.out ./...
	go tool cover -html=cover.out -o cover.html
	@echo "→ ouvrir cover.html"

vet:
	go vet ./...

dev:
	go run . $(ARGS)

clean:
	rm -rf dist/ cover.out cover.html
