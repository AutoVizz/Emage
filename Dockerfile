# The named context points to the EmageWasm checkout.
FROM emscripten/emsdk:6.0.9 AS wasm-build
WORKDIR /src/wasm
COPY --from=wasm-source . .
RUN emcmake cmake -S . -B /tmp/wasm-build -DCMAKE_BUILD_TYPE=Release -DEMAGE_CLIENT_WASM_DIR=/tmp/wasm-assets \
    && cmake --build /tmp/wasm-build --parallel

FROM python:3.13-alpine AS demo
WORKDIR /app
COPY tools/demo_server.py ./tools/demo_server.py
COPY demo-assets/ ./demo-assets/
ENV PYTHONDONTWRITEBYTECODE=1
USER 1000:1000
EXPOSE 8082 3434 3435 3436 3437
HEALTHCHECK --interval=5s --timeout=3s --start-period=90s CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8082/demo/config', timeout=2).close()"
CMD ["python3", "-u", "tools/demo_server.py", "--bind", "0.0.0.0", "--port", "8082", "--transport-ports", "3434,3435,3436,3437", "--seed-attempts", "30"]

FROM nginx:alpine AS client
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY *.html emage.js /usr/share/nginx/html/
COPY css/ /usr/share/nginx/html/css/
COPY js/ /usr/share/nginx/html/js/
COPY assets/ /usr/share/nginx/html/assets/
COPY demo-assets/ /usr/share/nginx/html/demo-assets/
COPY vendor/noble-sha3.js /usr/share/nginx/html/vendor/noble-sha3.js
COPY --from=wasm-build /tmp/wasm-assets/ /usr/share/nginx/html/wasm/
EXPOSE 80
