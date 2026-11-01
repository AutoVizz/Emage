# The named context points to the EmageWasm checkout.
FROM emscripten/emsdk:6.0.9 AS wasm-build
WORKDIR /src/wasm
COPY --from=wasm-source . .
RUN emcmake cmake -S . -B /tmp/wasm-build -DCMAKE_BUILD_TYPE=Release -DEMAGE_CLIENT_WASM_DIR=/tmp/wasm-assets \
    && cmake --build /tmp/wasm-build --parallel

FROM nginx:alpine
COPY *.html emage.js /usr/share/nginx/html/
COPY css/ /usr/share/nginx/html/css/
COPY js/ /usr/share/nginx/html/js/
COPY assets/ /usr/share/nginx/html/assets/
COPY demo-assets/ /usr/share/nginx/html/demo-assets/
COPY vendor/noble-sha3.js /usr/share/nginx/html/vendor/noble-sha3.js
COPY --from=wasm-build /tmp/wasm-assets/ /usr/share/nginx/html/wasm/
EXPOSE 80
