FROM apify/actor-node-puppeteer-chrome:22-24.36.1

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . ./
