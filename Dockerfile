FROM node:22-alpine AS web-build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml README.md LICENSE ./
COPY src ./src
COPY data ./data
COPY --from=web-build /app/web/dist ./static
RUN pip install --no-cache-dir .
ENV FLOWSPEC_MODE=demo
EXPOSE 8010
CMD ["uvicorn", "flowspec.api:app", "--host", "0.0.0.0", "--port", "8010"]
