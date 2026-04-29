# ── Build stage ───────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

ARG VITE_AZURE_TENANT_ID
ARG VITE_AZURE_CLIENT_ID
ARG VITE_API_URL

RUN npm run build

# ── Production stage (nginx) ─────────────────────────────
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
