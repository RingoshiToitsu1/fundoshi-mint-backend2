FROM node:20

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Install Sugar CLI
RUN curl -sSf https://sugar.metaplex.com/install.sh -o /tmp/install-sugar.sh && \
    bash /tmp/install-sugar.sh && \
    rm /tmp/install-sugar.sh

# Verify installations
RUN cargo --version && sugar --version

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["npm", "start"]
