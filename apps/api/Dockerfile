FROM node:22-alpine

WORKDIR /app
RUN apk add --no-cache openssl

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY prisma ./prisma
RUN npm ci

COPY apps/api ./apps/api
COPY packages/shared ./packages/shared
RUN npx prisma generate --schema prisma/schema.prisma \
    && npm run build --workspace @school-crm/api

ENV NODE_ENV=production
# Run the API and database migrations without root privileges.
USER node
EXPOSE 4000
CMD ["sh", "-c", "npx prisma migrate deploy --schema prisma/schema.prisma && node apps/api/dist/main.js"]
