FROM nginx:alpine
COPY *.html emage.js /usr/share/nginx/html/
COPY css/ /usr/share/nginx/html/css/
COPY js/ /usr/share/nginx/html/js/
COPY assets/ /usr/share/nginx/html/assets/
COPY demo-assets/ /usr/share/nginx/html/demo-assets/
COPY vendor/noble-sha3.js /usr/share/nginx/html/vendor/noble-sha3.js
EXPOSE 80
