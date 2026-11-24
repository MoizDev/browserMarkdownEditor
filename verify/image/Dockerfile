# Debian amd64, selected from the official Node index and pulled 2026-11-13.
# Both stages use the same content-addressed root, not a mutable distribution tag.
FROM --platform=linux/amd64 node:26.0.0-bookworm-slim@sha256:52d70d606181ef3b3c2137a190196a8c452e0358e6d0971573d0e59135ada9fc AS libraries

# Download/extract runtime libraries rather than installing fontconfig-config: its
# mandatory font dependency would otherwise install DejaVu behind our private font set.
# No system font package is installed or extracted, including in this build stage.
RUN set -eu; \
    rm -f /etc/apt/apt.conf.d/docker-clean; \
    apt-get update; \
    apt-get --download-only --no-install-recommends -y install \
        ca-certificates unzip fontconfig libasound2 libatk-bridge2.0-0 libatk1.0-0 \
        libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libgbm1 \
        libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libudev1 libx11-6 libxcb1 \
        libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
        libx11-xcb1 libxshmfence1 libxss1; \
    mkdir -p /runtime/opt/picture; \
    for archive in /var/cache/apt/archives/*.deb; do \
        package="$(dpkg-deb -f "$archive" Package)"; \
        case "$package" in fonts-*|ttf-*) continue ;; esac; \
        dpkg-deb -f "$archive" Package Version Architecture >> /runtime/opt/picture/library-packages.txt; \
        sha256sum "$archive" >> /runtime/opt/picture/library-archives.sha256; \
        dpkg-deb -x "$archive" /runtime; \
    done; \
    test -s /runtime/opt/picture/library-packages.txt

# Measured: copying dpkg's /lib directory onto Debian's /lib -> usr/lib failed
# at COPY ("cannot copy to non-directory"). Normalize the extracted tree to the
# base's merged-/usr layout without ever installing the skipped font packages.
RUN set -eu; \
    for directory in bin sbin lib lib64; do \
        if [ -d "/runtime/$directory" ] && [ ! -L "/runtime/$directory" ]; then \
            mkdir -p "/runtime/usr/$directory"; \
            cp -a "/runtime/$directory/." "/runtime/usr/$directory/"; \
            rm -rf "/runtime/$directory"; \
            ln -s "usr/$directory" "/runtime/$directory"; \
        fi; \
    done

FROM --platform=linux/amd64 node:26.0.0-bookworm-slim@sha256:52d70d606181ef3b3c2137a190196a8c452e0358e6d0971573d0e59135ada9fc
COPY --from=libraries /runtime/ /
COPY chrome-linux64.zip /opt/chrome-linux64.zip
COPY node_modules/ /work/node_modules/
COPY fonts/ /opt/fonts/files/
COPY fonts.conf /opt/fonts/fonts.conf
COPY fonts.manifest.json /opt/fonts/manifest.json
COPY THIRD_PARTY_NOTICES /opt/fonts/THIRD_PARTY_NOTICES
ENV FONTCONFIG_FILE=/opt/fonts/fonts.conf \
    FONTCONFIG_PATH=/opt/fonts \
    BME_CHROME_PATH=/opt/chrome-linux64/chrome \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/cache \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=UTC
RUN set -eu; \
    echo 'e4cffe4c057c8dd96832e0ac3060e79eecc3b1c7fb5cd18cdf2e23702a13ac55  /opt/chrome-linux64.zip' | sha256sum -c -; \
    unzip -q /opt/chrome-linux64.zip -d /opt; \
    rm /opt/chrome-linux64.zip; \
    ldconfig; \
    mkdir -p /opt/font-cache; \
    fc-cache -f /opt/fonts/files; \
    fc-list -f '%{file}\t%{family}\n' | sort > /opt/fonts/fontconfig-list.txt; \
    test -s /opt/fonts/fontconfig-list.txt; \
    if grep -v '^/opt/fonts/files/' /opt/fonts/fontconfig-list.txt; then exit 1; fi; \
    if dpkg-query -W -f='${binary:Package} ${db:Status-Status}\n' 'fonts-*' 'ttf-*' 2>/dev/null | grep -q 'installed$'; then exit 1; fi; \
    /opt/chrome-linux64/chrome --version; \
    node -e 'if (require("/work/node_modules/playwright/package.json").version !== "1.63.0") process.exit(1)'
WORKDIR /work
# The caller mounts app dist and verification code read-only and runs by this image's ID.
# No app build or golden enters the image; candidate app builds share the same rasterizer.
ENTRYPOINT ["node", "/work/verify/image/capture.mjs"]
