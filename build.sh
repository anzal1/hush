#!/bin/sh
# Builds the universal macOS helper into bin/hush.
set -e
cd "$(dirname "$0")"
mkdir -p bin
swiftc -O -target arm64-apple-macos12 native/hush.swift -o bin/hush-arm64
swiftc -O -target x86_64-apple-macos12 native/hush.swift -o bin/hush-x86_64
lipo -create bin/hush-arm64 bin/hush-x86_64 -output bin/hush
rm bin/hush-arm64 bin/hush-x86_64
codesign -s - --force bin/hush
echo "built bin/hush"
