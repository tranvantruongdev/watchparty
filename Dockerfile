FROM node:24-alpine

COPY . /usr/src

WORKDIR /usr/src

RUN npm ci

RUN npm run build

# Production only from here on: NODE_ENV=production during npm ci would skip
# devDependencies that the build above needs. Keeps error responses generic
# (no err.stack in the body) for anyone running this image outside render.yaml.
ENV NODE_ENV=production

ENTRYPOINT ["/bin/sh", "-c" , "npm start"]