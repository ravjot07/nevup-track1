FROM node:20-alpine AS build

WORKDIR /app

COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY web/ ./

ARG VITE_API_BASE_URL=http://localhost:3000
ARG VITE_JWT_SECRET=97791d4db2aa5f689c3cc39356ce35762f0a73aa70923039d8ef72a2840a1b02
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_JWT_SECRET=$VITE_JWT_SECRET

RUN npm run build

FROM nginx:1.27-alpine

COPY web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

ENV PORT=80
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
