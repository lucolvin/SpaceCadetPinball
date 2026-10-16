# Space Cadet Pinball for the web, built from this fork (alula's web port plus fixes: the player controls
# dialog, and high scores and options saved as they change rather than on exit, which a browser tab never reaches).
# persist.js keeps saves in the browser and, for players signed in with GitHub, in PocketBase with a shared leaderboard.
# Build from the repository root: docker build -f web/Dockerfile .
FROM alpine/git AS prebuilt
# The game files only exist inside alula's published build
RUN git clone --single-branch --branch gh-pages https://github.com/alula/SpaceCadetPinball.git /prebuilt \
 && git -C /prebuilt checkout a93547299a2ed7bd602630c0be3a43648e25a886

# Emscripten close to what upstream used (its SDL2 port is version_24)
FROM emscripten/emsdk:2.0.34 AS build
COPY . /src/game
COPY --from=prebuilt /prebuilt /src/prebuilt
WORKDIR /src/game
RUN python3 web/extract-data.py ../prebuilt/SpaceCadetPinball.js ../prebuilt/SpaceCadetPinball.data game_resources \
 && sed -i 's#</head>#<link rel="stylesheet" href="tweaks.css"><script src="tweaks.js"></script></head>#' SpaceCadetPinball/emscripten_shell.html \
 && sed -i 's#{{{ SCRIPT }}}#<script src="persist.js"></script>\n{{{ SCRIPT }}}#' SpaceCadetPinball/emscripten_shell.html \
 && emcmake cmake -B build -DCMAKE_BUILD_TYPE=Release \
 && cmake --build build -j"$(nproc)" \
 && mkdir /out && cp bin/SpaceCadetPinball.js bin/SpaceCadetPinball.wasm bin/SpaceCadetPinball.data /out/ \
 && cp bin/SpaceCadetPinball.html /out/index.html

FROM nginx:alpine
COPY --from=build /out /usr/share/nginx/html
COPY web/persist.js web/tweaks.js web/tweaks.css /usr/share/nginx/html/
COPY web/nginx.conf.template /etc/nginx/templates/default.conf.template
# Cloudflare caches .js and .css, so a rebuild could pair a stale SpaceCadetPinball.js with a new .wasm
# ("function signature mismatch"). Load them by content hash so each build gets new URLs.
RUN cd /usr/share/nginx/html && for f in SpaceCadetPinball.js persist.js tweaks.js tweaks.css; do \
      h=$(sha1sum "$f" | cut -c1-12); sed -i -E "s#(src|href)=\"?$f\"?#\\1=\"$f?v=$h\"#g" index.html; \
    done && grep -q 'SpaceCadetPinball.js?v=' index.html
EXPOSE 80
